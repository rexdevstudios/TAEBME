import { describe, it, expect } from 'bun:test';
import { NextRequest } from 'next/server';
import { ensureUserEntity } from '../packages/shared/db-pool';
import { GET as gamefiProfileGET } from '../app/api/gamefi/profile/route';
import { POST as gamefiQuestPOST } from '../app/api/gamefi/quests/complete/route';
import { POST as tradingExecutePOST } from '../app/api/trading/execute/route';

describe('Batch C1–C4 — Entitlement Identity Resolution, Metered Credit Burn & GameFi Quest Closure', () => {
  it('Task C1: ensureUserEntity resolves usr-<8hex> prefix to the same user_id as the full 0x wallet in PostgreSQL', async () => {
    const canonicalUserId = '11111111-2222-3333-4444-555555555555';
    const fullWallet = '0x0c9f4a1234567890abcdef1234567890abcd34b6';
    const sessionUserId = 'usr-0c9f4a12';

    const mockPool = {
      query: async (sql: string, params: any[]) => {
        if (sql.includes('LOWER(address) = LOWER($1)')) {
          if (params[0] === fullWallet.toLowerCase()) {
            return { rows: [{ user_id: canonicalUserId }] };
          }
          return { rows: [] };
        }
        if (sql.includes('LOWER(address) LIKE $1')) {
          if (params[0] === '0x0c9f4a12%') {
            return { rows: [{ user_id: canonicalUserId }] };
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const resolvedFromWallet = await ensureUserEntity(mockPool, fullWallet);
    const resolvedFromUsrPrefix = await ensureUserEntity(mockPool, sessionUserId);
    expect(resolvedFromWallet).toBe(canonicalUserId);
    expect(resolvedFromUsrPrefix).toBe(canonicalUserId);
  });

  it('Task C3 & C4: GameFi profile, quest completion, and multi-mode trading execution fail closed (401) without SIWE session', async () => {
    const profileReq = new NextRequest('https://pndigi.site/api/gamefi/profile', { method: 'GET' });
    expect((await gamefiProfileGET(profileReq)).status).toBe(401);

    const questReq = new NextRequest('https://pndigi.site/api/gamefi/quests/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questId: 'connect_siwe' }),
    });
    expect((await gamefiQuestPOST(questReq)).status).toBe(401);

    const execReq = new NextRequest('https://pndigi.site/api/trading/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionMode: 'PAPER', symbol: 'BTCUSDT', side: 'BUY', quantity: 0.1 }),
    });
    expect((await tradingExecutePOST(execReq)).status).toBe(401);
  });
});
