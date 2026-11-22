/**
 * tests/batch-ak-bybit-spot-execution-and-venue-routing.test.ts
 *
 * Phase AK Unit Tests:
 * 1. Credential Vault `testnet`/`mainnet` chainScope support & strict blast-radius isolation.
 * 2. Bybit V5 POST HMAC-SHA256 signing & stateless Spot Order submission (`submitBybitSpotOrder`).
 * 3. Soft-Freeze Mainnet locking (`FROZEN_MAINNET_LOCKED`) for Bybit Mainnet keys on non-TRADER tiers.
 */

import { describe, it, expect } from 'bun:test';
import crypto from 'crypto';
import {
  validateChainScope,
  assertChainScopeMatches,
} from '../packages/shared/credential-vault';
import {
  signBybitV5Post,
  submitBybitSpotOrder,
} from '../packages/trading/bybit-vault';
import {
  annotateKeysWithQuotaStatus,
  computeEffectiveVaultCapacity,
} from '../packages/billing/subscriptions-engine';

describe('Phase AK — Bybit V5 Spot Execution, Scope Isolation & Soft-Freeze', () => {
  it('accepts testnet and mainnet in validateChainScope while preserving strict chain isolation', () => {
    expect(validateChainScope('testnet')).toBe('testnet');
    expect(validateChainScope('MAINNET')).toBe('mainnet');
    expect(() => validateChainScope('invalid-net')).toThrow('INVALID_CHAIN_SCOPE');

    // Cross-lookup with targetChain='all' (used by verify/execute resolvers) succeeds
    expect(() => assertChainScopeMatches('testnet', 'all')).not.toThrow();
    expect(() => assertChainScopeMatches('mainnet', 'all')).not.toThrow();

    // Strict isolation remains enforced for concrete targets
    expect(() => assertChainScopeMatches('base', 'robinhood')).toThrow('CHAIN_SCOPE_MISMATCH');
    expect(() => assertChainScopeMatches('testnet', 'mainnet')).toThrow('CHAIN_SCOPE_MISMATCH');
  });

  it('computes deterministic Bybit V5 POST HMAC-SHA256 signature', () => {
    const timestamp = '1732200000000';
    const apiKey = 'bybit_test_key_123456';
    const secretKey = 'bybit_test_secret_abcdef';
    const recvWindow = '5000';
    const rawBody = JSON.stringify({ category: 'spot', symbol: 'BTCUSDT', side: 'Buy', orderType: 'Market', qty: '0.01' });

    const expected = crypto
      .createHmac('sha256', secretKey)
      .update(`${timestamp}${apiKey}${recvWindow}${rawBody}`)
      .digest('hex');

    const actual = signBybitV5Post({ timestamp, apiKey, secretKey, recvWindow, rawBody });
    expect(actual).toBe(expected);
  });

  it('submits Spot MARKET order to Bybit V5 Testnet with marketUnit=baseCoin and headers', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init?.body || '{}'));
      capturedHeaders = init?.headers || {};
      return new Response(
        JSON.stringify({
          retCode: 0,
          retMsg: 'OK',
          result: { orderId: 'bybit-ord-9901', orderLinkId: 'exec-ak-1' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const res = await submitBybitSpotOrder({
      apiKey: 'bybit_api_key_9999',
      secretKey: 'bybit_secret_9999',
      environment: 'TESTNET',
      symbol: 'BTC/USDT',
      side: 'BUY',
      orderType: 'MARKET',
      qty: 0.05,
      orderLinkId: 'exec-ak-1',
      fetchImpl: mockFetch,
    });

    expect(res.submitted).toBe(true);
    expect(res.orderId).toBe('bybit-ord-9901');
    expect(capturedUrl).toBe('https://api-testnet.bybit.com/v5/order/create');
    expect(capturedBody.symbol).toBe('BTCUSDT');
    expect(capturedBody.category).toBe('spot');
    expect(capturedBody.side).toBe('Buy');
    expect(capturedBody.orderType).toBe('Market');
    expect(capturedBody.marketUnit).toBe('baseCoin');
    expect(capturedHeaders['X-BAPI-API-KEY']).toBe('bybit_api_key_9999');
    expect(capturedHeaders['X-BAPI-SIGN']?.length).toBe(64);
  });

  it('handles Bybit V5 exchange rejection and network timeout gracefully without throwing', async () => {
    const rejectFetch = (async () =>
      new Response(JSON.stringify({ retCode: 170131, retMsg: 'Insufficient balance' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    const rejected = await submitBybitSpotOrder({
      apiKey: 'bybit_api_key_9999',
      secretKey: 'bybit_secret_9999',
      environment: 'MAINNET',
      symbol: 'ETHUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      qty: 1,
      price: 3500,
      orderLinkId: 'exec-ak-2',
      fetchImpl: rejectFetch,
    });
    expect(rejected.submitted).toBe(false);
    expect(rejected.error).toContain('170131');

    const timeoutFetch = (async () => {
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof fetch;

    const timedOut = await submitBybitSpotOrder({
      apiKey: 'bybit_api_key_9999',
      secretKey: 'bybit_secret_9999',
      environment: 'TESTNET',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      qty: 0.01,
      orderLinkId: 'exec-ak-3',
      fetchImpl: timeoutFetch,
    });
    expect(timedOut.submitted).toBe(false);
    expect(timedOut.error).toBe('BYBIT_TIMEOUT');
  });

  it('locks Bybit Mainnet keys as FROZEN_MAINNET_LOCKED on FREE/CREATOR and unlocks on TRADER', () => {
    const keys = [
      { id: 'bybit-main', isDefault: true, createdAt: '2026-11-22T00:00:00Z', environment: 'MAINNET' as const },
      { id: 'bybit-test', isDefault: false, createdAt: '2026-11-21T00:00:00Z', environment: 'TESTNET' as const },
    ];

    const freeCap = computeEffectiveVaultCapacity('FREE', { bankrExtraSlots: 0, binanceExtraSlots: 0 });
    const onFree = annotateKeysWithQuotaStatus(keys, {
      maxActive: freeCap.maxBinanceAccounts,
      allowMainnet: freeCap.allowMainnetBinance,
    });
    expect(onFree.find((k) => k.id === 'bybit-main')?.quotaStatus).toBe('FROZEN_MAINNET_LOCKED');
    expect(onFree.find((k) => k.id === 'bybit-test')?.quotaStatus).toBe('ACTIVE');

    const traderCap = computeEffectiveVaultCapacity('TRADER', { bankrExtraSlots: 0, binanceExtraSlots: 0 });
    const onTrader = annotateKeysWithQuotaStatus(keys, {
      maxActive: traderCap.maxBinanceAccounts,
      allowMainnet: traderCap.allowMainnetBinance,
    });
    expect(onTrader.find((k) => k.id === 'bybit-main')?.quotaStatus).toBe('ACTIVE');
  });
});
