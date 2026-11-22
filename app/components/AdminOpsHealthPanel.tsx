'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Database, ShieldAlert, RefreshCw, Users } from 'lucide-react';

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
    </div>
  );
}
