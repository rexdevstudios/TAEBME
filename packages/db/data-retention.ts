/**
 * packages/db/data-retention.ts
 *
 * Automated PostgreSQL Residue Retention & Cost-Control Sweeper (Phase BR).
 * - Strictly prunes only expired/non-critical operational residue:
 *     1. `trade_intents` where stage = 'PAPER' OR status IN ('REJECTED', 'CANCELLED') older than 30d.
 *        NEVER deletes `EXECUTED` or active live intents or rows referenced by `orders`.
 *     2. `dual_control_requests` where status IN ('EXPIRED', 'REJECTED') older than 30d.
 *     3. `audit_logs` non-financial entries older than 90d.
 *        NEVER deletes `DEX_SWAP_TX_CONFIRMED`, `KILL_SWITCH_*`, `CREDIT_*`, `SUBSCRIPTION_*`,
 *        or `DUAL_CONTROL_*` compliance records.
 * - Zero DDL migration, fault-isolated, safe to run daily inside `/api/cron/reconcile-orders`.
 */

import type { Pool } from 'pg';

export interface DataRetentionPolicy {
  paperOrRejectedIntentsDays: number;
  expiredDualControlDays: number;
  nonFinancialAuditLogsDays: number;
}

export const DEFAULT_RETENTION_POLICY: DataRetentionPolicy = {
  paperOrRejectedIntentsDays: 30,
  expiredDualControlDays: 30,
  nonFinancialAuditLogsDays: 90,
};

export interface RetentionCleanupQuery {
  target: 'trade_intents_residue' | 'dual_control_residue' | 'audit_logs_residue';
  sql: string;
  params: number[];
}

export function clampRetentionPolicy(
  policy?: Partial<DataRetentionPolicy>
): DataRetentionPolicy {
  return {
    paperOrRejectedIntentsDays: Math.max(7, Math.min(365, Math.floor(Number(policy?.paperOrRejectedIntentsDays ?? DEFAULT_RETENTION_POLICY.paperOrRejectedIntentsDays)))),
    expiredDualControlDays: Math.max(7, Math.min(365, Math.floor(Number(policy?.expiredDualControlDays ?? DEFAULT_RETENTION_POLICY.expiredDualControlDays)))),
    nonFinancialAuditLogsDays: Math.max(30, Math.min(730, Math.floor(Number(policy?.nonFinancialAuditLogsDays ?? DEFAULT_RETENTION_POLICY.nonFinancialAuditLogsDays)))),
  };
}

export function buildRetentionCleanupQueries(
  policy?: Partial<DataRetentionPolicy>
): RetentionCleanupQuery[] {
  const safe = clampRetentionPolicy(policy);
  return [
    {
      target: 'trade_intents_residue',
      sql: `DELETE FROM trade_intents ti
            WHERE (ti.stage = 'PAPER' OR ti.status IN ('REJECTED', 'CANCELLED'))
              AND ti.status <> 'EXECUTED'
              AND ti.created_at < NOW() - ($1::int * INTERVAL '1 day')
              AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.intent_id = ti.id)`,
      params: [safe.paperOrRejectedIntentsDays],
    },
    {
      target: 'dual_control_residue',
      sql: `DELETE FROM dual_control_requests
            WHERE status IN ('EXPIRED', 'REJECTED')
              AND created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      params: [safe.expiredDualControlDays],
    },
    {
      target: 'audit_logs_residue',
      sql: `DELETE FROM audit_logs
            WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
              AND action NOT IN ('DEX_SWAP_TX_CONFIRMED')
              AND action NOT LIKE 'KILL_SWITCH_%'
              AND action NOT LIKE 'CREDIT_%'
              AND action NOT LIKE 'SUBSCRIPTION_%'
              AND action NOT LIKE 'DUAL_CONTROL_%'`,
      params: [safe.nonFinancialAuditLogsDays],
    },
  ];
}

export interface DataRetentionSweepResult {
  dryRun: boolean;
  policy: DataRetentionPolicy;
  deleted: {
    tradeIntentsResidue: number;
    dualControlResidue: number;
    auditLogsResidue: number;
  };
  errors: string[];
}

export async function runSafeDataRetentionSweep(params: {
  pool: Pool | null;
  dryRun?: boolean;
  policy?: Partial<DataRetentionPolicy>;
}): Promise<DataRetentionSweepResult> {
  const policy = clampRetentionPolicy(params.policy);
  const queries = buildRetentionCleanupQueries(policy);
  const deleted = {
    tradeIntentsResidue: 0,
    dualControlResidue: 0,
    auditLogsResidue: 0,
  };
  const errors: string[] = [];

  if (params.dryRun || !params.pool) {
    return {
      dryRun: Boolean(params.dryRun || !params.pool),
      policy,
      deleted,
      errors,
    };
  }

  for (const q of queries) {
    try {
      const res = await params.pool.query(q.sql, q.params);
      const count = Number(res.rowCount || 0);
      if (q.target === 'trade_intents_residue') deleted.tradeIntentsResidue = count;
      else if (q.target === 'dual_control_residue') deleted.dualControlResidue = count;
      else if (q.target === 'audit_logs_residue') deleted.auditLogsResidue = count;
    } catch (err: unknown) {
      errors.push(`${q.target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    dryRun: false,
    policy,
    deleted,
    errors,
  };
}
