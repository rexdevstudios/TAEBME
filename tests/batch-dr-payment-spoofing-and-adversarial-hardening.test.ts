/**
 * Unit Suite #85 — Phase DR:
 * On-Chain Payment Anti-Spoofing Hardening (to/from/value) + Global Cross-Endpoint txHash Anti-Replay.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ethStringToWei,
  validateEvmNativePaymentFields,
} from '../packages/launchpad/evm-verifier';
import { PostgresBillingDbAdapter } from '../packages/db/billing-repo';

describe('Phase DR — On-Chain Payment Anti-Spoofing & Cross-Endpoint Replay Guard', () => {
  const TREASURY = '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6';
  const USER = '0x1111111111111111111111111111111111111111';
  const ATTACKER = '0x9999999999999999999999999999999999999999';

  test('validateEvmNativePaymentFields strictly rejects wrong recipient, wrong sender, and underpayment', () => {
    const minWei = ethStringToWei('0.00018');
    expect(minWei).toBe(BigInt('180000000000000'));

    // 1. Wrong recipient (self-transfer or random contract)
    const wrongTo = validateEvmNativePaymentFields({
      from: USER,
      to: ATTACKER,
      valueWei: minWei,
      expectedFrom: USER,
      expectedTo: TREASURY,
      minValueWei: minWei,
    });
    expect(wrongTo.ok).toBe(false);
    expect(wrongTo.code).toBe('RECIPIENT_MISMATCH');

    // 2. Wrong sender (stolen txHash from BaseScan belonging to someone else)
    const wrongFrom = validateEvmNativePaymentFields({
      from: ATTACKER,
      to: TREASURY,
      valueWei: minWei,
      expectedFrom: USER,
      expectedTo: TREASURY,
      minValueWei: minWei,
    });
    expect(wrongFrom.ok).toBe(false);
    expect(wrongFrom.code).toBe('SENDER_MISMATCH');

    // 3. Underpayment (0 ETH or dust)
    const underpaid = validateEvmNativePaymentFields({
      from: USER,
      to: TREASURY,
      valueWei: BigInt('1000'),
      expectedFrom: USER,
      expectedTo: TREASURY,
      minValueWei: minWei,
    });
    expect(underpaid.ok).toBe(false);
    expect(underpaid.code).toBe('INSUFFICIENT_PAYMENT_VALUE');

    // 4. Valid exact/overpaid transfer (case-insensitive hex matching)
    const ok = validateEvmNativePaymentFields({
      from: USER.toUpperCase().replace('0X', '0x'),
      to: TREASURY.toUpperCase().replace('0X', '0x'),
      valueWei: minWei,
      expectedFrom: USER,
      expectedTo: TREASURY,
      minValueWei: minWei,
    });
    expect(ok.ok).toBe(true);
  });

  test('redeemGlobalPaymentTxHash prevents replaying the same txHash across different endpoints', async () => {
    const adapter = new PostgresBillingDbAdapter();
    const txHash = '0x' + 'c'.repeat(64);

    const first = await adapter.redeemGlobalPaymentTxHash({
      txHash,
      purpose: 'GENESIS_SBT',
      walletAddress: USER,
    });
    expect(first.ok).toBe(true);

    // Attempt cross-endpoint replay on billing/subscribe with same txHash (different casing)
    const replay = await adapter.redeemGlobalPaymentTxHash({
      txHash: txHash.toUpperCase().replace('0X', '0x'),
      purpose: 'SUBSCRIPTION_AGENT',
      walletAddress: USER,
    });
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe('GLOBAL_REPLAY_TX_HASH');
  });

  test('all 5 paid on-chain routes enforce verifyEvmNativePayment and redeemGlobalPaymentTxHash', () => {
    const root = join(import.meta.dir, '..');
    const paidRoutes = [
      'app/api/gamefi/genesis-sbt/route.ts',
      'app/api/launchpad/featured-boost/route.ts',
      'app/api/gamefi/quests/complete/route.ts',
      'app/api/prop/challenge/route.ts',
      'app/api/billing/subscribe/route.ts',
    ];
    for (const rel of paidRoutes) {
      const src = readFileSync(join(root, rel), 'utf8');
      expect(src).toContain('verifyEvmNativePayment');
      expect(src).toContain('redeemGlobalPaymentTxHash');
      expect(src).toContain('platformCfg.treasuryWallet');
    }
  });
});
