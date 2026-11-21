/**
 * app/api/user/risk-policy/route.ts
 *
 * Non-Custodial Per-User Risk Limit Configuration Endpoint.
 * - Requires authenticated SIWE session (`CONNECT_WALLET`).
 * - Clamps all user-configured limits against both the user's active billing tier ceiling
 *   (`SubscriptionsEngine.getPlanCapacities`) and the global platform admin risk cap.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import { SubscriptionsEngine, computeEffectiveUserRiskLimits } from '@packages/billing/subscriptions-engine';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireCapability(req, 'CONNECT_WALLET');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const [planId, userPolicy, globalCfg, exposure24h] = await Promise.all([
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
      defaultBillingDbAdapter.getUserRiskPolicy(auth.walletAddress).catch(() => null),
      defaultBillingDbAdapter.getPlatformFeeAndRiskConfig().catch(() => null),
      defaultBillingDbAdapter.getUser24hRiskExposure(auth.user.userId).catch(() => ({
        currentDailyLossUsd: 0,
        currentOpenPositions: 0,
      })),
    ]);

    const tierCeiling = SubscriptionsEngine.getPlanCapacities(planId);
    const effectiveLimits = computeEffectiveUserRiskLimits({
      planId,
      userPolicy,
      platformGlobalCap: globalCfg,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          planId: tierCeiling.planId,
          tierCeiling: {
            maxOrderValueUsd: tierCeiling.maxOrderValueUsd,
            maxDailyLossUsd: tierCeiling.maxDailyLossUsd,
            maxSlippagePct: globalCfg?.maxSlippagePct ?? 3.0,
          },
          userPolicy,
          effectiveLimits,
          exposure24h: {
            ...exposure24h,
            maxOpenPositions: 5,
          },
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'RISK_POLICY_READ_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:risk-policy:write:${ip}`, 20, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Risk policy update rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let auth;
    try {
      auth = await requireCapability(req, 'CONNECT_WALLET');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const rawOrder = Number(body?.maxOrderValueUsd);
    const rawLoss = Number(body?.maxDailyLossUsd);
    const rawSlippage = Number(body?.maxSlippagePct);
    const rawSymbols: string[] = Array.isArray(body?.allowedSymbols)
      ? body.allowedSymbols
      : typeof body?.allowedSymbols === 'string'
      ? body.allowedSymbols.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];

    if (!Number.isFinite(rawOrder) || rawOrder <= 0 || !Number.isFinite(rawLoss) || rawLoss <= 0 || !Number.isFinite(rawSlippage) || rawSlippage <= 0) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: maxOrderValueUsd, maxDailyLossUsd, and maxSlippagePct must be positive numbers', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const [planId, globalCfg] = await Promise.all([
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
      defaultBillingDbAdapter.getPlatformFeeAndRiskConfig().catch(() => null),
    ]);

    const clamped = computeEffectiveUserRiskLimits({
      planId,
      userPolicy: {
        maxOrderValueUsd: rawOrder,
        maxDailyLossUsd: rawLoss,
        maxSlippagePct: rawSlippage,
        allowedSymbols: rawSymbols,
      },
      platformGlobalCap: globalCfg,
    });

    const saved = await defaultBillingDbAdapter.upsertUserRiskPolicy(auth.walletAddress, {
      maxOrderValueUsd: clamped.maxOrderValueUsd,
      maxDailyLossUsd: clamped.maxDailyLossUsd,
      maxSlippagePct: clamped.maxSlippagePct,
      allowedSymbols: clamped.allowedSymbols,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          planId: clamped.planId,
          userPolicy: saved,
          effectiveLimits: clamped,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'RISK_POLICY_WRITE_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
