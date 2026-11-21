'use client';

import React, { useEffect, useState } from 'react';
import { ShieldCheck, Sliders, Lock } from 'lucide-react';

interface UserRiskPolicyPanelProps {
  isConnected: boolean;
}

export function UserRiskPolicyPanel({ isConnected }: UserRiskPolicyPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [planId, setPlanId] = useState('FREE');
  const [ceiling, setCeiling] = useState({ maxOrderValueUsd: 250, maxDailyLossUsd: 50, maxSlippagePct: 3.0 });
  const [maxOrder, setMaxOrder] = useState<number>(250);
  const [maxDailyLoss, setMaxDailyLoss] = useState<number>(50);
  const [maxSlippage, setMaxSlippage] = useState<number>(1.5);
  const [allowedSymbolsText, setAllowedSymbolsText] = useState<string>('');
  const [exposure24h, setExposure24h] = useState<{ currentDailyLossUsd: number; currentOpenPositions: number; maxOpenPositions: number }>({
    currentDailyLossUsd: 0,
    currentOpenPositions: 0,
    maxOpenPositions: 5,
  });
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadPolicy = async () => {
    if (!isConnected) return;
    try {
      const res = await fetch('/api/user/risk-policy');
      const json = await res.json();
      if (json?.success && json.data) {
        setPlanId(json.data.planId || 'FREE');
        if (json.data.tierCeiling) {
          setCeiling(json.data.tierCeiling);
        }
        const eff = json.data.effectiveLimits;
        if (eff) {
          setMaxOrder(eff.maxOrderValueUsd);
          setMaxDailyLoss(eff.maxDailyLossUsd);
          setMaxSlippage(eff.maxSlippagePct);
          setAllowedSymbolsText(Array.isArray(eff.allowedSymbols) ? eff.allowedSymbols.join(', ') : '');
        }
        if (json.data.exposure24h) {
          setExposure24h({
            currentDailyLossUsd: Number(json.data.exposure24h.currentDailyLossUsd || 0),
            currentOpenPositions: Number(json.data.exposure24h.currentOpenPositions || 0),
            maxOpenPositions: Number(json.data.exposure24h.maxOpenPositions || 5),
          });
        }
      }
    } catch {
      // Non-blocking
    }
  };

  useEffect(() => {
    loadPolicy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/user/risk-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxOrderValueUsd: maxOrder,
          maxDailyLossUsd: maxDailyLoss,
          maxSlippagePct: maxSlippage,
          allowedSymbols: allowedSymbolsText,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`⚠️ ${json?.error || 'Gagal menyimpan batas risiko'}`);
      } else {
        const eff = json.data.effectiveLimits;
        setMaxOrder(eff.maxOrderValueUsd);
        setMaxDailyLoss(eff.maxDailyLossUsd);
        setMaxSlippage(eff.maxSlippagePct);
        setAllowedSymbolsText(Array.isArray(eff.allowedSymbols) ? eff.allowedSymbols.join(', ') : '');
        setFeedback(`✅ Batas risiko aktif: Max Order $${eff.maxOrderValueUsd} · Daily Loss $${eff.maxDailyLossUsd} · Slippage ${eff.maxSlippagePct}%`);
      }
    } catch (err: any) {
      setFeedback(`⚠️ ${err?.message || 'Network error'}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: '10px',
        border: '1px solid var(--color-border)',
        background: 'rgba(15, 23, 42, 0.03)',
        marginBottom: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Sliders size={13} style={{ color: '#38BDF8' }} />
          <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--color-foreground)' }}>
            Personal Risk Guard ({planId})
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="btn-secondary"
          style={{ padding: '3px 8px', fontSize: '10px' }}
        >
          {expanded ? 'Tutup' : 'Atur Batas'}
        </button>
      </div>

      <div style={{ fontSize: '10px', color: 'var(--color-muted)', marginTop: '4px', fontFamily: 'var(--font-mono)' }}>
        <ShieldCheck size={11} style={{ display: 'inline', marginRight: '4px', color: '#10B981', verticalAlign: 'middle' }} />
        Aktif: Order ≤ ${maxOrder.toLocaleString()} · Daily Loss ≤ ${maxDailyLoss.toLocaleString()} · Slippage ≤ {maxSlippage}%
      </div>
      {isConnected && (
        <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>
            <span>
              24h Loss Used:{' '}
              <strong style={{ color: maxDailyLoss > 0 && exposure24h.currentDailyLossUsd / maxDailyLoss >= 0.8 ? '#EF4444' : 'var(--color-foreground)' }}>
                ${exposure24h.currentDailyLossUsd.toLocaleString()} / ${maxDailyLoss.toLocaleString()}
              </strong>
            </span>
            <span>
              Open Intents: <strong style={{ color: 'var(--color-foreground)' }}>{exposure24h.currentOpenPositions}/{exposure24h.maxOpenPositions}</strong>
            </span>
          </div>
          <div style={{ width: '100%', height: '4px', borderRadius: '999px', background: 'rgba(148, 163, 184, 0.2)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.min(100, maxDailyLoss > 0 ? Math.round((exposure24h.currentDailyLossUsd / maxDailyLoss) * 100) : 0)}%`,
                height: '100%',
                background:
                  maxDailyLoss > 0 && exposure24h.currentDailyLossUsd / maxDailyLoss >= 0.8
                    ? '#EF4444'
                    : maxDailyLoss > 0 && exposure24h.currentDailyLossUsd / maxDailyLoss >= 0.5
                    ? '#F59E0B'
                    : '#10B981',
                transition: 'width 200ms ease',
              }}
            />
          </div>
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: '10px' }}>
          {!isConnected ? (
            <div style={{ fontSize: '11px', color: 'var(--color-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Lock size={12} /> Hubungkan wallet (SIWE) untuk menyesuaikan batas risiko pribadi Anda.
            </div>
          ) : (
            <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
                Plafon paket <strong>{planId}</strong>: Max Order ${ceiling.maxOrderValueUsd.toLocaleString()} · Daily Loss ${ceiling.maxDailyLossUsd.toLocaleString()} · Slippage {ceiling.maxSlippagePct}%.{' '}
                <a href="/billing" style={{ color: '#38BDF8', textDecoration: 'underline' }}>Upgrade →</a>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                <div>
                  <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>Max Order ($)</label>
                  <input
                    type="number"
                    min={1}
                    max={ceiling.maxOrderValueUsd}
                    value={maxOrder}
                    onChange={(e) => setMaxOrder(Number(e.target.value) || 1)}
                    className="input"
                    style={{ width: '100%', padding: '5px 7px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>Daily Loss ($)</label>
                  <input
                    type="number"
                    min={1}
                    max={ceiling.maxDailyLossUsd}
                    value={maxDailyLoss}
                    onChange={(e) => setMaxDailyLoss(Number(e.target.value) || 1)}
                    className="input"
                    style={{ width: '100%', padding: '5px 7px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>Slippage (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    min={0.1}
                    max={ceiling.maxSlippagePct}
                    value={maxSlippage}
                    onChange={(e) => setMaxSlippage(Number(e.target.value) || 0.5)}
                    className="input"
                    style={{ width: '100%', padding: '5px 7px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                  />
                </div>
              </div>
              <div>
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>
                  Whitelist Pair Opsional (kosongkan untuk semua pair, cth: BTCUSDT, ETHUSDT)
                </label>
                <input
                  type="text"
                  placeholder="BTCUSDT, ETHUSDT, SOLUSDT"
                  value={allowedSymbolsText}
                  onChange={(e) => setAllowedSymbolsText(e.target.value)}
                  className="input"
                  style={{ width: '100%', padding: '5px 7px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <button
                type="submit"
                disabled={saving}
                className="btn-primary"
                style={{ padding: '6px 10px', fontSize: '11px', justifyContent: 'center' }}
              >
                {saving ? 'Menyimpan...' : 'Simpan Batas Risiko Pribadi'}
              </button>
            </form>
          )}
          {feedback && (
            <div style={{ marginTop: '6px', fontSize: '11px', color: feedback.startsWith('✅') ? '#10B981' : '#F59E0B' }}>
              {feedback}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
