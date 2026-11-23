import { describe, expect, test } from 'bun:test';
import { compareSchemaSnapshots } from '../packages/db/schema-drift-guard';

describe('Phase CF: Dual-Environment Neon Schema & Index Drift Guard', () => {
  test('CF1.1 reports inSync=true when Testnet & Production tables and indexes match exactly', () => {
    const report = compareSchemaSnapshots(
      { tables: ['users', 'subscriptions', 'orders'], indexes: ['users_pkey', 'idx_subscriptions_user_status'] },
      { tables: ['orders', 'users', 'subscriptions'], indexes: ['idx_subscriptions_user_status', 'users_pkey'] }
    );
    expect(report.inSync).toBe(true);
    expect(report.summary).toContain('0 DRIFT');
  });

  test('CF1.2 flags missing and extra tables/indexes deterministically', () => {
    const report = compareSchemaSnapshots(
      { tables: ['users', 'new_table'], indexes: ['users_pkey', 'idx_agent_proposals_status'] },
      { tables: ['users', 'legacy_only'], indexes: ['users_pkey'] }
    );
    expect(report.inSync).toBe(false);
    expect(report.missingInProductionTables).toEqual(['new_table']);
    expect(report.extraInProductionTables).toEqual(['legacy_only']);
    expect(report.missingInProductionIndexes).toEqual(['idx_agent_proposals_status']);
    expect(report.summary).toContain('DRIFT DETECTED');
  });
});
