/**
 * app/api/agent/autopilot/route.ts
 *
 * Tier-Gated Autonomous AI Trading Auto-Pilot Configuration Endpoint (Phase BK).
 * - Protected by Edge Middleware SIWE + `CONNECT_WALLET` capability.
 * - Exclusive to `TRADER` (Pro Terminal Trader) and `AGENT` (AI Autonomous Desk) plans.
 * - Fail-closed HTTP 403 (`PLAN_AUTOPILOT_REQUIRED`) for `FREE` and `CREATOR` accounts on PUT.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import { upstashRedis } from '@packages/shared/redis-client';
import { SubscriptionsEngine } from '@packages/billing/subscriptions-engine';
import {
  getDefaultAutoPilotConfig,
  validateAndClampAutoPilotConfig,
  type AutoPilotConfig,
} from '@packages/agent/autopilot-policy';
import { syncActiveAutoPilotRegistry } from '@packages/agent/autopilot-market-feed';

export const dynamic = 'force-dynamic';

const inMemoryAutoPilotStore = new Map<string, AutoPilotConfig>();

function redisKeyForWallet(wallet: string): string {
  return `agent:autopilot:cfg:${wallet.trim().toLowerCase()}`;
}

async function readUserAutoPilotConfig(wallet: string): Promise<AutoPilotConfig | null> {
  const key = redisKeyForWallet(wallet);
  if (upstashRedis.isConfigured()) {
    const raw = await upstashRedis.get(key).catch(() => null);
    if (raw) {
      try {
        return JSON.parse(raw) as AutoPilotConfig;
      } catch {
        // fallback below
      }
    }
  }
  return inMemoryAutoPilotStore.get(key) || null;
}

async function writeUserAutoPilotConfig(wallet: string, config: AutoPilotConfig): Promise<void> {
  const key = redisKeyForWallet(wallet);
  inMemoryAutoPilotStore.set(key, config);
  if (upstashRedis.isConfigured()) {
    await upstashRedis.set(key, JSON.stringify(config), 30 * 86400).catch(() => false);
  }
}

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

    const [planId, lastTickRaw] = await Promise.all([
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
      upstashRedis.isConfigured()
        ? upstashRedis.get<string>('agent:autopilot:last_tick').catch(() => null)
        : Promise.resolve(null),
    ]);
    const capacities = SubscriptionsEngine.getPlanCapacities(planId);
    const stored = capacities.autoPilotEnabled ? await readUserAutoPilotConfig(auth.walletAddress) : null;
    const config = stored || getDefaultAutoPilotConfig(planId);

    let lastPulse: {
      updatedAt: string;
      scannedWallets: number;
      executedWallets: number;
      totalQueued: number;
      scoutSignalsLoaded: number;
    } | null = null;
    if (lastTickRaw) {
      try {
        const parsed = typeof lastTickRaw === 'string' ? JSON.parse(lastTickRaw) : lastTickRaw;
        if (parsed?.updatedAt) {
          lastPulse = {
            updatedAt: String(parsed.updatedAt),
            scannedWallets: Number(parsed.scannedWallets || 0),
            executedWallets: Number(parsed.executedWallets || 0),
            totalQueued: Number(parsed.totalQueued || 0),
            scoutSignalsLoaded: Number(parsed.scoutSignalsLoaded || 0),
          };
        }
      } catch {
        // ignore malformed cache
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          planId: capacities.planId,
          eligible: capacities.autoPilotEnabled,
          capacities: {
            autoPilotEnabled: capacities.autoPilotEnabled,
            maxAutoPilotStrategies: capacities.maxAutoPilotStrategies,
            autoPilotRails: capacities.autoPilotRails,
            maxAutoPilotOrderUsd: capacities.maxAutoPilotOrderUsd,
          },
          config,
          lastPulse,
          upgradeUrl: capacities.autoPilotEnabled ? null : '/billing',
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'AUTOPILOT_READ_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:agent:autopilot:${ip}`, 20, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Auto-Pilot config rate limit exceeded', timestamp: new Date().toISOString() },
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
    const planId = await defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const);

    let validated;
    try {
      validated = validateAndClampAutoPilotConfig(body, planId);
    } catch (valErr: unknown) {
      const msg = valErr instanceof Error ? valErr.message : 'INVALID_AUTOPILOT_CONFIG';
      const isTierLocked =
        msg.startsWith('PLAN_AUTOPILOT_REQUIRED') || msg.startsWith('AUTOPILOT_RAIL_UPGRADE_REQUIRED');
      return NextResponse.json(
        { success: false, error: msg, upgradeUrl: isTierLocked ? '/billing' : undefined, timestamp: new Date().toISOString() },
        { status: isTierLocked ? 403 : 400 }
      );
    }

    await writeUserAutoPilotConfig(auth.walletAddress, validated.config);
    await syncActiveAutoPilotRegistry(auth.walletAddress, validated.config.enabled).catch(() => {});
    await defaultBillingDbAdapter
      .createAuditLog(
        auth.user?.userId || auth.walletAddress,
        'AUTOPILOT_CONFIG_UPDATED',
        auth.user?.userId || auth.walletAddress,
        `Auto-Pilot ${validated.config.enabled ? 'ENABLED' : 'PAUSED'} (${validated.config.rail}, maxOrder=$${validated.config.maxOrderUsd}, TP=${validated.config.takeProfitPct}%, SL=${validated.config.stopLossPct}%)`
      )
      .catch(() => {});

    return NextResponse.json(
      {
        success: true,
        data: {
          planId: validated.planId,
          eligible: true,
          config: validated.config,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'AUTOPILOT_UPDATE_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
