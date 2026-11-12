import { NextRequest, NextResponse } from 'next/server';
import { AgentProposalEngine } from '@packages/agent/proposal-engine';
import { FeatureEngine } from '@packages/intelligence/feature-engine';
import { intelligenceCache } from '@packages/intelligence/market-data-cache';
import { fetchDefiLlamaMacroSignal } from '@packages/intelligence/defillama-client';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { requireCapability } from '@packages/auth/session';
import { defaultProposalDbAdapter } from '@packages/shared/db-pool';

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

    // 2. Fetch DefiLlama macro signal in parallel (non-blocking enrichment)
    const macroResult = await Promise.allSettled([fetchDefiLlamaMacroSignal()]);
    const macroSignal = macroResult[0].status === 'fulfilled' ? macroResult[0].value : null;

    // 3. Compute Intelligence Signal (with macro enrichment)
    const signal = FeatureEngine.computeSignal(symbol, intelligenceCache, null, null, macroSignal);

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

    const response: ApiResponse<typeof proposal> = {
      success: true,
      data: proposal,
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


