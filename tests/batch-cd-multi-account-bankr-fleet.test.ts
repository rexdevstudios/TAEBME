import { describe, expect, test } from 'bun:test';
import {
  MAX_BANKR_BATCH_ACCOUNTS,
  validateBankrMultiAccountBatch,
} from '../packages/launchpad/bankr-client';

describe('Phase CD: Sequential Multi-Account Bankr Fleet Deploy Guard', () => {
  test('CD1.1 blocks multi-account batch on FREE & TRADER plans (exclusive to CREATOR & AGENT)', () => {
    const freeRes = validateBankrMultiAccountBatch({
      providerKeyIds: ['key-1', 'key-2'],
      planId: 'FREE',
      launchCostCr: 50,
      userCreditBalance: 500,
    });
    expect(freeRes.valid).toBe(false);
    expect(freeRes.errorCode).toBe('PLAN_MULTI_BANKR_REQUIRED');

    const traderRes = validateBankrMultiAccountBatch({
      providerKeyIds: ['key-1', 'key-2'],
      planId: 'TRADER',
      launchCostCr: 50,
      userCreditBalance: 500,
    });
    expect(traderRes.valid).toBe(false);
    expect(traderRes.errorCode).toBe('PLAN_MULTI_BANKR_REQUIRED');
  });

  test('CD1.2 enforces MAX_BANKR_BATCH_ACCOUNTS (5), deduplicates IDs, and validates upfront credits', () => {
    expect(MAX_BANKR_BATCH_ACCOUNTS).toBe(5);

    const tooMany = validateBankrMultiAccountBatch({
      providerKeyIds: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'],
      planId: 'CREATOR',
      launchCostCr: 50,
      userCreditBalance: 5000,
    });
    expect(tooMany.valid).toBe(false);
    expect(tooMany.errorCode).toBe('BATCH_LIMIT_EXCEEDED');

    const lowCredit = validateBankrMultiAccountBatch({
      providerKeyIds: ['k1', 'k2', 'k3'],
      planId: 'CREATOR',
      launchCostCr: 50,
      userCreditBalance: 100, // needs 150
    });
    expect(lowCredit.valid).toBe(false);
    expect(lowCredit.errorCode).toBe('INSUFFICIENT_CREDITS');
    expect(lowCredit.requiredCredits).toBe(150);

    const ok = validateBankrMultiAccountBatch({
      providerKeyIds: ['k1', 'k2', 'k2', 'PLATFORM_DEFAULT', 'k3'],
      planId: 'AGENT',
      launchCostCr: 50,
      userCreditBalance: 500,
    });
    expect(ok.valid).toBe(true);
    expect(ok.dedupedKeyIds).toEqual(['k1', 'k2', 'k3']);
    expect(ok.requiredCredits).toBe(150);
  });
});
