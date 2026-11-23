import { describe, it, expect } from 'vitest';
import {
  buildRetentionCleanupQueries,
  clampRetentionPolicy,
  runSafeDataRetentionSweep,
} from '../packages/db/data-retention';
import { runMultiTenantAutoPilotSweep } from '../packages/agent/autopilot-sweep';

describe('Phase BR — Zero-Leak Data Retention, Zero-DB Idle Fast-Path & Cost-Control', () => {
  it('[BR1.1] buildRetentionCleanupQueries strictly protects EXECUTED intents, orders, and financial audit logs', () => {
    const policy = clampRetentionPolicy({ paperOrRejectedIntentsDays: 1, nonFinancialAuditLogsDays: 5 });
    expect(policy.paperOrRejectedIntentsDays).toBe(7); // clamped to safe minimum 7d
    expect(policy.nonFinancialAuditLogsDays).toBe(30); // clamped to safe minimum 30d

    const queries = buildRetentionCleanupQueries(policy);
    expect(queries).toHaveLength(3);

    const intentQ = queries.find((q) => q.target === 'trade_intents_residue')!;
    expect(intentQ.sql).toContain("ti.status <> 'EXECUTED'");
    expect(intentQ.sql).toContain('NOT EXISTS (SELECT 1 FROM orders o WHERE o.intent_id = ti.id)');

    const auditQ = queries.find((q) => q.target === 'audit_logs_residue')!;
    expect(auditQ.sql).toContain("DEX_SWAP_TX_CONFIRMED");
    expect(auditQ.sql).toContain("KILL_SWITCH_%");
    expect(auditQ.sql).toContain("CREDIT_%");
  });

  it('[BR1.2] runSafeDataRetentionSweep executes all 3 cleanup queries cleanly against a mocked Pool', async () => {
    const executedSql: string[] = [];
    const mockPool = {
      query: async (sql: string) => {
        executedSql.push(sql);
        return { rowCount: 4 };
      },
    } as any;

    const res = await runSafeDataRetentionSweep({ pool: mockPool, dryRun: false });
    expect(res.dryRun).toBe(false);
    expect(res.errors).toEqual([]);
    expect(executedSql).toHaveLength(3);
    expect(res.deleted).toEqual({
      tradeIntentsResidue: 4,
      dualControlResidue: 4,
      auditLogsResidue: 4,
    });
  });

  it('[BR2.1] runMultiTenantAutoPilotSweep returns fastPathIdle=true with zero DB queries when no wallets are active', async () => {
    const res = await runMultiTenantAutoPilotSweep({ dryRun: true });
    expect(res.scannedWallets).toBe(0);
    expect(res.fastPathIdle).toBe(true);
    expect(res.totalQueued).toBe(0);
  });
});
