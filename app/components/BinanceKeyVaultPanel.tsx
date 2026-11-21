'use client';

import React, { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, Plus, Trash2, CheckCircle2, Lock, AlertTriangle } from 'lucide-react';

export interface BinanceAccountMetaItem {
  id: string;
  label: string;
  maskedApiKey: string;
  environment: 'TESTNET' | 'MAINNET';
  permissions: {
    read: boolean;
    trade: boolean;
    withdraw: boolean;
  };
  isDefault: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

interface BinanceKeyVaultPanelProps {
  isConnected: boolean;
  selectedCredentialId: string;
  onSelectCredentialId: (credentialId: string) => void;
}

export function BinanceKeyVaultPanel({
  isConnected,
  selectedCredentialId,
  onSelectCredentialId,
}: BinanceKeyVaultPanelProps) {
  const [accounts, setAccounts] = useState<BinanceAccountMetaItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [label, setLabel] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [secretKey, setSecretKey] = useState<string>('');
  const [environment, setEnvironment] = useState<'TESTNET' | 'MAINNET'>('TESTNET');
  const [confirmNoWithdraw, setConfirmNoWithdraw] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const fetchAccounts = async () => {
    if (!isConnected) return;
    setLoading(true);
    try {
      const res = await fetch('/api/user/binance-credentials');
      const json = await res.json();
      if (json?.success && Array.isArray(json.data?.accounts)) {
        const list: BinanceAccountMetaItem[] = json.data.accounts;
        setAccounts(list);
        const def = list.find((a) => a.isDefault) || list[0];
        if (def && (!selectedCredentialId || selectedCredentialId === 'DEFAULT')) {
          onSelectCredentialId(def.id);
        }
      }
    } catch {
      // Non-blocking
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !apiKey.trim() || !secretKey.trim()) return;
    if (!confirmNoWithdraw) {
      setFeedback('⚠️ Harap konfirmasi bahwa izin Enable Withdrawals NONAKTIF pada API Key Binance Anda.');
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/user/binance-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: label.trim(),
          apiKey: apiKey.trim(),
          secretKey: secretKey.trim(),
          environment,
          permissions: { read: true, trade: true, withdraw: false },
          isDefault: accounts.length === 0,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`⚠️ ${json?.error || 'Gagal menyimpan kredensial Binance'}`);
      } else {
        setLabel('');
        setApiKey('');
        setSecretKey('');
        setShowAddForm(false);
        setFeedback(`✅ Akun "${json.data.label}" (${json.data.maskedApiKey}) berhasil dienkripsi AES-256-GCM.`);
        await fetchAccounts();
        if (json.data?.id) {
          onSelectCredentialId(json.data.id);
        }
      }
    } catch (err: any) {
      setFeedback(`⚠️ ${err?.message || 'Network error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSetDefault = async (credentialId: string) => {
    setFeedback(null);
    try {
      const res = await fetch('/api/user/binance-credentials', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialId }),
      });
      if (res.ok) {
        onSelectCredentialId(credentialId);
        await fetchAccounts();
      }
    } catch {
      // Ignore
    }
  };

  const handleRevoke = async (credentialId: string) => {
    setFeedback(null);
    try {
      const res = await fetch(`/api/user/binance-credentials?credentialId=${encodeURIComponent(credentialId)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        if (selectedCredentialId === credentialId) {
          onSelectCredentialId('DEFAULT');
        }
        setFeedback('🗑️ Akun Binance berhasil dicabut dari vault.');
        await fetchAccounts();
      }
    } catch {
      // Ignore
    }
  };

  return (
    <div
      style={{
        padding: '12px',
        borderRadius: '10px',
        border: '1px solid var(--color-border)',
        background: 'rgba(15, 23, 42, 0.04)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        marginBottom: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <KeyRound size={14} style={{ color: '#F59E0B' }} />
          <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)' }}>
            Binance Multi-Account Vault ({accounts.length}/10)
          </span>
        </div>
        {isConnected && (
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            className="btn-secondary"
            style={{ padding: '4px 8px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            <Plus size={12} /> {showAddForm ? 'Tutup' : 'Tambah Akun'}
          </button>
        )}
      </div>

      <div
        style={{
          fontSize: '11px',
          color: 'var(--color-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          lineHeight: 1.4,
        }}
      >
        <ShieldCheck size={13} style={{ color: '#10B981', flexShrink: 0 }} />
        <span>
          AES-256-GCM Write-Only · <strong>No-Withdrawal Guard</strong> (izin tarik dana ditolak keras, private key dompet dilarang).
        </span>
      </div>

      {!isConnected ? (
        <div style={{ fontSize: '11px', color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Lock size={12} /> Hubungkan wallet (SIWE) untuk mengelola beberapa akun API Binance Anda.
        </div>
      ) : (
        <>
          {accounts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-muted)' }}>
                Akun Binance Aktif untuk Order CEX:
              </label>
              <select
                aria-label="Select Binance account"
                value={selectedCredentialId}
                onChange={(e) => onSelectCredentialId(e.target.value)}
                className="input"
                style={{ width: '100%', padding: '6px 8px', fontSize: '11px', fontWeight: 700 }}
              >
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.label} ({acc.maskedApiKey}) — {acc.environment} {acc.isDefault ? '★ Default' : ''}
                  </option>
                ))}
              </select>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '4px' }}>
                {accounts.map((acc) => (
                  <div
                    key={acc.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '6px 8px',
                      borderRadius: '6px',
                      border: '1px solid var(--color-border)',
                      fontSize: '11px',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                        <strong style={{ color: 'var(--color-foreground)' }}>{acc.label}</strong>
                        <span
                          style={{
                            fontSize: '9px',
                            fontWeight: 800,
                            padding: '1px 5px',
                            borderRadius: '4px',
                            background: acc.environment === 'MAINNET' ? 'rgba(245,158,11,0.16)' : 'rgba(56,189,248,0.16)',
                            color: acc.environment === 'MAINNET' ? '#F59E0B' : '#38BDF8',
                          }}
                        >
                          {acc.environment}
                        </span>
                        <span
                          style={{
                            fontSize: '9px',
                            fontWeight: 800,
                            padding: '1px 5px',
                            borderRadius: '4px',
                            background: 'rgba(16,185,129,0.14)',
                            color: '#10B981',
                          }}
                        >
                          NO-WITHDRAW
                        </span>
                      </div>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--color-muted)' }}>
                        {acc.maskedApiKey}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                      {!acc.isDefault ? (
                        <button
                          type="button"
                          onClick={() => handleSetDefault(acc.id)}
                          className="btn-secondary"
                          style={{ padding: '3px 6px', fontSize: '10px' }}
                          title="Jadikan akun default"
                        >
                          Set Default
                        </button>
                      ) : (
                        <span style={{ color: '#10B981', display: 'inline-flex', alignItems: 'center', gap: '2px', fontSize: '10px', fontWeight: 700 }}>
                          <CheckCircle2 size={11} /> Default
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRevoke(acc.id)}
                        className="btn-destructive"
                        style={{ padding: '3px 6px', fontSize: '10px' }}
                        title="Cabut kredensial"
                        aria-label={`Revoke ${acc.label}`}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {accounts.length === 0 && !loading && !showAddForm && (
            <div style={{ fontSize: '11px', color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <AlertTriangle size={12} style={{ color: '#F59E0B', flexShrink: 0 }} />
              <span>Belum ada akun Binance tersimpan. Klik <strong>Tambah Akun</strong> untuk menghubungkan API Key Trade-Only Anda.</span>
            </div>
          )}

          {showAddForm && (
            <form onSubmit={handleAddAccount} style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: '6px' }}>
                <input
                  type="text"
                  placeholder="Label Akun (mis: Binance Scalping)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="input"
                  style={{ padding: '6px 8px', fontSize: '11px' }}
                  required
                />
                <select
                  aria-label="Binance environment"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value as 'TESTNET' | 'MAINNET')}
                  className="input"
                  style={{ padding: '6px 8px', fontSize: '11px', fontWeight: 700 }}
                >
                  <option value="TESTNET">TESTNET</option>
                  <option value="MAINNET">MAINNET</option>
                </select>
              </div>
              <input
                type="password"
                placeholder="Binance API Key (Read + Spot Trade Only)"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                autoComplete="off"
                required
              />
              <input
                type="password"
                placeholder="Binance API Secret Key"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                className="input"
                style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                autoComplete="off"
                required
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--color-muted)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={confirmNoWithdraw}
                  onChange={(e) => setConfirmNoWithdraw(e.target.checked)}
                />
                <span>Saya pastikan <strong>Enable Withdrawals = OFF</strong> pada API Key ini.</span>
              </label>
              <button
                type="submit"
                disabled={saving}
                className="btn-primary"
                style={{ padding: '6px 10px', fontSize: '11px', justifyContent: 'center' }}
              >
                {saving ? 'Mengenkripsi...' : 'Simpan & Enkripsi Akun Binance'}
              </button>
            </form>
          )}
        </>
      )}

      {feedback && (
        <div
          style={{
            fontSize: '11px',
            padding: '6px 8px',
            borderRadius: '6px',
            border: '1px solid var(--color-border)',
            color: feedback.startsWith('✅') ? '#10B981' : '#F59E0B',
          }}
        >
          {feedback}
        </div>
      )}
    </div>
  );
}
