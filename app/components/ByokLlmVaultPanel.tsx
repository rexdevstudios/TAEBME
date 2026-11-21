'use client';

import React, { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, Plus, Trash2, Lock } from 'lucide-react';

interface LlmKeyItem {
  id: string;
  label: string;
  maskedKey: string;
  isDefault: boolean;
  lastUsedAt: string | null;
}

interface ByokLlmVaultPanelProps {
  isConnected: boolean;
  selectedLlmProvider: 'PLATFORM' | 'GEMINI' | 'OPENAI';
  onSelectLlmProvider: (provider: 'PLATFORM' | 'GEMINI' | 'OPENAI') => void;
}

export function ByokLlmVaultPanel({
  isConnected,
  selectedLlmProvider,
  onSelectLlmProvider,
}: ByokLlmVaultPanelProps) {
  const [activeTab, setActiveTab] = useState<'GEMINI' | 'OPENAI'>('GEMINI');
  const [keys, setKeys] = useState<LlmKeyItem[]>([]);
  const [maxKeys, setMaxKeys] = useState<number>(1);
  const [planId, setPlanId] = useState<string>('FREE');
  const [showAdd, setShowAdd] = useState<boolean>(false);
  const [label, setLabel] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadKeys = async (prov: 'GEMINI' | 'OPENAI') => {
    if (!isConnected) return;
    try {
      const res = await fetch(`/api/user/provider-keys?provider=${prov}`);
      const json = await res.json();
      if (json?.success && json.data) {
        setKeys(json.data.keys || []);
        setMaxKeys(Number(json.data.maxKeys || 1));
        setPlanId(json.data.planId || 'FREE');
      }
    } catch {
      // Non-blocking
    }
  };

  useEffect(() => {
    loadKeys(activeTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, activeTab]);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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
            onChange={(e) => {
              const v = e.target.value as 'PLATFORM' | 'GEMINI' | 'OPENAI';
              onSelectLlmProvider(v);
              if (v === 'GEMINI' || v === 'OPENAI') setActiveTab(v);
            }}
            className="input"
            style={{ padding: '4px 8px', fontSize: '11px', fontWeight: 700 }}
          >
            <option value="PLATFORM">LLM: Platform Default (5 Cr)</option>
            <option value="GEMINI">LLM: BYOK Gemini (2 Cr)</option>
            <option value="OPENAI">LLM: BYOK OpenAI (2 Cr)</option>
          </select>
          {isConnected && (
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
          <Lock size={12} /> Hubungkan wallet (SIWE) untuk menyimpan API Key Gemini / OpenAI pribadi Anda.
        </div>
      ) : (
        <>
          {showAdd && (
            <form onSubmit={handleAdd} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr auto', gap: '6px', alignItems: 'center' }}>
              <select
                aria-label="LLM provider to add"
                value={activeTab}
                onChange={(e) => setActiveTab(e.target.value as 'GEMINI' | 'OPENAI')}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontWeight: 700 }}
              >
                <option value="GEMINI">GEMINI</option>
                <option value="OPENAI">OPENAI</option>
              </select>
              <input
                type="text"
                placeholder="Label (mis: Gemini Pro Key)"
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

          {keys.length > 0 && (
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
                  }}
                >
                  <strong>{k.label}</strong>
                  <code style={{ fontSize: '10px', color: 'var(--color-muted)' }}>{k.maskedKey}</code>
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
        </>
      )}

      {feedback && (
        <div style={{ fontSize: '11px', color: feedback.startsWith('✅') ? '#10B981' : '#F59E0B' }}>
          {feedback}
        </div>
      )}
    </div>
  );
}
