/**
 * app/api/agent/profiles/route.ts
 *
 * Custom AI Agent Builder & Modular Skill Registry CRUD Endpoint.
 * - Requires authenticated SIWE session (`CONNECT_WALLET`).
 * - Strictly isolates all read/create/update/delete operations to `owner_id = authenticated user`.
 * - Enforces billing tier `maxCustomAgents` SSOT (`SubscriptionsEngine.getPlanCapacities`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { defaultBillingDbAdapter, defaultCustomAgentAdapter } from '@packages/shared/db-pool';
import { SubscriptionsEngine } from '@packages/billing/subscriptions-engine';
import { AGENT_SKILL_CATALOG } from '@packages/agent/skill-registry';

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

    const [agents, planId] = await Promise.all([
      defaultCustomAgentAdapter.listUserAgents(auth.walletAddress),
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
    ]);
    const cap = SubscriptionsEngine.getPlanCapacities(planId);

    return NextResponse.json(
      {
        success: true,
        data: {
          planId: cap.planId,
          maxCustomAgents: cap.maxCustomAgents,
          skillCatalog: Object.values(AGENT_SKILL_CATALOG),
          agents,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'AGENT_PROFILES_READ_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:agent-profiles:write:${ip}`, 15, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Custom agent creation rate limit exceeded', timestamp: new Date().toISOString() },
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
    const cap = SubscriptionsEngine.getPlanCapacities(planId);

    const targetSymbols = Array.isArray(body?.targetSymbols)
      ? body.targetSymbols
      : typeof body?.targetSymbols === 'string'
      ? body.targetSymbols.split(',').map((s: string) => s.trim()).filter(Boolean)
      : ['BTCUSDT', 'ETHUSDT'];

    const created = await defaultCustomAgentAdapter.createUserAgent({
      userIdentifier: auth.walletAddress,
      name: typeof body?.name === 'string' ? body.name : '',
      strategyDescription: typeof body?.strategyDescription === 'string' ? body.strategyDescription : undefined,
      systemPrompt: typeof body?.systemPrompt === 'string' ? body.systemPrompt : '',
      riskToleranceLevel: typeof body?.riskToleranceLevel === 'string' ? body.riskToleranceLevel : 'MODERATE',
      strategyProfile: typeof body?.strategyProfile === 'string' ? body.strategyProfile : 'MOMENTUM_BREAKOUT',
      enabledSkills: body?.enabledSkills,
      targetSymbols,
      maxAllowed: cap.maxCustomAgents,
    });

    return NextResponse.json(
      { success: true, data: created, timestamp: new Date().toISOString() },
      { status: 201 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'AGENT_PROFILE_CREATE_ERROR';
    const isBadInput = msg.startsWith('INVALID_') || msg.startsWith('MAX_AGENTS_REACHED');
    return NextResponse.json(
      { success: false, error: msg, timestamp: new Date().toISOString() },
      { status: isBadInput ? 400 : 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireCapability(req, 'CONNECT_WALLET');
    } catch (authErr: unknown) {
      return NextResponse.json(
        { success: false, error: `UNAUTHORIZED: ${authErr instanceof Error ? authErr.message : String(authErr)}`, timestamp: new Date().toISOString() },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : '';
    const status = body?.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE';
    if (!agentId) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: agentId is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const updated = await defaultCustomAgentAdapter.updateUserAgentStatus(auth.walletAddress, agentId, status);
    if (!updated) {
      return NextResponse.json(
        { success: false, error: 'NOT_FOUND_OR_FORBIDDEN: Custom agent not found in your account', timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: true, data: { agentId, status }, timestamp: new Date().toISOString() },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'AGENT_PROFILE_UPDATE_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireCapability(req, 'CONNECT_WALLET');
    } catch (authErr: unknown) {
      return NextResponse.json(
        { success: false, error: `UNAUTHORIZED: ${authErr instanceof Error ? authErr.message : String(authErr)}`, timestamp: new Date().toISOString() },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const agentId = (searchParams.get('agentId') || '').trim();
    if (!agentId) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: agentId is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const deleted = await defaultCustomAgentAdapter.deleteUserAgent(auth.walletAddress, agentId);
    if (!deleted) {
      return NextResponse.json(
        { success: false, error: 'NOT_FOUND_OR_FORBIDDEN: Custom agent not found in your account', timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: true, data: { agentId, deleted: true }, timestamp: new Date().toISOString() },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'AGENT_PROFILE_DELETE_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
