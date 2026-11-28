'use client';

import React from 'react';
import { ExternalLink, ShieldCheck, X } from 'lucide-react';
import type { ChartCandleMarker } from '@packages/intelligence/kol-chart-overlay';

interface KolMarkerHoverCardProps {
  marker: ChartCandleMarker;
  onClose?: () => void;
  formatPrice?: (p: number) => string;
}

function defaultFormatPrice(val: number): string {
  if (!Number.isFinite(val)) return '0';
  const abs = Math.abs(val);
  if (abs === 0) return '0.00';
  if (abs < 0.001) return val.toFixed(7);
  if (abs < 1) return val.toFixed(5);
  if (abs < 100) return val.toFixed(3);
  return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Reusable GMGN-style floating KOL Callout / Entry Hover Card (Phase FI).
 * Shared by both `/token/[chain]/[address]` (InteractiveCandlestickChart) and `/trading`.
 * Strictly uses Pons-v2 CSS tokens and renders external tweet links only for valid https:// URLs.
 */
export function KolMarkerHoverCard({
  marker,
  onClose,
  formatPrice = defaultFormatPrice,
}: KolMarkerHoverCardProps) {
  const isKol = marker.kind === 'KOL_BUY' || marker.kind === 'KOL_SELL';
  const isSafeTweetUrl =
    typeof marker.tweetUrl === 'string' && marker.tweetUrl.startsWith('https://');
  const timeStr = (() => {
    try {
      return new Date(marker.timestampMs).toLocaleString([], {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  })();

  return (
    <div
      role="status"
      aria-label="KOL Chart Marker Callout"
      style={{
        padding: '10px 12px',
        borderRadius: '10px',
        backgroundColor: 'var(--color-surface-elevated)',
        border: `1px solid ${
          marker.side === 'BUY'
            ? 'var(--color-badge-success-border)'
            : 'var(--color-badge-warning-border)'
        }`,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.24)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        fontSize: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span
            style={{
              fontWeight: 800,
              color: 'var(--color-foreground)',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
            }}
          >
            {marker.kolHandle || marker.label}
          </span>
          {isKol && (
            <span
              style={{
                fontSize: '9px',
                fontWeight: 800,
                fontFamily: 'var(--font-mono)',
                padding: '2px 6px',
                borderRadius: '999px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                backgroundColor: 'var(--color-badge-success-bg)',
                color: 'var(--color-badge-success-text)',
                border: '1px solid var(--color-badge-success-border)',
              }}
            >
              <ShieldCheck size={10} />
              KOL VERIFIED{marker.tier ? ` · ${marker.tier}` : ''}
            </span>
          )}
          <span
            style={{
              fontSize: '9px',
              fontWeight: 800,
              fontFamily: 'var(--font-mono)',
              padding: '2px 6px',
              borderRadius: '4px',
              backgroundColor:
                marker.source === 'SOCIAL_TWEET'
                  ? 'var(--color-badge-info-bg)'
                  : marker.side === 'BUY'
                    ? 'var(--color-badge-success-bg)'
                    : 'var(--color-badge-warning-bg)',
              color:
                marker.source === 'SOCIAL_TWEET'
                  ? 'var(--color-badge-info-text)'
                  : marker.side === 'BUY'
                    ? 'var(--color-badge-success-text)'
                    : 'var(--color-badge-warning-text)',
            }}
          >
            {marker.source === 'SOCIAL_TWEET'
              ? `CALLOUT · ${marker.side}`
              : marker.source === 'AI_SIGNAL'
                ? `AI SIGNAL · ${marker.side}`
                : `ENTRY · ${marker.side}`}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {timeStr && (
            <span style={{ fontSize: '10px', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>
              {timeStr}
            </span>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close callout card"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--color-muted)',
                cursor: 'pointer',
                padding: '2px',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div style={{ color: 'var(--color-foreground)', lineHeight: 1.45, fontSize: '12px' }}>
        {marker.quoteText || marker.label}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          fontSize: '11px',
          fontFamily: 'var(--font-mono)',
          color: 'var(--color-muted)',
        }}
      >
        <span>
          Price: <strong style={{ color: 'var(--color-foreground)' }}>${formatPrice(marker.price)}</strong>
        </span>
        {isSafeTweetUrl && (
          <a
            href={marker.tweetUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: 'var(--color-accent-info)',
              textDecoration: 'none',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <span>View Tweet</span>
            <ExternalLink size={11} />
          </a>
        )}
      </div>
    </div>
  );
}
