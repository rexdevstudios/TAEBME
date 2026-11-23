/**
 * scripts/check-neon-drift.ts
 *
 * Read-Only Dual-Environment Neon PostgreSQL Schema & Index Drift Checker (Phase CF1).
 * Usage: bun run verify:db:drift
 * - Reads `DATABASE_URL_TESTNET` and `DATABASE_URL` (Production).
 * - Exits 0 if 0 drift; exits 1 if any table or index drift is detected.
 */

import { Pool } from 'pg';
import { compareSchemaSnapshots, type SchemaDriftSnapshot } from '../packages/db/schema-drift-guard';

async function readSnapshot(connectionString: string): Promise<SchemaDriftSnapshot> {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 8000 });
  try {
    const [tablesRes, indexesRes] = await Promise.all([
      pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
      ),
      pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`),
    ]);
    return {
      tables: tablesRes.rows.map((r: any) => String(r.table_name)),
      indexes: indexesRes.rows.map((r: any) => String(r.indexname)),
    };
  } finally {
    await pool.end();
  }
}

async function main() {
  const testnetUrl = process.env.DATABASE_URL_TESTNET?.trim();
  const prodUrl = process.env.DATABASE_URL?.trim();

  if (!testnetUrl || !prodUrl) {
    console.log(
      '[Drift Guard] Skipped live check: both DATABASE_URL_TESTNET and DATABASE_URL are required for dual comparison.'
    );
    process.exit(0);
  }

  console.log('[Drift Guard] Inspecting Neon Testnet vs Production schemas (read-only)...');
  const [testnetSnap, prodSnap] = await Promise.all([readSnapshot(testnetUrl), readSnapshot(prodUrl)]);
  const report = compareSchemaSnapshots(testnetSnap, prodSnap);

  console.log(`[Drift Guard] ${report.summary}`);
  if (!report.inSync) {
    console.error('[Drift Guard] Drift details:', JSON.stringify(report, null, 2));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[Drift Guard] Error:', err?.message || err);
  process.exit(1);
});
