/**
 * packages/db/schema-drift-guard.ts
 *
 * Pure Deterministic Schema & Index Drift Comparator for Dual-Environment Neon PostgreSQL (Phase CF1).
 * - Zero external dependencies, 100% unit-testable.
 * - Compares table lists and index lists between Testnet and Production to guarantee 0 schema/index drift.
 */

export interface SchemaDriftSnapshot {
  tables: string[];
  indexes: string[];
}

export interface SchemaDriftReport {
  inSync: boolean;
  missingInProductionTables: string[];
  extraInProductionTables: string[];
  missingInProductionIndexes: string[];
  extraInProductionIndexes: string[];
  summary: string;
}

export function compareSchemaSnapshots(
  testnet: SchemaDriftSnapshot,
  production: SchemaDriftSnapshot
): SchemaDriftReport {
  const tnTables = new Set((testnet.tables || []).map((t) => t.trim().toLowerCase()).filter(Boolean));
  const prTables = new Set((production.tables || []).map((t) => t.trim().toLowerCase()).filter(Boolean));

  const tnIndexes = new Set((testnet.indexes || []).map((i) => i.trim().toLowerCase()).filter(Boolean));
  const prIndexes = new Set((production.indexes || []).map((i) => i.trim().toLowerCase()).filter(Boolean));

  const missingInProductionTables = Array.from(tnTables).filter((t) => !prTables.has(t)).sort();
  const extraInProductionTables = Array.from(prTables).filter((t) => !tnTables.has(t)).sort();
  const missingInProductionIndexes = Array.from(tnIndexes).filter((i) => !prIndexes.has(i)).sort();
  const extraInProductionIndexes = Array.from(prIndexes).filter((i) => !tnIndexes.has(i)).sort();

  const inSync =
    missingInProductionTables.length === 0 &&
    extraInProductionTables.length === 0 &&
    missingInProductionIndexes.length === 0 &&
    extraInProductionIndexes.length === 0;

  const summary = inSync
    ? `0 DRIFT: Testnet & Production synced (${prTables.size} tables, ${prIndexes.size} indexes).`
    : `DRIFT DETECTED: Tables(-${missingInProductionTables.length}/+${extraInProductionTables.length}), Indexes(-${missingInProductionIndexes.length}/+${extraInProductionIndexes.length}).`;

  return {
    inSync,
    missingInProductionTables,
    extraInProductionTables,
    missingInProductionIndexes,
    extraInProductionIndexes,
    summary,
  };
}
