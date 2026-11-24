'use client';

import React, { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, Plus, Trash2, Lock, Activity, AlertTriangle } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

interface BybitKeyItem {
  id: string;
  label: string;
  maskedKey: string;
  chainScope: string;
  isDefault: boolean;
  lastUsedAt: string | null;
  quotaStatus?: 'ACTIVE' | 'FROZEN_OVER_QUOTA' | 'FROZEN_MAINNET_LOCKED';
}

interface BybitKeyVaultPanelProps {
  isConnected: boolean;
  selectedKeyId?: string;
  onSelectKeyId?: (keyId: string) => void;
}

export function BybitKeyVaultPanel({
  isConnected,
  selectedKeyId = 'DEFAULT',
  onSelectKeyId,
}: BybitKeyVaultPanelProps) {
  const { tr } = useLocale();
  const [keys, setKeys] = useState<BybitKeyItem[]>([]);
  const [maxKeys, setMaxKeys] = useState<number>(1);
  const [planId, setPlanId] = useState<string>('FREE');
  const [showAdd, setShowAdd] = useState<boolean>(false);
  const [label, setLabel] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [secretKey, setSecretKey] = useState<string>('');
  const [environment, setEnvironment] = useState<'testnet' | 'mainnet'>('testnet');
  const [confirmNoWithdraw, setConfirmNoWithdraw] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [pingingId, setPingingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadKeys = async () => {
    if (!isConnected) return;
    try {
      const res = await fetch('/api/user/provider-keys?provider=BYBIT');
      const json = await res.json();
      if (json?.success && json.data) {
        setKeys(json.data.keys || []);
        setMaxKeys(Number(json.data.maxKeys ?? 1));
        setPlanId(json.data.planId || 'FREE');
      }
    } catch {
      // Non-blocking
    }
  };

  useEffect(() => {
    loadKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !apiKey.trim() || !secretKey.trim()) return;
    if (!confirmNoWithdraw) {
      setFeedback('Notice: Harap konfirmasi bahwa izin Withdrawals NONAKTIF pada API Key Bybit Anda.');
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/user/provider-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'BYBIT',
          label: label.trim(),
          apiKey: `${apiKey.trim()}:${secretKey.trim()}`,
          chainScope: environment,
          isDefault: keys.length === 0,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`Notice: ${json?.error || 'Gagal menyimpan API Key Bybit'}`);
      } else {
        setLabel('');
        setApiKey('');
        setSecretKey('');
        setShowAdd(false);
        setFeedback(`OK: Akun Bybit "${json.data.label}" (${json.data.maskedKey}) dienkripsi AES-256-GCM.`);
        await loadKeys();
      }
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Network error'}`);
    } finally {
      setSaving(false);
    }
  };

  const handlePing = async (item: BybitKeyItem) => {
    setPingingId(item.id);
    setFeedback(null);
    try {
      const res = await fetch('/api/user/provider-keys/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyId: item.id, provider: 'BYBIT' }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`Notice: Ping Bybit "${item.label}" gagal: ${json?.error || `HTTP ${res.status}`}`);
      } else if (json.data?.connected) {
        const warn = json.data?.canWithdraw
          ? ' Notice: PERINGATAN: Withdraw aktif di Bybit — segera nonaktifkan!'
          : ' · No-Withdrawal Verified';
        setFeedback(
          `OK: Bybit "${item.label}" (${json.data.environment}) terhubung (${json.data.latencyMs}ms · canTrade=${json.data.canTrade}${warn})`
        );
        await loadKeys();
      } else {
        setFeedback(`Notice: Bybit "${item.label}" ditolak: ${json.data?.error || 'Auth failed'} (${json.data?.latencyMs ?? 0}ms).`);
      }
    } catch (err: any) {
      setFeedback(`Notice: ${err?.message || 'Network error'}`);
    } finally {
      setPingingId(null);
    }
  };

  const handleRevoke = async (keyId: string) => {
    await fetch(`/api/user/provider-keys?keyId=${encodeURIComponent(keyId)}`, { method: 'DELETE' });
    await loadKeys();
  };

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '14px 16px',
        marginTop: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <KeyRound size={14} style={{ color: '#F59E0B' }} />
          <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)' }}>
            Bybit V5 CEX Vault ({keys.length}/{maxKeys} · {planId})
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
            V5 HMAC-SHA256 · No-Withdrawal Guard
          </span>
        </div>

        {isConnected && (
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="btn-secondary"
            style={{ padding: '4px 8px', fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            <Plus size={12} /> {showAdd ? tr('Close', 'Tutup') : tr('Add Bybit Key', 'Tambah Bybit Key')}
          </button>
        )}
      </div>

      {!isConnected ? (
        <div style={{ fontSize: '11px', color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Lock size={12} /> {tr('Connect wallet (SIWE) to store & verify Bybit V5 API keys (Testnet / Mainnet).', 'Hubungkan wallet (SIWE) untuk menyimpan & memverifikasi API Key Bybit V5 (Testnet / Mainnet).')}
        </div>
      ) : (
        <>
          {showAdd && (
            <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr 1fr', gap: '6px' }}>
                <select
                  aria-label="Bybit environment"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value as 'testnet' | 'mainnet')}
                  className="input"
                  style={{ padding: '6px 8px', fontSize: '11px', fontWeight: 700 }}
                >
                  <option value="testnet">TESTNET</option>
                  <option value="mainnet">MAINNET (TRADER+)</option>
                </select>
                <input
                  type="text"
                  placeholder="Label (mis: Bybit Spot 1)"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="input"
                  style={{ padding: '6px 8px', fontSize: '11px' }}
                  required
                />
                <input
                  type="password"
                  placeholder="Bybit API Key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="input"
                  style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                  autoComplete="off"
                  required
                />
                <input
                  type="password"
                  placeholder="Bybit Secret Key"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  className="input"
                  style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                  autoComplete="off"
                  required
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <label style={{ fontSize: '11px', color: 'var(--color-muted)', display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={confirmNoWithdraw}
                    onChange={(e) => setConfirmNoWithdraw(e.target.checked)}
                  />
                  <AlertTriangle size={11} style={{ color: '#F59E0B' }} /> Saya pastikan izin Withdrawals NONAKTIF (Read + Spot/Contract Trade only).
                </label>
                <button type="submit" disabled={saving} className="btn-primary" style={{ padding: '6px 12px', fontSize: '11px' }}>
                  {saving ? 'Menyimpan...' : 'Simpan Bybit Key'}
                </button>
              </div>
            </form>
          )}

          {keys.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {keys.map((k) => {
                const isSelected =
                  selectedKeyId === k.id || (selectedKeyId === 'DEFAULT' && k.isDefault);
                const isFrozen =
                  k.quotaStatus === 'FROZEN_OVER_QUOTA' || k.quotaStatus === 'FROZEN_MAINNET_LOCKED';
                return (
                  <div
                    key={k.id}
                    onClick={() => !isFrozen && onSelectKeyId?.(k.id)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '4px 8px',
                      borderRadius: '6px',
                      border: isSelected ? '1px solid #F59E0B' : '1px solid var(--color-border)',
                      background: isSelected ? 'rgba(245, 158, 11, 0.10)' : 'transparent',
                      fontSize: '11px',
                      cursor: onSelectKeyId && !isFrozen ? 'pointer' : 'default',
                      opacity: isFrozen ? 0.65 : 1,
                    }}
                  >
                    <strong>{k.label}</strong>
                    <span style={{ fontSize: '9px', fontWeight: 800, color: k.chainScope === 'mainnet' ? '#F59E0B' : 'var(--color-accent-info)' }}>
                      {(k.chainScope || 'testnet').toUpperCase()}
                    </span>
                    {k.quotaStatus === 'FROZEN_MAINNET_LOCKED' && (
                      <span style={{ fontSize: '9px', fontWeight: 800, color: '#EF4444' }}>LOCKED</span>
                    )}
                    <code style={{ fontSize: '10px', color: 'var(--color-muted)' }}>{k.maskedKey}</code>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handlePing(k);
                      }}
                      disabled={pingingId === k.id}
                      className="btn-secondary"
                      style={{ padding: '2px 6px', fontSize: '10px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                    >
                      <Activity size={10} /> {pingingId === k.id ? '...' : 'Test V5'}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRevoke(k.id);
                      }}
                      className="btn-destructive"
                      style={{ padding: '2px 5px', fontSize: '10px' }}
                      aria-label={`Revoke ${k.label}`}
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {feedback && (
        <div style={{ fontSize: '11px', color: feedback.startsWith('OK:') ? '#10B981' : '#F59E0B' }}>
          {feedback}
        </div>
      )}
    </div>
  );
}
