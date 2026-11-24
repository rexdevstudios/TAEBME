/**
 * tests/batch-de-signal-marketplace.test.ts
 *
 * Phase DE Verification Suite:
 *  - Verifies deterministic 80% Creator / 20% Platform Treasury credit split
 *  - Verifies Risk Gate bounds on preset TP/SL/Trailing Stop & price validation
 *  - Verifies publish, self-subscribe block, and atomic 80/20 credit ledger settlement
 */

import { describe, expect, test } from 'bun:test';
import {
  computeMarketplaceSplit,
  validateSignalPresetInput,
} from '../packages/agent/signal-marketplace';
import { PostgresBillingDbAdapter } from '../packages/db/billing-repo';

describe('Phase DE: Copy-Trading / Signal Preset Marketplace (80/20 Rev-Share)', () => {
  test('[DE1.1] computeMarketplaceSplit enforces exact 80% creator / 20% treasury split', () => {
    const s100 = computeMarketplaceSplit(100);
    expect(s100).toEqual({ totalCredits: 100, creatorCredits: 80, platformCredits: 20 });

    const s250 = computeMarketplaceSplit(250);
    expect(s250).toEqual({ totalCredits: 250, creatorCredits: 200, platformCredits: 50 });
  });

  test('[DE1.2] validateSignalPresetInput rejects unsafe SL/TP or out-of-range prices', () => {
    expect(
      validateSignalPresetInput({
        title: 'Bad',
        description: 'too short title',
        priceCredits: 100,
        takeProfitPct: 15,
        stopLossPct: 5,
      }).ok
    ).toBe(false);

    expect(
      validateSignalPresetInput({
        title: 'Unsafe SL',
        description: '90% SL must fail',
        priceCredits: 100,
        takeProfitPct: 15,
        stopLossPct: 90,
      }).ok
    ).toBe(false);

    const ok = validateSignalPresetInput({
      title: 'Base Momentum Pro',
      description: 'Disciplined trailing stop breakout',
      priceCredits: 100,
      takeProfitPct: 18,
      stopLossPct: 6,
      trailingStopPct: 3.5,
      allowedSymbols: ['btcusdt', 'ethusdt'],
    });
    expect(ok.ok).toBe(true);
    expect(ok.sanitized?.allowedSymbols).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  test('[DE1.3] publish & subscribe settles 80/20 credits atomically and blocks self-subscribe', async () => {
    const repo = new PostgresBillingDbAdapter({
      getDbPool: () => null,
      ensureUserEntity: async (_p, u) => u,
    });
    const creator = '0x1111111111111111111111111111111111111111';
    const follower = '0x2222222222222222222222222222222222222222';

    await repo.updateUserSubscription(creator, 'FREE');
    await repo.updateUserSubscription(follower, 'CREATOR');

    const preset = await repo.publishMarketplacePreset({
      title: 'Swiss Scalper v1',
      description: 'Low drawdown momentum preset',
      creatorWallet: creator,
      priceCredits: 100,
      rail: 'CEX_AUTO',
      takeProfitPct: 12,
      stopLossPct: 4,
      trailingStopPct: 2.5,
      allowedSymbols: ['BTCUSDT'],
    });

    const selfSub = await repo.subscribeMarketplacePreset(creator, preset.id);
    expect(selfSub.ok).toBe(false);
    expect(selfSub.error).toContain('SELF_SUBSCRIBE_FORBIDDEN');

    const okSub = await repo.subscribeMarketplacePreset(follower, preset.id);
    expect(okSub.ok).toBe(true);
    expect(okSub.split?.creatorCredits).toBe(80);
    expect(okSub.split?.platformCredits).toBe(20);
    expect(await repo.getUserCreditBalance(follower)).toBe(1900);
    expect(await repo.getUserCreditBalance(creator)).toBe(180);
  });
});
