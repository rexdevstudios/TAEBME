'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  resolveIpfsImageCandidates,
  getDeterministicAvatarGradient,
} from '@packages/shared/ipfs-image';

interface TokenAvatarProps {
  src?: string | null;
  name?: string;
  ticker?: string;
  seed?: string;
  size?: number;
  borderRadius?: number;
}

/**
 * Resilient Token Avatar Component:
 * 1. Tries ordered IPFS/HTTPS gateway candidates with automatic `onError` failover.
 * 2. Immediately falls back to a crisp deterministic gradient monogram if URL is
 *    missing, non-image, or all gateways fail (zero broken-image icons ever).
 */
export function TokenAvatar({
  src,
  name = 'Token',
  ticker = 'TK',
  seed,
  size = 44,
  borderRadius = 12,
}: TokenAvatarProps) {
  const candidates = useMemo(() => resolveIpfsImageCandidates(src), [src]);
  const [candidateIdx, setCandidateIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setCandidateIdx(0);
    setLoaded(false);
  }, [src]);

  const activeUrl = candidateIdx < candidates.length ? candidates[candidateIdx] : null;
  const [gradStart, gradEnd] = useMemo(
    () => getDeterministicAvatarGradient(seed || ticker || name),
    [seed, ticker, name]
  );

  const initials = useMemo(() => {
    const clean = (ticker || name || 'TK').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    return clean.slice(0, 3) || 'TK';
  }, [ticker, name]);

  return (
    <div
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: `${borderRadius}px`,
        background: `linear-gradient(135deg, ${gradStart} 0%, ${gradEnd} 100%)`,
        border: '1px solid var(--color-border)',
        position: 'relative',
        overflow: 'hidden',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: 'var(--shadow-sm)',
      }}
      title={`${name} ($${ticker})`}
    >
      {/* Deterministic Monogram (always visible underneath until image loads) */}
      <span
        style={{
          color: '#FFFFFF',
          fontWeight: 900,
          fontSize: `${Math.max(10, Math.round(size * 0.3))}px`,
          letterSpacing: '-0.03em',
          fontFamily: 'var(--font-mono)',
          textShadow: '0 1px 4px rgba(0,0,0,0.28)',
          userSelect: 'none',
          opacity: activeUrl && loaded ? 0 : 1,
          transition: 'opacity 180ms ease',
        }}
      >
        {initials}
      </span>

      {/* Multi-gateway Image Layer */}
      {activeUrl && (
        <img
          src={activeUrl}
          alt={name}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(false);
            setCandidateIdx((prev) => prev + 1);
          }}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            opacity: loaded ? 1 : 0,
            transition: 'opacity 220ms ease',
          }}
        />
      )}
    </div>
  );
}
