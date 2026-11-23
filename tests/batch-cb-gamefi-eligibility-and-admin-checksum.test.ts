import { describe, expect, test } from 'bun:test';
import { getConfiguredAdminWallet } from '../packages/auth/session';
import { PostgresGameFiDbAdapter } from '../packages/db/gamefi-repo';

describe('Phase CB: Admin Checksum Normalization & Authoritative GameFi Quest Eligibility', () => {
  test('CB1.1 getConfiguredAdminWallet accepts mixed-case non-EIP55 valid 40-hex address and rejects 64-hex private keys', () => {
    const prev = process.env.ADMIN_WALLET_PUBLIC_ADDRESS;
    try {
      // Exact mixed-case address from production Vercel log screenshot
      process.env.ADMIN_WALLET_PUBLIC_ADDRESS = '0x367f08A4D27F52d715d90930C2f3B06a3FE0A0D3';
      expect(getConfiguredAdminWallet()).toBe('0x367f08a4d27f52d715d90930c2f3b06a3fe0a0d3');

      // Strictly reject 64-hex private keys (AGENTS.md Rule 3)
      process.env.ADMIN_WALLET_PUBLIC_ADDRESS = '0x' + 'a'.repeat(64);
      expect(getConfiguredAdminWallet()).toBeNull();

      // Strictly reject malformed strings
      process.env.ADMIN_WALLET_PUBLIC_ADDRESS = 'not-an-eth-address';
      expect(getConfiguredAdminWallet()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.ADMIN_WALLET_PUBLIC_ADDRESS;
      else process.env.ADMIN_WALLET_PUBLIC_ADDRESS = prev;
    }
  });

  test('CB2.1 hasTradeOrLaunchActivity recognizes persisted trade_intents in PostgreSQL', async () => {
    const queriedSql: string[] = [];
    const mockPool = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        if (sql.includes('FROM trade_intents')) {
          return { rows: [{ '?column?': 1 }] };
        }
        return { rows: [] };
      },
    } as any;

    const adapter = new PostgresGameFiDbAdapter(mockPool, false);
    const eligible = await adapter.hasTradeOrLaunchActivity('11111111-1111-1111-1111-111111111111', '0x1111111111111111111111111111111111111111');
    expect(eligible).toBe(true);
    expect(queriedSql.some((q) => q.includes('FROM trade_intents'))).toBe(true);
  });

  test('CB2.2 hasSybilEvidence recognizes registered kol_profiles in PostgreSQL', async () => {
    const queriedSql: string[] = [];
    const mockPool = {
      query: async (sql: string) => {
        queriedSql.push(sql);
        if (sql.includes('FROM kol_profiles')) {
          return { rows: [{ '?column?': 1 }] };
        }
        return { rows: [] };
      },
    } as any;

    const adapter = new PostgresGameFiDbAdapter(mockPool, false);
    const eligible = await adapter.hasSybilEvidence('11111111-1111-1111-1111-111111111111', '0x1111111111111111111111111111111111111111');
    expect(eligible).toBe(true);
    expect(queriedSql.some((q) => q.includes('FROM kol_profiles'))).toBe(true);
  });
});
