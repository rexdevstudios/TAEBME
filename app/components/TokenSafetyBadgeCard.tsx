'use client';

import React, { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck, AlertTriangle } from 'lucide-react';
import type { OnChainTokenSecurityReport } from '@packages/intelligence/onchain-insider-guard';

interface TokenSafetyBadgeCardProps {
  /** Direct pre-fetched report (e.g. from 5-Agent Desk response) */
  report?: OnChainTokenSecurityReport | null;
  /** Or pass address + chainId to auto-fetch from public cached GET /api/trading/token-safety */
  address?: string | null;
  chainId?: number;
  /** Optional callback notifying parent of the resolved safety report (e.g. for pre-trade hard-block guard) */
  onReportChange?: (report: OnChainTokenSecurityReport | null) => void;
}

export function TokenSafetyBadgeCard({
  report: propReport,
  address,
  chainId = 8453,
  onReportChange,
}: TokenSafetyBadgeCardProps) {
  const [fetched, setFetched] = useState<OnChainTokenSecurityReport | null>(null);
  const [loading, setLoading] = useState(false);

  const validAddr = typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address.trim()) ? address.trim() : null;

  useEffect(() => {
    if (propReport !== undefined) return;
    if (!validAddr) {
      setFetched(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/trading/token-safety?address=${encodeURIComponent(validAddr)}&chainId=${encodeURIComponent(String(chainId))}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && json?.success && json.data) {
          setFetched(json.data as OnChainTokenSecurityReport);
        } else if (!cancelled) {
          setFetched(null);
        }
      })
      .catch(() => {
        if (!cancelled) setFetched(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propReport, validAddr, chainId]);

  const data = propReport !== undefined ? propReport : fetched;

  useEffect(() => {
    if (onReportChange) {
      onReportChange(data ?? null);
    }
  }, [data, onReportChange]);

  if (loading) {
    return (
      <div
        style={{
          padding: '8px 10px',
          borderRadius: '6px',
          border: '1px solid var(--color-border)',
          background: 'rgba(15, 23, 42, 0.45)',
          fontSize: '11px',
          color: 'var(--color-muted)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        🛡️ Memindai keamanan kontrak &amp; deteksi insider (GoPlus On-Chain Guard)...
      </div>
    );
  }

  if (!data) return null;

  const palette =
    data.riskLevel === 'LOW'
      ? { border: 'rgba(16, 185, 129, 0.4)', bg: 'rgba(16, 185, 129, 0.08)', color: '#34D399' }
      : data.riskLevel === 'MEDIUM'
      ? { border: 'rgba(245, 158, 11, 0.4)', bg: 'rgba(245, 158, 11, 0.08)', color: '#FBBF24' }
      : { border: 'rgba(239, 68, 68, 0.5)', bg: 'rgba(239, 68, 68, 0.1)', color: '#F87171' };

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: '8px',
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        fontSize: '11px',
        fontFamily: 'var(--font-mono)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, color: palette.color, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
          {data.riskLevel === 'LOW' ? (
            <ShieldCheck size={14} />
          ) : data.riskLevel === 'MEDIUM' ? (
            <AlertTriangle size={14} />
          ) : (
            <ShieldAlert size={14} />
          )}
          ON-CHAIN ANTI-INSIDER GUARD · {data.riskLevel} RISK
          {data.hardBlocked ? ' (HARD BLOCKED)' : ''}
        </span>
        <span style={{ fontSize: '10px', color: 'var(--color-muted)' }}>
          {data.source === 'GOPLUS_REDIS_CACHE' ? 'GoPlus · Redis 15m' : 'GoPlus Live'} · Chain #{data.chainId}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(105px, 1fr))', gap: '6px', fontSize: '10px' }}>
        <div>
          <span className="text-muted">Honeypot:</span>{' '}
          <strong style={{ color: data.isHoneypot ? '#F87171' : '#34D399' }}>
            {data.isHoneypot ? 'YA (BAHAYA)' : 'AMAN'}
          </strong>
        </div>
        <div>
          <span className="text-muted">Buy/Sell Tax:</span>{' '}
          <strong style={{ color: data.sellTaxPct > 10 || data.buyTaxPct > 10 ? '#F87171' : '#E2E8F0' }}>
            {data.buyTaxPct}% / {data.sellTaxPct}%
          </strong>
        </div>
        <div>
          <span className="text-muted">Top-10 Holder:</span>{' '}
          <strong style={{ color: data.top10HolderPct >= 45 ? '#FBBF24' : '#34D399' }}>
            {data.top10HolderPct}%
          </strong>
        </div>
        <div>
          <span className="text-muted">Cluster Insider:</span>{' '}
          <strong style={{ color: data.suspectedClusterCount >= 3 ? '#F87171' : '#34D399' }}>
            {data.suspectedClusterCount >= 3 ? `${data.suspectedClusterCount} Wallet Kembar` : 'Bersih'}
          </strong>
        </div>
      </div>

      <div style={{ fontSize: '11px', color: '#E2E8F0', lineHeight: 1.4 }}>{data.summary}</div>
    </div>
  );
}
