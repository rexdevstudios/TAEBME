/**
 * app/api/agent/desk/run/route.ts
 *
 * Vercel-Native 5-Agent Trading Desk Endpoint (Scanner -> Analyst -> Brain -> Risk -> Executor).
 * - Protected by Edge Middleware SIWE + RBAC TRADE_MANUALLY + rateLimiter.
 * - Zero private keys, zero DB schema mutations, zero cursor collisions.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { runFiveAgentDeskCycle } from '@packages/agent/trading-desk-orchestrator';
import {
  defaultProposalDbAdapter,
  defaultDraftDbAdapter,
  defaultKillSwitchDbAdapter,
  defaultBillingDbAdapter,
  saveTradeIntent,
} from '@packages/shared/db-pool';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:agent:desk:${ip}`, 15, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: 5-Agent Desk rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let auth;
    try {
      auth = await requireCapability(req, 'TRADE_MANUALLY');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const symbol = typeof body?.symbol === 'string' && body.symbol.trim() ? body.symbol.trim().toUpperCase() : 'BTCUSDT';
    const action = body?.action === 'SELL' ? 'SELL' : 'BUY';
    const quantity = Number(body?.quantity ?? 100);
    const maxSlippagePct = Number(body?.maxSlippagePct ?? 1.0);
    const mode = body?.mode === 'LIVE_ADVISORY' ? 'LIVE_ADVISORY' : 'PAPER';
    const tokenAddress = typeof body?.tokenAddress === 'string' ? body.tokenAddress.trim() : undefined;
    const chainId = body?.chainId !== undefined ? Number(body.chainId) : undefined;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: quantity must be a positive number', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const report = await runFiveAgentDeskCycle(
      {
        userId: auth.user.userId,
        symbol,
        action,
        quantity,
        maxSlippagePct,
        mode,
        tokenAddress,
        chainId,
      },
      {
        proposalDb: defaultProposalDbAdapter,
        getActiveLaunchesCount: async () => (await defaultDraftDbAdapter.getActiveTokenLaunches().catch(() => [])).length,
        getActiveKillSwitches: () => defaultKillSwitchDbAdapter.getActiveKillSwitches(),
        getUserEntitlement: (uid) => defaultBillingDbAdapter.getUserEntitlement(uid),
        saveTradeIntent,
      }
    );

    return NextResponse.json({
      success: true,
      data: report,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg || 'FIVE_AGENT_DESK_FAILED', timestamp: new Date().toISOString() },
      { status: msg.startsWith('DATABASE_UNAVAILABLE') ? 503 : 500 }
    );
  }
}
