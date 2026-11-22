/**
 * packages/db/dual-control-repo.ts
 *
 * Modular Domain Repository for Dual-Control Governance Requests & Audit Logs.
 * Extracted from packages/shared/db-pool.ts (Phase AF1) with zero breaking changes via barrel facade.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import type { DualControlDbAdapter, DualControlRequestRecord } from '../admin/dual-control';

export interface DualControlRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool, userIdentifier: string) => Promise<string>;
  isUuid: (val: string | undefined | null) => boolean;
}

let registeredDeps: DualControlRepoDeps | null = null;

export function registerDualControlRepoDeps(deps: DualControlRepoDeps): void {
  registeredDeps = deps;
}

export class PostgresDualControlDbAdapter implements DualControlDbAdapter {
  private inMemoryRequests: Map<string, DualControlRequestRecord> = new Map();
  private inMemoryAuditLogs: any[] = [];
  private readonly deps?: DualControlRepoDeps;

  constructor(deps?: DualControlRepoDeps) {
    this.deps = deps;
  }

  private resolveDeps(): DualControlRepoDeps | null {
    return this.deps || registeredDeps;
  }

  seedRequest(req: DualControlRequestRecord): void {
    this.inMemoryRequests.set(req.id, { ...req });
  }

  clearRequests(): void {
    this.inMemoryRequests.clear();
    this.inMemoryAuditLogs = [];
  }

  getAuditLogs(): any[] {
    return [...this.inMemoryAuditLogs];
  }

  async createRequest(req: Omit<DualControlRequestRecord, 'id'>): Promise<string> {
    const id = crypto.randomUUID();
    const enrichedPayload = { ...(req.payload || {}), reason: req.reason };
    const record: DualControlRequestRecord = { id, ...req, payload: enrichedPayload };
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validRequesterId = await deps.ensureUserEntity(pool, req.requestedBy);
        await pool.query(
          `INSERT INTO dual_control_requests (
            id, action_type, requested_by, payload, status, expires_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            id,
            req.actionType,
            validRequesterId,
            JSON.stringify(enrichedPayload),
            req.status,
            req.expiresAt,
          ]
        );
        this.inMemoryRequests.set(id, record);
        return id;
      } catch (err: any) {
        throw new Error(`DB_DUAL_CONTROL_CREATE_FAILED: ${err?.message}`);
      }
    }
    this.inMemoryRequests.set(id, record);
    return id;
  }

  async listRecentRequests(limit: number = 15): Promise<DualControlRequestRecord[]> {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 15)));
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT id, action_type AS "actionType", requested_by AS "requestedBy",
                  approved_by AS "approvedBy", payload, status,
                  expires_at AS "expiresAt", created_at AS "createdAt"
           FROM dual_control_requests
           ORDER BY created_at DESC
           LIMIT $1`,
          [safeLimit]
        );
        return res.rows.map((row: any) => {
          const parsedPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {};
          return {
            id: row.id,
            actionType: row.actionType,
            requestedBy: row.requestedBy,
            approvedBy: row.approvedBy || undefined,
            payload: parsedPayload,
            reason: parsedPayload?.reason || 'Dual-control request',
            status: row.status,
            expiresAt: new Date(row.expiresAt).toISOString(),
            createdAt: new Date(row.createdAt).toISOString(),
          };
        });
      } catch {
        // Fallback to in-memory records
      }
    }
    return Array.from(this.inMemoryRequests.values())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, safeLimit);
  }

  async getRequestById(id: string): Promise<DualControlRequestRecord | null> {
    if (this.inMemoryRequests.has(id)) {
      return this.inMemoryRequests.get(id) || null;
    }
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT id, action_type AS "actionType", requested_by AS "requestedBy",
                  approved_by AS "approvedBy", payload, status,
                  expires_at AS "expiresAt", created_at AS "createdAt"
           FROM dual_control_requests
           WHERE id = $1 LIMIT 1`,
          [id]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            id: row.id,
            actionType: row.actionType,
            requestedBy: row.requestedBy,
            approvedBy: row.approvedBy,
            payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
            reason: row.payload?.reason || 'Dual-control request',
            status: row.status,
            expiresAt: new Date(row.expiresAt).toISOString(),
            createdAt: new Date(row.createdAt).toISOString(),
          };
        }
        return this.inMemoryRequests.get(id) || null;
      } catch (err: any) {
        throw new Error(`DB_DUAL_CONTROL_GET_FAILED: ${err?.message}`);
      }
    }
    return this.inMemoryRequests.get(id) || null;
  }

  async updateRequestStatus(
    id: string,
    status: string,
    approvedBy?: string,
    expectedStatus?: string
  ): Promise<boolean> {
    const memReq = this.inMemoryRequests.get(id);
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validApproverId = approvedBy ? await deps.ensureUserEntity(pool, approvedBy) : null;
        const res = await pool.query(
          `UPDATE dual_control_requests
           SET status = $1, approved_by = COALESCE($2, approved_by)
           WHERE id = $3 AND ($4::varchar IS NULL OR status = $4)`,
          [status, validApproverId, id, expectedStatus || null]
        );
        if (expectedStatus && res.rowCount === 0 && !memReq) {
          return false;
        }
      } catch (err: any) {
        if (!memReq) {
          throw new Error(`DB_DUAL_CONTROL_UPDATE_FAILED: ${err?.message}`);
        }
      }
    }
    if (memReq) {
      if (expectedStatus && memReq.status !== expectedStatus) {
        return false;
      }
      memReq.status = status as any;
      if (approvedBy) memReq.approvedBy = approvedBy;
    }
    return true;
  }

  async createAuditLog(entry: {
    actorId: string;
    action: string;
    entityId?: string;
    payloadBefore?: unknown;
    payloadAfter?: unknown;
    reason?: string;
  }): Promise<void> {
    this.inMemoryAuditLogs.push({ ...entry, timestamp: new Date().toISOString() });
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validActorId = await deps.ensureUserEntity(pool, entry.actorId);
        await pool.query(
          `INSERT INTO audit_logs (
            actor_id, action, entity_id, payload_before, payload_after, reason, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            validActorId,
            entry.action,
            entry.entityId && deps.isUuid(entry.entityId) ? entry.entityId : null,
            JSON.stringify(entry.payloadBefore || {}),
            JSON.stringify(entry.payloadAfter || {}),
            entry.reason || null,
          ]
        );
      } catch {
        // Non-blocking fallback
      }
    }
  }
}
