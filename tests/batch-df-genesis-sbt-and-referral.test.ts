/**
 * tests/batch-df-genesis-sbt-and-referral.test.ts
 *
 * Phase DF Verification Suite:
 *  - Verifies Free Mint (0 ETH) + 0.00018 ETH (~$0.50) Base Protocol Mint Fee economics
 *  - Verifies anti-self-referral guard & referral URL formatting
 *  - Verifies 1-per-wallet limit, anti-replay txHash, +200 cr minter & +50 cr referrer settlement,
 *    and live Top Genesis Referrers leaderboard aggregation
 */

import { describe, expect, test } from 'bun:test';
import {
  GENESIS_SBT_MINT_PRICE_ETH,
  GENESIS_SBT_PROTOCOL_FEE_ETH,
  GENESIS_SBT_REFERRAL_BONUS_CREDITS,
  GENESIS_SBT_WELCOME_CREDITS,
  buildGenesisReferralUrl,
  normalizeReferrerWallet,
} from '../packages/billing/genesis-sbt';
import { PostgresBillingDbAdapter } from '../packages/db/billing-repo';

describe('Phase DF: Free-Mint Genesis Pioneer SBT (~$0.50 Protocol Fee) & Viral Referral Engine', () => {
  test('[DF1.1] enforces FREE mint price + 0.00018 ETH protocol fee and rejects self-referral', () => {
    expect(GENESIS_SBT_MINT_PRICE_ETH).toBe('0');
    expect(GENESIS_SBT_PROTOCOL_FEE_ETH).toBe('0.00018');
    expect(GENESIS_SBT_WELCOME_CREDITS).toBe(200);
    expect(GENESIS_SBT_REFERRAL_BONUS_CREDITS).toBe(50);

    const w1 = '0x1111111111111111111111111111111111111111';
    const w2 = '0x2222222222222222222222222222222222222222';
    expect(normalizeReferrerWallet(w1, w1)).toBeNull();
    expect(normalizeReferrerWallet(w1.toUpperCase(), w1)).toBeNull();
    expect(normalizeReferrerWallet('invalid', w1)).toBeNull();
    expect(normalizeReferrerWallet(w2, w1)).toBe(w2);
    expect(buildGenesisReferralUrl('https://pndigi.site/', w1)).toBe(
      `https://pndigi.site/?ref=${w1}`
    );
  });

  test('[DF1.2] mints 1 SBT per wallet, blocks replay txHash, credits +200/+50 cr & updates leaderboard', async () => {
    const repo = new PostgresBillingDbAdapter({
      getDbPool: () => null,
      ensureUserEntity: async (_p, u) => u,
    });
    const refWallet = '0x1111111111111111111111111111111111111111';
    const minter1 = '0x2222222222222222222222222222222222222222';
    const minter2 = '0x3333333333333333333333333333333333333333';

    await repo.updateUserSubscription(refWallet, 'FREE');
    await repo.updateUserSubscription(minter1, 'FREE');
    await repo.updateUserSubscription(minter2, 'FREE');

    const tx1 = `0x${'a'.repeat(64)}`;
    const first = await repo.recordGenesisSbtMint({
      walletAddress: minter1,
      txHash: tx1,
      chain: 'base-mainnet',
      referredBy: refWallet,
    });
    expect(first.ok).toBe(true);
    expect(first.pass?.serialNumber).toBe(1);
    expect(first.totalMinted).toBe(1);
    expect(await repo.getUserCreditBalance(minter1)).toBe(300); // 100 FREE + 200 welcome
    expect(await repo.getUserCreditBalance(refWallet)).toBe(150); // 100 FREE + 50 referral

    // Duplicate wallet mint strictly rejected
    const dupWallet = await repo.recordGenesisSbtMint({
      walletAddress: minter1,
      txHash: `0x${'b'.repeat(64)}`,
      chain: 'base-mainnet',
      referredBy: null,
    });
    expect(dupWallet.ok).toBe(false);
    expect(dupWallet.code).toBe('ALREADY_MINTED');

    // Replay txHash strictly rejected
    const replayTx = await repo.recordGenesisSbtMint({
      walletAddress: minter2,
      txHash: tx1,
      chain: 'base-mainnet',
      referredBy: refWallet,
    });
    expect(replayTx.ok).toBe(false);
    expect(replayTx.code).toBe('REPLAY_TX_HASH');

    // Second valid minter via same referrer updates leaderboard to 2 referrals
    const second = await repo.recordGenesisSbtMint({
      walletAddress: minter2,
      txHash: `0x${'c'.repeat(64)}`,
      chain: 'base-mainnet',
      referredBy: refWallet,
    });
    expect(second.ok).toBe(true);
    expect(second.pass?.serialNumber).toBe(2);
    expect(second.leaderboard?.[0]?.walletAddress).toBe(refWallet);
    expect(second.leaderboard?.[0]?.referralsCount).toBe(2);
    expect(second.leaderboard?.[0]?.bonusCreditsEarned).toBe(100);
  });
});
