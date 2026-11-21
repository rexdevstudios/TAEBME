'use client';

import React, { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, Plus, Trash2, CheckCircle2, Lock } from 'lucide-react';

export interface ProviderKeyItem {
  id: string;
  label: string;
  maskedKey: string;
  chainScope: 'all' | 'base' | 'robinhood' | 'arbitrum' | 'arc';
  isDefault: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  quotaStatus?: 'ACTIVE' | 'FROZEN_OVER_QUOTA' | 'FROZEN_MAINNET_LOCKED';
}

interface BankrKeyVaultPanelProps {
  isConnected: boolean;
  selectedChain: string;
  selectedKeyId: string;
  onSelectKeyId: (keyId: string) => void;
  canPublishLaunch: boolean;
  activePlanLabel?: string;
}

export function BankrKeyVaultPanel({
  isConnected,
  selectedChain,
  selectedKeyId,
  onSelectKeyId,
  canPublishLaunch,
  activePlanLabel = 'FREE',
}: BankrKeyVaultPanelProps) {
  const [keys, setKeys] = useState<ProviderKeyItem[]>([]);
  const [maxKeys, setMaxKeys] = useState<number>(10);
  const [vaultPlanId, setVaultPlanId] = useState<string>(activePlanLabel || 'FREE');
  const [platformFallbackAvailable, setPlatformFallbackAvailable] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(false);
  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [label, setLabel] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [chainScope, setChainScope] = useState<'all' | 'base' | 'robinhood' | 'arbitrum' | 'arc'>('all');
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const fetchKeys = async () => {
    if (!isConnected) return;
    setLoading(true);
    try {
      const res = await fetch('/api/user/provider-keys?provider=BANKR');
      const json = await res.json();
      if (json?.success && Array.isArray(json.data?.keys)) {
        const list: ProviderKeyItem[] = json.data.keys;
        setKeys(list);
        if (typeof json.data.maxKeys === 'number') setMaxKeys(json.data.maxKeys);
        if (typeof json.data.planId === 'string') setVaultPlanId(json.data.planId);
        setPlatformFallbackAvailable(Boolean(json.data.platformFallbackAvailable));
        const def = list.find((k) => k.isDefault);
        if (def && (!selectedKeyId || selectedKeyId === 'AUTO')) {
          onSelectKeyId(def.id);
        }
      }
    } catch {
      // Non-blocking
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !apiKey.trim()) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/user/provider-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'BANKR',
          label: label.trim(),
          apiKey: apiKey.trim(),
          chainScope,
          isDefault: keys.length === 0,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`⚠️ ${json?.error || 'Gagal menyimpan API Key'}`);
      } else {
        setLabel('');
        setApiKey('');
        setShowAddForm(false);
        setFeedback(`✅ API Key "${json.data.label}" (${json.data.maskedKey}) berhasil dienkripsi & disimpan.`);
        await fetchKeys();
        if (json.data?.id) {
          onSelectKeyId(json.data.id);
        }
      }
    } catch (err: any) {
      setFeedback(`⚠️ ${err?.message || 'Network error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (keyId: string) => {
    setFeedback(null);
    try {
      const res = await fetch('/api/user/provider-keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId, provider: 'BANKR' }),
      });
      if (res.ok) {
        onSelectKeyId(keyId);
        await fetchKeys();
      }
    } catch {
      // Ignore
    }
  };

  const handleRevoke = async (keyId: string, keyLabel: string) => {
    setFeedback(null);
    try {
      const res = await fetch(`/api/user/provider-keys?keyId=${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setFeedback(`🗑️ API Key "${keyLabel}" berhasil dicabut.`);
        if (selectedKeyId === keyId) {
          onSelectKeyId('PLATFORM_DEFAULT');
        }
        await fetchKeys();
      }
    } catch {
      // Ignore
    }
  };

  return (
    <div
      style={{
        marginTop: '12px',
        padding: '12px 14px',
        borderRadius: '10px',
        backgroundColor: 'var(--color-surface-elevated)',
        border: '1px solid var(--color-border)',
      }}
    >
      {/* Header Row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <KeyRound size={14} style={{ color: 'var(--color-accent)' }} />
          <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)' }}>
            Multi-Key Bankr BYOK Vault ({keys.length}/{maxKeys} · {vaultPlanId})
          </span>
          {keys.length >= maxKeys && (
            <a href="/billing" style={{ fontSize: '10px', fontWeight: 800, color: '#38BDF8', textDecoration: 'underline' }}>
              Upgrade Kuota →
            </a>
          )}
          <span
            className="badge"
            style={{
              fontSize: '9px',
              fontWeight: 800,
              backgroundColor: 'var(--color-badge-success-bg)',
              color: 'var(--color-badge-success-text)',
              border: '1px solid var(--color-badge-success-border)',
            }}
          >
            <ShieldCheck size={10} style={{ display: 'inline', marginRight: '3px', verticalAlign: 'middle' }} />
            AES-256-GCM · MULTI-CHAIN SAFE
          </span>
        </div>

        {isConnected && (
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            className="btn-secondary"
            style={{ padding: '4px 10px', fontSize: '11px', gap: '4px' }}
          >
            <Plus size={12} />
            {showAddForm ? 'Tutup Form' : 'Tambah Bankr API Key'}
          </button>
        )}
      </div>

      {/* Tier Requirement Info */}
      <div style={{ fontSize: '11px', color: 'var(--color-muted)', marginBottom: '10px', lineHeight: 1.45 }}>
        {canPublishLaunch ? (
          <span>
            ✅ Paket aktif Anda (<strong>{activePlanLabel}</strong>) memiliki akses penuh <strong>Publish &amp; Bankr Deploy</strong>. Anda dapat menyimpan hingga 10 API Key Bankr dengan batasan jaringan (<em>chain scope</em>) terisolasi.
          </span>
        ) : (
          <span>
            <Lock size={11} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle', color: 'var(--color-badge-warning-text)' }} />
            Akses <strong>Publish &amp; Bankr Deploy</strong> khusus untuk pelanggan paket <strong>Token Creator (CREATOR)</strong> atau <strong>AI Autonomous Desk (AGENT)</strong>. Anda tetap bisa menyimpan API Key di vault akun Anda sekarang.
          </span>
        )}
      </div>

      {/* Active Key Selector for Current Deployment */}
      {isConnected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: keys.length > 0 || showAddForm ? '10px' : '0' }}>
          <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>
            Sumber Key Deploy ({selectedChain.toUpperCase()}):
          </label>
          <select
            value={selectedKeyId}
            onChange={(e) => onSelectKeyId(e.target.value)}
            className="input"
            style={{ flex: '1 1 200px', padding: '6px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
          >
            <option value="PLATFORM_DEFAULT">
              🌐 Default Platform Key {platformFallbackAvailable ? '(Tersedia)' : '(Perlu BYOK Key)'}
            </option>
            {keys.map((k) => {
              const scopeMismatch = k.chainScope !== 'all' && k.chainScope !== selectedChain.toLowerCase();
              return (
                <option key={k.id} value={k.id} disabled={scopeMismatch}>
                  🔑 {k.label} ({k.maskedKey}) · Scope: {k.chainScope.toUpperCase()}
                  {k.isDefault ? ' ★ Default' : ''}
                  {scopeMismatch ? ` [Khusus ${k.chainScope.toUpperCase()}]` : ''}
                </option>
              );
            })}
          </select>
        </div>
      )}

      {/* Saved Keys List */}
      {isConnected && keys.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: showAddForm ? '10px' : '0' }}>
          {keys.map((k) => {
            const scopeMismatch = k.chainScope !== 'all' && k.chainScope !== selectedChain.toLowerCase();
            return (
              <div
                key={k.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap',
                  padding: '6px 10px',
                  borderRadius: '8px',
                  backgroundColor: 'var(--color-surface-subtle)',
                  border: `1px solid ${selectedKeyId === k.id ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  fontSize: '11px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <strong style={{ color: 'var(--color-foreground)' }}>{k.label}</strong>
                  <code style={{ color: 'var(--color-muted)', fontSize: '10px' }}>{k.maskedKey}</code>
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 800,
                      padding: '1px 6px',
                      borderRadius: '4px',
                      backgroundColor: scopeMismatch ? 'var(--color-badge-warning-bg)' : 'var(--color-badge-info-bg)',
                      color: scopeMismatch ? 'var(--color-badge-warning-text)' : 'var(--color-badge-info-text)',
                      border: `1px solid ${scopeMismatch ? 'var(--color-badge-warning-border)' : 'var(--color-badge-info-border)'}`,
                    }}
                  >
                    SCOPE: {k.chainScope.toUpperCase()}
                  </span>
                  <span style={{ fontSize: '9px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
                    {k.lastUsedAt ? `Dipakai: ${new Date(k.lastUsedAt).toLocaleString()}` : 'Belum dipakai'}
                  </span>
                  {k.quotaStatus && k.quotaStatus !== 'ACTIVE' && (
                    <span
                      style={{
                        fontSize: '9px',
                        fontWeight: 800,
                        padding: '1px 6px',
                        borderRadius: '4px',
                        backgroundColor: 'rgba(245, 158, 11, 0.18)',
                        color: '#F59E0B',
                        border: '1px solid rgba(245, 158, 11, 0.45)',
                      }}
                      title="Key aman tersimpan, tetapi terkunci sementara karena melebihi kuota paket aktif. Klik Set Default untuk menukar ke slot aktif atau tambah slot di /billing."
                    >
                      🔒 FROZEN (OVER-QUOTA)
                    </span>
                  )}
                  {k.isDefault && (
                    <span
                      style={{
                        fontSize: '9px',
                        fontWeight: 800,
                        padding: '1px 6px',
                        borderRadius: '4px',
                        backgroundColor: 'var(--color-badge-success-bg)',
                        color: 'var(--color-badge-success-text)',
                      }}
                    >
                      DEFAULT
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {!k.isDefault && (
                    <button
                      type="button"
                      onClick={() => handleSetDefault(k.id)}
                      className="btn-secondary"
                      style={{ padding: '2px 7px', fontSize: '10px' }}
                    >
                      <CheckCircle2 size={10} /> Set Default
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRevoke(k.id, k.label)}
                    className="btn-secondary"
                    style={{ padding: '2px 7px', fontSize: '10px', color: 'var(--color-destructive)' }}
                    title="Cabut & Nonaktifkan API Key"
                  >
                    <Trash2 size={10} /> Cabut
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add New Key Form */}
      {isConnected && showAddForm && (
        <form
          onSubmit={handleAddKey}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            padding: '10px',
            borderRadius: '8px',
            backgroundColor: 'var(--color-surface-subtle)',
            border: '1px solid var(--color-border)',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (mis. Bankr Base Utama)"
              className="input"
              style={{ padding: '7px 10px', fontSize: '11px' }}
              required
            />
            <select
              value={chainScope}
              onChange={(e) => setChainScope(e.target.value as any)}
              className="input"
              style={{ padding: '7px 10px', fontSize: '11px' }}
            >
              <option value="all">Semua Chain EVM (Base/RH/Arb/Arc)</option>
              <option value="base">Khusus Base L2</option>
              <option value="robinhood">Khusus Robinhood Chain</option>
              <option value="arbitrum">Khusus Arbitrum One</option>
              <option value="arc">Khusus Arc Network</option>
            </select>
          </div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Tempel Bankr API Key (Jangan pernah masukkan Private Key / Seed Phrase!)"
            className="input"
            style={{ padding: '7px 10px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
            autoComplete="off"
            required
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
              🔒 Dienkripsi AES-256-GCM sebelum disimpan. Sistem otomatis menolak input berbentuk private key wallet.
            </span>
            <button
              type="submit"
              disabled={saving || loading}
              className="btn-primary"
              style={{ padding: '6px 12px', fontSize: '11px' }}
            >
              {saving ? 'Mengenkripsi...' : 'Simpan ke Vault'}
            </button>
          </div>
        </form>
      )}

      {feedback && (
        <div
          style={{
            marginTop: '8px',
            padding: '6px 10px',
            borderRadius: '6px',
            fontSize: '11px',
            backgroundColor: feedback.startsWith('✅') ? 'var(--color-badge-success-bg)' : 'var(--color-badge-warning-bg)',
            color: feedback.startsWith('✅') ? 'var(--color-badge-success-text)' : 'var(--color-badge-warning-text)',
            border: `1px solid ${feedback.startsWith('✅') ? 'var(--color-badge-success-border)' : 'var(--color-badge-warning-border)'}`,
          }}
        >
          {feedback}
        </div>
      )}
    </div>
  );
}
