/**
 * app/api/agent/autopilot/simulate/route.ts
 *
 * Tier-Gated Autonomous AI Trading Cycle Dry-Run Simulator Endpoint (Phase BL).
 * - Protected by Edge Middleware SIWE + `CONNECT_WALLET` capability + rate limiter.
 * - Exclusive to `TRADER` (Pro Terminal Trader) and `AGENT` (AI Autonomous Desk) plans.
 * - Fail-closed HTTP 403 (`PLAN_AUTOPILOT_REQUIRED`) for `FREE` and `CREATOR` accounts.
 * - Zero live fund mutation; reads active Kill-Switch from PostgreSQL SSOT & Scout hints from Redis.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { defaultBillingDbAdapter, defaultKillSwitchDbAdapter } from '@packages/shared/db-pool';
import { upstashRedis } from '@packages/shared/redis-client';
import { SubscriptionsEngine } from '@packages/billing/subscriptions-engine';
import {
  getDefaultAutoPilotConfig,
  type AutoPilotConfig,
} from '@packages/agent/autopilot-policy';
import {
  runAutonomousCycleEvaluation,
  type AutoPilotMarketSignal,
  type AutoPilotOpenPosition,
} from '@packages/agent/autopilot-cycle-runner';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:agent:autopilot:sim:${ip}`, 15, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Auto-Pilot simulation rate limit exceeded', timestamp: new Date().toISOString() },
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

    const planId = await defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const);
    const cap = SubscriptionsEngine.getPlanCapacities(planId);
    if (!cap.autoPilotEnabled) {
      return NextResponse.json(
        {
          success: false,
          error:
            'PLAN_AUTOPILOT_REQUIRED: Autonomous AI Auto-Pilot simulation is exclusive to Pro Terminal Trader (TRADER) and AI Autonomous Desk (AGENT) plans.',
          upgradeUrl: '/billing',
          timestamp: new Date().toISOString(),
        },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const cfgKey = `agent:autopilot:cfg:${auth.walletAddress.trim().toLowerCase()}`;

    const [storedCfgRaw, activeKillSwitches, scoutRaw] = await Promise.all([
      upstashRedis.isConfigured() ? upstashRedis.get<string>(cfgKey).catch(() => null) : Promise.resolve(null),
      defaultKillSwitchDbAdapter.getActiveKillSwitches().catch(() => []),
      upstashRedis.isConfigured() ? upstashRedis.get<string>('agent:scout:dataset').catch(() => null) : Promise.resolve(null),
    ]);

    let config: AutoPilotConfig = getDefaultAutoPilotConfig(planId);
    if (storedCfgRaw) {
      try {
        config = typeof storedCfgRaw === 'string' ? JSON.parse(storedCfgRaw) : storedCfgRaw;
      } catch {
        // use default
      }
    }

    const killSwitchActive = Array.isArray(activeKillSwitches) && activeKillSwitches.length > 0;

    let marketSignals: AutoPilotMarketSignal[] = Array.isArray(body?.marketSignals) ? body.marketSignals : [];
    if (marketSignals.length === 0) {
      const primarySym = config.allowedSymbols[0] || 'BTCUSDT';
      marketSignals = [
        {
          symbol: primarySym,
          confidenceScore: Math.max(config.minConfidenceScore + 5, 82),
          suggestedOrderUsd: Math.min(config.maxOrderUsd || 100, cap.maxAutoPilotOrderUsd),
          source: '5_AGENT_DESK_SIGNAL',
        },
      ];
      if (scoutRaw) {
        try {
          const parsedScout = typeof scoutRaw === 'string' ? JSON.parse(scoutRaw) : scoutRaw;
          const firstHint = Array.isArray(parsedScout?.hints) ? parsedScout.hints[0] : null;
          if (firstHint?.symbol) {
            marketSignals.push({
              symbol: String(firstHint.symbol).toUpperCase(),
              confidenceScore: 78,
              suggestedOrderUsd: Math.min(config.maxOrderUsd || 100, cap.maxAutoPilotOrderUsd),
              source: 'SCOUT_DEXSCREENER',
            });
          }
        } catch {
          // ignore
        }
      }
    }

    const openPositions: AutoPilotOpenPosition[] = Array.isArray(body?.openPositions)
      ? body.openPositions
      : [
          {
            symbol: config.allowedSymbols[0] || 'BTCUSDT',
            entryPrice: 100,
            currentPrice: 100 * (1 + config.takeProfitPct / 100),
            quantity: 1,
          },
        ];

    const report = runAutonomousCycleEvaluation({
      planId,
      config,
      killSwitchActive,
      marketSignals,
      openPositions,
    });

    return NextResponse.json(
      {
        success: true,
        data: report,
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'AUTOPILOT_SIMULATE_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
