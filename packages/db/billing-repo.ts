/**
 * packages/db/billing-repo.ts
 *
 * Modular Domain Repository for Subscriptions, Credit Ledger, Capacity Add-Ons,
 * Plan Discounts, Platform Fee/Risk Config, User Risk Limits, 24h Exposure, & Security Activity.
 * Extracted from packages/shared/db-pool.ts (Phase AI2) with zero breaking changes via barrel facade.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import { compute24hRiskExposure } from '../trading/risk-gate';
import {
  filterActiveFeaturedBoosts,
  type FeaturedBoostRecord,
} from '../billing/high-margin-revenue';
import {
  PlanId,
  BillingDbAdapter,
  UserRiskPolicy,
  UserAddonSlots,
  CapacityAddonType,
  CAPACITY_ADDON_CATALOG,
  SubscriptionsEngine,
} from '../billing/subscriptions-engine';

export interface BillingRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool, userIdentifier: string) => Promise<string>;
}

let registeredDeps: BillingRepoDeps | null = null;

export function registerBillingRepoDeps(deps: BillingRepoDeps): void {
  registeredDeps = deps;
}

export interface SubscriptionRecord {
  id: string;
  userId: string;
  planId: PlanId;
  status: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  credits: number;
}

export interface AiFeatureWeights {
  arkham: number;
  firecrawl: number;
  ohlcv: number;
  defillama: number;
}

export const DEFAULT_AI_FEATURE_WEIGHTS: AiFeatureWeights = {
  arkham: 0.35,
  firecrawl: 0.25,
  ohlcv: 0.25,
  defillama: 0.15,
};

function normalizeAiFeatureWeights(raw?: Partial<AiFeatureWeights> | null): AiFeatureWeights {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_AI_FEATURE_WEIGHTS };
  const a = Number.isFinite(Number(raw.arkham)) ? Math.max(0, Number(raw.arkham)) : DEFAULT_AI_FEATURE_WEIGHTS.arkham;
  const f = Number.isFinite(Number(raw.firecrawl)) ? Math.max(0, Number(raw.firecrawl)) : DEFAULT_AI_FEATURE_WEIGHTS.firecrawl;
  const o = Number.isFinite(Number(raw.ohlcv)) ? Math.max(0, Number(raw.ohlcv)) : DEFAULT_AI_FEATURE_WEIGHTS.ohlcv;
  const d = Number.isFinite(Number(raw.defillama)) ? Math.max(0, Number(raw.defillama)) : DEFAULT_AI_FEATURE_WEIGHTS.defillama;
  const sum = a + f + o + d;
  if (sum <= 0) return { ...DEFAULT_AI_FEATURE_WEIGHTS };
  return {
    arkham: Math.round((a / sum) * 10000) / 10000,
    firecrawl: Math.round((f / sum) * 10000) / 10000,
    ohlcv: Math.round((o / sum) * 10000) / 10000,
    defillama: Math.round((d / sum) * 10000) / 10000,
  };
}

export interface PlatformFeeAndRiskConfig {
  studioCostCr: number;
  deskCostCr: number;
  launchCostCr: number;
  maxOrderValueUsd: number;
  maxDailyLossUsd: number;
  maxSlippagePct: number;
  dexSwapFeeBps?: number;
  treasuryWallet: string;
  launchpadContractAddress?: string;
  aiFeatureWeights?: AiFeatureWeights;
  updatedBy?: string;
  updatedAt?: string;
}

export class PostgresBillingDbAdapter implements BillingDbAdapter {
  private readonly deps?: BillingRepoDeps;
  private inMemorySubscriptions: Map<string, SubscriptionRecord> = new Map();
  private inMemoryPlanDiscounts: Map<
    PlanId,
    { discountPct: number; promoLabel?: string; updatedBy?: string; updatedAt?: string }
  > = new Map();
  private inMemoryFeeAndRiskConfig: PlatformFeeAndRiskConfig = {
    studioCostCr: 1,
    deskCostCr: 5,
    launchCostCr: 50,
    maxOrderValueUsd: 10000,
    maxDailyLossUsd: 1000,
    maxSlippagePct: 3.0,
    dexSwapFeeBps: 25,
    treasuryWallet: '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6',
    aiFeatureWeights: { ...DEFAULT_AI_FEATURE_WEIGHTS },
  };
  private inMemoryUserRiskPolicies = new Map<string, UserRiskPolicy>();
  private inMemoryAddonSlots = new Map<string, UserAddonSlots>();

  constructor(deps?: BillingRepoDeps) {
    this.deps = deps;
  }

  private resolveDeps(): BillingRepoDeps | null {
    return this.deps || registeredDeps;
  }

  seedSubscription(
    userId: string,
    sub: {
      planId: PlanId;
      status?: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED';
      currentPeriodEnd?: Date;
      credits?: number;
    }
  ): void {
    this.inMemorySubscriptions.set(userId, {
      id: crypto.randomUUID(),
      userId,
      planId: sub.planId,
      status: sub.status || 'ACTIVE',
      currentPeriodStart: new Date(),
      currentPeriodEnd: sub.currentPeriodEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      credits: sub.credits ?? 5000,
    });
  }

  clearSubscriptions(): void {
    this.inMemorySubscriptions.clear();
    this.inMemoryPlanDiscounts.clear();
    this.inMemoryFeeAndRiskConfig = {
      studioCostCr: 1,
      deskCostCr: 5,
      launchCostCr: 50,
      maxOrderValueUsd: 10000,
      maxDailyLossUsd: 1000,
      maxSlippagePct: 3.0,
      treasuryWallet: '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6',
      aiFeatureWeights: { ...DEFAULT_AI_FEATURE_WEIGHTS },
    };
  }

  async getPlatformFeeAndRiskConfig(): Promise<PlatformFeeAndRiskConfig> {
    const base: PlatformFeeAndRiskConfig = {
      ...this.inMemoryFeeAndRiskConfig,
      aiFeatureWeights: normalizeAiFeatureWeights(this.inMemoryFeeAndRiskConfig.aiFeatureWeights),
    };
    const pool = this.resolveDeps()?.getDbPool() || null;
    if (pool) {
      try {
        const res = await pool.query(`SELECT features FROM plans WHERE id = 'FREE' LIMIT 1`);
        if (res.rows.length > 0) {
          const feat =
            typeof res.rows[0].features === 'string'
              ? JSON.parse(res.rows[0].features || '{}')
              : res.rows[0].features || {};
          const cfg = feat.platformFeeAndRiskConfig;
          if (cfg && typeof cfg === 'object') {
            if (Number.isFinite(Number(cfg.studioCostCr))) base.studioCostCr = Math.max(0, Math.round(Number(cfg.studioCostCr)));
            if (Number.isFinite(Number(cfg.deskCostCr))) base.deskCostCr = Math.max(0, Math.round(Number(cfg.deskCostCr)));
            if (Number.isFinite(Number(cfg.launchCostCr))) base.launchCostCr = Math.max(0, Math.round(Number(cfg.launchCostCr)));
            if (Number.isFinite(Number(cfg.maxOrderValueUsd))) base.maxOrderValueUsd = Math.max(100, Math.round(Number(cfg.maxOrderValueUsd)));
            if (Number.isFinite(Number(cfg.maxDailyLossUsd))) base.maxDailyLossUsd = Math.max(50, Math.round(Number(cfg.maxDailyLossUsd)));
            if (Number.isFinite(Number(cfg.maxSlippagePct))) base.maxSlippagePct = Math.max(0.1, Math.min(10, Number(cfg.maxSlippagePct)));
            if (Number.isFinite(Number(cfg.dexSwapFeeBps))) base.dexSwapFeeBps = Math.max(0, Math.min(100, Math.round(Number(cfg.dexSwapFeeBps))));
            if (typeof cfg.treasuryWallet === 'string' && /^0x[a-fA-F0-9]{40}$/.test(cfg.treasuryWallet)) {
              base.treasuryWallet = cfg.treasuryWallet;
            }
            if (typeof cfg.launchpadContractAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(cfg.launchpadContractAddress)) {
              base.launchpadContractAddress = cfg.launchpadContractAddress;
            }
            if (cfg.aiFeatureWeights && typeof cfg.aiFeatureWeights === 'object') {
              base.aiFeatureWeights = normalizeAiFeatureWeights(cfg.aiFeatureWeights);
            }
            if (typeof cfg.updatedBy === 'string') base.updatedBy = cfg.updatedBy;
            if (typeof cfg.updatedAt === 'string') base.updatedAt = cfg.updatedAt;
          }
        }
      } catch {
        // Fallback to in-memory
      }
    }
    return base;
  }

  async setPlatformFeeAndRiskConfig(
    params: Partial<PlatformFeeAndRiskConfig> & { actorId: string }
  ): Promise<PlatformFeeAndRiskConfig> {
    const current = await this.getPlatformFeeAndRiskConfig();
    const updated: PlatformFeeAndRiskConfig = {
      studioCostCr: params.studioCostCr !== undefined ? Math.max(0, Math.round(Number(params.studioCostCr))) : current.studioCostCr,
      deskCostCr: params.deskCostCr !== undefined ? Math.max(0, Math.round(Number(params.deskCostCr))) : current.deskCostCr,
      launchCostCr: params.launchCostCr !== undefined ? Math.max(0, Math.round(Number(params.launchCostCr))) : current.launchCostCr,
      maxOrderValueUsd: params.maxOrderValueUsd !== undefined ? Math.max(100, Math.round(Number(params.maxOrderValueUsd))) : current.maxOrderValueUsd,
      maxDailyLossUsd: params.maxDailyLossUsd !== undefined ? Math.max(50, Math.round(Number(params.maxDailyLossUsd))) : current.maxDailyLossUsd,
      maxSlippagePct: params.maxSlippagePct !== undefined ? Math.max(0.1, Math.min(10, Number(params.maxSlippagePct))) : current.maxSlippagePct,
      dexSwapFeeBps:
        params.dexSwapFeeBps !== undefined
          ? Math.max(0, Math.min(100, Math.round(Number(params.dexSwapFeeBps))))
          : (current.dexSwapFeeBps ?? 25),
      treasuryWallet:
        typeof params.treasuryWallet === 'string' && /^0x[a-fA-F0-9]{40}$/.test(params.treasuryWallet)
          ? params.treasuryWallet
          : current.treasuryWallet,
      launchpadContractAddress:
        typeof params.launchpadContractAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(params.launchpadContractAddress)
          ? params.launchpadContractAddress
          : params.launchpadContractAddress === ''
            ? undefined
            : current.launchpadContractAddress,
      aiFeatureWeights: params.aiFeatureWeights
        ? normalizeAiFeatureWeights(params.aiFeatureWeights)
        : normalizeAiFeatureWeights(current.aiFeatureWeights),
      updatedBy: params.actorId,
      updatedAt: new Date().toISOString(),
    };

    this.inMemoryFeeAndRiskConfig = { ...updated };

    const pool = this.resolveDeps()?.getDbPool() || null;
    if (pool) {
      try {
        const patch = JSON.stringify({ platformFeeAndRiskConfig: updated });
        await pool.query(
          `INSERT INTO plans (id, name, base_price_cents, monthly_credits, features)
           VALUES ('FREE', 'FREE Tier', 0, 100, $1::jsonb)
           ON CONFLICT (id) DO UPDATE SET
             features = COALESCE(plans.features, '{}'::jsonb) || EXCLUDED.features`,
          [patch]
        );
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] setPlatformFeeAndRiskConfig warning:', err?.message);
      }
    }

    return updated;
  }

  async getUserRiskPolicy(userId: string): Promise<UserRiskPolicy | null> {
    const norm = userId.toLowerCase();
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, userId);
        const res = await pool.query(
          `SELECT max_order_value_usd, max_daily_loss_usd, max_slippage_pct, allowed_symbols, updated_at
           FROM user_risk_limits
           WHERE user_id = $1
           LIMIT 1`,
          [validUserId]
        );
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            maxOrderValueUsd: Number(r.max_order_value_usd),
            maxDailyLossUsd: Number(r.max_daily_loss_usd),
            maxSlippagePct: Number(r.max_slippage_pct),
            allowedSymbols: Array.isArray(r.allowed_symbols) ? r.allowed_symbols.map(String) : [],
            updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : undefined,
          };
        }
        return null;
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] getUserRiskPolicy fallback:', err?.message);
      }
    }
    return this.inMemoryUserRiskPolicies.get(norm) || null;
  }

  async upsertUserRiskPolicy(userId: string, policy: UserRiskPolicy): Promise<UserRiskPolicy> {
    const norm = userId.toLowerCase();
    const clean: UserRiskPolicy = {
      maxOrderValueUsd: Math.max(1, Number(policy.maxOrderValueUsd)),
      maxDailyLossUsd: Math.max(1, Number(policy.maxDailyLossUsd)),
      maxSlippagePct: Math.max(0.1, Math.min(10, Number(policy.maxSlippagePct))),
      allowedSymbols: Array.isArray(policy.allowedSymbols)
        ? policy.allowedSymbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean).slice(0, 20)
        : [],
      updatedAt: new Date().toISOString(),
    };

    this.inMemoryUserRiskPolicies.set(norm, clean);

    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, userId);
        await pool.query(
          `INSERT INTO user_risk_limits (user_id, max_order_value_usd, max_daily_loss_usd, max_slippage_pct, allowed_symbols, updated_at)
           VALUES ($1, $2, $3, $4, $5::text[], NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             max_order_value_usd = EXCLUDED.max_order_value_usd,
             max_daily_loss_usd = EXCLUDED.max_daily_loss_usd,
             max_slippage_pct = EXCLUDED.max_slippage_pct,
             allowed_symbols = EXCLUDED.allowed_symbols,
             updated_at = NOW()`,
          [validUserId, clean.maxOrderValueUsd, clean.maxDailyLossUsd, clean.maxSlippagePct, clean.allowedSymbols]
        );
        await this.createAuditLog(
          validUserId,
          'USER_RISK_POLICY_UPDATED',
          validUserId,
          `Updated risk policy: maxOrder=$${clean.maxOrderValueUsd}, maxDailyLoss=$${clean.maxDailyLossUsd}, maxSlippage=${clean.maxSlippagePct}%`
        );
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] upsertUserRiskPolicy fallback:', err?.message);
      }
    }

    return clean;
  }

  async getUserAddonSlots(userId: string): Promise<UserAddonSlots> {
    const norm = userId.toLowerCase();
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, userId);
        const res = await pool.query(
          `SELECT type, COALESCE(SUM(amount), 0)::int AS total_slots
           FROM ledger_entries
           WHERE user_id = $1 AND currency = 'SLOTS'
             AND type IN ('ADDON_BANKR_SLOTS', 'ADDON_BINANCE_SLOTS')
           GROUP BY type`,
          [validUserId]
        );
        let bankrExtraSlots = 0;
        let binanceExtraSlots = 0;
        for (const r of res.rows) {
          if (r.type === 'ADDON_BANKR_SLOTS') bankrExtraSlots = Math.max(0, Number(r.total_slots || 0));
          if (r.type === 'ADDON_BINANCE_SLOTS') binanceExtraSlots = Math.max(0, Number(r.total_slots || 0));
        }
        return { bankrExtraSlots, binanceExtraSlots };
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] getUserAddonSlots fallback:', err?.message);
      }
    }
    return this.inMemoryAddonSlots.get(norm) || { bankrExtraSlots: 0, binanceExtraSlots: 0 };
  }

  async purchaseCapacityAddon(
    userId: string,
    addonType: CapacityAddonType
  ): Promise<{
    addonType: CapacityAddonType;
    slotsAdded: number;
    creditsCharged: number;
    remainingCredits: number;
    totalAddonSlots: UserAddonSlots;
  }> {
    const item = CAPACITY_ADDON_CATALOG[addonType];
    if (!item) {
      throw new Error(`INVALID_ADDON_TYPE: Unknown add-on "${addonType}"`);
    }

    const refId = `addon-${addonType.toLowerCase()}-${Date.now()}`;
    await SubscriptionsEngine.deductMeteredCredits(userId, item.creditCost, addonType, refId, this);

    await this.recordLedgerEntry({
      userId,
      amount: item.slotsAdded,
      currency: 'SLOTS',
      type: addonType,
      referenceId: refId,
      description: `Permanent slot add-on: ${item.name}`,
    });

    const norm = userId.toLowerCase();
    const cur = this.inMemoryAddonSlots.get(norm) || { bankrExtraSlots: 0, binanceExtraSlots: 0 };
    const nextMem: UserAddonSlots = {
      bankrExtraSlots: cur.bankrExtraSlots + (addonType === 'ADDON_BANKR_SLOTS' ? item.slotsAdded : 0),
      binanceExtraSlots: cur.binanceExtraSlots + (addonType === 'ADDON_BINANCE_SLOTS' ? item.slotsAdded : 0),
    };
    this.inMemoryAddonSlots.set(norm, nextMem);

    await this.createAuditLog(
      userId,
      'ADDON_SLOT_PURCHASED',
      addonType,
      `Purchased ${item.name} (+${item.slotsAdded} slots) for ${item.creditCost} Credits`
    );

    const [remainingCredits, totalAddonSlots] = await Promise.all([
      this.getUserCreditBalance(userId),
      this.getUserAddonSlots(userId),
    ]);

    return {
      addonType,
      slotsAdded: item.slotsAdded,
      creditsCharged: item.creditCost,
      remainingCredits,
      totalAddonSlots,
    };
  }

  async getUser24hRiskExposure(userId: string): Promise<{ currentDailyLossUsd: number; currentOpenPositions: number }> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (!pool || !deps) {
      return { currentDailyLossUsd: 0, currentOpenPositions: 0 };
    }
    try {
      const validUserId = await deps.ensureUserEntity(pool, userId);
      const [fillsRes, openRes] = await Promise.all([
        pool.query(
          `SELECT ti.side, COALESCE(o.cummulative_quote_qty, 0)::numeric AS quote_val, o.status
           FROM orders o
           JOIN trade_intents ti ON o.intent_id = ti.id
           WHERE ti.user_id = $1 AND o.created_at >= NOW() - INTERVAL '24 hours'`,
          [validUserId]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS cnt
           FROM trade_intents
           WHERE user_id = $1
             AND status IN ('APPROVED', 'EXECUTING')
             AND created_at >= NOW() - INTERVAL '24 hours'`,
          [validUserId]
        ),
      ]);
      const fills = fillsRes.rows.map((r: any) => ({
        side: (String(r.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
        quoteValueUsd: Number(r.quote_val || 0),
        status: String(r.status || ''),
      }));
      const openIntentCount = Number(openRes.rows[0]?.cnt || 0);
      return compute24hRiskExposure({ fills, openIntentCount });
    } catch {
      return { currentDailyLossUsd: 0, currentOpenPositions: 0 };
    }
  }

  async getUserSecurityActivity(
    userId: string,
    limit: number = 10
  ): Promise<Array<{ id: string; action: string; reason: string | null; createdAt: string }>> {
    const safeLimit = Math.max(1, Math.min(25, Math.floor(limit)));
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (!pool || !deps) {
      return [];
    }
    try {
      const validUserId = await deps.ensureUserEntity(pool, userId);
      const res = await pool.query(
        `SELECT id, action, reason, created_at
         FROM audit_logs
         WHERE actor_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [validUserId, safeLimit]
      );
      return res.rows.map((r: any) => ({
        id: String(r.id),
        action: String(r.action),
        reason: r.reason ? String(r.reason) : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      }));
    } catch {
      return [];
    }
  }

  async getPlanDiscounts(): Promise<
    Record<PlanId, { discountPct: number; promoLabel?: string; updatedBy?: string; updatedAt?: string }>
  > {
    const result: Record<PlanId, { discountPct: number; promoLabel?: string; updatedBy?: string; updatedAt?: string }> = {
      FREE: { discountPct: 0 },
      CREATOR: { discountPct: 0 },
      TRADER: { discountPct: 0 },
      AGENT: { discountPct: 0 },
    };

    for (const [planId, cfg] of this.inMemoryPlanDiscounts.entries()) {
      result[planId] = { ...cfg };
    }

    const pool = this.resolveDeps()?.getDbPool() || null;
    if (pool) {
      try {
        const res = await pool.query(`SELECT id, features FROM plans`);
        for (const row of res.rows) {
          const pid = String(row.id || '').toUpperCase() as PlanId;
          if (pid === 'FREE' || pid === 'CREATOR' || pid === 'TRADER' || pid === 'AGENT') {
            const feat = typeof row.features === 'string' ? JSON.parse(row.features || '{}') : row.features || {};
            const pct = Math.max(0, Math.min(100, Math.round(Number(feat.discountPct ?? 0))));
            result[pid] = {
              discountPct: pct,
              promoLabel: typeof feat.promoLabel === 'string' && feat.promoLabel.trim() ? feat.promoLabel.trim() : undefined,
              updatedBy: typeof feat.updatedBy === 'string' ? feat.updatedBy : undefined,
              updatedAt: typeof feat.updatedAt === 'string' ? feat.updatedAt : undefined,
            };
          }
        }
      } catch {
        // Fallback to in-memory
      }
    }

    return result;
  }

  async setPlanDiscount(params: {
    planId: PlanId;
    discountPct: number;
    promoLabel?: string;
    actorId: string;
  }): Promise<{ planId: PlanId; discountPct: number; promoLabel?: string; updatedAt: string }> {
    const planId = params.planId;
    const discountPct = Math.max(0, Math.min(100, Math.round(Number(params.discountPct ?? 0))));
    const promoLabel = params.promoLabel?.trim() || undefined;
    const updatedAt = new Date().toISOString();

    this.inMemoryPlanDiscounts.set(planId, {
      discountPct,
      promoLabel,
      updatedBy: params.actorId,
      updatedAt,
    });

    const pool = this.resolveDeps()?.getDbPool() || null;
    if (pool) {
      try {
        const basePricesCents: Record<PlanId, number> = {
          FREE: 0,
          CREATOR: 4900,
          TRADER: 7900,
          AGENT: 14900,
        };
        const planCredits: Record<PlanId, number> = {
          FREE: 100,
          CREATOR: 2000,
          TRADER: 5000,
          AGENT: 15000,
        };
        const discountedCents = Math.max(0, Math.round(basePricesCents[planId] * (1 - discountPct / 100)));
        const featurePatch = JSON.stringify({
          discountPct,
          promoLabel: promoLabel || null,
          updatedBy: params.actorId,
          updatedAt,
        });

        await pool.query(
          `INSERT INTO plans (id, name, base_price_cents, monthly_credits, features)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (id) DO UPDATE SET
             base_price_cents = EXCLUDED.base_price_cents,
             features = COALESCE(plans.features, '{}'::jsonb) || EXCLUDED.features`,
          [planId, `${planId} Tier`, discountedCents, planCredits[planId] ?? 100, featurePatch]
        );
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] setPlanDiscount warning:', err?.message);
      }
    }

    return { planId, discountPct, promoLabel, updatedAt };
  }

  async getUserPlan(userId: string): Promise<PlanId> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (!pool) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DATABASE_UNAVAILABLE: Neon connection pool is not available in production.');
      }
      if (process.env.NODE_ENV !== 'test') {
        return 'FREE';
      }
    }

    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, userId);
        const res = await pool.query(
          `SELECT plan_id, status, current_period_end
           FROM subscriptions
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [validUserId]
        );
        if (res.rows.length === 0) {
          return 'FREE';
        }
        const row = res.rows[0];
        const isActive = row.status === 'ACTIVE';
        const isNotExpired = new Date(row.current_period_end).getTime() > Date.now();
        if (isActive && isNotExpired) {
          const plan = row.plan_id?.toUpperCase();
          if (plan === 'TRADER' || plan === 'AGENT' || plan === 'CREATOR' || plan === 'FREE') {
            return plan as PlanId;
          }
        }
        return 'FREE';
      } catch (err: any) {
        throw new Error(`DATABASE_UNAVAILABLE: Failed to query user subscription: ${err?.message || err}`);
      }
    }

    const sub = this.inMemorySubscriptions.get(userId);
    if (!sub) return 'FREE';
    const isActive = sub.status === 'ACTIVE';
    const isNotExpired = new Date(sub.currentPeriodEnd).getTime() > Date.now();
    if (isActive && isNotExpired) {
      return sub.planId;
    }
    return 'FREE';
  }

  async getUserEntitlement(userId: string): Promise<{ planId: PlanId; hasLiveTrading: boolean; paperTrading: boolean }> {
    const planId = await this.getUserPlan(userId);
    const hasLiveTrading = planId === 'TRADER' || planId === 'AGENT';
    return {
      planId,
      hasLiveTrading,
      paperTrading: true,
    };
  }

  async getUserCreditBalance(userId: string): Promise<number> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, userId);
        const res = await pool.query(
          `SELECT COALESCE(SUM(amount), 0)::numeric AS balance, COUNT(*)::int AS cnt
           FROM ledger_entries
           WHERE user_id = $1 AND currency = 'CREDITS'`,
          [validUserId]
        );
        const cnt = Number(res.rows[0]?.cnt ?? 0);
        if (cnt > 0) {
          return Math.max(0, Math.round(Number(res.rows[0]?.balance ?? 0)));
        }
        const plan = await this.getUserPlan(userId).catch(() => 'FREE' as PlanId);
        const defaultCredits: Record<PlanId, number> = {
          FREE: 100,
          CREATOR: 2000,
          TRADER: 5000,
          AGENT: 15000,
        };
        const initialGrant = defaultCredits[plan] ?? 100;
        await pool
          .query(
            `INSERT INTO ledger_entries (
               id, user_id, amount, currency, type, reference_id, description, created_at
             ) VALUES ($1, $2, $3, 'CREDITS', 'INITIAL_PLAN_GRANT', $4, $5, NOW())`,
            [
              crypto.randomUUID(),
              validUserId,
              initialGrant,
              `init-${plan.toLowerCase()}`,
              `Initial credit allocation for ${plan} tier`,
            ]
          )
          .catch(() => {});
        return initialGrant;
      } catch {
        // Fallback to in-memory
      }
    }
    const sub = this.inMemorySubscriptions.get(userId);
    return sub?.credits ?? 100;
  }

  async getUserLedgerEntries(
    userId: string,
    limit: number = 25
  ): Promise<
    Array<{
      id: string;
      amount: number;
      currency: string;
      type: string;
      referenceId: string | null;
      description: string;
      createdAt: string;
    }>
  > {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit || 25)));
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, userId);
        await this.getUserCreditBalance(userId);
        const res = await pool.query(
          `SELECT id, amount::numeric AS amount, currency, type, reference_id AS "referenceId",
                  COALESCE(description, '') AS description, created_at AS "createdAt"
           FROM ledger_entries
           WHERE user_id = $1 AND currency = 'CREDITS'
           ORDER BY created_at DESC
           LIMIT $2`,
          [validUserId, safeLimit]
        );
        return res.rows.map((r: any) => ({
          id: String(r.id),
          amount: Math.round(Number(r.amount ?? 0)),
          currency: String(r.currency || 'CREDITS'),
          type: String(r.type || 'LEDGER_ENTRY'),
          referenceId: r.referenceId ? String(r.referenceId) : null,
          description: String(r.description || ''),
          createdAt: r.createdAt?.toISOString ? r.createdAt.toISOString() : String(r.createdAt || new Date().toISOString()),
        }));
      } catch {
        // Fallback to in-memory
      }
    }
    const balance = await this.getUserCreditBalance(userId);
    const plan = await this.getUserPlan(userId).catch(() => 'FREE' as PlanId);
    return [
      {
        id: `mem-init-${plan.toLowerCase()}`,
        amount: balance,
        currency: 'CREDITS',
        type: 'INITIAL_PLAN_GRANT',
        referenceId: `init-${plan.toLowerCase()}`,
        description: `Initial credit allocation for ${plan} tier`,
        createdAt: new Date().toISOString(),
      },
    ];
  }

  async recordLedgerEntry(entry: {
    userId: string;
    amount: number;
    currency: string;
    type: string;
    referenceId?: string;
    description: string;
  }): Promise<void> {
    const sub = this.inMemorySubscriptions.get(entry.userId);
    if (sub) {
      sub.credits = Math.max(0, (sub.credits ?? 0) + entry.amount);
    }
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, entry.userId);
        await pool.query(
          `INSERT INTO ledger_entries (
             id, user_id, amount, currency, type, reference_id, description, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [
            crypto.randomUUID(),
            validUserId,
            entry.amount,
            entry.currency || 'CREDITS',
            entry.type,
            entry.referenceId ?? null,
            entry.description,
          ]
        );
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] recordLedgerEntry warning:', err?.message);
      }
    }
  }

  async updateUserSubscription(userId: string, planId: PlanId, stripeSubId?: string): Promise<void> {
    const planCredits: Record<PlanId, number> = {
      FREE: 100,
      CREATOR: 2000,
      TRADER: 5000,
      AGENT: 15000,
    };
    this.seedSubscription(userId, { planId, status: 'ACTIVE', credits: planCredits[planId] ?? 100 });
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const validUserId = await deps.ensureUserEntity(pool, userId);
        const priceCents: Record<PlanId, number> = {
          FREE: 0,
          CREATOR: 4900,
          TRADER: 7900,
          AGENT: 14900,
        };
        await pool.query(
          `INSERT INTO plans (id, name, base_price_cents, monthly_credits, features)
           VALUES ($1, $2, $3, $4, '{}'::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [planId, `${planId} Tier`, priceCents[planId] ?? 0, planCredits[planId] ?? 100]
        );
        await pool.query(
          `INSERT INTO subscriptions (
             id, user_id, plan_id, stripe_subscription_id, status,
             current_period_start, current_period_end, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'ACTIVE', NOW(), NOW() + INTERVAL '30 days', NOW(), NOW())`,
          [crypto.randomUUID(), validUserId, planId, stripeSubId ?? null]
        );
        if (planId === 'CREATOR' || planId === 'AGENT') {
          await pool.query(
            `INSERT INTO user_roles (user_id, role, created_at)
             VALUES ($1, 'CREATOR', NOW())
             ON CONFLICT (user_id, role) DO NOTHING`,
            [validUserId]
          );
        }
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] updateUserSubscription warning:', err?.message);
      }
    }
  }

  private inMemoryFeaturedBoosts: FeaturedBoostRecord[] = [];
  private inMemoryRedeemedBoostTxHashes: Set<string> = new Set();

  async getActiveFeaturedBoosts(): Promise<FeaturedBoostRecord[]> {
    const pool = this.resolveDeps()?.getDbPool() || null;
    if (pool) {
      try {
        const res = await pool.query(`SELECT features FROM plans WHERE id = 'FREE' LIMIT 1`);
        if (res.rows.length > 0) {
          const feat =
            typeof res.rows[0].features === 'string'
              ? JSON.parse(res.rows[0].features)
              : res.rows[0].features || {};
          if (Array.isArray(feat.featuredBoosts)) {
            return filterActiveFeaturedBoosts(feat.featuredBoosts as FeaturedBoostRecord[]);
          }
        }
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] getActiveFeaturedBoosts warning:', err?.message);
      }
    }
    return filterActiveFeaturedBoosts(this.inMemoryFeaturedBoosts);
  }

  async recordFeaturedBoost(record: FeaturedBoostRecord): Promise<{
    ok: boolean;
    replay?: boolean;
    activeBoosts: FeaturedBoostRecord[];
  }> {
    const normTx = record.txHash.trim().toLowerCase();
    const pool = this.resolveDeps()?.getDbPool() || null;

    if (pool) {
      try {
        const res = await pool.query(`SELECT features FROM plans WHERE id = 'FREE' LIMIT 1`);
        const feat =
          res.rows.length > 0
            ? typeof res.rows[0].features === 'string'
              ? JSON.parse(res.rows[0].features)
              : res.rows[0].features || {}
            : {};
        const existingBoosts: FeaturedBoostRecord[] = Array.isArray(feat.featuredBoosts)
          ? feat.featuredBoosts
          : [];
        const redeemedTxs: string[] = Array.isArray(feat.redeemedBoostTxHashes)
          ? feat.redeemedBoostTxHashes
          : [];

        if (redeemedTxs.some((t) => String(t).toLowerCase() === normTx)) {
          return {
            ok: false,
            replay: true,
            activeBoosts: filterActiveFeaturedBoosts(existingBoosts),
          };
        }

        const nextBoosts = filterActiveFeaturedBoosts([record, ...existingBoosts]);
        const nextRedeemed = [normTx, ...redeemedTxs].slice(0, 500);
        const patch = JSON.stringify({
          featuredBoosts: nextBoosts,
          redeemedBoostTxHashes: nextRedeemed,
        });

        await pool.query(
          `INSERT INTO plans (id, name, base_price_cents, monthly_credits, features)
           VALUES ('FREE', 'FREE Tier', 0, 100, $1::jsonb)
           ON CONFLICT (id) DO UPDATE SET
             features = COALESCE(plans.features, '{}'::jsonb) || $1::jsonb`,
          [patch]
        );

        this.inMemoryFeaturedBoosts = nextBoosts;
        this.inMemoryRedeemedBoostTxHashes.add(normTx);
        return { ok: true, activeBoosts: nextBoosts };
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] recordFeaturedBoost warning:', err?.message);
      }
    }

    if (this.inMemoryRedeemedBoostTxHashes.has(normTx)) {
      return {
        ok: false,
        replay: true,
        activeBoosts: filterActiveFeaturedBoosts(this.inMemoryFeaturedBoosts),
      };
    }
    this.inMemoryRedeemedBoostTxHashes.add(normTx);
    this.inMemoryFeaturedBoosts = filterActiveFeaturedBoosts([record, ...this.inMemoryFeaturedBoosts]);
    return { ok: true, activeBoosts: this.inMemoryFeaturedBoosts };
  }

  async createAuditLog(_actorId: string, _action: string, _entityId?: string, _reason?: string): Promise<void> {
    // Audit log
  }
}
