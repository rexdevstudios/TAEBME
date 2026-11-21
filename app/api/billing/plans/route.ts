import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { requireCapability } from '@packages/auth/session';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import { SubscriptionsEngine, type PlanId } from '@packages/billing/subscriptions-engine';

const CANONICAL_PLANS = [
  {
    id: 'FREE',
    name: 'Free Degen',
    priceUsd: 0,
    monthlyPriceUsd: 0,
    priceEth: '0',
    monthlyCredits: 100,
    hasLiveTrading: false,
    hasCreatorAccess: false,
    hasAgentAccess: false,
    hasPriorityScrape: false,
    features: ['Paper Trading & 5-Agent Paper Sim', 'Basic Launchpad & KOL Bounty View'],
  },
  {
    id: 'CREATOR',
    name: 'Token Creator',
    priceUsd: 49,
    monthlyPriceUsd: 49,
    priceEth: '0.015',
    monthlyCredits: 5000,
    hasLiveTrading: false,
    hasCreatorAccess: true,
    hasAgentAccess: false,
    hasPriorityScrape: true,
    features: [
      'Token Launchpad Wizard (5 Modes)',
      'AI Creator Asset Studio & Growth Pack',
      'KOL Bounty Campaign Creation',
      '0.50% Creator Bonding Curve Fee Share',
    ],
  },
  {
    id: 'TRADER',
    name: 'Pro Terminal Trader',
    priceUsd: 79,
    monthlyPriceUsd: 79,
    priceEth: '0.025',
    monthlyCredits: 5000,
    hasLiveTrading: true,
    hasCreatorAccess: false,
    hasAgentAccess: false,
    hasPriorityScrape: true,
    features: [
      'Live Trading Terminal (DEX & CEX Single-Shot)',
      'MEV Slippage Guard (<= 3.0% Cap)',
      'Deterministic Risk Gate & Kill-Switch Protection',
      'BYOK LLM Vault (3 Keys: Gemini / OpenAI / Claude · Hemat 60% Credits)',
    ],
  },
  {
    id: 'AGENT',
    name: 'AI Autonomous Desk',
    priceUsd: 149,
    monthlyPriceUsd: 149,
    priceEth: '0.045',
    monthlyCredits: 15000,
    hasLiveTrading: true,
    hasCreatorAccess: true,
    hasAgentAccess: true,
    hasPriorityScrape: true,
    features: [
      'Full Creator + Pro Trader Entitlements',
      '5-Agent Autonomous Trading Desk (BytePlus / Gemini)',
      'BYOK LLM Vault (5 Keys: Gemini / OpenAI / Claude · Hemat 60% Credits)',
      'Arkham Wallet Profiling & Firecrawl Priority',
      'Daytona Strategy Sandbox & Backtester',
    ],
  },
];

export const dynamic = 'force-dynamic';

const VALID_PLAN_IDS = new Set<PlanId>(['FREE', 'CREATOR', 'TRADER', 'AGENT']);

export async function GET() {
  const [discounts, platformConfig] = await Promise.all([
    defaultBillingDbAdapter.getPlanDiscounts().catch(
      (): Record<PlanId, { discountPct: number; promoLabel?: string }> => ({
        FREE: { discountPct: 0 },
        CREATOR: { discountPct: 0 },
        TRADER: { discountPct: 0 },
        AGENT: { discountPct: 0 },
      })
    ),
    defaultBillingDbAdapter.getPlatformFeeAndRiskConfig().catch(() => ({
      studioCostCr: 1,
      deskCostCr: 5,
      launchCostCr: 50,
      maxOrderValueUsd: 10000,
      maxDailyLossUsd: 1000,
      maxSlippagePct: 3.0,
      treasuryWallet: '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6',
    })),
  ]);

  const enrichedPlans = CANONICAL_PLANS.map((plan) => {
    const pid = plan.id as PlanId;
    const disc: { discountPct: number; promoLabel?: string } = discounts[pid] || { discountPct: 0 };
    const discountPct = Math.max(0, Math.min(100, Number(disc.discountPct ?? 0)));
    const originalPriceUsd = plan.priceUsd;
    const originalPriceEth = plan.priceEth;
    const finalPriceUsd = Math.max(0, Math.round(originalPriceUsd * (1 - discountPct / 100) * 100) / 100);
    const numEth = parseFloat(originalPriceEth || '0');
    const finalPriceEth =
      numEth <= 0 || discountPct >= 100
        ? '0'
        : (numEth * (1 - discountPct / 100)).toFixed(4).replace(/\.?0+$/, '');

    return {
      ...plan,
      capacities: SubscriptionsEngine.getPlanCapacities(pid),
      originalPriceUsd,
      originalPriceEth,
      discountPct,
      promoLabel: disc.promoLabel,
      priceUsd: finalPriceUsd,
      monthlyPriceUsd: finalPriceUsd,
      priceEth: finalPriceEth,
    };
  });

  const response: ApiResponse<typeof enrichedPlans> = {
    success: true,
    data: enrichedPlans,
    timestamp: new Date().toISOString(),
  };
  return NextResponse.json(
    {
      ...response,
      platformConfig,
    },
    { status: 200 }
  );
}

export async function POST(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireCapability(req, 'MANAGE_BILLING_PLANS');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));

    if (body?.action === 'update-platform-config') {
      const updatedCfg = await defaultBillingDbAdapter.setPlatformFeeAndRiskConfig({
        studioCostCr: body.studioCostCr !== undefined ? Number(body.studioCostCr) : undefined,
        deskCostCr: body.deskCostCr !== undefined ? Number(body.deskCostCr) : undefined,
        launchCostCr: body.launchCostCr !== undefined ? Number(body.launchCostCr) : undefined,
        maxOrderValueUsd: body.maxOrderValueUsd !== undefined ? Number(body.maxOrderValueUsd) : undefined,
        maxDailyLossUsd: body.maxDailyLossUsd !== undefined ? Number(body.maxDailyLossUsd) : undefined,
        maxSlippagePct: body.maxSlippagePct !== undefined ? Number(body.maxSlippagePct) : undefined,
        treasuryWallet: typeof body.treasuryWallet === 'string' ? body.treasuryWallet.trim() : undefined,
        launchpadContractAddress:
          typeof body.launchpadContractAddress === 'string' ? body.launchpadContractAddress.trim() : undefined,
        aiFeatureWeights:
          body.aiFeatureWeights && typeof body.aiFeatureWeights === 'object' ? body.aiFeatureWeights : undefined,
        actorId: auth.walletAddress || auth.user.userId,
      });

      return NextResponse.json({
        success: true,
        data: updatedCfg,
        timestamp: new Date().toISOString(),
      });
    }

    const rawPlan = typeof body?.planId === 'string' ? body.planId.trim().toUpperCase() : '';
    if (!VALID_PLAN_IDS.has(rawPlan as PlanId)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_PLAN: Supported plans are FREE, CREATOR, TRADER, AGENT', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const rawDiscount = Number(body?.discountPct ?? 0);
    if (!Number.isFinite(rawDiscount) || rawDiscount < 0 || rawDiscount > 100) {
      return NextResponse.json(
        { success: false, error: 'INVALID_DISCOUNT_PCT: discountPct must be a number between 0 and 100', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const promoLabel = typeof body?.promoLabel === 'string' ? body.promoLabel.trim().slice(0, 64) : undefined;

    const updated = await defaultBillingDbAdapter.setPlanDiscount({
      planId: rawPlan as PlanId,
      discountPct: rawDiscount,
      promoLabel,
      actorId: auth.walletAddress || auth.user.userId,
    });

    return NextResponse.json({
      success: true,
      data: updated,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg || 'PLAN_DISCOUNT_UPDATE_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
