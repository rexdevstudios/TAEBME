/**
 * tests/batch-as-scout-cron-and-session-allowance-api.test.ts
 *
 * Phase AS Unit Tests:
 * 1. `GET /api/cron/agent-scout-sync` fails closed with HTTP 401 without valid `CRON_SECRET`.
 * 2. `POST /api/agent/session-allowance` fails closed with HTTP 401 without SIWE session.
 * 3. `validateSessionAllowanceSpec` enforces Non-Custodial Rule 3 & tier daily cap clamping.
 */

import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { GET as runScoutCron } from '../app/api/cron/agent-scout-sync/route';
import { POST as postSessionAllowance } from '../app/api/agent/session-allowance/route';
import { validateSessionAllowanceSpec } from '../packages/agent/session-allowance';

describe('Phase AS — Automated Scout Cron & ERC-7715 Session Allowance API Guards', () => {
  it('GET /api/cron/agent-scout-sync fails closed with HTTP 401 without valid CRON_SECRET', async () => {
    const req = new NextRequest('http://localhost:3000/api/cron/agent-scout-sync', { method: 'GET' });
    const res = await runScoutCron(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('POST /api/agent/session-allowance fails closed with HTTP 401 without SIWE session', async () => {
    const req = new NextRequest('http://localhost:3000/api/agent/session-allowance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dailySpendCapUsd: 100 }),
    });
    const res = await postSessionAllowance(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('validates ERC-7715 spec with Base 0x AllowanceHolder and clamps daily cap to FREE tier ($250)', () => {
    const spec = validateSessionAllowanceSpec(
      {
        delegateAddress: '0x4444444444444444444444444444444444444444',
        chainId: 8453,
        dailySpendCapUsd: 5000,
        expiresAtIso: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        allowedContracts: ['0x0000000000001fF3684f28c67538d4D072C22734'],
        allowedActions: ['SWAP_DEX'],
      },
      'FREE'
    );
    expect(spec.standard).toBe('ERC-4337/ERC-7715');
    expect(spec.effectiveDailySpendCapUsd).toBe(250);
    expect(spec.allowedContracts[0]).toBe('0x0000000000001fF3684f28c67538d4D072C22734');
  });
});
