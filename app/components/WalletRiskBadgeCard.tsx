'use client';

import React, { useEffect, useState } from 'react';
import { ShieldAlert, ShieldCheck, AlertTriangle } from 'lucide-react';
import type { ArkhamEntityProfile } from '@packages/intelligence/arkham-enrichment';

interface WalletRiskBadgeCardProps {
  address?: string | null;
  chainId?: number;
  title?: string;
}

export function WalletRiskBadgeCard({
  address,
  chainId = 8453,
  title = 'On-Chain Wallet Guard (GoPlus + RPC · $0)',
}: WalletRiskBadgeCardProps) {
  const [profile, setProfile] = useState<ArkhamEntityProfile | null>(null);
  const [loading, setLoading] = useState(false);

  const validAddr = typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address.trim()) ? address.trim() : null;

  useEffect(() => {
    if (!validAddr) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/trading/wallet-risk?address=${encodeURIComponent(validAddr)}&chainId=${encodeURIComponent(String(chainId))}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!cancelled && json?.success && json.data) {
          setProfile(json.data as ArkhamEntityProfile);
        } else if (!cancelled) {
          setProfile(null);
        }
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [validAddr, chainId]);

  if (!validAddr) return null;

  if (loading) {
    return (
      <div
        style={{
          padding: '8px 10px',
          borderRadius: '6px',
          border: '1px solid var(--color-border)',
          background: 'var(--color-surface-subtle)',
          fontSize: '11px',
          color: 'var(--color-muted)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        Memindai reputasi wallet on-chain (GoPlus + Public RPC)...
      </div>
    );
  }

  if (!profile) return null;

  const isBlocked = profile.isCounterpartyBlocked || profile.riskPassportScore < 40;
  const isCaution = !isBlocked && profile.riskPassportScore < 70;
  const palette = isBlocked
    ? { border: 'rgba(239, 68, 68, 0.5)', bg: 'rgba(239, 68, 68, 0.1)', color: '#F87171' }
    : isCaution
    ? { border: 'rgba(245, 158, 11, 0.45)', bg: 'rgba(245, 158, 11, 0.08)', color: '#FBBF24' }
    : { border: 'rgba(16, 185, 129, 0.4)', bg: 'rgba(16, 185, 129, 0.08)', color: 'var(--color-text-positive)' };

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
          {isBlocked ? (
            <ShieldAlert size={14} />
          ) : isCaution ? (
            <AlertTriangle size={14} />
          ) : (
            <ShieldCheck size={14} />
          )}
          {title}
        </span>
        <span style={{ fontWeight: 800, color: palette.color }}>
          Score {profile.riskPassportScore}/100 · {profile.isCounterpartyBlocked ? 'BLOCKED' : profile.arkhamEntityType}
        </span>
      </div>

      <div style={{ fontSize: '11px', color: '#E2E8F0' }}>
        <strong>{profile.arkhamEntityName || 'On-Chain Wallet'}</strong> ({validAddr.slice(0, 6)}...{validAddr.slice(-4)})
      </div>

      {Array.isArray(profile.tags) && profile.tags.length > 0 && (
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {profile.tags.slice(0, 6).map((tag) => (
            <span
              key={tag}
              style={{
                fontSize: '10px',
                padding: '2px 6px',
                borderRadius: '999px',
                border: '1px solid rgba(148, 163, 184, 0.25)',
                background: 'var(--color-surface-subtle)',
                color: '#CBD5E1',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
