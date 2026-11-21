/**
 * packages/db/kill-switch-repo.ts
 *
 * Modular Domain Repository for Global/User/Token Kill Switches.
 * Extracted from packages/shared/db-pool.ts (Phase AE1) with zero breaking changes via barrel facade.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import type { KillSwitchDbAdapter, KillSwitchRecord } from '../admin/kill-switch-manager';

export interface KillSwitchRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool, userIdentifier: string) => Promise<string>;
  isUuid: (val: string | undefined | null) => boolean;
}

let registeredDeps: KillSwitchRepoDeps | null = null;

export function registerKillSwitchRepoDeps(deps: KillSwitchRepoDeps): void {
  registeredDeps = deps;
}

export class PostgresKillSwitchDbAdapter implements KillSwitchDbAdapter {
  private inMemorySwitches: Map<string, KillSwitchRecord> = new Map();
  private readonly deps?: KillSwitchRepoDeps;

  constructor(deps?: KillSwitchRepoDeps) {
    this.deps = deps;
  }

  private resolveDeps(): KillSwitchRepoDeps | null {
    return this.deps || registeredDeps;
  }

  seedKillSwitch(ks: {
    id: string;
    scope: 'GLOBAL' | 'USER' | 'TOKEN';
    targetId?: string;
    isActive: boolean;
    reason: string;
    triggeredBy?: string;
    triggeredAt?: Date | string;
  }): void {
    this.inMemorySwitches.set(ks.id, {
      id: ks.id,
      scope: ks.scope,
      targetId: ks.targetId,
      isActive: ks.isActive,
      reason: ks.reason,
      activatedBy: ks.triggeredBy || 'admin',
      activatedAt:
        ks.triggeredAt instanceof Date
          ? ks.triggeredAt.toISOString()
          : ks.triggeredAt || new Date().toISOString(),
    });
  }

  clearKillSwitches(): void {
    this.inMemorySwitches.clear();
  }

  async activateKillSwitch(ks: Omit<KillSwitchRecord, 'id' | 'activatedAt'>): Promise<string> {
    const id = crypto.randomUUID();
    const activatedAt = new Date().toISOString();
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;

    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, ks.activatedBy);
        const targetUuid = deps.isUuid(ks.targetId) ? ks.targetId : null;

        await pool.query(
          `UPDATE kill_switches SET is_active = FALSE, deactivated_at = NOW()
           WHERE scope = $1 AND (target_id = $2 OR ($2 IS NULL AND target_id IS NULL)) AND is_active = TRUE`,
          [ks.scope, targetUuid]
        );

        const res = await pool.query(
          `INSERT INTO kill_switches (id, scope, target_id, is_active, reason, activated_by, activated_at)
           VALUES ($1, $2, $3, TRUE, $4, $5, $6) RETURNING id`,
          [id, ks.scope, targetUuid, ks.reason, validUserId, activatedAt]
        );
        return res.rows[0]?.id || id;
      } catch (err: any) {
        console.error('[PostgresKillSwitchDbAdapter] activateKillSwitch error:', err?.message || err);
        throw new Error(`DB_KILL_SWITCH_ACTIVATE_FAILED: ${err?.message}`);
      }
    }

    const record: KillSwitchRecord = { id, activatedAt, ...ks };
    this.inMemorySwitches.set(id, record);
    return id;
  }

  async deactivateKillSwitch(idOrScope: string, deactivatedBy: string): Promise<void> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, deactivatedBy);
        if (deps.isUuid(idOrScope)) {
          await pool.query(
            `UPDATE kill_switches SET is_active = FALSE, deactivated_by = $1, deactivated_at = NOW() WHERE id = $2`,
            [validUserId, idOrScope]
          );
        } else {
          await pool.query(
            `UPDATE kill_switches SET is_active = FALSE, deactivated_by = $1, deactivated_at = NOW() WHERE scope = $2 AND is_active = TRUE`,
            [validUserId, idOrScope.toUpperCase()]
          );
        }
        return;
      } catch (err: any) {
        console.error('[PostgresKillSwitchDbAdapter] deactivateKillSwitch error:', err?.message || err);
        throw new Error(`DB_KILL_SWITCH_DEACTIVATE_FAILED: ${err?.message}`);
      }
    }

    for (const record of this.inMemorySwitches.values()) {
      if (record.id === idOrScope || record.scope === idOrScope.toUpperCase()) {
        record.isActive = false;
        record.deactivatedBy = deactivatedBy;
        record.deactivatedAt = new Date().toISOString();
      }
    }
  }

  async getActiveKillSwitches(): Promise<KillSwitchRecord[]> {
    const memSwitches = Array.from(this.inMemorySwitches.values()).filter((ks) => ks.isActive);
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT id, scope, target_id as "targetId", is_active as "isActive", reason,
                  activated_by as "activatedBy", deactivated_by as "deactivatedBy",
                  activated_at as "activatedAt", deactivated_at as "deactivatedAt"
           FROM kill_switches WHERE is_active = TRUE`
        );
        const dbSwitches = res.rows.map((r) => ({
          id: r.id,
          scope: r.scope,
          targetId: r.targetId || undefined,
          isActive: r.isActive,
          reason: r.reason,
          activatedBy: r.activatedBy,
          deactivatedBy: r.deactivatedBy || undefined,
          activatedAt: r.activatedAt?.toISOString ? r.activatedAt.toISOString() : String(r.activatedAt),
          deactivatedAt: r.deactivatedAt?.toISOString ? r.deactivatedAt.toISOString() : r.deactivatedAt,
        }));
        const combined = new Map<string, KillSwitchRecord>();
        for (const s of dbSwitches) combined.set(s.id, s);
        for (const s of memSwitches) combined.set(s.id, s);
        return Array.from(combined.values());
      } catch (err: any) {
        console.error('[PostgresKillSwitchDbAdapter] getActiveKillSwitches error (FAIL-CLOSED):', err?.message || err);
        throw new Error(`DATABASE_UNAVAILABLE: Failed to query active kill switches: ${err?.message || err}`);
      }
    }

    return memSwitches;
  }

  async createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, actorId);
        let validEntityId: string | null = null;
        if (entityId && deps.isUuid(entityId)) {
          const entityCheck = await pool.query('SELECT id FROM entities WHERE id = $1', [entityId]);
          if (entityCheck.rows.length > 0) {
            validEntityId = entityId;
          }
        }

        await pool.query(
          `INSERT INTO audit_logs (id, actor_id, action, entity_id, reason, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())`,
          [validUserId, action, validEntityId, reason || '']
        );
      } catch (err: any) {
        console.warn('[PostgresKillSwitchDbAdapter] createAuditLog warning:', err?.message || err);
      }
    }
  }
}
