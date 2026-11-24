/**
 * tests/batch-dd-high-margin-revenue.test.ts
 *
 * Phase DD Verification Suite:
 *  - Verifies On-Chain Boosted Daily Check-In constants & txHash format guard
 *  - Verifies Featured Boost 24h/72h expiry window, active filtering, and featured-first sorting
 *  - Verifies PostgresBillingDbAdapter anti-replay txHash protection for Featured Boosts
 */

import { describe, expect, test } from 'bun:test';
import {
  BOOSTED_CHECKIN_BONUS_CREDITS,
  BOOSTED_CHECKIN_FEE_ETH,
  FEATURED_BOOST_TIERS,
  computeFeaturedBoostWindow,
  filterActiveFeaturedBoosts,
  getFeaturedBoostTier,
  isValidEvmTxHash,
  sortLaunchesWithFeaturedFirst,
  type FeaturedBoostRecord,
} from '../packages/billing/high-margin-revenue';
import { PostgresBillingDbAdapter } from '../packages/db/billing-repo';

describe('Phase DD: High-Margin Revenue (On-Chain Boosted Check-In & Launchpad Featured Boost)', () => {
  test('[DD1.1] validates boosted check-in economics and strict 32-byte EVM txHash format', () => {
    expect(BOOSTED_CHECKIN_FEE_ETH).toBe('0.00008');
    expect(BOOSTED_CHECKIN_BONUS_CREDITS).toBe(10);
    expect(isValidEvmTxHash(`0x${'a'.repeat(64)}`)).toBe(true);
    expect(isValidEvmTxHash('0x1234')).toBe(false);
    expect(isValidEvmTxHash('not-a-hash')).toBe(false);
  });

  test('[DD1.2] computes 24h/72h boost windows and floats actively featured tokens to the top', () => {
    const tier24 = getFeaturedBoostTier('BOOST_24H');
    expect(tier24?.feeEth).toBe(FEATURED_BOOST_TIERS.BOOST_24H.feeEth);
    expect(getFeaturedBoostTier('INVALID')).toBeNull();

    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    const win = computeFeaturedBoostWindow('BOOST_24H', nowMs);
    expect(Date.parse(win.expiresAt) - Date.parse(win.startedAt)).toBe(24 * 60 * 60 * 1000);

    const expired: FeaturedBoostRecord = {
      contractAddress: '0x1111111111111111111111111111111111111111',
      chain: 'base-mainnet',
      tierId: 'BOOST_24H',
      sponsoredBy: '0xaaaa000000000000000000000000000000000001',
      txHash: `0x${'1'.repeat(64)}`,
      startedAt: '2026-11-22T00:00:00.000Z',
      expiresAt: '2026-11-23T00:00:00.000Z',
    };
    const active: FeaturedBoostRecord = {
      contractAddress: '0x2222222222222222222222222222222222222222',
      chain: 'base-mainnet',
      tierId: 'BOOST_72H',
      sponsoredBy: '0xaaaa000000000000000000000000000000000002',
      txHash: `0x${'2'.repeat(64)}`,
      startedAt: win.startedAt,
      expiresAt: win.expiresAt,
    };

    const filtered = filterActiveFeaturedBoosts([expired, active], nowMs);
    expect(filtered.length).toBe(1);
    expect(filtered[0].contractAddress).toBe(active.contractAddress);

    const sorted = sortLaunchesWithFeaturedFirst(
      [
        { ticker: 'FIRST', contractAddress: '0x1111111111111111111111111111111111111111' },
        { ticker: 'SECOND', contractAddress: '0x2222222222222222222222222222222222222222' },
        { ticker: 'THIRD', contractAddress: '0x3333333333333333333333333333333333333333' },
      ],
      [expired, active],
      nowMs
    );
    expect(sorted.map((x) => x.ticker)).toEqual(['SECOND', 'FIRST', 'THIRD']);
  });

  test('[DD1.3] recordFeaturedBoost enforces strict anti-replay on txHash', async () => {
    const repo = new PostgresBillingDbAdapter({
      getDbPool: () => null,
      ensureUserEntity: async (_p, u) => u,
    });
    const win = computeFeaturedBoostWindow('BOOST_24H');
    const txHash = `0x${'f'.repeat(64)}`;

    const first = await repo.recordFeaturedBoost({
      contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chain: 'base-mainnet',
      tierId: 'BOOST_24H',
      sponsoredBy: '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6',
      txHash,
      startedAt: win.startedAt,
      expiresAt: win.expiresAt,
    });
    expect(first.ok).toBe(true);
    expect(first.replay).toBeUndefined();
    expect(first.activeBoosts.length).toBe(1);

    const replay = await repo.recordFeaturedBoost({
      contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      chain: 'base-mainnet',
      tierId: 'BOOST_24H',
      sponsoredBy: '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6',
      txHash,
      startedAt: win.startedAt,
      expiresAt: win.expiresAt,
    });
    expect(replay.ok).toBe(false);
    expect(replay.replay).toBe(true);
  });
});
