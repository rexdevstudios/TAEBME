/**
 * tests/batch-dg-prop-challenge-and-genesis-proof.test.ts
 *
 * Phase DG Verification Suite:
 *  - Verifies Proof-of-Skill Prop Challenge rules (+8% target, 5% daily loss, 10% drawdown, min 3 days)
 *  - Verifies start via Credits, duplicate active guard, pass reward (+250 cr), and Verified Traders leaderboard
 *  - Verifies Guest Landing Page & /transparency expose Genesis Pioneers public proof
 */

import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  PROP_CHALLENGE_RULES,
  evaluatePropChallengeMetrics,
} from '../packages/trading/prop-challenge';
import { PostgresBillingDbAdapter } from '../packages/db/billing-repo';

describe('Phase DG: Public Genesis SBT Proof & Web3 Proof-of-Skill Prop Challenge', () => {
  test('[DG1.1] evaluatePropChallengeMetrics enforces daily loss, drawdown, and +8% / 3-day pass rule', () => {
    const exp = '2026-12-31T00:00:00.000Z';
    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');

    // Daily loss >= 5% ($500 on $10,000) -> FAILED
    const failDaily = evaluatePropChallengeMetrics({
      trades: [{ pnlUsd: -520, executedAt: '2026-11-20T10:00:00.000Z' }],
      expiresAt: exp,
      nowMs,
    });
    expect(failDaily.status).toBe('FAILED');
    expect(failDaily.verdictReason).toContain('DAILY_LOSS_BREACHED');

    // Total drawdown >= 10% across 3 days (each <5% daily) -> FAILED
    const failDd = evaluatePropChallengeMetrics({
      trades: [
        { pnlUsd: -400, executedAt: '2026-11-20T10:00:00.000Z' },
        { pnlUsd: -400, executedAt: '2026-11-21T10:00:00.000Z' },
        { pnlUsd: -250, executedAt: '2026-11-22T10:00:00.000Z' },
      ],
      expiresAt: exp,
      nowMs,
    });
    expect(failDd.status).toBe('FAILED');
    expect(failDd.verdictReason).toContain('MAX_DRAWDOWN_BREACHED');

    // +8.5% across 3 distinct days -> PASSED
    const passed = evaluatePropChallengeMetrics({
      trades: [
        { pnlUsd: 300, executedAt: '2026-11-20T10:00:00.000Z' },
        { pnlUsd: 300, executedAt: '2026-11-21T10:00:00.000Z' },
        { pnlUsd: 250, executedAt: '2026-11-22T10:00:00.000Z' },
      ],
      expiresAt: exp,
      nowMs,
    });
    expect(passed.status).toBe('PASSED');
    expect(passed.pnlPct).toBe(8.5);
    expect(passed.tradingDaysCount).toBe(3);
  });

  test('[DG1.2] startPropChallenge deducts 100 cr, blocks duplicate active, and grants +250 cr on pass', async () => {
    const repo = new PostgresBillingDbAdapter({
      getDbPool: () => null,
      ensureUserEntity: async (_p, u) => u,
    });
    const trader = '0x4444444444444444444444444444444444444444';
    await repo.updateUserSubscription(trader, 'FREE'); // 100 cr

    const started = await repo.startPropChallenge({
      walletAddress: trader,
      paymentMode: 'CREDITS',
      paymentRef: 'credits-test-1',
    });
    expect(started.ok).toBe(true);
    expect(await repo.getUserCreditBalance(trader)).toBe(0);

    const dup = await repo.startPropChallenge({
      walletAddress: trader,
      paymentMode: 'ETH',
      paymentRef: `0x${'1'.repeat(64)}`,
    });
    expect(dup.ok).toBe(false);
    expect(dup.code).toBe('ACTIVE_CHALLENGE_EXISTS');

    const evalRes = await repo.evaluatePropChallenge(trader, [
      { pnlUsd: 300, executedAt: '2026-11-20T10:00:00.000Z' },
      { pnlUsd: 300, executedAt: '2026-11-21T10:00:00.000Z' },
      { pnlUsd: 250, executedAt: '2026-11-22T10:00:00.000Z' },
    ]);
    expect(evalRes.ok).toBe(true);
    expect(evalRes.challenge?.status).toBe('PASSED');
    expect(await repo.getUserCreditBalance(trader)).toBe(PROP_CHALLENGE_RULES.passRewardCredits);

    const state = await repo.getPropChallengeState(trader);
    expect(state.verifiedTradersCount).toBe(1);
    expect(state.leaderboard[0].walletAddress).toBe(trader);
  });

  test('[DG1.3] Guest Landing Page & /transparency surface live Genesis Pioneers proof', () => {
    const homeSrc = fs.readFileSync(path.resolve(process.cwd(), 'app/page.tsx'), 'utf8');
    const transApiSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'app/api/system/transparency/route.ts'),
      'utf8'
    );
    expect(homeSrc).toContain('PUBLIC FREE-MINT GENESIS PIONEER SBT');
    expect(transApiSrc).toContain('genesisPioneersMinted');
    expect(transApiSrc).toContain('system:transparency:v4');
  });
});
