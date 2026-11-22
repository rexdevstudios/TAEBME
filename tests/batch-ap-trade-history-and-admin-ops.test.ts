/**
 * tests/batch-ap-trade-history-and-admin-ops.test.ts
 *
 * Phase AP Unit Tests:
 * 1. `listUserRecentTradeIntents` isolates intents strictly per user and clamps limit cleanly.
 * 2. `GET /api/trade-intents` fails closed with HTTP 401 when unauthenticated.
 * 3. `GET /api/admin/ops-summary` fails closed with HTTP 401 when unauthenticated.
 */

import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import {
  defaultBinanceExecutionDbAdapter,
  listUserRecentTradeIntents,
} from '../packages/shared/db-pool';
import { GET as getTradeIntents } from '../app/api/trade-intents/route';
import { GET as getAdminOpsSummary } from '../app/api/admin/ops-summary/route';

describe('Phase AP — User Trade History Isolation & Admin Ops Summary Guards', () => {
  it('isolates recent trade intents strictly per user and respects limit cap', async () => {
    const userA = 'usr-ap-alpha-001';
    const userB = 'usr-ap-beta-002';

    defaultBinanceExecutionDbAdapter.seedIntent({
      id: 'intent-ap-a1',
      userId: userA,
      stage: 'PAPER',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 0.05,
      maxSlippagePct: 1.0,
      idempotencyKey: 'ap-idem-a1',
      status: 'APPROVED',
      createdAt: '2026-11-22T01:00:00Z',
    });
    defaultBinanceExecutionDbAdapter.seedIntent({
      id: 'intent-ap-a2',
      userId: userA,
      stage: 'TESTNET',
      symbol: 'ETHUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: 0.5,
      maxSlippagePct: 1.0,
      idempotencyKey: 'ap-idem-a2',
      status: 'APPROVED',
      createdAt: '2026-11-22T02:00:00Z',
    });
    defaultBinanceExecutionDbAdapter.seedIntent({
      id: 'intent-ap-b1',
      userId: userB,
      stage: 'PAPER',
      symbol: 'SOLUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 10,
      maxSlippagePct: 1.0,
      idempotencyKey: 'ap-idem-b1',
      status: 'APPROVED',
      createdAt: '2026-11-22T03:00:00Z',
    });

    const listA = await listUserRecentTradeIntents(userA, 10);
    expect(listA.length).toBe(2);
    expect(listA.every((i) => i.userId === userA)).toBe(true);
    expect(listA[0]?.id).toBe('intent-ap-a2');

    const limitedA = await listUserRecentTradeIntents(userA, 1);
    expect(limitedA.length).toBe(1);
    expect(limitedA[0]?.id).toBe('intent-ap-a2');
  });

  it('GET /api/trade-intents fails closed with HTTP 401 without SIWE session', async () => {
    const req = new NextRequest('http://localhost:3000/api/trade-intents?limit=10', { method: 'GET' });
    const res = await getTradeIntents(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('GET /api/admin/ops-summary fails closed with HTTP 401 without admin session', async () => {
    const req = new NextRequest('http://localhost:3000/api/admin/ops-summary', { method: 'GET' });
    const res = await getAdminOpsSummary(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });
});
