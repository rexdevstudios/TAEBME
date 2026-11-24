/**
 * packages/billing/high-margin-revenue.ts
 *
 * Pure, deterministic high-margin monetization primitives (Phase DD):
 *  1. On-Chain Boosted Daily Check-In (0.00008 ETH Base L2 -> Treasury, +50 XP / +15 Credits)
 *  2. Paid 24h / 72h Launchpad Featured Boost Slot (0.005 / 0.012 ETH Base L2 -> Treasury)
 *  3. Anti-replay txHash validation & featured-first launch sorting
 */

export const BOOSTED_CHECKIN_FEE_ETH = '0.00008';
export const BOOSTED_CHECKIN_BONUS_XP = 25; // Added on top of base 25 XP -> 50 XP total
export const BOOSTED_CHECKIN_BONUS_CREDITS = 10; // Added on top of base 5 cr -> 15 cr total

export type FeaturedBoostTierId = 'BOOST_24H' | 'BOOST_72H';

export interface FeaturedBoostTier {
  tierId: FeaturedBoostTierId;
  label: string;
  durationHours: number;
  feeEth: string;
}

export const FEATURED_BOOST_TIERS: Record<FeaturedBoostTierId, FeaturedBoostTier> = {
  BOOST_24H: {
    tierId: 'BOOST_24H',
    label: '24h Featured Boost',
    durationHours: 24,
    feeEth: '0.005',
  },
  BOOST_72H: {
    tierId: 'BOOST_72H',
    label: '72h Featured Boost',
    durationHours: 72,
    feeEth: '0.012',
  },
};

export interface FeaturedBoostRecord {
  contractAddress: string;
  chain: string;
  tierId: FeaturedBoostTierId;
  sponsoredBy: string;
  txHash: string;
  startedAt: string;
  expiresAt: string;
}

export function isValidEvmTxHash(txHash: unknown): txHash is string {
  return typeof txHash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(txHash.trim());
}

export function getFeaturedBoostTier(tierId: unknown): FeaturedBoostTier | null {
  const key = typeof tierId === 'string' ? tierId.trim().toUpperCase() : '';
  if (key === 'BOOST_24H' || key === 'BOOST_72H') {
    return FEATURED_BOOST_TIERS[key];
  }
  return null;
}

export function computeFeaturedBoostWindow(
  tierId: FeaturedBoostTierId,
  nowMs: number = Date.now()
): { startedAt: string; expiresAt: string } {
  const tier = FEATURED_BOOST_TIERS[tierId];
  const start = new Date(nowMs);
  const end = new Date(nowMs + tier.durationHours * 60 * 60 * 1000);
  return {
    startedAt: start.toISOString(),
    expiresAt: end.toISOString(),
  };
}

export function filterActiveFeaturedBoosts(
  records: readonly FeaturedBoostRecord[],
  nowMs: number = Date.now()
): FeaturedBoostRecord[] {
  const byAddr = new Map<string, FeaturedBoostRecord>();
  for (const r of records || []) {
    if (!r || !r.contractAddress || !r.expiresAt) continue;
    const expMs = Date.parse(r.expiresAt);
    if (!Number.isFinite(expMs) || expMs <= nowMs) continue;
    const key = r.contractAddress.trim().toLowerCase();
    const prev = byAddr.get(key);
    if (!prev || Date.parse(prev.expiresAt) < expMs) {
      byAddr.set(key, r);
    }
  }
  return Array.from(byAddr.values()).sort(
    (a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt)
  );
}

/**
 * Sorts launchpad token cards so actively boosted FEATURED tokens always float to the top
 * while preserving the relative order of all remaining tokens.
 */
export function sortLaunchesWithFeaturedFirst<T extends { contractAddress?: string | null }>(
  launches: readonly T[],
  activeBoosts: readonly FeaturedBoostRecord[],
  nowMs: number = Date.now()
): T[] {
  const activeSet = new Set(
    filterActiveFeaturedBoosts(activeBoosts, nowMs).map((b) =>
      b.contractAddress.trim().toLowerCase()
    )
  );
  if (activeSet.size === 0) return [...launches];
  const featured: T[] = [];
  const standard: T[] = [];
  for (const item of launches) {
    const addr = (item.contractAddress || '').trim().toLowerCase();
    if (addr && activeSet.has(addr)) {
      featured.push(item);
    } else {
      standard.push(item);
    }
  }
  return [...featured, ...standard];
}
