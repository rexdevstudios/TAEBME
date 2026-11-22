/**
 * packages/trading/venue-router.ts
 *
 * Pure Deterministic Venue-Agnostic CEX Auto-Router (Phase AM).
 * - Keeps AI Agents 100% venue-agnostic: agents emit neutral trade intents (`symbol`, `side`, `qty`),
 *   while this router deterministically picks the user's active, non-frozen CEX venue.
 * - Reuses `computeEffectiveVaultCapacity` and `annotateKeysWithQuotaStatus` (SSOT, zero duplication).
 * - Priority when `requestedVenue === 'AUTO'`: Active Binance -> Active Bybit V5 -> Fail-Closed (`null`).
 */

import {
  annotateKeysWithQuotaStatus,
  computeEffectiveVaultCapacity,
} from '../billing/subscriptions-engine';

export type CexVenueId = 'BINANCE' | 'BYBIT';
export type RequestedCexVenue = 'AUTO' | CexVenueId;

export interface MinimalCexKeyRecord {
  id: string;
  isDefault: boolean;
  createdAt: string;
  environment?: 'TESTNET' | 'MAINNET';
  chainScope?: string;
}

export interface VenueResolutionResult {
  venue: CexVenueId | null;
  routingMode: 'EXPLICIT' | 'AUTO';
  reason:
    | 'EXPLICIT_SELECTION'
    | 'AUTO_ACTIVE_BINANCE'
    | 'AUTO_ACTIVE_BYBIT'
    | 'NO_ACTIVE_CEX_CREDENTIALS';
  activeBinanceCount: number;
  activeBybitCount: number;
  allFrozen: boolean;
}

export function resolveCexExecutionVenue(params: {
  requestedVenue?: string | null;
  planId?: string | null;
  addonSlots?: { bankrExtraSlots?: number; binanceExtraSlots?: number } | null;
  binanceAccounts: MinimalCexKeyRecord[];
  bybitKeys: MinimalCexKeyRecord[];
}): VenueResolutionResult {
  const normReq = String(params.requestedVenue || 'AUTO').trim().toUpperCase();
  const effCap = computeEffectiveVaultCapacity(params.planId, params.addonSlots);

  const annotatedBinance = annotateKeysWithQuotaStatus(params.binanceAccounts, {
    maxActive: effCap.maxBinanceAccounts,
    allowMainnet: effCap.allowMainnetBinance,
  });
  const annotatedBybit = annotateKeysWithQuotaStatus(
    params.bybitKeys.map((k) => ({
      ...k,
      environment: (k.environment ||
        (String(k.chainScope || '').toLowerCase() === 'mainnet' ? 'MAINNET' : 'TESTNET')) as
        | 'TESTNET'
        | 'MAINNET',
    })),
    {
      maxActive: effCap.maxBinanceAccounts,
      allowMainnet: effCap.allowMainnetBinance,
    }
  );

  const activeBinanceCount = annotatedBinance.filter((k) => k.quotaStatus === 'ACTIVE').length;
  const activeBybitCount = annotatedBybit.filter((k) => k.quotaStatus === 'ACTIVE').length;
  const totalConfigured = params.binanceAccounts.length + params.bybitKeys.length;
  const allFrozen = totalConfigured > 0 && activeBinanceCount === 0 && activeBybitCount === 0;

  if (normReq === 'BINANCE' || normReq === 'BYBIT') {
    return {
      venue: normReq,
      routingMode: 'EXPLICIT',
      reason: 'EXPLICIT_SELECTION',
      activeBinanceCount,
      activeBybitCount,
      allFrozen,
    };
  }

  if (activeBinanceCount > 0) {
    return {
      venue: 'BINANCE',
      routingMode: 'AUTO',
      reason: 'AUTO_ACTIVE_BINANCE',
      activeBinanceCount,
      activeBybitCount,
      allFrozen: false,
    };
  }

  if (activeBybitCount > 0) {
    return {
      venue: 'BYBIT',
      routingMode: 'AUTO',
      reason: 'AUTO_ACTIVE_BYBIT',
      activeBinanceCount,
      activeBybitCount,
      allFrozen: false,
    };
  }

  return {
    venue: null,
    routingMode: 'AUTO',
    reason: 'NO_ACTIVE_CEX_CREDENTIALS',
    activeBinanceCount: 0,
    activeBybitCount: 0,
    allFrozen,
  };
}
