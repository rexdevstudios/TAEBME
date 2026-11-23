import { NextRequest, NextResponse } from 'next/server';
import { TradingRiskGate } from '@packages/trading/risk-gate';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { ApiResponse, CreateTradeIntentRequest } from '@packages/shared/contracts/api-contracts';
import { TradeIntentInput, UserRiskLimits } from '@packages/shared/types/domain';
import { requireCapability } from '@packages/auth/session';
import {
  saveTradeIntent,
  listUserRecentTradeIntents,
  confirmUserDexTradeIntentSettlement,
  defaultKillSwitchDbAdapter,
  defaultBillingDbAdapter,
  defaultProviderKeyVaultAdapter,
} from '@packages/shared/db-pool';
import { notifyUserWebhookBestEffort } from '@packages/notifications/webhook-dispatcher';
import { getEvmExplorerTxUrl } from '@packages/launchpad/web3-provider';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireCapability(req, 'TRADE_MANUALLY');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.startsWith('RBAC_FORBIDDEN') || msg.startsWith('AUTH_ACCOUNT_');
      return NextResponse.json(
        {
          success: false,
          error: { code: isForbidden ? 'FORBIDDEN' : 'UNAUTHORIZED', message: msg },
          timestamp: new Date().toISOString(),
        },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const limitParam = Number(searchParams.get('limit') || 10);
    const intents = await listUserRecentTradeIntents(auth.user.userId, limitParam);

    return NextResponse.json(
      {
        success: true,
        data: {
          intents,
          count: intents.length,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'TRADE_INTENTS_READ_FAILED';
    return NextResponse.json(
      {
        success: false,
        error: { code: 'SERVER_ERROR', message: msg },
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';

    // Rate Limiting (Non-blocking fallback)
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:trade:${ip}`, 30, 60);
    if (!rateCheck.allowed) {
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'TOO_MANY_REQUESTS', message: 'Trade intent creation rate limit exceeded.' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 429 });
    }

    // Require TRADE_MANUALLY capability
    const auth = await requireCapability(req, 'TRADE_MANUALLY');

    const body = (await req.json()) as CreateTradeIntentRequest;
    
    const intent: TradeIntentInput = {
      userId: auth.user.userId,
      stage: body.stage || 'PAPER',
      symbol: body.symbol || 'DEGEN/USDT',
      side: body.side || 'BUY',
      type: body.type || 'MARKET',
      quantity: body.quantity || 1.0,
      price: body.price,
      maxSlippagePct: body.maxSlippagePct || 1.0,
      idempotencyKey: body.idempotencyKey || `intent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };

    const userLimits: UserRiskLimits = {
      maxOrderValueUsd: 10000,
      maxDailyLossUsd: 1000,
      currentDailyLossUsd: 0,
      maxOpenPositions: 5,
      currentOpenPositions: 0,
    };

    // Authoritatively query active kill switches from PostgreSQL SSOT (Fail-Closed)
    const activeKillSwitches = await defaultKillSwitchDbAdapter.getActiveKillSwitches();

    // Authoritatively resolve user subscription plan & live trading entitlement from PostgreSQL SSOT (Fail-Closed)
    const userEntitlement = await defaultBillingDbAdapter.getUserEntitlement(auth.user.userId);

    const { status, decision } = TradingRiskGate.evaluateIntent(
      intent,
      userLimits,
      userEntitlement,
      activeKillSwitches
    );

    // Persist Trade Intent to PostgreSQL SSOT
    let persistedIntentId = intent.idempotencyKey;
    try {
      persistedIntentId = await saveTradeIntent({
        userId: auth.user.userId,
        stage: intent.stage as any,
        symbol: intent.symbol,
        side: intent.side as any,
        type: intent.type as any,
        quantity: intent.quantity,
        price: intent.price,
        idempotencyKey: intent.idempotencyKey,
        status: decision.isApproved ? 'APPROVED' : 'REJECTED',
        riskDecisionReason: decision.reason,
      });
    } catch (dbErr: any) {
      console.warn('[POST /api/trade-intents] DB persistence warning (non-blocking):', dbErr?.message);
    }

    const data = {
      tradeIntentId: persistedIntentId,
      status,
      decision,
    };

    const response: ApiResponse<typeof data> = {
      success: decision.isApproved,
      data,
      error: decision.isApproved ? undefined : { code: 'RISK_REJECTED', message: decision.reason || 'Risk check failed' },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: decision.isApproved ? 200 : 400 });
  } catch (err: any) {
    const message = err?.message || 'Trade intent creation failed';
    if (message.includes('DATABASE_UNAVAILABLE')) {
      return NextResponse.json(
        { success: false, error: { code: 'SERVICE_UNAVAILABLE', message }, timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }
    if (message.startsWith('RBAC_FORBIDDEN') || message.startsWith('AUTH_ACCOUNT_')) {
      return NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message }, timestamp: new Date().toISOString() },
        { status: 403 }
      );
    }
    if (message.startsWith('UNAUTHORIZED')) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message }, timestamp: new Date().toISOString() },
        { status: 401 }
      );
    }
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'SERVER_ERROR', message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireCapability(req, 'TRADE_MANUALLY');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.startsWith('RBAC_FORBIDDEN') || msg.startsWith('AUTH_ACCOUNT_');
      return NextResponse.json(
        {
          success: false,
          error: { code: isForbidden ? 'FORBIDDEN' : 'UNAUTHORIZED', message: msg },
          timestamp: new Date().toISOString(),
        },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const tradeIntentId = typeof body?.tradeIntentId === 'string' ? body.tradeIntentId.trim() : '';
    const txHash = typeof body?.txHash === 'string' ? body.txHash.trim() : '';
    const chainId = Number(body?.chainId ?? 8453);

    const confirmed = await confirmUserDexTradeIntentSettlement({
      userIdentifier: auth.user.userId,
      tradeIntentId,
      txHash,
      chainId,
    });

    const explorerUrl = getEvmExplorerTxUrl(chainId, txHash.toLowerCase());
    await notifyUserWebhookBestEffort({
      resolveWebhookUrl: async () => {
        const hook = await defaultProviderKeyVaultAdapter
          .resolveDecryptedKeyForDeploy({
            userIdentifier: auth.walletAddress,
            targetChain: 'all',
            provider: 'WEBHOOK',
          })
          .catch(() => null);
        return hook?.apiKey || null;
      },
      payload: {
        event: 'DEX_SWAP_EXECUTED',
        title: `0x Swap v2 Executed (Chain ${chainId})`,
        message: `Intent ${tradeIntentId} terkonfirmasi on-chain: ${txHash.toLowerCase()}`,
        metadata: {
          tradeIntentId,
          chainId,
          txHash: txHash.toLowerCase(),
          explorerUrl,
        },
      },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          ...confirmed,
          chainId,
          txHash: txHash.toLowerCase(),
          explorerUrl,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'DEX_SETTLEMENT_CONFIRM_FAILED';
    const isNotFound = msg.includes('TRADE_INTENT_NOT_FOUND_OR_FORBIDDEN');
    const isBadReq =
      msg.includes('INVALID_') || msg.includes('UNSUPPORTED_DEX_SETTLEMENT_CHAIN');
    return NextResponse.json(
      {
        success: false,
        error: {
          code: isNotFound ? 'NOT_FOUND' : isBadReq ? 'BAD_REQUEST' : 'SERVER_ERROR',
          message: msg,
        },
        timestamp: new Date().toISOString(),
      },
      { status: isNotFound ? 404 : isBadReq ? 400 : 500 }
    );
  }
}
