import { describe, it, expect, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { SubscriptionsEngine } from '../packages/billing/subscriptions-engine';
import { PostgresBinanceExecutionDbAdapter } from '../packages/shared/db-pool';
import { verifyBinanceCredentialLive } from '../packages/trading/binance-vault';
import { GET as getBillingPlans } from '../app/api/billing/plans/route';
import { POST as verifyBinanceRoute } from '../app/api/user/binance-credentials/verify/route';

describe('Phase Q1–Q3: Billing Capacity SSOT, Tier Quotas & Binance Live Ping Verifier', () => {
  const TEST_MASTER_KEY = 'b'.repeat(64);
  const USER_FREE = '0x3333333333333333333333333333333333333333';

  beforeEach(() => {
    // Clean per-test isolation
  });

  it('[Q1.1] SubscriptionsEngine.getPlanCapacities returns canonical tiered capacities across all 4 plans', () => {
    const freeCap = SubscriptionsEngine.getPlanCapacities('FREE');
    const creatorCap = SubscriptionsEngine.getPlanCapacities('CREATOR');
    const traderCap = SubscriptionsEngine.getPlanCapacities('TRADER');
    const agentCap = SubscriptionsEngine.getPlanCapacities('AGENT');

    expect(freeCap.maxBankrKeys).toBe(1);
    expect(freeCap.maxBinanceAccounts).toBe(1);
    expect(freeCap.allowMainnetBinance).toBe(false);
    expect(freeCap.maxOrderValueUsd).toBe(250);

    expect(creatorCap.maxBankrKeys).toBe(15);
    expect(creatorCap.maxBinanceAccounts).toBe(2);
    expect(creatorCap.allowMainnetBinance).toBe(false);

    expect(traderCap.maxBankrKeys).toBe(3);
    expect(traderCap.maxBinanceAccounts).toBe(5);
    expect(traderCap.allowMainnetBinance).toBe(true);
    expect(traderCap.maxOrderValueUsd).toBe(10000);

    expect(agentCap.maxBankrKeys).toBe(25);
    expect(agentCap.maxBinanceAccounts).toBe(15);
    expect(agentCap.allowMainnetBinance).toBe(true);
    expect(agentCap.maxOrderValueUsd).toBe(25000);
  });

  it('[Q1.2] GET /api/billing/plans exposes capacities object for all 4 canonical tiers', async () => {
    const res = await getBillingPlans();
    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.success).toBe(true);
    const plans = Array.isArray(json.data) ? json.data : json.data?.plans;
    expect(Array.isArray(plans)).toBe(true);
    expect(plans.length).toBe(4);
    for (const plan of plans) {
      expect(plan.capacities).toBeDefined();
      expect(typeof plan.capacities.maxBankrKeys).toBe('number');
      expect(typeof plan.capacities.maxBinanceAccounts).toBe('number');
      expect(typeof plan.capacities.allowMainnetBinance).toBe('boolean');
      expect(typeof plan.capacities.maxOrderValueUsd).toBe('number');
    }
  });

  it('[Q1.3] Tier quota enforcement blocks adding beyond plan maxAllowed (e.g. FREE max 1 Binance account)', async () => {
    const adapter = new PostgresBinanceExecutionDbAdapter(null, { inMemory: true });
    adapter.clearInMemoryState();
    const freeCap = SubscriptionsEngine.getPlanCapacities('FREE');

    await adapter.addBinanceCredential({
      userId: USER_FREE,
      label: 'Free Testnet 1',
      rawApiKey: 'bn_free_key_11112222',
      rawSecretKey: 'bn_free_sec_33334444',
      environment: 'TESTNET',
      maxAllowed: freeCap.maxBinanceAccounts,
      customMasterKeyHex: TEST_MASTER_KEY,
    });

    await expect(
      adapter.addBinanceCredential({
        userId: USER_FREE,
        label: 'Free Testnet 2',
        rawApiKey: 'bn_free_key_55556666',
        rawSecretKey: 'bn_free_sec_77778888',
        environment: 'TESTNET',
        maxAllowed: freeCap.maxBinanceAccounts,
        customMasterKeyHex: TEST_MASTER_KEY,
      })
    ).rejects.toThrow(/MAX_KEYS_REACHED/);
  });

  it('[Q2.1] verifyBinanceCredentialLive validates HMAC-SHA256 ping, trade/withdraw flags, and Binance errors', async () => {
    let capturedUrl = '';
    let capturedApiKey = '';
    const okFetch = (async (url: any, init?: any) => {
      capturedUrl = String(url);
      capturedApiKey = init?.headers?.['X-MBX-APIKEY'] || '';
      return new Response(
        JSON.stringify({ canTrade: true, canWithdraw: false, accountType: 'SPOT' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as unknown as typeof fetch;

    const okRes = await verifyBinanceCredentialLive({
      apiKey: 'bn_test_ping_key_1234',
      secretKey: 'bn_test_ping_secret_5678',
      environment: 'TESTNET',
      fetchImpl: okFetch,
    });
    expect(capturedUrl).toContain('https://testnet.binance.vision/api/v3/account?');
    expect(capturedUrl).toContain('signature=');
    expect(capturedApiKey).toBe('bn_test_ping_key_1234');
    expect(okRes.connected).toBe(true);
    expect(okRes.canTrade).toBe(true);
    expect(okRes.canWithdraw).toBe(false);
    expect(okRes.securityWarning).toBeUndefined();

    // Case 2: Exchange reports withdrawal enabled -> triggers security warning
    const warnFetch = (async () =>
      new Response(
        JSON.stringify({ canTrade: true, canWithdraw: true, accountType: 'SPOT' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch;
    const warnRes = await verifyBinanceCredentialLive({
      apiKey: 'bn_warn_key_1234',
      secretKey: 'bn_warn_sec_5678',
      environment: 'MAINNET',
      fetchImpl: warnFetch,
    });
    expect(warnRes.connected).toBe(true);
    expect(warnRes.canWithdraw).toBe(true);
    expect(warnRes.securityWarning).toBe('WITHDRAWAL_ENABLED_ON_EXCHANGE');

    // Case 3: Binance API rejects invalid key (-2015)
    const errFetch = (async () =>
      new Response(
        JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch;
    const errRes = await verifyBinanceCredentialLive({
      apiKey: 'bn_bad_key_1234',
      secretKey: 'bn_bad_sec_5678',
      environment: 'TESTNET',
      fetchImpl: errFetch,
    });
    expect(errRes.connected).toBe(false);
    expect(errRes.error).toContain('-2015');
  });

  it('[Q2.2] POST /api/user/binance-credentials/verify fails closed (401) without SIWE session', async () => {
    const res = await verifyBinanceRoute(
      new NextRequest('http://localhost/api/user/binance-credentials/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentialId: '00000000-0000-0000-0000-000000000001' }),
      })
    );
    expect(res.status).toBe(401);
  });
});
