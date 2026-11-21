import { describe, it, expect, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET as plansGET, POST as plansPOST } from '../app/api/billing/plans/route';
import { POST as subscribePOST } from '../app/api/billing/subscribe/route';
import { GET as ledgerGET } from '../app/api/billing/ledger/route';
import { defaultBillingDbAdapter } from '../packages/shared/db-pool';
import { createSessionToken } from '../packages/auth/session';
import { middleware } from '../middleware';

describe('Batch B1–B3 — Billing Tiers, Credit Ledger SSOT & Post-Login Dashboard', () => {
  beforeEach(() => {
    defaultBillingDbAdapter.clearSubscriptions();
  });
  it('GET /api/billing/plans returns all 4 canonical tiers with priceUsd, monthlyPriceUsd, priceEth, and feature flags', async () => {
    const res = await plansGET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(4);

    const ids = json.data.map((p: any) => p.id);
    expect(ids).toEqual(['FREE', 'CREATOR', 'TRADER', 'AGENT']);

    for (const p of json.data) {
      expect(typeof p.priceUsd).toBe('number');
      expect(p.priceUsd).toBe(p.monthlyPriceUsd);
      expect(typeof p.monthlyCredits).toBe('number');
      expect(typeof p.hasLiveTrading).toBe('boolean');
      expect(typeof p.hasCreatorAccess).toBe('boolean');
      expect(typeof p.hasAgentAccess).toBe('boolean');
    }
  });

  it('POST /api/billing/subscribe fails closed (401) without SIWE session', async () => {
    const req = new NextRequest('https://pndigi.site/api/billing/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: 'CREATOR' }),
    });
    expect((await middleware(req)).status).toBe(401);
    expect((await subscribePOST(req)).status).toBe(401);
  });

  it('GET /api/billing/ledger fails closed (401) without SIWE session', async () => {
    const req = new NextRequest('https://pndigi.site/api/billing/ledger?limit=10', {
      method: 'GET',
    });
    expect((await middleware(req)).status).toBe(401);
    expect((await ledgerGET(req)).status).toBe(401);
  });

  it('POST /api/billing/plans allows SUPER_ADMIN / SYSTEM_ADMIN to set tier discount and updates GET /api/billing/plans prices', async () => {
    const unauthReq = new NextRequest('https://pndigi.site/api/billing/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: 'AGENT', discountPct: 50, promoLabel: 'LAUNCH 50' }),
    });
    expect((await plansPOST(unauthReq)).status).toBe(401);

    const adminWallet = '0x0c9f4a1234567890abcdef1234567890abcd34b6';
    const origAdmin = process.env.ADMIN_WALLET_PUBLIC_ADDRESS;
    process.env.ADMIN_WALLET_PUBLIC_ADDRESS = adminWallet;
    try {
      const adminToken = createSessionToken({ userId: 'usr-0c9f4a12', walletAddress: adminWallet });
      const adminReq = new NextRequest('https://pndigi.site/api/billing/plans', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: `rtrader_session=${adminToken}`,
        },
        body: JSON.stringify({ planId: 'AGENT', discountPct: 50, promoLabel: 'LAUNCH 50' }),
      });

      const postRes = await plansPOST(adminReq);
      expect(postRes.status).toBe(200);
      const postJson = await postRes.json();
      expect(postJson.success).toBe(true);
      expect(postJson.data.planId).toBe('AGENT');
      expect(postJson.data.discountPct).toBe(50);

      const getRes = await plansGET();
      const getJson = await getRes.json();
      const agentPlan = getJson.data.find((p: any) => p.id === 'AGENT');
      expect(agentPlan.originalPriceUsd).toBe(149);
      expect(agentPlan.discountPct).toBe(50);
      expect(agentPlan.priceUsd).toBe(74.5);
      expect(agentPlan.promoLabel).toBe('LAUNCH 50');

      const cfgReq = new NextRequest('https://pndigi.site/api/billing/plans', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: `rtrader_session=${adminToken}`,
        },
        body: JSON.stringify({
          action: 'update-platform-config',
          studioCostCr: 2,
          deskCostCr: 10,
          launchCostCr: 75,
          maxOrderValueUsd: 25000,
          maxDailyLossUsd: 2500,
          maxSlippagePct: 2.5,
        }),
      });
      const cfgRes = await plansPOST(cfgReq);
      expect(cfgRes.status).toBe(200);
      const cfgJson = await cfgRes.json();
      expect(cfgJson.data.deskCostCr).toBe(10);
      expect(cfgJson.data.maxOrderValueUsd).toBe(25000);

      const { getContractConfiguration, SUPPORTED_BASE_CHAINS } = await import('../packages/launchpad/web3-provider');
      expect(SUPPORTED_BASE_CHAINS.ARBITRUM_MAINNET.hexChainId).toBe('0xa4b1');
      expect(SUPPORTED_BASE_CHAINS.ARC_MAINNET.hexChainId).toBe('0x13b2');
      const customContractCfg = getContractConfiguration('0x4200000000000000000000000000000000000006');
      expect(customContractCfg.isConfigured).toBe(true);
      expect(customContractCfg.contractAddress).toBe('0x4200000000000000000000000000000000000006');
    } finally {
      if (origAdmin !== undefined) process.env.ADMIN_WALLET_PUBLIC_ADDRESS = origAdmin;
      else delete process.env.ADMIN_WALLET_PUBLIC_ADDRESS;
      defaultBillingDbAdapter.clearSubscriptions();
    }
  });
});
