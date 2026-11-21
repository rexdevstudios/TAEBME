export type PlanId = 'FREE' | 'CREATOR' | 'TRADER' | 'AGENT';

export interface PlanEntitlements {
  paperTrading: boolean;
  viewLaunchpad: boolean;
  createLaunch: boolean;
  liveTrading: boolean;
  binanceWsStreams: boolean;
  daytonaSandbox: boolean;
  aiProposals: boolean;
}

export interface PlanCapacities {
  planId: PlanId;
  monthlyCredits: number;
  maxBankrKeys: number;
  maxBinanceAccounts: number;
  maxCustomAgents: number;
  allowMainnetBinance: boolean;
  maxOrderValueUsd: number;
  maxDailyLossUsd: number;
}

export interface UserRiskPolicy {
  maxOrderValueUsd: number;
  maxDailyLossUsd: number;
  maxSlippagePct: number;
  allowedSymbols: string[];
  updatedAt?: string;
}

export interface EffectiveUserRiskLimits {
  planId: PlanId;
  maxOrderValueUsd: number;
  maxDailyLossUsd: number;
  maxSlippagePct: number;
  allowedSymbols: string[];
}

/**
 * Pure deterministic clamping function (Defense-in-Depth):
 * Users can tighten their own risk limits, but can NEVER exceed their billing tier ceiling
 * or the global platform admin risk cap.
 */
export function computeEffectiveUserRiskLimits(params: {
  planId?: string | null;
  userPolicy?: Partial<UserRiskPolicy> | null;
  platformGlobalCap?: {
    maxOrderValueUsd?: number;
    maxDailyLossUsd?: number;
    maxSlippagePct?: number;
  } | null;
}): EffectiveUserRiskLimits {
  const tier = SubscriptionsEngine.getPlanCapacities(params.planId);
  const globalMaxOrder = Number.isFinite(Number(params.platformGlobalCap?.maxOrderValueUsd))
    ? Math.max(10, Number(params.platformGlobalCap?.maxOrderValueUsd))
    : 10000;
  const globalMaxDailyLoss = Number.isFinite(Number(params.platformGlobalCap?.maxDailyLossUsd))
    ? Math.max(10, Number(params.platformGlobalCap?.maxDailyLossUsd))
    : 1000;
  const globalMaxSlippage = Number.isFinite(Number(params.platformGlobalCap?.maxSlippagePct))
    ? Math.max(0.1, Math.min(10, Number(params.platformGlobalCap?.maxSlippagePct)))
    : 3.0;

  const ceilingOrder = Math.min(tier.maxOrderValueUsd, globalMaxOrder);
  const ceilingLoss = Math.min(tier.maxDailyLossUsd, globalMaxDailyLoss);
  const ceilingSlippage = globalMaxSlippage;

  const userOrder =
    params.userPolicy?.maxOrderValueUsd !== undefined && Number.isFinite(Number(params.userPolicy.maxOrderValueUsd))
      ? Math.max(1, Number(params.userPolicy.maxOrderValueUsd))
      : ceilingOrder;
  const userLoss =
    params.userPolicy?.maxDailyLossUsd !== undefined && Number.isFinite(Number(params.userPolicy.maxDailyLossUsd))
      ? Math.max(1, Number(params.userPolicy.maxDailyLossUsd))
      : ceilingLoss;
  const userSlippage =
    params.userPolicy?.maxSlippagePct !== undefined && Number.isFinite(Number(params.userPolicy.maxSlippagePct))
      ? Math.max(0.1, Number(params.userPolicy.maxSlippagePct))
      : Math.min(1.5, ceilingSlippage);

  const allowedSymbols = Array.isArray(params.userPolicy?.allowedSymbols)
    ? Array.from(
        new Set(
          params.userPolicy.allowedSymbols
            .map((s) => String(s || '').trim().toUpperCase())
            .filter((s) => s.length >= 2 && s.length <= 24)
        )
      ).slice(0, 20)
    : [];

  return {
    planId: tier.planId,
    maxOrderValueUsd: Math.round(Math.min(userOrder, ceilingOrder) * 100) / 100,
    maxDailyLossUsd: Math.round(Math.min(userLoss, ceilingLoss) * 100) / 100,
    maxSlippagePct: Math.round(Math.min(userSlippage, ceilingSlippage) * 100) / 100,
    allowedSymbols,
  };
}

export interface BillingDbAdapter {
  getUserPlan(userId: string): Promise<PlanId>;
  getUserCreditBalance(userId: string): Promise<number>;
  recordLedgerEntry(entry: {
    userId: string;
    amount: number;
    currency: string;
    type: string;
    referenceId?: string;
    description: string;
  }): Promise<void>;
  updateUserSubscription(userId: string, planId: PlanId, stripeSubId?: string): Promise<void>;
  createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void>;
}

export type VaultKeyQuotaStatus = 'ACTIVE' | 'FROZEN_OVER_QUOTA' | 'FROZEN_MAINNET_LOCKED';
export type CapacityAddonType = 'ADDON_BANKR_SLOTS' | 'ADDON_BINANCE_SLOTS';

export interface UserAddonSlots {
  bankrExtraSlots: number;
  binanceExtraSlots: number;
}

export const CAPACITY_ADDON_CATALOG: Record<
  CapacityAddonType,
  {
    type: CapacityAddonType;
    name: string;
    description: string;
    slotsAdded: number;
    creditCost: number;
    targetVault: 'BANKR' | 'BINANCE';
  }
> = {
  ADDON_BANKR_SLOTS: {
    type: 'ADDON_BANKR_SLOTS',
    name: '+5 Permanent Bankr Key Slots',
    description: 'Tambahan 5 slot API Key Bankr permanen (tidak hangus saat ganti bulan atau downgrade).',
    slotsAdded: 5,
    creditCost: 250,
    targetVault: 'BANKR',
  },
  ADDON_BINANCE_SLOTS: {
    type: 'ADDON_BINANCE_SLOTS',
    name: '+5 Permanent Binance CEX Slots',
    description: 'Tambahan 5 slot akun Binance CEX permanen (akses Mainnet tetap mengikuti tier TRADER/AGENT).',
    slotsAdded: 5,
    creditCost: 300,
    targetVault: 'BINANCE',
  },
};

export function computeEffectiveVaultCapacity(
  planId?: string | null,
  addonSlots?: Partial<UserAddonSlots> | null
): {
  planId: PlanId;
  baseBankrKeys: number;
  baseBinanceAccounts: number;
  bankrExtraSlots: number;
  binanceExtraSlots: number;
  maxBankrKeys: number;
  maxBinanceAccounts: number;
  allowMainnetBinance: boolean;
} {
  const base = SubscriptionsEngine.getPlanCapacities(planId);
  const bankrExtra = Math.max(0, Math.floor(Number(addonSlots?.bankrExtraSlots || 0)));
  const binanceExtra = Math.max(0, Math.floor(Number(addonSlots?.binanceExtraSlots || 0)));
  return {
    planId: base.planId,
    baseBankrKeys: base.maxBankrKeys,
    baseBinanceAccounts: base.maxBinanceAccounts,
    bankrExtraSlots: bankrExtra,
    binanceExtraSlots: binanceExtra,
    maxBankrKeys: Math.min(50, base.maxBankrKeys + bankrExtra),
    maxBinanceAccounts: Math.min(50, base.maxBinanceAccounts + binanceExtra),
    allowMainnetBinance: base.allowMainnetBinance,
  };
}

/**
 * Pure deterministic Soft-Freeze annotator (Zero Data Loss):
 * Keys ordered by `isDefault DESC, createdAt DESC` fill active slots first.
 * Excess keys are marked `FROZEN_OVER_QUOTA`, and Mainnet Binance keys on non-Mainnet tiers
 * are marked `FROZEN_MAINNET_LOCKED`.
 */
export function annotateKeysWithQuotaStatus<
  T extends { id: string; isDefault: boolean; createdAt: string; environment?: 'TESTNET' | 'MAINNET' }
>(
  keys: T[],
  opts: { maxActive: number; allowMainnet?: boolean }
): Array<T & { quotaStatus: VaultKeyQuotaStatus }> {
  const ordered = [...keys].sort((a, b) => {
    const defDiff = Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault));
    if (defDiff !== 0) return defDiff;
    return Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0');
  });

  let activeUsed = 0;
  return ordered.map((item) => {
    if (item.environment === 'MAINNET' && opts.allowMainnet === false) {
      return { ...item, quotaStatus: 'FROZEN_MAINNET_LOCKED' as VaultKeyQuotaStatus };
    }
    if (activeUsed < opts.maxActive) {
      activeUsed += 1;
      return { ...item, quotaStatus: 'ACTIVE' as VaultKeyQuotaStatus };
    }
    return { ...item, quotaStatus: 'FROZEN_OVER_QUOTA' as VaultKeyQuotaStatus };
  });
}

export class SubscriptionsEngine {
  private static readonly PLAN_MONTHLY_CREDITS: Record<PlanId, number> = {
    FREE: 100,
    CREATOR: 5000,
    TRADER: 5000,
    AGENT: 15000,
  };

  private static readonly PLAN_CAPACITIES: Record<PlanId, PlanCapacities> = {
    FREE: {
      planId: 'FREE',
      monthlyCredits: 100,
      maxBankrKeys: 1,
      maxBinanceAccounts: 1,
      maxCustomAgents: 1,
      allowMainnetBinance: false,
      maxOrderValueUsd: 250,
      maxDailyLossUsd: 50,
    },
    CREATOR: {
      planId: 'CREATOR',
      monthlyCredits: 5000,
      maxBankrKeys: 15,
      maxBinanceAccounts: 2,
      maxCustomAgents: 3,
      allowMainnetBinance: false,
      maxOrderValueUsd: 1000,
      maxDailyLossUsd: 200,
    },
    TRADER: {
      planId: 'TRADER',
      monthlyCredits: 5000,
      maxBankrKeys: 3,
      maxBinanceAccounts: 5,
      maxCustomAgents: 5,
      allowMainnetBinance: true,
      maxOrderValueUsd: 10000,
      maxDailyLossUsd: 1000,
    },
    AGENT: {
      planId: 'AGENT',
      monthlyCredits: 15000,
      maxBankrKeys: 25,
      maxBinanceAccounts: 15,
      maxCustomAgents: 15,
      allowMainnetBinance: true,
      maxOrderValueUsd: 25000,
      maxDailyLossUsd: 2500,
    },
  };

  /**
   * SSOT Kapasitas Bisnis per Tier Billing (Vault Keys, Binance Accounts, Mainnet Access, Risk Caps)
   */
  static getPlanCapacities(planId?: string | null): PlanCapacities {
    const norm = String(planId || 'FREE').trim().toUpperCase() as PlanId;
    return this.PLAN_CAPACITIES[norm] || this.PLAN_CAPACITIES.FREE;
  }

  /**
   * Pengecekan Entitlement Fitur berdasarkan Plan Aktif User
   */
  static async checkEntitlement(
    userId: string,
    feature: keyof PlanEntitlements,
    db: BillingDbAdapter
  ): Promise<boolean> {
    const planId = await db.getUserPlan(userId);

    const entitlements: Record<PlanId, PlanEntitlements> = {
      FREE: { paperTrading: true, viewLaunchpad: true, createLaunch: false, liveTrading: false, binanceWsStreams: false, daytonaSandbox: false, aiProposals: false },
      CREATOR: { paperTrading: true, viewLaunchpad: true, createLaunch: true, liveTrading: false, binanceWsStreams: false, daytonaSandbox: false, aiProposals: false },
      TRADER: { paperTrading: true, viewLaunchpad: true, createLaunch: false, liveTrading: true, binanceWsStreams: true, daytonaSandbox: false, aiProposals: false },
      AGENT: { paperTrading: true, viewLaunchpad: true, createLaunch: true, liveTrading: true, binanceWsStreams: true, daytonaSandbox: true, aiProposals: true },
    };

    return entitlements[planId]?.[feature] || false;
  }

  /**
   * Pengurangan Kredit Metered Usage (Daytona Sandbox = 5, Scrape = 1, Launch = 50)
   */
  static async deductMeteredCredits(
    userId: string,
    creditsToDeduct: number,
    actionType: string,
    referenceId: string,
    db: BillingDbAdapter
  ): Promise<void> {
    const currentBalance = await db.getUserCreditBalance(userId);

    if (currentBalance < creditsToDeduct) {
      throw new Error(
        `BILLING_INSUFFICIENT_CREDITS: Required ${creditsToDeduct} credits for ${actionType}, but current balance is ${currentBalance}`
      );
    }

    // Catat Double-Entry Ledger Debit (Negatif)
    await db.recordLedgerEntry({
      userId,
      amount: -creditsToDeduct,
      currency: 'CREDITS',
      type: actionType,
      referenceId,
      description: `Metered usage deduction for ${actionType}`,
    });

    console.log(`[Billing Ledger] Deducted ${creditsToDeduct} credits from user ${userId} for ${actionType}`);
  }

  /**
   * Penambahan Kredit Bulanan (Stripe Webhook Sync / Monthly Cycle Grant)
   */
  static async grantMonthlyPlanCredits(
    userId: string,
    planId: PlanId,
    stripeSubscriptionId: string | undefined,
    db: BillingDbAdapter
  ): Promise<void> {
    const creditAmount = this.PLAN_MONTHLY_CREDITS[planId];

    await db.updateUserSubscription(userId, planId, stripeSubscriptionId);

    // Catat Double-Entry Ledger Credit (Positif)
    await db.recordLedgerEntry({
      userId,
      amount: creditAmount,
      currency: 'CREDITS',
      type: 'SUBSCRIPTION_GRANT',
      referenceId: stripeSubscriptionId,
      description: `Monthly credit grant for ${planId} plan`,
    });

    await db.createAuditLog(
      userId,
      'BILLING_SUBSCRIPTION_UPDATED',
      planId,
      `Subscription updated to ${planId}. Granted ${creditAmount} credits.`
    );
  }
}
