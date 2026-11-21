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
  defaultCustomAgentAdapter,
  defaultProviderKeyVaultAdapter,
  saveTradeIntent,
  getDbPool,
} from '@packages/shared/db-pool';
import { SubscriptionsEngine } from '@packages/billing/subscriptions-engine';
import { buildAgentActionCards } from '@packages/agent/skill-registry';
import { generateMarketAdvisoryNote } from '@packages/intelligence/llm-advisory-client';

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
    const dexNetwork = typeof body?.dexNetwork === 'string' ? body.dexNetwork.trim().toLowerCase() : undefined;
    const allowedStrategies = new Set(['EARLY_SNIPER', 'MOMENTUM_BREAKOUT', 'DIP_ACCUMULATOR', 'CONSERVATIVE_DCA']);
    const agentId = typeof body?.agentId === 'string' && body.agentId.trim() ? body.agentId.trim() : undefined;
    const customAgent = agentId
      ? await defaultCustomAgentAdapter.getUserAgentById(auth.walletAddress, agentId).catch(() => null)
      : null;

    const strategyProfile =
      typeof body?.strategyProfile === 'string' && allowedStrategies.has(body.strategyProfile.trim().toUpperCase())
        ? (body.strategyProfile.trim().toUpperCase() as 'EARLY_SNIPER' | 'MOMENTUM_BREAKOUT' | 'DIP_ACCUMULATOR' | 'CONSERVATIVE_DCA')
        : customAgent?.strategyProfile;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: quantity must be a positive number', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const platformCfg = await defaultBillingDbAdapter.getPlatformFeeAndRiskConfig().catch(() => null);
    const requestedLlm = typeof body?.llmProvider === 'string' ? body.llmProvider.trim().toUpperCase() : 'PLATFORM';
    let byokLlm: { provider: 'GEMINI' | 'OPENAI'; apiKey: string } | undefined;
    if (requestedLlm === 'GEMINI' || requestedLlm === 'OPENAI') {
      const resolved = await defaultProviderKeyVaultAdapter
        .resolveDecryptedKeyForDeploy({
          userIdentifier: auth.walletAddress,
          targetChain: 'all',
          provider: requestedLlm,
        })
        .catch(() => null);
      if (resolved?.apiKey) {
        byokLlm = { provider: requestedLlm, apiKey: resolved.apiKey };
      }
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
        dexNetwork,
        strategyProfile,
        aiFeatureWeights: platformCfg?.aiFeatureWeights,
      },
      {
        proposalDb: defaultProposalDbAdapter,
        getActiveLaunchesCount: async () => (await defaultDraftDbAdapter.getActiveTokenLaunches().catch(() => [])).length,
        getActiveKillSwitches: () => defaultKillSwitchDbAdapter.getActiveKillSwitches(),
        getUserEntitlement: (uid) => defaultBillingDbAdapter.getUserEntitlement(uid),
        saveTradeIntent,
        generateAdvisory: (sig, ctx) =>
          generateMarketAdvisoryNote(sig, {
            ...ctx,
            customSystemPrompt: customAgent?.systemPrompt,
            byokLlm,
          }),
      }
    );

    let remainingCredits: number | undefined;
    const baseDeskCost = platformCfg?.deskCostCr ?? 5;
    let deskCost = byokLlm ? Math.min(2, baseDeskCost) : baseDeskCost;
    try {
      if (getDbPool()) {
        await SubscriptionsEngine.deductMeteredCredits(
          auth.walletAddress,
          deskCost,
          'FIVE_AGENT_DESK_RUN',
          report.proposal?.id || `desk-${Date.now()}`,
          defaultBillingDbAdapter
        );
        remainingCredits = await defaultBillingDbAdapter.getUserCreditBalance(auth.walletAddress);
      }
    } catch {
      // Non-blocking in unit test environments without DB
    }

    const agentActionCards = buildAgentActionCards({
      skills: customAgent?.enabledSkills || ['SKILL_CEX_TRADE', 'SKILL_DEX_SWAP', 'SKILL_TOKEN_DEPLOY'],
      symbol,
      action,
      quantity,
      agentName: customAgent?.name,
    });

    return NextResponse.json({
      success: true,
      data: {
        ...report,
        activeAgent: customAgent
          ? {
              id: customAgent.id,
              name: customAgent.name,
              strategyProfile: customAgent.strategyProfile,
              riskToleranceLevel: customAgent.riskToleranceLevel,
              enabledSkills: customAgent.enabledSkills,
            }
          : null,
        agentActionCards,
        creditsBurned: deskCost,
        remainingCredits,
      },
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
