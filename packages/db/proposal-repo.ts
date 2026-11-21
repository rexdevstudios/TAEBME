/**
 * packages/db/proposal-repo.ts
 *
 * Modular Domain Repository for AI Agent Trade Proposals & Audit Logs.
 * Extracted from packages/shared/db-pool.ts (Phase AE1) with zero breaking changes via barrel facade.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import type { ProposalDbAdapter, AgentProposalRecord } from '../agent/proposal-engine';

export interface ProposalRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool, userIdentifier: string) => Promise<string>;
  isUuid: (val: string | undefined | null) => boolean;
}

let registeredDeps: ProposalRepoDeps | null = null;

export function registerProposalRepoDeps(deps: ProposalRepoDeps): void {
  registeredDeps = deps;
}

export class PostgresProposalDbAdapter implements ProposalDbAdapter {
  private inMemoryProposals: Map<string, AgentProposalRecord> = new Map();
  private inMemoryAuditLogs: Array<{
    actorId: string;
    action: string;
    entityId?: string;
    reason?: string;
    createdAt: string;
  }> = [];
  private readonly deps?: ProposalRepoDeps;

  constructor(deps?: ProposalRepoDeps) {
    this.deps = deps;
  }

  private resolveDeps(): ProposalRepoDeps | null {
    return this.deps || registeredDeps;
  }

  async createProposal(proposal: Omit<AgentProposalRecord, 'id'>): Promise<string> {
    const id = crypto.randomUUID();
    const record: AgentProposalRecord = {
      ...proposal,
      id,
    };
    this.inMemoryProposals.set(id, record);

    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (!pool && process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_UNAVAILABLE: Neon connection pool is not available in production.');
    }

    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, proposal.userId);
        let validAgentId: string = proposal.agentId;
        if (!deps.isUuid(validAgentId)) {
          const agentRes = await pool.query('SELECT id FROM agent_profiles LIMIT 1');
          if (agentRes.rows.length > 0) {
            validAgentId = agentRes.rows[0].id;
          } else {
            const newAgentId = crypto.randomUUID();
            await pool.query("INSERT INTO entities (id, type) VALUES ($1, 'AGENT')", [newAgentId]);
            await pool.query(
              "INSERT INTO agent_profiles (id, owner_id, name, strategy_description, system_prompt, risk_tolerance_level) VALUES ($1, $2, 'Default Agent', 'Momentum trading strategy', 'Analyze market signals and propose trades', 'MODERATE')",
              [newAgentId, validUserId]
            );
            validAgentId = newAgentId;
          }
        }

        await pool.query(
          `INSERT INTO agent_proposals (
            id, agent_id, user_id, target_symbol, action, suggested_qty, suggested_price,
            rationale, confidence_score, status, expires_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            id,
            validAgentId,
            validUserId,
            proposal.targetSymbol,
            proposal.action,
            proposal.suggestedQty,
            proposal.suggestedPrice || null,
            proposal.rationale,
            proposal.confidenceScore,
            proposal.status || 'PENDING_APPROVAL',
            proposal.expiresAt,
            proposal.createdAt || new Date().toISOString(),
          ]
        );
      } catch (err: any) {
        console.warn('[PostgresProposalDbAdapter] createProposal DB write warning:', err?.message || err);
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`DATABASE_ERROR: Failed to persist agent proposal to PostgreSQL SSOT: ${err?.message || err}`);
        }
      }
    }

    return id;
  }

  async getProposalById(id: string): Promise<AgentProposalRecord | null> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool) {
      try {
        const res = await pool.query('SELECT * FROM agent_proposals WHERE id = $1', [id]);
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            id: r.id,
            agentId: r.agent_id,
            userId: r.user_id,
            targetSymbol: r.target_symbol,
            action: r.action,
            suggestedQty: Number(r.suggested_qty),
            suggestedPrice: r.suggested_price ? Number(r.suggested_price) : undefined,
            rationale: r.rationale,
            confidenceScore: Number(r.confidence_score),
            status: r.status,
            expiresAt: r.expires_at?.toISOString ? r.expires_at.toISOString() : String(r.expires_at),
            createdAt: r.created_at?.toISOString ? r.created_at.toISOString() : String(r.created_at),
          };
        }
      } catch (err: any) {
        console.warn('[PostgresProposalDbAdapter] getProposalById warning:', err?.message || err);
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`DATABASE_ERROR: Failed to query agent proposal from PostgreSQL SSOT: ${err?.message || err}`);
        }
      }
    }

    return this.inMemoryProposals.get(id) || null;
  }

  async updateProposalStatus(id: string, status: 'APPROVED' | 'REJECTED' | 'EXPIRED'): Promise<void> {
    const mem = this.inMemoryProposals.get(id);
    if (mem) {
      mem.status = status;
    }

    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (!pool && process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_UNAVAILABLE: Neon connection pool is not available in production.');
    }

    if (pool) {
      try {
        await pool.query('UPDATE agent_proposals SET status = $1 WHERE id = $2', [status, id]);
      } catch (err: any) {
        console.warn('[PostgresProposalDbAdapter] updateProposalStatus warning:', err?.message || err);
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`DATABASE_ERROR: Failed to update agent proposal status in PostgreSQL SSOT: ${err?.message || err}`);
        }
      }
    }
  }

  async createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void> {
    this.inMemoryAuditLogs.push({
      actorId,
      action,
      entityId,
      reason,
      createdAt: new Date().toISOString(),
    });

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
        console.warn('[PostgresProposalDbAdapter] createAuditLog warning:', err?.message || err);
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`DATABASE_ERROR: Failed to write audit log to PostgreSQL SSOT: ${err?.message || err}`);
        }
      }
    }
  }

  getAuditLogs() {
    return [...this.inMemoryAuditLogs];
  }

  clearInMemoryState() {
    this.inMemoryProposals.clear();
    this.inMemoryAuditLogs = [];
  }
}
