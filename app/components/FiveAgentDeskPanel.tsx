'use client';

import React, { useState } from 'react';
import { Radar, Microscope, BrainCircuit, ShieldCheck, Zap, AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface FiveAgentDeskPanelProps {
  isConnected: boolean;
  defaultSymbol: string;
  defaultAction: 'BUY' | 'SELL';
  defaultQty: number;
}

const AGENT_META: Record<string, { color: string; icon: React.ReactNode; subtitle: string }> = {
  SCANNER: { color: '#10B981', icon: <Radar size={15} />, subtitle: 'Finds pairs & macro regime' },
  ANALYST: { color: '#A855F7', icon: <Microscope size={15} />, subtitle: 'Evaluates tokens & risk flags' },
  BRAIN: { color: '#38BDF8', icon: <BrainCircuit size={15} />, subtitle: 'Sizes entries & LLM advisory' },
  RISK: { color: '#F43F5E', icon: <ShieldCheck size={15} />, subtitle: 'Immutable loss & rule guard' },
  EXECUTOR: { color: '#F59E0B', icon: <Zap size={15} />, subtitle: 'Zero-collision execution' },
};

export function FiveAgentDeskPanel({
  isConnected,
  defaultSymbol,
  defaultAction,
  defaultQty,
}: FiveAgentDeskPanelProps) {
  const { refreshSession } = useAuth();
  const [mode, setMode] = useState<'PAPER' | 'LIVE_ADVISORY'>('PAPER');
  const [symbol, setSymbol] = useState(defaultSymbol || 'BTCUSDT');
  const [action, setAction] = useState<'BUY' | 'SELL'>(defaultAction || 'BUY');
  const [quantity, setQuantity] = useState<number>(defaultQty || 100);
  const [maxSlippagePct, setMaxSlippagePct] = useState<number>(1.0);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRunDesk = async () => {
    if (!isConnected) {
      setError('Hubungkan dompet Web3 (SIWE) terlebih dahulu untuk menjalankan 5-Agent Trading Desk.');
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/agent/desk/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, action, quantity, maxSlippagePct, mode }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(`5-Agent Desk (${res.status}): ${json.error || 'Gagal menjalankan siklus desk'}`);
        return;
      }
      setReport(json.data);
      refreshSession().catch(() => {});
    } catch (err: any) {
      setError(`Koneksi gagal: ${err?.message || 'Unknown error'}`);
    } finally {
      setRunning(false);
    }
  };

  const agents = report?.agents || [
    { agent: 'SCANNER', status: 'READY', summary: 'Idle — ready to scan active SSOT launches & macro TVL', elapsedMs: 0 },
    { agent: 'ANALYST', status: 'READY', summary: 'Idle — ready to evaluate FeatureEngine & counterparty flags', elapsedMs: 0 },
    { agent: 'BRAIN', status: 'READY', summary: 'Idle — ready to size proposal + BytePlus/Gemini advisory', elapsedMs: 0 },
    { agent: 'RISK', status: 'READY', summary: 'Immutable Risk Gate & Kill Switch armed', elapsedMs: 0 },
    { agent: 'EXECUTOR', status: 'READY', summary: 'Zero-collision pipeline standing by', elapsedMs: 0 },
  ];

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid rgba(168, 85, 247, 0.45)',
        borderRadius: '10px',
        padding: '20px',
      }}
    >
      {/* Top Telemetry Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 900, color: '#E2E8F0', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <BrainCircuit size={18} color="#A855F7" /> 5-Agent Autonomous Trading Desk (100% Vercel-Native)
          </h2>
          <p className="text-muted" style={{ margin: '2px 0 0 0', fontSize: '11px' }}>
            Scanner → Analyst → Brain (BytePlus/Gemini) → Risk (Immutable) → Executor · One Rule: No agent can modify trading rules.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
          <span style={{ padding: '4px 8px', borderRadius: '4px', backgroundColor: 'rgba(16, 185, 129, 0.14)', color: '#6EE7B7', border: '1px solid rgba(16, 185, 129, 0.35)' }}>
            COLLISIONS: {report ? report.collisions : 0}
          </span>
          <span style={{ padding: '4px 8px', borderRadius: '4px', backgroundColor: 'rgba(244, 63, 94, 0.14)', color: '#FDA4AF', border: '1px solid rgba(244, 63, 94, 0.35)' }}>
            RULES: IMMUTABLE
          </span>
          {report?.llmAdvisory?.provider && (
            <span style={{ padding: '4px 8px', borderRadius: '4px', backgroundColor: 'rgba(56, 189, 248, 0.14)', color: '#7DD3FC', border: '1px solid rgba(56, 189, 248, 0.35)' }}>
              LLM: {report.llmAdvisory.provider}
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '16px' }}>
        <input
          type="text"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="Symbol (BTCUSDT)"
          style={{ width: '120px', padding: '7px 10px', borderRadius: '6px', backgroundColor: '#0B1220', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
        />
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as 'BUY' | 'SELL')}
          style={{ padding: '7px 10px', borderRadius: '6px', backgroundColor: '#0B1220', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px' }}
        >
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>
        <input
          type="number"
          min={1}
          value={quantity}
          onChange={(e) => setQuantity(Number(e.target.value))}
          style={{ width: '95px', padding: '7px 10px', borderRadius: '6px', backgroundColor: '#0B1220', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
        />
        <input
          type="number"
          step={0.1}
          min={0.1}
          max={5}
          value={maxSlippagePct}
          onChange={(e) => setMaxSlippagePct(Number(e.target.value))}
          title="Max Slippage %"
          style={{ width: '80px', padding: '7px 10px', borderRadius: '6px', backgroundColor: '#0B1220', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px', fontFamily: 'var(--font-mono)' }}
        />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as 'PAPER' | 'LIVE_ADVISORY')}
          style={{ padding: '7px 10px', borderRadius: '6px', backgroundColor: '#0B1220', border: '1px solid var(--color-border)', color: 'var(--color-foreground)', fontSize: '12px' }}
        >
          <option value="PAPER">PAPER (Auto-Fill Sim)</option>
          <option value="LIVE_ADVISORY">LIVE (Non-Custodial Handoff)</option>
        </select>
        <button
          type="button"
          className="btn-primary"
          disabled={running}
          onClick={handleRunDesk}
          style={{ fontSize: '12px', padding: '8px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
        >
          <Zap size={13} /> {running ? 'Running 5 Agents...' : 'Run 5-Agent Desk Cycle'}
        </button>
      </div>

      {/* Main Split: 5 Agent Status Cards + READ-BACK Audit Log */}
      <div className="grid-2" style={{ gap: '16px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {agents.map((a: any) => {
            const meta = AGENT_META[a.agent] || { color: '#94A3B8', icon: null, subtitle: '' };
            const statusColor =
              a.status === 'DONE'
                ? '#10B981'
                : a.status === 'BLOCKED'
                ? '#EF4444'
                : a.status === 'WAITING_CONFIRMATION'
                ? '#F59E0B'
                : '#64748B';
            return (
              <div
                key={a.agent}
                style={{
                  backgroundColor: '#0B1220',
                  border: `1px solid ${a.status === 'BLOCKED' ? '#EF4444' : 'var(--color-border)'}`,
                  borderLeft: `3px solid ${meta.color}`,
                  borderRadius: '6px',
                  padding: '10px 12px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 800, color: meta.color, display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    {meta.icon} {a.agent}
                  </span>
                  <span style={{ fontSize: '10px', fontWeight: 800, color: statusColor, fontFamily: 'var(--font-mono)' }}>
                    {a.status} {a.elapsedMs > 0 ? `(${a.elapsedMs}ms)` : ''}
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: '#CBD5E1', lineHeight: 1.4 }}>{a.summary}</div>
              </div>
            );
          })}
        </div>

        {/* Right Column: READ-BACK Log + LLM Advisory + Handoff CTA */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div
            style={{
              backgroundColor: '#070B14',
              border: '1px solid var(--color-border)',
              borderRadius: '6px',
              padding: '12px',
              flex: 1,
              minHeight: '220px',
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
            }}
          >
            <div style={{ color: '#94A3B8', fontWeight: 800, marginBottom: '8px', letterSpacing: '0.06em' }}>
              READ-BACK AUDIT STREAM
            </div>
            {report?.readBackLog?.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {report.readBackLog.map((entry: any) => (
                  <div key={entry.id} style={{ color: entry.ok ? '#A7F3D0' : '#FCA5A5', lineHeight: 1.35 }}>
                    <span style={{ color: '#64748B' }}>{entry.ok ? '✓' : '✕'} {entry.id}</span>{' '}
                    <strong>[{entry.event}]</strong> {entry.detail}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-muted">Jalankan 1 siklus 5-Agent Desk untuk melihat log READ-BACK real-time tanpa kolisi.</div>
            )}
          </div>

          {report?.llmAdvisory && (
            <div
              style={{
                backgroundColor: 'rgba(56, 189, 248, 0.08)',
                border: '1px solid rgba(56, 189, 248, 0.35)',
                borderRadius: '6px',
                padding: '10px 12px',
                fontSize: '11px',
              }}
            >
              <div style={{ fontWeight: 800, color: '#38BDF8', marginBottom: '4px' }}>
                AI Narrative Advisory ({report.llmAdvisory.provider} · Advisory Only)
              </div>
              <div style={{ color: '#E2E8F0', marginBottom: '4px' }}>{report.llmAdvisory.summary}</div>
              <div style={{ color: '#FDE047' }}>⚠ {report.llmAdvisory.caution}</div>
            </div>
          )}

          {report?.execution?.handoffUrl && (
            <a
              href={report.execution.handoffUrl}
              className="btn-primary"
              style={{ fontSize: '12px', padding: '9px 14px', justifyContent: 'center', display: 'inline-flex', alignItems: 'center', gap: '6px', textDecoration: 'none' }}
            >
              <CheckCircle2 size={14} /> Open Approved Plan in Trading Terminal <ArrowRight size={14} />
            </a>
          )}
        </div>
      </div>

      {error && (
        <div style={{ marginTop: '12px', padding: '10px 12px', borderRadius: '6px', backgroundColor: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.35)', color: '#FCA5A5', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={15} /> <span>{error}</span>
        </div>
      )}
    </div>
  );
}
