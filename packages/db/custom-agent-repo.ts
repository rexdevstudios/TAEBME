/**
 * packages/db/custom-agent-repo.ts
 *
 * Modular Domain Repository for Custom AI Agent Profiles (`agent_profiles` + `entities` SSOT).
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import {
  type CustomAgentProfile,
  type AgentSkillId,
  type AgentRiskTolerance,
  type AgentStrategyProfileId,
  validateAgentSkills,
  VALID_RISK_LEVELS,
  VALID_STRATEGIES,
} from '../agent/skill-registry';

export interface CustomAgentRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool, userIdentifier: string) => Promise<string>;
}

const inMemoryCustomAgents: CustomAgentProfile[] = [];
let registeredDeps: CustomAgentRepoDeps | null = null;

export function registerCustomAgentRepoDeps(deps: CustomAgentRepoDeps): void {
  registeredDeps = deps;
}

export class PostgresCustomAgentAdapter {
  private static readonly HARD_MAX_AGENTS_PER_USER = 50;
  private readonly deps?: CustomAgentRepoDeps;

  constructor(deps?: CustomAgentRepoDeps) {
    this.deps = deps;
  }

  private resolveDeps(): CustomAgentRepoDeps | null {
    return this.deps || registeredDeps;
  }

  async listUserAgents(userIdentifier: string): Promise<CustomAgentProfile[]> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const ownerId = await deps.ensureUserEntity(pool, userIdentifier);
        const res = await pool.query(
          `SELECT id, owner_id, name, strategy_description, system_prompt, risk_tolerance_level,
                  enabled_skills, strategy_profile, target_symbols, status, created_at, updated_at
           FROM agent_profiles
           WHERE owner_id = $1
           ORDER BY updated_at DESC`,
          [ownerId]
        );
        return res.rows.map((r: any) => ({
          id: String(r.id),
          ownerId: String(r.owner_id),
          name: String(r.name),
          strategyDescription: String(r.strategy_description || ''),
          systemPrompt: String(r.system_prompt || ''),
          riskToleranceLevel: (VALID_RISK_LEVELS.has(r.risk_tolerance_level) ? r.risk_tolerance_level : 'MODERATE') as AgentRiskTolerance,
          strategyProfile: (VALID_STRATEGIES.has(r.strategy_profile) ? r.strategy_profile : 'MOMENTUM_BREAKOUT') as AgentStrategyProfileId,
          enabledSkills: Array.isArray(r.enabled_skills) ? (r.enabled_skills as AgentSkillId[]) : ['SKILL_CEX_TRADE', 'SKILL_DEX_SWAP'],
          targetSymbols: Array.isArray(r.target_symbols) ? r.target_symbols.map(String) : ['BTCUSDT', 'ETHUSDT'],
          status: (r.status === 'ACTIVE' || r.status === 'PAUSED' ? r.status : 'IDLE') as 'IDLE' | 'ACTIVE' | 'PAUSED',
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
          updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
        }));
      } catch (err: any) {
        console.warn('[PostgresCustomAgentAdapter] listUserAgents fallback:', err?.message);
      }
    }

    const norm = userIdentifier.toLowerCase();
    return inMemoryCustomAgents
      .filter((a) => a.ownerId === norm)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async getUserAgentById(userIdentifier: string, agentId: string): Promise<CustomAgentProfile | null> {
    const all = await this.listUserAgents(userIdentifier);
    return all.find((a) => a.id === agentId) || null;
  }

  async createUserAgent(params: {
    userIdentifier: string;
    name: string;
    strategyDescription?: string;
    systemPrompt: string;
    riskToleranceLevel?: string;
    strategyProfile?: string;
    enabledSkills?: unknown;
    targetSymbols?: string[];
    maxAllowed?: number;
  }): Promise<CustomAgentProfile> {
    const cleanName = (params.name || '').trim().slice(0, 100);
    const cleanPrompt = (params.systemPrompt || '').trim().slice(0, 2000);
    if (cleanName.length < 2) {
      throw new Error('INVALID_AGENT_NAME: Agent name must be at least 2 characters.');
    }
    if (cleanPrompt.length < 10) {
      throw new Error('INVALID_SYSTEM_PROMPT: System prompt / strategy instructions must be at least 10 characters.');
    }

    const skills = validateAgentSkills(params.enabledSkills);
    const riskUpper = String(params.riskToleranceLevel || 'MODERATE').trim().toUpperCase() as AgentRiskTolerance;
    const riskLevel: AgentRiskTolerance = VALID_RISK_LEVELS.has(riskUpper) ? riskUpper : 'MODERATE';
    const stratUpper = String(params.strategyProfile || 'MOMENTUM_BREAKOUT').trim().toUpperCase() as AgentStrategyProfileId;
    const strategyProfile: AgentStrategyProfileId = VALID_STRATEGIES.has(stratUpper) ? stratUpper : 'MOMENTUM_BREAKOUT';
    const targetSymbols = Array.isArray(params.targetSymbols) && params.targetSymbols.length > 0
      ? Array.from(new Set(params.targetSymbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean))).slice(0, 15)
      : ['BTCUSDT', 'ETHUSDT'];
    const cleanDesc = (params.strategyDescription || `${strategyProfile} custom strategy`).trim().slice(0, 400);
    const effectiveMax = Math.max(1, Math.min(PostgresCustomAgentAdapter.HARD_MAX_AGENTS_PER_USER, Number(params.maxAllowed ?? 15)));

    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const ownerId = await deps.ensureUserEntity(pool, params.userIdentifier);
        const cntRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM agent_profiles WHERE owner_id = $1`, [ownerId]);
        if (Number(cntRes.rows[0]?.cnt || 0) >= effectiveMax) {
          throw new Error(`MAX_AGENTS_REACHED: Maximum ${effectiveMax} custom agents allowed for your plan.`);
        }

        const agentId = crypto.randomUUID();
        await pool.query(`INSERT INTO entities (id, entity_type) VALUES ($1, 'AGENT') ON CONFLICT (id) DO NOTHING`, [agentId]);
        const res = await pool.query(
          `INSERT INTO agent_profiles (
             id, owner_id, name, strategy_description, system_prompt,
             risk_tolerance_level, enabled_skills, strategy_profile, target_symbols, status, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::text[], 'ACTIVE', NOW(), NOW())
           RETURNING id, owner_id, name, strategy_description, system_prompt, risk_tolerance_level,
                     enabled_skills, strategy_profile, target_symbols, status, created_at, updated_at`,
          [agentId, ownerId, cleanName, cleanDesc, cleanPrompt, riskLevel, JSON.stringify(skills), strategyProfile, targetSymbols]
        );
        await pool.query(
          `INSERT INTO audit_logs (id, actor_id, action, entity_id, reason, created_at)
           VALUES (gen_random_uuid(), $1, 'AGENT_PROFILE_CREATED', $2, $3, NOW())`,
          [ownerId, agentId, `Created custom AI agent "${cleanName}" (${strategyProfile}) with skills: ${skills.join(', ')}`]
        ).catch(() => {});

        const r = res.rows[0];
        return {
          id: String(r.id),
          ownerId: String(r.owner_id),
          name: String(r.name),
          strategyDescription: String(r.strategy_description || ''),
          systemPrompt: String(r.system_prompt || ''),
          riskToleranceLevel: riskLevel,
          strategyProfile,
          enabledSkills: skills,
          targetSymbols,
          status: 'ACTIVE',
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
          updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
        };
      } catch (err: any) {
        if (err?.message?.startsWith('MAX_AGENTS_REACHED')) throw err;
        console.warn('[PostgresCustomAgentAdapter] createUserAgent fallback:', err?.message);
      }
    }

    const norm = params.userIdentifier.toLowerCase();
    const existing = inMemoryCustomAgents.filter((a) => a.ownerId === norm);
    if (existing.length >= effectiveMax) {
      throw new Error(`MAX_AGENTS_REACHED: Maximum ${effectiveMax} custom agents allowed for your plan.`);
    }
    const now = new Date().toISOString();
    const created: CustomAgentProfile = {
      id: crypto.randomUUID(),
      ownerId: norm,
      name: cleanName,
      strategyDescription: cleanDesc,
      systemPrompt: cleanPrompt,
      riskToleranceLevel: riskLevel,
      strategyProfile,
      enabledSkills: skills,
      targetSymbols,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    };
    inMemoryCustomAgents.push(created);
    return created;
  }

  async updateUserAgentStatus(userIdentifier: string, agentId: string, status: 'ACTIVE' | 'PAUSED'): Promise<boolean> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const ownerId = await deps.ensureUserEntity(pool, userIdentifier);
        const res = await pool.query(
          `UPDATE agent_profiles SET status = $1, updated_at = NOW() WHERE id = $2 AND owner_id = $3 RETURNING id`,
          [status, agentId, ownerId]
        );
        return res.rows.length > 0;
      } catch {
        // fallback
      }
    }
    const norm = userIdentifier.toLowerCase();
    const target = inMemoryCustomAgents.find((a) => a.id === agentId && a.ownerId === norm);
    if (!target) return false;
    target.status = status;
    target.updatedAt = new Date().toISOString();
    return true;
  }

  async deleteUserAgent(userIdentifier: string, agentId: string): Promise<boolean> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const ownerId = await deps.ensureUserEntity(pool, userIdentifier);
        const res = await pool.query(
          `DELETE FROM agent_profiles WHERE id = $1 AND owner_id = $2 RETURNING id`,
          [agentId, ownerId]
        );
        return res.rows.length > 0;
      } catch {
        // fallback
      }
    }
    const norm = userIdentifier.toLowerCase();
    const idx = inMemoryCustomAgents.findIndex((a) => a.id === agentId && a.ownerId === norm);
    if (idx === -1) return false;
    inMemoryCustomAgents.splice(idx, 1);
    return true;
  }
}
