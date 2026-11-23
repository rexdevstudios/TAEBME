'use client';

import React, { useEffect, useState } from 'react';
import { Bot, Lock, ShieldCheck, Sparkles } from 'lucide-react';

interface AutoPilotApiPayload {
  planId: 'FREE' | 'CREATOR' | 'TRADER' | 'AGENT';
  eligible: boolean;
  capacities: {
    autoPilotEnabled: boolean;
    maxAutoPilotStrategies: number;
    autoPilotRails: Array<'CEX_AUTO' | 'DEX_SESSION'>;
    maxAutoPilotOrderUsd: number;
  };
  config: {
    enabled: boolean;
    rail: 'CEX_AUTO' | 'DEX_SESSION';
    maxOrderUsd: number;
    takeProfitPct: number;
    stopLossPct: number;
    minConfidenceScore: number;
    allowedSymbols: string[];
    updatedAt?: string;
  };
  upgradeUrl?: string | null;
}

interface AutoPilotControlPanelProps {
  isConnected: boolean;
}

export function AutoPilotControlPanel({ isConnected }: AutoPilotControlPanelProps) {
  const [data, setData] = useState<AutoPilotApiPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simReport, setSimReport] = useState<any>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [rail, setRail] = useState<'CEX_AUTO' | 'DEX_SESSION'>('CEX_AUTO');
  const [maxOrderUsd, setMaxOrderUsd] = useState(100);
  const [takeProfitPct, setTakeProfitPct] = useState(12);
  const [stopLossPct, setStopLossPct] = useState(5);
  const [minConfidenceScore, setMinConfidenceScore] = useState(75);
  const [symbolsText, setSymbolsText] = useState('BTCUSDT, ETHUSDT');

  useEffect(() => {
    if (!isConnected) {
      setData(null);
      return;
    }
    setLoading(true);
    fetch('/api/agent/autopilot', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((json) => {
        if (json?.success && json.data) {
          const payload = json.data as AutoPilotApiPayload;
          setData(payload);
          setEnabled(Boolean(payload.config?.enabled));
          setRail(payload.config?.rail === 'DEX_SESSION' ? 'DEX_SESSION' : 'CEX_AUTO');
          setMaxOrderUsd(Number(payload.config?.maxOrderUsd || 100));
          setTakeProfitPct(Number(payload.config?.takeProfitPct || 12));
          setStopLossPct(Number(payload.config?.stopLossPct || 5));
          setMinConfidenceScore(Number(payload.config?.minConfidenceScore || 75));
          setSymbolsText((payload.config?.allowedSymbols || ['BTCUSDT', 'ETHUSDT']).join(', '));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isConnected]);

  if (!isConnected) return null;

  const handleSave = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/agent/autopilot', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          rail,
          maxOrderUsd,
          takeProfitPct,
          stopLossPct,
          minConfidenceScore,
          allowedSymbols: symbolsText,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`⚠️ ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      setData((prev) => (prev ? { ...prev, config: json.data.config } : prev));
      setFeedback(
        `✅ Auto-Pilot ${json.data.config.enabled ? 'AKTIF' : 'PAUSED'} tersimpan (${json.data.config.rail} · Max $${json.data.config.maxOrderUsd} · TP ${json.data.config.takeProfitPct}% / SL ${json.data.config.stopLossPct}%).`
      );
    } catch (err: any) {
      setFeedback(`⚠️ ${err?.message || 'Gagal menyimpan konfigurasi Auto-Pilot.'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSimulateCycle = async () => {
    setSimulating(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/agent/autopilot/simulate', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setFeedback(`⚠️ ${json?.error || `HTTP ${res.status}`}`);
        return;
      }
      setSimReport(json.data);
    } catch (err: any) {
      setFeedback(`⚠️ ${err?.message || 'Gagal menjalankan simulasi siklus Auto-Pilot.'}`);
    } finally {
      setSimulating(false);
    }
  };

  return (
    <div
      className="bg-panel"
      style={{
        borderRadius: '10px',
        padding: '20px',
        border: '1px solid var(--color-border)',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 800, color: 'var(--color-foreground)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Bot size={18} style={{ color: '#38BDF8' }} /> AI Autonomous Trading Auto-Pilot (Auto-Buy &amp; TP/SL)
        </h2>
        <span
          style={{
            fontSize: '10px',
            fontWeight: 800,
            padding: '3px 8px',
            borderRadius: '999px',
            background: data?.eligible ? 'rgba(16, 185, 129, 0.14)' : 'rgba(245, 158, 11, 0.14)',
            color: data?.eligible ? '#34D399' : '#FBBF24',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {loading ? 'CHECKING TIER...' : data?.eligible ? `UNLOCKED · ${data.planId}` : `LOCKED · ${data?.planId || 'FREE'}`}
        </span>
      </div>

      {!loading && data && !data.eligible ? (
        <div
          style={{
            padding: '14px',
            borderRadius: '8px',
            border: '1px solid rgba(245, 158, 11, 0.35)',
            background: 'rgba(245, 158, 11, 0.08)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '680px' }}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: '#FDE047', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Lock size={14} /> Eksklusif Pro Terminal Trader (TRADER) &amp; AI Autonomous Desk (AGENT)
            </div>
            <div className="text-muted" style={{ fontSize: '12px' }}>
              Aktifkan AI Auto-Pilot untuk mencari sinyal pasar otomatis, eksekusi beli terproteksi Risk Gate, serta pemantauan Take Profit / Stop Loss otomatis.
              <strong> TRADER:</strong> 2 strategi CEX Auto (maks $500/order) · <strong>AGENT:</strong> 5 strategi CEX &amp; DEX Session (maks $2,500/order).
            </div>
          </div>
          <a
            href="/billing"
            className="btn-primary"
            style={{ padding: '8px 14px', fontSize: '12px', fontWeight: 800, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <Sparkles size={13} /> Upgrade di /billing →
          </a>
        </div>
      ) : data?.eligible ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className="grid-4" style={{ gap: '10px' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700 }}>
              Status Auto-Pilot
              <select
                value={enabled ? 'ON' : 'OFF'}
                onChange={(e) => setEnabled(e.target.value === 'ON')}
                className="input"
                style={{ padding: '8px', fontSize: '12px' }}
              >
                <option value="OFF">PAUSED (Advisory Only)</option>
                <option value="ON">ACTIVE (Auto-Buy &amp; TP/SL)</option>
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700 }}>
              Execution Rail
              <select
                value={rail}
                onChange={(e) => setRail(e.target.value as 'CEX_AUTO' | 'DEX_SESSION')}
                className="input"
                style={{ padding: '8px', fontSize: '12px' }}
              >
                <option value="CEX_AUTO">CEX Auto (Binance / Bybit)</option>
                {data.capacities.autoPilotRails.includes('DEX_SESSION') && (
                  <option value="DEX_SESSION">DEX Session (0x v2 · AGENT)</option>
                )}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700 }}>
              Max Order USD (Cap ${data.capacities.maxAutoPilotOrderUsd})
              <input
                type="number"
                min={10}
                max={data.capacities.maxAutoPilotOrderUsd}
                value={maxOrderUsd}
                onChange={(e) => setMaxOrderUsd(Number(e.target.value))}
                className="input"
                style={{ padding: '8px', fontSize: '12px' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700 }}>
              Min AI Confidence (55–95)
              <input
                type="number"
                min={55}
                max={95}
                value={minConfidenceScore}
                onChange={(e) => setMinConfidenceScore(Number(e.target.value))}
                className="input"
                style={{ padding: '8px', fontSize: '12px' }}
              />
            </label>
          </div>

          <div className="grid-3" style={{ gap: '10px' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700 }}>
              Take Profit (%)
              <input
                type="number"
                step="0.5"
                min={1}
                max={200}
                value={takeProfitPct}
                onChange={(e) => setTakeProfitPct(Number(e.target.value))}
                className="input"
                style={{ padding: '8px', fontSize: '12px' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700 }}>
              Stop Loss (%)
              <input
                type="number"
                step="0.5"
                min={0.5}
                max={50}
                value={stopLossPct}
                onChange={(e) => setStopLossPct(Number(e.target.value))}
                className="input"
                style={{ padding: '8px', fontSize: '12px' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', fontWeight: 700 }}>
              Allowed Symbols (comma-separated)
              <input
                type="text"
                value={symbolsText}
                onChange={(e) => setSymbolsText(e.target.value)}
                className="input"
                style={{ padding: '8px', fontSize: '12px' }}
              />
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <span className="text-muted" style={{ fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <ShieldCheck size={12} style={{ color: '#10B981' }} /> 100% Non-Custodial · Tunduk pada Risk Gate &amp; Global Kill-Switch
            </span>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={handleSimulateCycle}
                disabled={simulating}
                className="btn-secondary"
                style={{ padding: '8px 12px', fontSize: '12px', fontWeight: 700 }}
              >
                {simulating ? 'Mensimulasi...' : 'Simulasi Siklus Auto-Pilot'}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="btn-primary"
                style={{ padding: '8px 14px', fontSize: '12px', fontWeight: 800 }}
              >
                {saving ? 'Menyimpan...' : 'Simpan Konfigurasi Auto-Pilot'}
              </button>
            </div>
          </div>

          {simReport && (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid var(--color-border)',
                background: 'rgba(56, 189, 248, 0.06)',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
              }}
            >
              <div style={{ fontWeight: 800, color: '#38BDF8' }}>
                Dry-Run Cycle ({simReport.rail} · Kill-Switch: {simReport.killSwitchActive ? 'ACTIVE' : 'CLEAR'})
              </div>
              <div>
                BUY Ready: <strong>{simReport.summary?.buyReadyCount ?? 0}</strong> · TP Sell:{' '}
                <strong style={{ color: '#34D399' }}>{simReport.summary?.tpSellCount ?? 0}</strong> · SL Sell:{' '}
                <strong style={{ color: '#F28B82' }}>{simReport.summary?.slSellCount ?? 0}</strong> · Skipped:{' '}
                <strong>{simReport.summary?.skippedCount ?? 0}</strong>
              </div>
            </div>
          )}

          {feedback && (
            <div style={{ fontSize: '11px', fontWeight: 700, color: feedback.startsWith('✅') ? '#34D399' : '#FBBF24' }}>
              {feedback}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
