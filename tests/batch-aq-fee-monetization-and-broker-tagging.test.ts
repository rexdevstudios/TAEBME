/**
 * tests/batch-aq-fee-monetization-and-broker-tagging.test.ts
 *
 * Phase AQ Unit Tests:
 * 1. Env-driven CEX Broker tagging (`formatBrokerOrderId`, `resolveBybitBrokerReferer`, `X-BAPI-REFERER` header).
 * 2. Transparent DEX Partner Fee payload (`buildDexPartnerFeePayload` -> 0x Swap v2 params, 0..100 bps clamp).
 * 3. Bankr platform-key default feeRecipient fallback (`resolveBankrEffectiveFeeRecipient`).
 * 4. `PostgresBillingDbAdapter.setPlatformFeeAndRiskConfig` persists & clamps `dexSwapFeeBps`.
 */

import { describe, it, expect } from 'bun:test';
import {
  formatBrokerOrderId,
  resolveBybitBrokerReferer,
  buildDexPartnerFeePayload,
  resolveBankrEffectiveFeeRecipient,
} from '../packages/trading/fee-monetization';
import { submitBybitSpotOrder } from '../packages/trading/bybit-vault';
import { PostgresBillingDbAdapter } from '../packages/db/billing-repo';

describe('Phase AQ — Transaction Fee Monetization & Env-Driven Broker Tagging', () => {
  it('formats CEX broker clientOrderId safely within 36 chars', () => {
    expect(formatBrokerOrderId('exec-123456', '')).toBe('exec-123456');
    const prefixed = formatBrokerOrderId('exec-123456789012345678901234567890', 'x-RTRADER');
    expect(prefixed.startsWith('x-RTRADER-')).toBe(true);
    expect(prefixed.length).toBeLessThanOrEqual(36);
  });

  it('injects X-BAPI-REFERER header on Bybit Spot order only when configured', async () => {
    let headersWithRef: Record<string, string> = {};
    let headersWithoutRef: Record<string, string> = {};

    const mkFetch = (sink: (h: Record<string, string>) => void) =>
      (async (_url: any, init: any) => {
        sink(init?.headers || {});
        return new Response(JSON.stringify({ retCode: 0, result: { orderId: 'ord-aq-1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof fetch;

    await submitBybitSpotOrder({
      apiKey: 'bybit_key_123456',
      secretKey: 'bybit_sec_123456',
      environment: 'TESTNET',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      qty: 0.01,
      orderLinkId: 'aq-order-1',
      brokerReferer: 'RTRADER_BRK',
      fetchImpl: mkFetch((h) => { headersWithRef = h; }),
    });
    expect(headersWithRef['X-BAPI-REFERER']).toBe('RTRADER_BRK');

    await submitBybitSpotOrder({
      apiKey: 'bybit_key_123456',
      secretKey: 'bybit_sec_123456',
      environment: 'TESTNET',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      qty: 0.01,
      orderLinkId: 'aq-order-2',
      brokerReferer: '',
      fetchImpl: mkFetch((h) => { headersWithoutRef = h; }),
    });
    expect(headersWithoutRef['X-BAPI-REFERER']).toBeUndefined();
    expect(resolveBybitBrokerReferer('  ')).toBeUndefined();
  });

  it('builds clamped 0x-compatible DEX partner fee payload directed to treasuryWallet', () => {
    const customTreasury = '0x1111111111111111111111111111111111111111';
    const fee = buildDexPartnerFeePayload({
      dexSwapFeeBps: 35,
      treasuryWallet: customTreasury,
      chainId: 8453,
    });
    expect(fee.feeBps).toBe(35);
    expect(fee.feePct).toBe(0.35);
    expect(fee.feeRecipient).toBe(customTreasury);
    expect(fee.zeroXSwapParams).toEqual({
      swapFeeBps: '35',
      swapFeeRecipient: customTreasury,
    });

    // Hard cap at 100 bps (1.00%)
    const clamped = buildDexPartnerFeePayload({ dexSwapFeeBps: 500 });
    expect(clamped.feeBps).toBe(100);
  });

  it('defaults Bankr feeRecipient to treasury only on PLATFORM_DEFAULT key when omitted', () => {
    const treasury = '0x2222222222222222222222222222222222222222';
    const userWallet = { type: 'wallet', value: '0x3333333333333333333333333333333333333333' };

    expect(
      resolveBankrEffectiveFeeRecipient({
        requestedFeeRecipient: undefined,
        usingPlatformDefaultKey: true,
        treasuryWallet: treasury,
      })
    ).toEqual({ type: 'wallet', value: treasury });

    expect(
      resolveBankrEffectiveFeeRecipient({
        requestedFeeRecipient: userWallet,
        usingPlatformDefaultKey: true,
        treasuryWallet: treasury,
      })
    ).toEqual(userWallet);

    expect(
      resolveBankrEffectiveFeeRecipient({
        requestedFeeRecipient: undefined,
        usingPlatformDefaultKey: false,
        treasuryWallet: treasury,
      })
    ).toBeUndefined();
  });

  it('persists and clamps dexSwapFeeBps in PostgresBillingDbAdapter platform config', async () => {
    const billing = new PostgresBillingDbAdapter();
    const updated = await billing.setPlatformFeeAndRiskConfig({
      dexSwapFeeBps: 40,
      actorId: 'admin-aq-test',
    });
    expect(updated.dexSwapFeeBps).toBe(40);

    const capped = await billing.setPlatformFeeAndRiskConfig({
      dexSwapFeeBps: 999,
      actorId: 'admin-aq-test',
    });
    expect(capped.dexSwapFeeBps).toBe(100);
  });
});
