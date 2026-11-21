import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  SubscriptionsEngine,
  annotateKeysWithQuotaStatus,
  computeEffectiveVaultCapacity,
  CAPACITY_ADDON_CATALOG,
} from '../packages/billing/subscriptions-engine';
import { GET as getAddons, POST as postAddons } from '../app/api/billing/addons/route';

describe('Phase S1–S4: Over-Quota Soft-Freeze, Deployer Capacity & Permanent Add-On Slots (6 Scenarios)', () => {
  it('[S1] Deployer (CREATOR) & AGENT capacities upgraded cleanly in SSOT', () => {
    const creator = SubscriptionsEngine.getPlanCapacities('CREATOR');
    const agent = SubscriptionsEngine.getPlanCapacities('AGENT');
    expect(creator.maxBankrKeys).toBe(15);
    expect(creator.monthlyCredits).toBe(5000);
    expect(agent.maxBankrKeys).toBe(25);
    expect(agent.maxBinanceAccounts).toBe(15);
  });

  it('[S2] Scenario 2: Downgrade CREATOR (12 Bankr keys) -> FREE (max 1) soft-freezes keys #2..#12 with zero data loss', () => {
    const keys = Array.from({ length: 12 }, (_, i) => ({
      id: `key-${i + 1}`,
      isDefault: i === 0,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const freeCap = computeEffectiveVaultCapacity('FREE', { bankrExtraSlots: 0 });
    const annotated = annotateKeysWithQuotaStatus(keys, { maxActive: freeCap.maxBankrKeys });

    expect(annotated.length).toBe(12); // Zero data loss
    expect(annotated[0].id).toBe('key-1');
    expect(annotated[0].quotaStatus).toBe('ACTIVE');
    for (let i = 1; i < 12; i++) {
      expect(annotated[i].quotaStatus).toBe('FROZEN_OVER_QUOTA');
    }
  });

  it('[S3] Scenario 3: Permanent +5 Bankr Add-On survives downgrade to FREE (1 base + 5 permanent = 6 ACTIVE)', () => {
    const keys = Array.from({ length: 8 }, (_, i) => ({
      id: `key-${i + 1}`,
      isDefault: i === 0,
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const cap = computeEffectiveVaultCapacity('FREE', {
      bankrExtraSlots: CAPACITY_ADDON_CATALOG.ADDON_BANKR_SLOTS.slotsAdded,
    });
    expect(cap.maxBankrKeys).toBe(6);

    const annotated = annotateKeysWithQuotaStatus(keys, { maxActive: cap.maxBankrKeys });
    const activeCount = annotated.filter((k) => k.quotaStatus === 'ACTIVE').length;
    const frozenCount = annotated.filter((k) => k.quotaStatus === 'FROZEN_OVER_QUOTA').length;
    expect(activeCount).toBe(6);
    expect(frozenCount).toBe(2);
  });

  it('[S4] Scenario 4: Downgrade TRADER (3 Mainnet + 1 Testnet Binance) -> FREE freezes 3 Mainnet & keeps 1 Testnet ACTIVE', () => {
    const accounts = [
      { id: 'main-1', isDefault: true, environment: 'MAINNET' as const, createdAt: '2026-11-20T00:00:00Z' },
      { id: 'main-2', isDefault: false, environment: 'MAINNET' as const, createdAt: '2026-11-19T00:00:00Z' },
      { id: 'main-3', isDefault: false, environment: 'MAINNET' as const, createdAt: '2026-11-18T00:00:00Z' },
      { id: 'test-1', isDefault: false, environment: 'TESTNET' as const, createdAt: '2026-11-17T00:00:00Z' },
    ];
    const freeCap = computeEffectiveVaultCapacity('FREE', { binanceExtraSlots: 0 });
    const annotated = annotateKeysWithQuotaStatus(accounts, {
      maxActive: freeCap.maxBinanceAccounts,
      allowMainnet: freeCap.allowMainnetBinance,
    });

    expect(annotated.find((a) => a.id === 'main-1')?.quotaStatus).toBe('FROZEN_MAINNET_LOCKED');
    expect(annotated.find((a) => a.id === 'main-2')?.quotaStatus).toBe('FROZEN_MAINNET_LOCKED');
    expect(annotated.find((a) => a.id === 'main-3')?.quotaStatus).toBe('FROZEN_MAINNET_LOCKED');
    expect(annotated.find((a) => a.id === 'test-1')?.quotaStatus).toBe('ACTIVE');
  });

  it('[S5] Scenario 5: Swapping Default Key during Over-Quota moves the ACTIVE slot to the chosen key', () => {
    const keys = [
      { id: 'key-1', isDefault: false, createdAt: '2026-11-20T00:00:00Z' },
      { id: 'key-2', isDefault: false, createdAt: '2026-11-19T00:00:00Z' },
      { id: 'key-3', isDefault: true, createdAt: '2026-11-18T00:00:00Z' },
    ];
    const annotated = annotateKeysWithQuotaStatus(keys, { maxActive: 1 });
    expect(annotated[0].id).toBe('key-3');
    expect(annotated[0].quotaStatus).toBe('ACTIVE');
    expect(annotated.find((k) => k.id === 'key-1')?.quotaStatus).toBe('FROZEN_OVER_QUOTA');
  });

  it('[S6] GET & POST /api/billing/addons fail closed (401) without SIWE session', async () => {
    const getRes = await getAddons(new NextRequest('http://localhost/api/billing/addons', { method: 'GET' }));
    expect(getRes.status).toBe(401);

    const postRes = await postAddons(
      new NextRequest('http://localhost/api/billing/addons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addonType: 'ADDON_BANKR_SLOTS' }),
      })
    );
    expect(postRes.status).toBe(401);
  });
});
