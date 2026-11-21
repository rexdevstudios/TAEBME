import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { computeEffectiveUserRiskLimits } from '../packages/billing/subscriptions-engine';
import { PostgresBinanceExecutionDbAdapter } from '../packages/shared/db-pool';
import { GET as getRiskPolicy, PUT as putRiskPolicy } from '../app/api/user/risk-policy/route';

describe('Phase R1–R3: Per-User Clamped Risk Policy & Vault Usage Telemetry', () => {
  it('[R2.1] computeEffectiveUserRiskLimits clamps user limits against tier ceiling and platform global cap', () => {
    // FREE user attempts to raise maxOrder to $5,000 -> clamped to FREE ceiling ($250)
    const freeClamped = computeEffectiveUserRiskLimits({
      planId: 'FREE',
      userPolicy: {
        maxOrderValueUsd: 5000,
        maxDailyLossUsd: 900,
        maxSlippagePct: 8.0,
        allowedSymbols: ['btcusdt', ' ethusdt ', 'BTCUSDT'],
      },
      platformGlobalCap: { maxOrderValueUsd: 10000, maxDailyLossUsd: 1000, maxSlippagePct: 3.0 },
    });
    expect(freeClamped.planId).toBe('FREE');
    expect(freeClamped.maxOrderValueUsd).toBe(250);
    expect(freeClamped.maxDailyLossUsd).toBe(50);
    expect(freeClamped.maxSlippagePct).toBe(3.0);
    expect(freeClamped.allowedSymbols).toEqual(['BTCUSDT', 'ETHUSDT']);

    // AGENT user tightens limit to $500 / $100 / 0.5% -> respected (below tier ceiling & global cap)
    const agentTight = computeEffectiveUserRiskLimits({
      planId: 'AGENT',
      userPolicy: {
        maxOrderValueUsd: 500,
        maxDailyLossUsd: 100,
        maxSlippagePct: 0.5,
      },
      platformGlobalCap: { maxOrderValueUsd: 25000, maxDailyLossUsd: 5000, maxSlippagePct: 3.0 },
    });
    expect(agentTight.planId).toBe('AGENT');
    expect(agentTight.maxOrderValueUsd).toBe(500);
    expect(agentTight.maxDailyLossUsd).toBe(100);
    expect(agentTight.maxSlippagePct).toBe(0.5);
  });

  it('[R2.2] GET & PUT /api/user/risk-policy fail closed (401) without SIWE session', async () => {
    const getRes = await getRiskPolicy(new NextRequest('http://localhost/api/user/risk-policy', { method: 'GET' }));
    expect(getRes.status).toBe(401);

    const putRes = await putRiskPolicy(
      new NextRequest('http://localhost/api/user/risk-policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxOrderValueUsd: 100, maxDailyLossUsd: 25, maxSlippagePct: 1.0 }),
      })
    );
    expect(putRes.status).toBe(401);
  });

  it('[R3.1] touchBinanceCredentialLastUsed updates lastUsedAt telemetry accurately', async () => {
    const adapter = new PostgresBinanceExecutionDbAdapter(null, { inMemory: true });
    adapter.clearInMemoryState();
    const user = '0x4444444444444444444444444444444444444444';
    const created = await adapter.addBinanceCredential({
      userId: user,
      label: 'Telemetry Test Account',
      rawApiKey: 'bn_tele_key_12345678',
      rawSecretKey: 'bn_tele_sec_87654321',
      environment: 'TESTNET',
      customMasterKeyHex: 'c'.repeat(64),
    });
    expect(created.lastUsedAt).toBeNull();

    await adapter.touchBinanceCredentialLastUsed(created.id);
    const list = await adapter.listBinanceCredentials(user);
    expect(list.length).toBe(1);
    expect(typeof list[0].lastUsedAt).toBe('string');
    expect(Number.isNaN(Date.parse(list[0].lastUsedAt!))).toBe(false);
  });
});
