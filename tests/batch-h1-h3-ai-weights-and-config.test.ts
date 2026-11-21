import { describe, it, expect, spyOn, afterEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { PostgresBillingDbAdapter } from '../packages/shared/db-pool';
import { FeatureEngine } from '../packages/intelligence/feature-engine';
import { IntelligenceCache } from '../packages/intelligence/market-data-cache';
import * as sessionMod from '../packages/auth/session';
import { POST as postBillingPlans, GET as getBillingPlans } from '../app/api/billing/plans/route';

describe('Phase H1–H3 — AI Feature Weights SSOT & Platform Config Synchronization', () => {
  const spies: Array<{ mockRestore: () => void }> = [];

  afterEach(() => {
    while (spies.length > 0) {
      spies.pop()?.mockRestore();
    }
  });

  it('H1.1 — normalizes and persists aiFeatureWeights to sum 1.0 in PostgresBillingDbAdapter', async () => {
    const adapter = new PostgresBillingDbAdapter();
    const updated = await adapter.setPlatformFeeAndRiskConfig({
      aiFeatureWeights: { arkham: 50, firecrawl: 20, ohlcv: 20, defillama: 10 },
      actorId: 'usr-admin-test',
    });

    expect(updated.aiFeatureWeights).toBeDefined();
    expect(updated.aiFeatureWeights!.arkham).toBeCloseTo(0.5, 3);
    expect(updated.aiFeatureWeights!.firecrawl).toBeCloseTo(0.2, 3);
    expect(updated.aiFeatureWeights!.ohlcv).toBeCloseTo(0.2, 3);
    expect(updated.aiFeatureWeights!.defillama).toBeCloseTo(0.1, 3);

    const fetched = await adapter.getPlatformFeeAndRiskConfig();
    expect(fetched.aiFeatureWeights!.arkham).toBeCloseTo(0.5, 3);
  });

  it('H1.2 — FeatureEngine.computeSignal stays 100% backward-compatible with default weights and scales with custom weights', () => {
    const cache = new IntelligenceCache();
    const bullishMacro = {
      macroSentiment: 'BULLISH' as const,
      totalDefiTvlUsd: 80_000_000_000,
      topChains: [{ chainName: 'Base', tvlUsd: 10_000_000_000 }],
      fetchedAt: new Date().toISOString(),
    };

    const baseline = FeatureEngine.computeSignal('BTCUSDT', cache, null, null, bullishMacro);
    const explicitDefault = FeatureEngine.computeSignal('BTCUSDT', cache, null, null, bullishMacro, {
      arkham: 0.35,
      firecrawl: 0.25,
      ohlcv: 0.25,
      defillama: 0.15,
    });
    expect(explicitDefault.computedConfidenceScore).toBe(baseline.computedConfidenceScore);

    const boostedMacro = FeatureEngine.computeSignal('BTCUSDT', cache, null, null, bullishMacro, {
      arkham: 0.1,
      firecrawl: 0.1,
      ohlcv: 0.05,
      defillama: 0.75,
    });
    expect(boostedMacro.computedConfidenceScore).toBeGreaterThan(baseline.computedConfidenceScore);
    expect(boostedMacro.computedConfidenceScore).toBeLessThanOrEqual(1.0);
  });

  it('H1.3 — POST /api/billing/plans rejects unauthenticated update-platform-config (401) and persists for SUPER_ADMIN', async () => {
    const unauthReq = new NextRequest('http://localhost:3000/api/billing/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'update-platform-config',
        aiFeatureWeights: { arkham: 0.4, firecrawl: 0.2, ohlcv: 0.2, defillama: 0.2 },
      }),
    });
    const unauthRes = await postBillingPlans(unauthReq);
    expect(unauthRes.status).toBe(401);

    spies.push(
      spyOn(sessionMod, 'requireCapability').mockResolvedValue({
        user: { userId: 'usr-super-admin', roles: ['SUPER_ADMIN'], status: 'ACTIVE' },
        walletAddress: '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6',
        token: 'mock-token',
        issuedAt: Date.now(),
      })
    );

    const adminReq = new NextRequest('http://localhost:3000/api/billing/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'update-platform-config',
        aiFeatureWeights: { arkham: 0.4, firecrawl: 0.2, ohlcv: 0.2, defillama: 0.2 },
      }),
    });
    const adminRes = await postBillingPlans(adminReq);
    expect(adminRes.status).toBe(200);
    const adminJson = await adminRes.json();
    expect(adminJson.success).toBe(true);
    expect(adminJson.data.aiFeatureWeights.arkham).toBeCloseTo(0.4, 3);

    const getRes = await getBillingPlans();
    const getJson = await getRes.json();
    expect(getJson.platformConfig.aiFeatureWeights.arkham).toBeCloseTo(0.4, 3);
  });
});
