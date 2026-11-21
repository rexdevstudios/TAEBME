import { NextRequest, NextResponse } from 'next/server';
import { AgentProposalEngine } from '@packages/agent/proposal-engine';
import { FeatureEngine } from '@packages/intelligence/feature-engine';
import { intelligenceCache } from '@packages/intelligence/market-data-cache';
import { fetchDefiLlamaMacroSignal } from '@packages/intelligence/defillama-client';
import { generateMarketAdvisoryNote } from '@packages/intelligence/llm-advisory-client';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { requireCapability } from '@packages/auth/session';
import { defaultProposalDbAdapter, defaultBillingDbAdapter, getDbPool } from '@packages/shared/db-pool';
import { SubscriptionsEngine } from '@packages/billing/subscriptions-engine';

export async function POST(req: NextRequest) {
  try {
    // 1. Authoritative Cryptographic Session & RBAC Enforcement (Fail-Closed)
    const auth = await requireCapability(req, 'TRADE_MANUALLY');

    const body = await req.json().catch(() => ({}));
    const symbol = body.targetSymbol || 'DEGEN/USDT';
    const action = body.action === 'SELL' ? 'SELL' : 'BUY';
    const suggestedQty = Number(body.suggestedQty) > 0 ? Number(body.suggestedQty) : 100;
    const userId = auth.user.userId;
    const agentId = body.agentId && typeof body.agentId === 'string' ? body.agentId : 'agent-alpha';

    // 2. Fetch DefiLlama macro signal & SSOT platform config in parallel (non-blocking enrichment)
    const [macroResult, platformCfgResult] = await Promise.allSettled([
      fetchDefiLlamaMacroSignal(),
      defaultBillingDbAdapter.getPlatformFeeAndRiskConfig(),
    ]);
    const macroSignal = macroResult.status === 'fulfilled' ? macroResult.value : null;
    const platformCfg = platformCfgResult.status === 'fulfilled' ? platformCfgResult.value : null;
    const proposalCostCr = platformCfg?.studioCostCr ?? 1;

    // 3. Compute Intelligence Signal (with macro enrichment & SSOT feature weights)
    const signal = FeatureEngine.computeSignal(
      symbol,
      intelligenceCache,
      null,
      null,
      macroSignal,
      platformCfg?.aiFeatureWeights
    );

    // 4. Generate proposal with PostgreSQL SSOT persistence
    const proposal = await AgentProposalEngine.generateProposalWithIntelligence(
      {
        agentId,
        userId,
        targetSymbol: symbol,
        action,
        suggestedQty,
        intelligenceSignal: signal,
      },
      defaultProposalDbAdapter
    );

    // 5. Non-blocking LLM Advisory enrichment (BytePlus ModelArk / Gemini / deterministic fallback)
    const llmAdvisory = await generateMarketAdvisoryNote(signal, {
      symbol,
      action,
      suggestedQty,
    }).catch(() => null);

    let remainingCredits: number | undefined;
    try {
      if (getDbPool() && auth.walletAddress && proposalCostCr > 0) {
        await SubscriptionsEngine.deductMeteredCredits(
          auth.walletAddress,
          proposalCostCr,
          'AI_PROPOSAL_SIGNAL',
          proposal.id || `prop-${Date.now()}`,
          defaultBillingDbAdapter
        );
        remainingCredits = await defaultBillingDbAdapter.getUserCreditBalance(auth.walletAddress);
      }
    } catch {
      // Non-blocking fallback
    }

    const enrichedProposal = { ...proposal, llmAdvisory, creditsBurned: proposalCostCr, remainingCredits };

    const response: ApiResponse<typeof enrichedProposal> = {
      success: true,
      data: enrichedProposal,
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 200 });
  } catch (err: any) {
    const message = err?.message || 'Unknown error';

    if (message.startsWith('UNAUTHORIZED')) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message }, timestamp: new Date().toISOString() },
        { status: 401 }
      );
    }
    if (message.startsWith('RBAC_FORBIDDEN') || message.startsWith('AUTH_ACCOUNT_')) {
      return NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message }, timestamp: new Date().toISOString() },
        { status: 403 }
      );
    }
    if (message.startsWith('DATABASE_UNAVAILABLE')) {
      return NextResponse.json(
        { success: false, error: { code: 'SERVICE_UNAVAILABLE', message }, timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }

    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'PROPOSAL_GENERATION_FAILED', message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 400 });
  }
}


