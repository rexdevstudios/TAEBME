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
        text: `✅ Kill-Switch ${ksAction} (${ksScope}) sukses · Dual-Control #${json?.data?.dualControlId || trimmedId}`,
      });
      setKsDualControlId('');
      await loadSummary();
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
              color: '#00E5FF',
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
              color: '#00E5FF',
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
              color: data?.database.connected ? '#6EE7B7' : '#FDE047',
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
              color: data && data.killSwitches.activeCount > 0 ? '#FCA5A5' : '#6EE7B7',
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
              color: data && data.killSwitches.activeCount > 0 ? '#F87171' : '#6EE7B7',
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
              color: '#D500F9',
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
              color: '#FFC400',
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

      <div style={{ marginTop: '12px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span className="text-muted" style={{ fontSize: '11px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <Lock size={12} color="#FDE047" />
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
                Setiap eksekusi tercatat otomatis di PostgreSQL `audit_logs` &amp; broadcast ke Redis PubSub.
              </span>
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
                {ksSubmitting ? 'Executing...' : `Execute ${ksAction} (${ksScope})`}
              </button>
            </div>
            {ksFeedback && (
              <div
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: 700,
                  backgroundColor: ksFeedback.ok ? 'rgba(16, 185, 129, 0.14)' : 'rgba(239, 68, 68, 0.14)',
                  color: ksFeedback.ok ? '#6EE7B7' : '#FCA5A5',
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
