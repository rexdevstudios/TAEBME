import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET as plansGET } from '../app/api/billing/plans/route';
import { POST as subscribePOST } from '../app/api/billing/subscribe/route';
import { GET as ledgerGET } from '../app/api/billing/ledger/route';
import { middleware } from '../middleware';

describe('Batch B1–B3 — Billing Tiers, Credit Ledger SSOT & Post-Login Dashboard', () => {
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
});
