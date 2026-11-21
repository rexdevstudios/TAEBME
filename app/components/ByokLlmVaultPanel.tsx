'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { KeyRound, ShieldCheck, Plus, Trash2, Lock, Crown } from 'lucide-react';

export type SelectedLlmProvider = 'PLATFORM' | 'GEMINI' | 'OPENAI' | 'ANTHROPIC';
export type ByokVaultTab = 'GEMINI' | 'OPENAI' | 'ANTHROPIC';

export const BYOK_MODEL_CATALOG: Record<
  ByokVaultTab,
  Array<{ id: string; label: string; badge: string }>
> = {
  GEMINI: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash — Cepat & Hemat (Rekomendasi)', badge: 'FAST' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro — Analisa Mendalam', badge: 'DEEP' },
  ],
  OPENAI: [
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini — Cepat & Hemat (Rekomendasi)', badge: 'FAST' },
    { id: 'gpt-4o', label: 'GPT-4o — Analisa Mendalam', badge: 'DEEP' },
  ],
  ANTHROPIC: [
    { id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet — Seimbang & Tajam (Rekomendasi)', badge: 'BALANCED' },
    { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku — Ultra-Cepat', badge: 'FAST' },
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4 — Deep Analysis (Latensi & Biaya Tinggi)', badge: 'DEEP' },
  ],
};

interface LlmKeyItem {
  id: string;
  label: string;
  maskedKey: string;
  isDefault: boolean;
  lastUsedAt: string | null;
  quotaStatus?: 'ACTIVE' | 'FROZEN_OVER_QUOTA' | 'FROZEN_MAINNET_LOCKED';
}

interface ByokLlmVaultPanelProps {
  isConnected: boolean;
  selectedLlmProvider: SelectedLlmProvider;
  onSelectLlmProvider: (provider: SelectedLlmProvider) => void;
  selectedLlmModel: string;
  onSelectLlmModel: (model: string) => void;
}

export function ByokLlmVaultPanel({
  isConnected,
  selectedLlmProvider,
  onSelectLlmProvider,
  selectedLlmModel,
  onSelectLlmModel,
}: ByokLlmVaultPanelProps) {
  const [activeTab, setActiveTab] = useState<ByokVaultTab>('GEMINI');
  const [keys, setKeys] = useState<LlmKeyItem[]>([]);
  const [maxKeys, setMaxKeys] = useState<number>(0);
  const [planId, setPlanId] = useState<string>('FREE');
  const [showAdd, setShowAdd] = useState<boolean>(false);
  const [label, setLabel] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const isByokAllowed = maxKeys > 0;

  const loadKeys = async (prov: ByokVaultTab) => {
    if (!isConnected) return;
    try {
      const res = await fetch(`/api/user/provider-keys?provider=${prov}`);
      const json = await res.json();
      if (json?.success && json.data) {
        setKeys(json.data.keys || []);
        const nextMax = Number(json.data.maxKeys ?? 0);
        setMaxKeys(nextMax);
        setPlanId(json.data.planId || 'FREE');
        if (nextMax <= 0 && selectedLlmProvider !== 'PLATFORM') {
          onSelectLlmProvider('PLATFORM');
          onSelectLlmModel('');
        }
      }
    } catch {
      // Non-blocking
    }
  };

  useEffect(() => {
    loadKeys(activeTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, activeTab]);

  const handleProviderSelect = (v: SelectedLlmProvider) => {
    if (v !== 'PLATFORM' && !isByokAllowed) {
      setFeedback('🔒 BYOK LLM eksklusif untuk pelanggan Pro Terminal Trader (TRADER) & AI Autonomous Desk (AGENT).');
      return;
    }
    onSelectLlmProvider(v);
    if (v === 'GEMINI' || v === 'OPENAI' || v === 'ANTHROPIC') {
      setActiveTab(v);
      onSelectLlmModel(BYOK_MODEL_CATALOG[v][0].id);
    } else {
      onSelectLlmModel('');
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !apiKey.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/user/provider-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: activeTab,
          label: label.trim(),
          apiKey: apiKey.trim(),
          chainScope: 'all',
          isDefault: true,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`⚠️ ${json?.error || 'Gagal menyimpan API Key LLM'}`);
      } else {
        setLabel('');
        setApiKey('');
        setShowAdd(false);
        onSelectLlmProvider(activeTab);
        onSelectLlmModel(BYOK_MODEL_CATALOG[activeTab][0].id);
        setFeedback(`✅ BYOK ${activeTab} Key (${json.data.maskedKey}) aktif — hemat biaya desk menjadi 2 Cr/run!`);
        await loadKeys(activeTab);
      }
    } catch (err: any) {
      setFeedback(`⚠️ ${err?.message || 'Network error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (keyId: string) => {
    await fetch(`/api/user/provider-keys?keyId=${encodeURIComponent(keyId)}`, { method: 'DELETE' });
    await loadKeys(activeTab);
  };

  const activeModels =
    selectedLlmProvider !== 'PLATFORM' ? BYOK_MODEL_CATALOG[selectedLlmProvider] : [];

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '14px 16px',
        marginBottom: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <KeyRound size={14} style={{ color: '#A855F7' }} />
          <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)' }}>
            BYOK LLM Vault ({activeTab}: {keys.length}/{maxKeys} · {planId})
          </span>
          <span
            style={{
              fontSize: '9px',
              fontWeight: 800,
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'rgba(168,85,247,0.16)',
              color: '#C084FC',
            }}
          >
            <Crown size={10} style={{ display: 'inline', marginRight: '3px', verticalAlign: 'middle' }} />
            TRADER &amp; AGENT Exclusive
          </span>
          <span
            style={{
              fontSize: '9px',
              fontWeight: 800,
              padding: '2px 6px',
              borderRadius: '4px',
              background: 'rgba(16,185,129,0.14)',
              color: '#10B981',
            }}
          >
            <ShieldCheck size={10} style={{ display: 'inline', marginRight: '3px', verticalAlign: 'middle' }} />
            Hemat 60% Credits (2 Cr/run)
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <select
            aria-label="Select LLM engine for 5-Agent Desk"
            value={selectedLlmProvider}
            onChange={(e) => handleProviderSelect(e.target.value as SelectedLlmProvider)}
            className="input"
            style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 700 }}
          >
            <option value="PLATFORM">LLM: Platform Default · BytePlus/Gemini (5 Cr)</option>
            <option value="GEMINI" disabled={isConnected && !isByokAllowed}>
              LLM: BYOK Google Gemini (2 Cr){isConnected && !isByokAllowed ? ' 🔒' : ''}
            </option>
            <option value="OPENAI" disabled={isConnected && !isByokAllowed}>
              LLM: BYOK OpenAI GPT (2 Cr){isConnected && !isByokAllowed ? ' 🔒' : ''}
            </option>
            <option value="ANTHROPIC" disabled={isConnected && !isByokAllowed}>
              LLM: BYOK Anthropic Claude (2 Cr){isConnected && !isByokAllowed ? ' 🔒' : ''}
            </option>
          </select>

          {selectedLlmProvider !== 'PLATFORM' && activeModels.length > 0 && (
            <select
              aria-label="Select BYOK LLM model"
              value={selectedLlmModel || activeModels[0].id}
              onChange={(e) => onSelectLlmModel(e.target.value)}
              className="input"
              style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 700 }}
            >
              {activeModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          )}

          {isConnected && isByokAllowed && (
            <button
              type="button"
              onClick={() => setShowAdd((v) => !v)}
              className="btn-secondary"
              style={{ padding: '4px 8px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <Plus size={12} /> {showAdd ? 'Tutup' : `Tambah ${activeTab} Key`}
            </button>
          )}
        </div>
      </div>

      {!isConnected ? (
        <div style={{ fontSize: '11px', color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Lock size={12} /> Hubungkan wallet (SIWE) untuk mengakses BYOK LLM Vault (Gemini, OpenAI, Anthropic Claude).
        </div>
      ) : !isByokAllowed ? (
        <div
          style={{
            fontSize: '11px',
            color: '#FDE68A',
            background: 'rgba(245,158,11,0.10)',
            border: '1px solid rgba(245,158,11,0.35)',
            borderRadius: '8px',
            padding: '10px 12px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '8px',
          }}
        >
          <span>
            <Lock size={12} style={{ display: 'inline', marginRight: '5px', verticalAlign: 'middle' }} />
            <strong>BYOK LLM Vault</strong> (Gemini 2.5, GPT-4o, Claude 3.5 Sonnet / Opus) eksklusif untuk pelanggan{' '}
            <strong>Pro Terminal Trader (TRADER)</strong> dan <strong>AI Autonomous Desk (AGENT)</strong>. Paket Anda saat ini:{' '}
            <code>{planId}</code> (tetap bisa memakai LLM Platform Default).
          </span>
          <Link
            href="/billing"
            className="btn-primary"
            style={{ padding: '5px 10px', fontSize: '11px', textDecoration: 'none', whiteSpace: 'nowrap' }}
          >
            Upgrade di /billing →
          </Link>
        </div>
      ) : (
        <>
          {showAdd && (
            <form onSubmit={handleAdd} style={{ display: 'grid', gridTemplateColumns: '125px 1fr 1fr auto', gap: '6px', alignItems: 'center' }}>
              <select
                aria-label="LLM provider to add"
                value={activeTab}
                onChange={(e) => setActiveTab(e.target.value as ByokVaultTab)}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontWeight: 700 }}
              >
                <option value="GEMINI">GEMINI</option>
                <option value="OPENAI">OPENAI</option>
                <option value="ANTHROPIC">ANTHROPIC</option>
              </select>
              <input
                type="text"
                placeholder={`Label (mis: ${activeTab === 'ANTHROPIC' ? 'Claude Sonnet Key' : activeTab === 'OPENAI' ? 'OpenAI Desk Key' : 'Gemini Flash Key'})`}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px' }}
                required
              />
              <input
                type="password"
                placeholder={`${activeTab} API Key`}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                autoComplete="off"
                required
              />
              <button type="submit" disabled={saving} className="btn-primary" style={{ padding: '6px 10px', fontSize: '11px' }}>
                {saving ? '...' : 'Simpan'}
              </button>
            </form>
          )}
        </>
      )}

      {isConnected && keys.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {keys.map((k) => (
            <div
              key={k.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 8px',
                borderRadius: '6px',
                border: '1px solid var(--color-border)',
                fontSize: '11px',
                opacity: k.quotaStatus === 'FROZEN_OVER_QUOTA' ? 0.65 : 1,
              }}
            >
              <strong>{k.label}</strong>
              <code style={{ fontSize: '10px', color: 'var(--color-muted)' }}>{k.maskedKey}</code>
              {k.quotaStatus === 'FROZEN_OVER_QUOTA' && (
                <span style={{ fontSize: '9px', fontWeight: 800, color: '#F59E0B' }}>FROZEN</span>
              )}
              <button
                type="button"
                onClick={() => handleRevoke(k.id)}
                className="btn-destructive"
                style={{ padding: '2px 5px', fontSize: '10px' }}
                aria-label={`Revoke ${k.label}`}
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {feedback && (
        <div style={{ fontSize: '11px', color: feedback.startsWith('✅') ? '#10B981' : '#F59E0B' }}>
          {feedback}
        </div>
      )}
    </div>
  );
}
