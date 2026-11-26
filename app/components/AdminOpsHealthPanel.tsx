'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Database, ShieldAlert, RefreshCw, Users, Lock } from 'lucide-react';

interface OpsSummaryData {
  database: { connected: boolean };
  redis: { configured: boolean };
  killSwitches: { activeCount: number; scopes: string[] };
  tradeIntents24h: {
    total: number;
    approved: number;
    rejected: number;
    executed: number;
  };
  subscriptionsByPlan: Record<string, number>;
  autoPilot?: {
    activeWalletsCount: number;
    lastPulseAt: string | null;
  };
  aiEngine?: {
    configured: boolean;
    primaryProvider: string;
    fastPoolSize: number;
    deepPoolSize: number;
    imagePoolSize: number;
    infoQuestEnabled: boolean;
    geminiFallbackConfigured: boolean;
  };
  executionPlane?: {
    workerOnline: boolean;
    mode?: 'CLOUDFLARE_CRON' | 'VPS_WORKER' | 'STANDBY';
    pendingExecutionCount: number;
    staleUnexecutableCount?: number;
    lastExecutedAt: string | null;
    lastPulseAt?: string | null;
  };
  preflight?: {
    overallStatus: 'READY' | 'DEGRADED' | 'HALTED';
    passedCount: number;
    totalCount: number;
    checks: Array<{
      id: string;
      label: string;
      status: 'PASS' | 'WARN' | 'FAIL';
      detail: string;
    }>;
  };
}

interface DualControlRequestItem {
  id: string;
  actionType: string;
  requestedBy: string;
  approvedBy?: string;
  payload?: Record<string, unknown>;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'EXECUTED';
  expiresAt: string;
  createdAt: string;
}

export function AdminOpsHealthPanel() {
  const [data, setData] = useState<OpsSummaryData | null>(null);
  const [timestamp, setTimestamp] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Dual-Control Kill-Switch Console (SOP-07 & DOC-01 §3)
  const [showKsConsole, setShowKsConsole] = useState<boolean>(false);
  const [ksAction, setKsAction] = useState<'ACTIVATE' | 'DEACTIVATE'>('ACTIVATE');
  const [ksScope, setKsScope] = useState<'GLOBAL' | 'USER' | 'AGENT' | 'TOKEN'>('GLOBAL');
  const [ksDualControlId, setKsDualControlId] = useState<string>('');
  const [ksReason, setKsReason] = useState<string>('Emergency risk halt');
  const [ksSubmitting, setKsSubmitting] = useState<boolean>(false);
  const [ksFeedback, setKsFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [dcRequests, setDcRequests] = useState<DualControlRequestItem[]>([]);
  const [dcLoading, setDcLoading] = useState<boolean>(false);
  const [dcBusyId, setDcBusyId] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/ops-summary', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        setError(json?.error?.message || `HTTP ${res.status}`);
        return;
      }
      setData(json.data as OpsSummaryData);
      setTimestamp(typeof json.timestamp === 'string' ? json.timestamp : new Date().toISOString());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load ops telemetry');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const loadDualControlRequests = useCallback(async () => {
    setDcLoading(true);
    try {
      const res = await fetch('/api/admin/dual-control?limit=10', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const json = await res.json();
      if (res.ok && json?.success && Array.isArray(json?.data?.requests)) {
        setDcRequests(json.data.requests as DualControlRequestItem[]);
      }
    } catch {
      // Non-blocking
    } finally {
      setDcLoading(false);
    }
  }, []);

  useEffect(() => {
    if (showKsConsole) {
      void loadDualControlRequests();
    }
  }, [showKsConsole, loadDualControlRequests]);

  const handleProposeDualControl = async () => {
    setKsFeedback(null);
    setDcBusyId('PROPOSE');
    try {
      const res = await fetch('/api/admin/dual-control', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'PROPOSE',
          actionType: 'OVERRIDE_RISK',
          scope: ksScope,
          killSwitchAction: ksAction,
          reason: ksReason.trim() || `Dual-control ${ksAction} (${ksScope})`,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        const msg = json?.error?.message || json?.error?.code || `HTTP ${res.status}`;
        setKsFeedback({ ok: false, text: `Propose failed: ${msg}` });
        return;
      }
      const createdId = String(json?.data?.request?.id || '');
      setKsFeedback({
        ok: true,
        text: `OK: Step 1 Selesai: Request PENDING dibuat (#${createdId.slice(0, 8)}…). Minta Admin ke-2 klik Approve.`,
      });
      await loadDualControlRequests();
    } catch (err: unknown) {
      setKsFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to propose dual-control request',
      });
    } finally {
      setDcBusyId(null);
    }
  };

  const handleApproveDualControl = async (requestId: string) => {
    setKsFeedback(null);
    setDcBusyId(requestId);
    try {
      const res = await fetch('/api/admin/dual-control', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'APPROVE',
          requestId,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        const msg = json?.error?.message || json?.error?.code || `HTTP ${res.status}`;
        setKsFeedback({ ok: false, text: `Approve rejected: ${msg}` });
        return;
      }
      setKsDualControlId(requestId);
      setKsFeedback({
        ok: true,
        text: `OK: Step 2 Selesai: Request #${requestId.slice(0, 8)}… APPROVED dan otomatis diisi ke Step 3!`,
      });
      await loadDualControlRequests();
    } catch (err: unknown) {
      setKsFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Failed to approve dual-control request',
      });
    } finally {
      setDcBusyId(null);
    }
  };

  const handleSubmitKillSwitch = async (e: React.FormEvent) => {
    e.preventDefault();
    setKsFeedback(null);
    const trimmedId = ksDualControlId.trim();
    if (!trimmedId) {
      setKsFeedback({
        ok: false,
        text: 'DUAL_CONTROL_REQUIRED: Masukkan Dual-Control Approval Request ID yang telah disetujui.',
      });
      return;
    }
    const confirmed =
      typeof window !== 'undefined'
        ? window.confirm(
            `Konfirmasi ${ksAction} Kill-Switch (${ksScope}) menggunakan Dual-Control ID "${trimmedId}"?`
          )
        : true;
    if (!confirmed) return;

    setKsSubmitting(true);
    try {
      const res = await fetch('/api/admin/kill-switch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: ksAction,
          scope: ksScope,
          dualControlRequestId: trimmedId,
          reason: ksReason.trim() || 'Admin dual-control kill-switch action',
        }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        const msg = json?.error?.message || json?.error?.code || `HTTP ${res.status}`;
        setKsFeedback({ ok: false, text: `Rejected: ${msg}` });
        return;
      }
      setKsFeedback({
        ok: true,
        text: `OK: Kill-Switch ${ksAction} (${ksScope}) sukses · Dual-Control #${json?.data?.dualControlId || trimmedId}`,
      });
      setKsDualControlId('');
      await Promise.all([loadSummary(), loadDualControlRequests()]);
    } catch (err: unknown) {
      setKsFeedback({
        ok: false,
        text: err instanceof Error ? err.message : 'Kill-switch request failed',
      });
    } finally {
      setKsSubmitting(false);
    }
  };

  const planEntries = data ? Object.entries(data.subscriptionsByPlan) : [];
  const totalSubs = planEntries.reduce((acc, [, cnt]) => acc + Number(cnt || 0), 0);

  return (
    <div
      className="bg-panel"
      style={{
        border: '1px solid rgba(0, 229, 255, 0.35)',
        padding: '16px',
        borderRadius: '8px',
        marginBottom: '16px',
        background: 'linear-gradient(135deg, rgba(0, 229, 255, 0.05), rgba(16, 185, 129, 0.04))',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '8px',
          marginBottom: '12px',
        }}
      >
        <div>
          <div
            style={{
              fontWeight: 800,
              fontSize: '13px',
              color: 'var(--color-accent-info)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Activity size={14} /> LIVE OPS TELEMETRY (GET /api/admin/ops-summary)
          </div>
          <div className="text-muted" style={{ fontSize: '11px', marginTop: '2px' }}>
            Read-only PostgreSQL SSOT, Redis cache, Kill-Switch guard &amp; 24h Trade Intents.
            {timestamp ? ` · Synced: ${new Date(timestamp).toLocaleTimeString()}` : ''}
            {data?.autoPilot
              ? ` · 24/7 Auto-Pilot: ${data.autoPilot.activeWalletsCount} active wallets (${
                  data.autoPilot.lastPulseAt
                    ? `last pulse ${new Date(data.autoPilot.lastPulseAt).toLocaleTimeString()}`
                    : 'idle'
                })`
              : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadSummary()}
          disabled={loading}
          className="btn-secondary"
          style={{
            padding: '6px 10px',
            fontSize: '11px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
          }}
        >
          <RefreshCw size={12} /> {loading ? 'Refreshing...' : 'Refresh Ops'}
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '11px',
            color: '#FCA5A5',
            backgroundColor: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            marginBottom: '10px',
          }}
        >
          Ops telemetry warning: {error}
        </div>
      )}

      <div className="grid-4">
        <div
          className="bg-panel"
          style={{ border: '1px solid var(--color-border)', padding: '12px', borderRadius: '6px' }}
        >
          <div
            style={{
              color: 'var(--color-accent-info)',
              fontWeight: 800,
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <Database size={13} /> DB &amp; Redis Health
          </div>
          <div
            style={{
              fontSize: '15px',
              fontWeight: 900,
              margin: '6px 0',
              fontFamily: 'var(--font-mono)',
              color: data?.database.connected ? 'var(--color-text-positive)' : 'var(--color-accent-amber)',
            }}
          >
            {loading && !data
              ? 'CHECKING...'
              : `${data?.database.connected ? 'DB OK' : 'DB DOWN'} · ${data?.redis.configured ? 'REDIS ON' : 'REDIS OFF'}`}
          </div>
          <div className="text-muted" style={{ fontSize: '10px' }}>
            Neon PostgreSQL SSOT + Upstash
          </div>
        </div>

        <div
          className="bg-panel"
          style={{ border: '1px solid var(--color-border)', padding: '12px', borderRadius: '6px' }}
        >
          <div
            style={{
              color: data && data.killSwitches.activeCount > 0 ? '#FCA5A5' : 'var(--color-text-positive)',
              fontWeight: 800,
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <ShieldAlert size={13} /> Active Kill-Switches
          </div>
          <div
            style={{
              fontSize: '15px',
              fontWeight: 900,
              margin: '6px 0',
              fontFamily: 'var(--font-mono)',
              color: data && data.killSwitches.activeCount > 0 ? '#F87171' : 'var(--color-text-positive)',
            }}
          >
            {loading && !data ? '...' : `${data?.killSwitches.activeCount ?? 0} ACTIVE`}
          </div>
          <div className="text-muted" style={{ fontSize: '10px' }}>
            {data && data.killSwitches.scopes.length > 0
              ? `Scopes: ${data.killSwitches.scopes.join(', ')}`
              : 'All trading rails clear'}
          </div>
        </div>

        <div
          className="bg-panel"
          style={{ border: '1px solid var(--color-border)', padding: '12px', borderRadius: '6px' }}
        >
          <div
            style={{
              color: 'var(--color-accent-purple)',
              fontWeight: 800,
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <Activity size={13} /> 24h Trade Intents
          </div>
          <div
            style={{
              fontSize: '15px',
              fontWeight: 900,
              margin: '6px 0',
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-foreground)',
            }}
          >
            {loading && !data ? '...' : `${data?.tradeIntents24h.total ?? 0} TOTAL`}
          </div>
          <div className="text-muted" style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
            OK: {data?.tradeIntents24h.approved ?? 0} · EXEC: {data?.tradeIntents24h.executed ?? 0} · REJ:{' '}
            {data?.tradeIntents24h.rejected ?? 0}
          </div>
        </div>

        <div
          className="bg-panel"
          style={{ border: '1px solid var(--color-border)', padding: '12px', borderRadius: '6px' }}
        >
          <div
            style={{
              color: 'var(--color-accent-amber)',
              fontWeight: 800,
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
            }}
          >
            <Users size={13} /> Active Subscriptions
          </div>
          <div
            style={{
              fontSize: '15px',
              fontWeight: 900,
              margin: '6px 0',
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-foreground)',
            }}
          >
            {loading && !data ? '...' : `${totalSubs} ACTIVE`}
          </div>
          <div className="text-muted" style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
            {planEntries.length > 0
              ? planEntries.map(([plan, cnt]) => `${plan}:${cnt}`).join(' · ')
              : 'No paid/active rows yet'}
          </div>
        </div>
      </div>

      {(data?.aiEngine || data?.executionPlane || data?.preflight) && (
        <div
          style={{
            marginTop: '12px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '10px',
          }}
        >
          {data?.executionPlane && (
            <div
              className="bg-panel"
              style={{ border: '1px solid var(--color-border)', padding: '12px', borderRadius: '6px' }}
            >
              <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-accent-info)' }}>
                Serverless Execution (Cloudflare + Vercel)
              </div>
              <div
                style={{
                  fontSize: '14px',
                  fontWeight: 900,
                  margin: '5px 0',
                  fontFamily: 'var(--font-mono)',
                  color: data.executionPlane.workerOnline
                    ? 'var(--color-text-positive)'
                    : 'var(--color-accent-amber)',
                }}
              >
                {data.executionPlane.workerOnline
                  ? `ONLINE (${data.executionPlane.mode || 'CLOUDFLARE_CRON'})`
                  : 'STANDBY'}{' '}
                · {data.executionPlane.pendingExecutionCount} PENDING
              </div>
              <div className="text-muted" style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
                Last Pulse:{' '}
                {data.executionPlane.lastPulseAt
                  ? new Date(data.executionPlane.lastPulseAt).toLocaleString()
                  : 'Awaiting Cloudflare Cron'}
                {typeof data.executionPlane.staleUnexecutableCount === 'number' &&
                  data.executionPlane.staleUnexecutableCount > 0 &&
                  ` · Stale/Non-CEX: ${data.executionPlane.staleUnexecutableCount}`}
              </div>
            </div>
          )}

          {data?.aiEngine && (
            <div
              className="bg-panel"
              style={{ border: '1px solid var(--color-border)', padding: '12px', borderRadius: '6px' }}
            >
              <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-accent-purple)' }}>
                BytePlus ModelArk AI Engine
              </div>
              <div
                style={{
                  fontSize: '14px',
                  fontWeight: 900,
                  margin: '5px 0',
                  fontFamily: 'var(--font-mono)',
                  color: data.aiEngine.configured
                    ? 'var(--color-text-positive)'
                    : 'var(--color-accent-amber)',
                }}
              >
                {data.aiEngine.configured ? 'ACTIVE' : 'FALLBACK'} ·{' '}
                {data.aiEngine.primaryProvider.toUpperCase()}
              </div>
              <div className="text-muted" style={{ fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
                Fast:{data.aiEngine.fastPoolSize} · Deep:{data.aiEngine.deepPoolSize} · Img:
                {data.aiEngine.imagePoolSize} · InfoQuest:{data.aiEngine.infoQuestEnabled ? 'ON' : 'OFF'}
              </div>
            </div>
          )}

          {data?.preflight && (
            <div
              className="bg-panel"
              style={{ border: '1px solid var(--color-border)', padding: '12px', borderRadius: '6px' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--color-foreground)' }}>
                  Ops Preflight Readiness
                </span>
                <span
                  style={{
                    fontSize: '10px',
                    fontWeight: 900,
                    fontFamily: 'var(--font-mono)',
                    color:
                      data.preflight.overallStatus === 'READY'
                        ? 'var(--color-text-positive)'
                        : data.preflight.overallStatus === 'HALTED'
                          ? '#F87171'
                          : 'var(--color-accent-amber)',
                  }}
                >
                  {data.preflight.overallStatus} ({data.preflight.passedCount}/{data.preflight.totalCount})
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', marginTop: '6px' }}>
                {data.preflight.checks.map((c) => (
                  <div
                    key={c.id}
                    style={{
                      fontSize: '10px',
                      fontFamily: 'var(--font-mono)',
                      color:
                        c.status === 'PASS'
                          ? 'var(--color-text-positive)'
                          : c.status === 'FAIL'
                            ? '#F87171'
                            : 'var(--color-accent-amber)',
                    }}
                  >
                    [{c.status}] {c.label}: {c.detail}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span className="text-muted" style={{ fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <Lock size={12} color="var(--color-accent-amber)" />
            SOP-07 Strict Dual-Control Kill-Switch (Memerlukan Approved Dual-Control Request ID &amp; Role SUPER_ADMIN)
          </span>
          <button
            type="button"
            onClick={() => setShowKsConsole((v) => !v)}
            className="btn-secondary"
            style={{ padding: '5px 10px', fontSize: '11px' }}
          >
            {showKsConsole ? 'Tutup Dual-Control Console' : 'Buka Dual-Control Kill-Switch'}
          </button>
        </div>

        {showKsConsole && (
          <form
            onSubmit={handleSubmitKillSwitch}
            style={{
              marginTop: '10px',
              padding: '12px',
              borderRadius: '6px',
              border: '1px solid rgba(248, 113, 113, 0.35)',
              backgroundColor: 'rgba(239, 68, 68, 0.06)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px' }}>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>Action</label>
                <select
                  value={ksAction}
                  onChange={(e) => setKsAction(e.target.value as 'ACTIVATE' | 'DEACTIVATE')}
                  className="input"
                  style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                >
                  <option value="ACTIVATE">ACTIVATE (Halt Trading)</option>
                  <option value="DEACTIVATE">DEACTIVATE (Resume)</option>
                </select>
              </div>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>Scope</label>
                <select
                  value={ksScope}
                  onChange={(e) => setKsScope(e.target.value as 'GLOBAL' | 'USER' | 'AGENT' | 'TOKEN')}
                  className="input"
                  style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                >
                  <option value="GLOBAL">GLOBAL</option>
                  <option value="AGENT">AGENT</option>
                  <option value="USER">USER</option>
                  <option value="TOKEN">TOKEN</option>
                </select>
              </div>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>
                  Dual-Control Request ID (Wajib)
                </label>
                <input
                  type="text"
                  value={ksDualControlId}
                  onChange={(e) => setKsDualControlId(e.target.value)}
                  placeholder="dc-req-uuid..."
                  className="input"
                  style={{ padding: '6px 8px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="flex-col gap-xs">
                <label style={{ fontSize: '10px', fontWeight: 700, color: 'var(--color-muted)' }}>Audit Reason</label>
                <input
                  type="text"
                  value={ksReason}
                  onChange={(e) => setKsReason(e.target.value)}
                  placeholder="Emergency risk halt"
                  className="input"
                  style={{ padding: '6px 8px', fontSize: '11px' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
              <span className="text-muted" style={{ fontSize: '10px' }}>
                Alur SOP-07: (1) Admin #1 Propose → (2) Admin #2 Approve → (3) SUPER_ADMIN Execute Kill-Switch.
              </span>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => void handleProposeDualControl()}
                  disabled={dcBusyId === 'PROPOSE' || ksSubmitting}
                  className="btn-secondary"
                  style={{ padding: '7px 12px', fontSize: '11px', borderColor: 'rgba(250, 204, 21, 0.45)', color: 'var(--color-accent-amber)' }}
                >
                  {dcBusyId === 'PROPOSE' ? 'Proposing...' : `1. Propose Request (${ksScope})`}
                </button>
                <button
                  type="submit"
                  disabled={ksSubmitting}
                  className="btn-primary"
                  style={{
                    padding: '7px 14px',
                    fontSize: '11px',
                    backgroundColor: ksAction === 'ACTIVATE' ? '#DC2626' : '#059669',
                  }}
                >
                  {ksSubmitting ? 'Executing...' : `3. Execute ${ksAction} (${ksScope})`}
                </button>
              </div>
            </div>

            <div
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                backgroundColor: 'var(--color-surface-subtle)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '6px',
                  fontSize: '10px',
                  fontWeight: 800,
                  color: '#94A3B8',
                }}
              >
                <span>RECENT DUAL-CONTROL REQUESTS ({dcRequests.length})</span>
                <button
                  type="button"
                  onClick={() => void loadDualControlRequests()}
                  disabled={dcLoading}
                  className="btn-secondary"
                  style={{ padding: '2px 7px', fontSize: '10px' }}
                >
                  {dcLoading ? 'Loading...' : 'Refresh List'}
                </button>
              </div>
              {dcRequests.length === 0 ? (
                <div className="text-muted" style={{ fontSize: '10px' }}>
                  Belum ada request Dual-Control. Klik &ldquo;1. Propose Request&rdquo; di atas untuk memulai.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '150px', overflowY: 'auto' }}>
                  {dcRequests.slice(0, 6).map((reqItem) => {
                    const reqScope = String(reqItem.payload?.scope || 'GLOBAL');
                    return (
                      <div
                        key={reqItem.id}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '8px',
                          flexWrap: 'wrap',
                          padding: '5px 8px',
                          borderRadius: '4px',
                          backgroundColor: 'rgba(255, 255, 255, 0.03)',
                          fontSize: '10px',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span
                            style={{
                              padding: '1px 5px',
                              borderRadius: '4px',
                              fontWeight: 800,
                              backgroundColor:
                                reqItem.status === 'APPROVED'
                                  ? 'rgba(16, 185, 129, 0.2)'
                                  : reqItem.status === 'PENDING'
                                  ? 'rgba(245, 158, 11, 0.2)'
                                  : 'rgba(148, 163, 184, 0.15)',
                              color:
                                reqItem.status === 'APPROVED'
                                  ? 'var(--color-text-positive)'
                                  : reqItem.status === 'PENDING'
                                  ? 'var(--color-accent-amber)'
                                  : '#94A3B8',
                            }}
                          >
                            {reqItem.status}
                          </span>
                          <span style={{ color: '#E2E8F0', fontWeight: 700 }}>#{reqItem.id.slice(0, 8)}</span>
                          <span className="text-muted">
                            {reqItem.actionType} · {reqScope} · {reqItem.reason.slice(0, 36)}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: '5px' }}>
                          {reqItem.status === 'PENDING' && (
                            <button
                              type="button"
                              onClick={() => void handleApproveDualControl(reqItem.id)}
                              disabled={dcBusyId === reqItem.id}
                              className="btn-secondary"
                              style={{ padding: '2px 7px', fontSize: '10px', color: 'var(--color-text-positive)', borderColor: 'rgba(16, 185, 129, 0.4)' }}
                            >
                              {dcBusyId === reqItem.id ? 'Approving...' : '2. Approve (2nd Admin)'}
                            </button>
                          )}
                          {reqItem.status === 'APPROVED' && (
                            <button
                              type="button"
                              onClick={() => setKsDualControlId(reqItem.id)}
                              className="btn-secondary"
                              style={{ padding: '2px 7px', fontSize: '10px', color: 'var(--color-accent-info)' }}
                            >
                              Use ID → Step 3
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {ksFeedback && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: 700,
                  backgroundColor: ksFeedback.ok ? 'rgba(16, 185, 129, 0.14)' : 'rgba(239, 68, 68, 0.14)',
                  color: ksFeedback.ok ? 'var(--color-text-positive)' : '#FCA5A5',
                  border: `1px solid ${ksFeedback.ok ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)'}`,
                }}
              >
                {ksFeedback.text}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
