import { describe, it, expect } from 'bun:test';
import {
  parseBybitKeyPair,
  signBybitV5Get,
  verifyBybitCredentialLive,
  bybitCexAdapter,
} from '../packages/trading/bybit-vault';
import { ProviderRegistry } from '../packages/providers/registry';
import { PostgresBillingDbAdapter } from '../packages/shared/db-pool';

describe('Phase AI: Live Bybit V5 CEX Adapter & Extracted Billing Repo Parity', () => {
  it('[AI1.1] parseBybitKeyPair supports apiKey:secretKey & JSON formats and rejects malformed inputs', () => {
    const pair1 = parseBybitKeyPair('bybitKey12345:bybitSecret98765');
    expect(pair1.apiKey).toBe('bybitKey12345');
    expect(pair1.secretKey).toBe('bybitSecret98765');

    const pair2 = parseBybitKeyPair(JSON.stringify({ apiKey: 'bybitKeyJson1', secretKey: 'bybitSecretJson1' }));
    expect(pair2.apiKey).toBe('bybitKeyJson1');
    expect(pair2.secretKey).toBe('bybitSecretJson1');

    expect(() => parseBybitKeyPair('invalid-no-colon')).toThrow('INVALID_BYBIT_CREDENTIAL');
    expect(() => parseBybitKeyPair('short:123')).toThrow('INVALID_BYBIT_CREDENTIAL');
  });

  it('[AI1.2] verifyBybitCredentialLive signs V5 HMAC-SHA256 headers and detects trade & withdrawal permissions', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const resSafe = await verifyBybitCredentialLive({
      apiKey: 'bybitKey12345',
      secretKey: 'bybitSecret98765',
      environment: 'TESTNET',
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedHeaders = (init?.headers as Record<string, string>) || {};
        return new Response(
          JSON.stringify({
            retCode: 0,
            retMsg: 'OK',
            result: {
              readOnly: 0,
              permissions: {
                Spot: ['SpotTrade'],
                ContractTrade: ['Order'],
                Wallet: ['AccountTransfer'],
              },
            },
          }),
          { status: 200 }
        );
      }) as typeof fetch,
    });

    expect(capturedUrl).toBe('https://api-testnet.bybit.com/v5/user/query-api');
    expect(capturedHeaders['X-BAPI-API-KEY']).toBe('bybitKey12345');
    expect(capturedHeaders['X-BAPI-SIGN']).toBe(
      signBybitV5Get({
        timestamp: capturedHeaders['X-BAPI-TIMESTAMP'],
        apiKey: 'bybitKey12345',
        secretKey: 'bybitSecret98765',
        recvWindow: '5000',
        queryString: '',
      })
    );
    expect(resSafe.connected).toBe(true);
    expect(resSafe.canTrade).toBe(true);
    expect(resSafe.canWithdraw).toBe(false);
    expect(resSafe.securityWarning).toBeUndefined();

    // Withdrawal enabled triggers securityWarning
    const resWarn = await verifyBybitCredentialLive({
      apiKey: 'bybitKey12345',
      secretKey: 'bybitSecret98765',
      environment: 'MAINNET',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            retCode: 0,
            result: {
              readOnly: 0,
              permissions: { Spot: ['SpotTrade'], Wallet: ['Withdraw'] },
            },
          }),
          { status: 200 }
        )) as typeof fetch,
    });
    expect(resWarn.connected).toBe(true);
    expect(resWarn.canWithdraw).toBe(true);
    expect(resWarn.securityWarning).toBe('WITHDRAWAL_ENABLED_ON_EXCHANGE');
  });

  it('[AI1.3] ProviderRegistry promotes BYBIT to LIVE and bybitCexAdapter satisfies contract', () => {
    const bybit = ProviderRegistry.getById('BYBIT');
    expect(bybit?.status).toBe('LIVE');
    expect(bybit?.category).toBe('CEX');
    expect(bybitCexAdapter.providerId).toBe('BYBIT');
  });

  it('[AI2.1] Extracted PostgresBillingDbAdapter preserves subscription, risk policy & AI weight normalization parity', async () => {
    const adapter = new PostgresBillingDbAdapter();
    adapter.seedSubscription('sim-billing-user', { planId: 'TRADER', credits: 5000 });
    expect(await adapter.getUserPlan('sim-billing-user')).toBe('TRADER');

    const cfg = await adapter.setPlatformFeeAndRiskConfig({
      actorId: 'admin',
      aiFeatureWeights: { arkham: 2, firecrawl: 2, ohlcv: 1, defillama: 0 },
    });
    expect(cfg.aiFeatureWeights?.arkham).toBe(0.4);
    expect(cfg.aiFeatureWeights?.firecrawl).toBe(0.4);
    expect(cfg.aiFeatureWeights?.ohlcv).toBe(0.2);
  });
});
