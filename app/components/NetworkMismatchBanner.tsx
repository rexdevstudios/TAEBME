'use client';

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLocale } from '../context/LocaleContext';
import { resolveChainDisplayMeta } from '@packages/trading/paper-wallet';

interface NetworkMismatchBannerProps {
  targetChainHex: string;
  targetChainLabel?: string;
  contextLabel?: string;
}

/**
 * Shared 1-Click Network Mismatch Banner (Phase EL).
 * - Renders nothing (`null`) when wallet is disconnected or already on the target chain (zero clutter).
 * - Displays a clean Pons-v2 warning + 1-click MetaMask switch button when active wallet chain != target chain.
 */
export function NetworkMismatchBanner({
  targetChainHex,
  targetChainLabel,
  contextLabel,
}: NetworkMismatchBannerProps) {
  const { isConnected, chainId, switchNetwork } = useAuth();
  const { tr } = useLocale();
  const [switching, setSwitching] = useState(false);

  if (!isConnected || !chainId) return null;
  const normWallet = chainId.trim().toLowerCase();
  const normTarget = targetChainHex.trim().toLowerCase();
  if (normWallet === normTarget) return null;

  const walletMeta = resolveChainDisplayMeta(normWallet);
  const targetMeta = resolveChainDisplayMeta(normTarget);
  const resolvedTargetLabel = targetChainLabel || targetMeta.label;
  const scopeText = contextLabel ? ` (${contextLabel})` : '';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
        flexWrap: 'wrap',
        padding: '8px 12px',
        borderRadius: '6px',
        border: '1px solid rgba(245, 158, 11, 0.45)',
        backgroundColor: 'rgba(245, 158, 11, 0.1)',
        marginBottom: '10px',
        fontSize: '11px',
      }}
    >
      <span style={{ color: 'var(--color-accent-amber)', fontWeight: 700 }}>
        {tr(
          `Wallet is on ${walletMeta.label}, while this action${scopeText} uses ${resolvedTargetLabel}.`,
          `Wallet Anda di ${walletMeta.label}, sedangkan aksi ini${scopeText} memakai ${resolvedTargetLabel}.`
        )}
      </span>
      <button
        type="button"
        disabled={switching}
        onClick={async () => {
          setSwitching(true);
          try {
            await switchNetwork(normTarget);
          } finally {
            setSwitching(false);
          }
        }}
        className="btn-primary"
        style={{ fontSize: '10px', padding: '4px 10px', whiteSpace: 'nowrap' }}
      >
        {switching
          ? tr('Switching...', 'Memindah...')
          : tr(`Switch to ${resolvedTargetLabel}`, `Pindah ke ${resolvedTargetLabel}`)}
      </button>
    </div>
  );
}
