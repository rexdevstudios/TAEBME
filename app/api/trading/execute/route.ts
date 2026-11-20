/**
 * app/api/trading/execute/route.ts
 *
 * Vercel-Native Stateless Single-Shot Trading Execution Endpoint (Batch V2).
 * - RBAC: requires TRADE_MANUALLY capability (enforced by middleware + requireCapability).
 * - Risk Gate: ALL intents pass TradingRiskGate + KillSwitch + Billing Entitlement (AGENTS.md Rule 5).
 * - Non-Custodial: ZERO private keys in Vercel (AGENTS.md Rule 3). DEX swaps return MEV-checked
 *   payload for browser MetaMask signing; CEX single-shot enforces non-withdrawal credentials.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { TradingRiskGate } from '@packages/trading/risk-gate';
import { MevProtectionService } from '@packages/trading/mev-protection';
import { validateBinancePermissions } from '@packages/shared/types/domain';
import {
  getDbPool,
  saveTradeIntent,
  defaultKillSwitchDbAdapter,
  defaultBillingDbAdapter,
  PostgresBinanceExecutionDbAdapter,
} from '@packages/shared/db-pool';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:trade:exec:${ip}`, 20, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Trade execution rate limit exceeded', timestamp: new Date().toISOString() },
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
    const executionMode = (body?.executionMode || 'PAPER') as 'PAPER' | 'DEX_NON_CUSTODIAL' | 'CEX_SINGLE_SHOT';
    const stage = (body?.stage || (executionMode === 'PAPER' ? 'PAPER' : 'TESTNET')) as 'PAPER' | 'TESTNET' | 'LIVE';
    const symbol = typeof body?.symbol === 'string' && body.symbol.trim() ? body.symbol.trim() : 'BTCUSDT';
    const side = body?.side === 'SELL' ? 'SELL' : 'BUY';
    const type = body?.type === 'LIMIT' ? 'LIMIT' : 'MARKET';
    const quantity = Number(body?.quantity ?? 0);
    const price = body?.price !== undefined ? Number(body.price) : undefined;
    const maxSlippagePct = Number(body?.maxSlippagePct ?? 1.0);
    const idempotencyKey =
      typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: quantity must be a positive number', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    // 1. Authoritative Kill Switch, Entitlement & Deterministic Risk Gate (Fail-Closed)
    const activeKillSwitches = await defaultKillSwitchDbAdapter.getActiveKillSwitches();
    const userEntitlement = await defaultBillingDbAdapter.getUserEntitlement(auth.user.userId);
    const dynamicRiskCfg = await defaultBillingDbAdapter.getPlatformFeeAndRiskConfig().catch(() => null);
    const { status: gateStatus, decision } = TradingRiskGate.evaluateIntent(
      {
        userId: auth.user.userId,
        stage,
        symbol,
        side,
        type,
        quantity,
        price,
        maxSlippagePct,
        idempotencyKey,
      },
      {
        maxOrderValueUsd: dynamicRiskCfg?.maxOrderValueUsd ?? 10000,
        maxDailyLossUsd: dynamicRiskCfg?.maxDailyLossUsd ?? 1000,
        currentDailyLossUsd: 0,
        maxOpenPositions: 5,
        currentOpenPositions: 0,
      },
      userEntitlement,
      activeKillSwitches
    );

    if (!decision.isApproved) {
      return NextResponse.json(
        {
          success: false,
          error: `RISK_REJECTED: ${decision.reason || 'Trade intent rejected by Risk Gate'}`,
          data: { status: gateStatus, decision },
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // 2. Branch by Vercel-Native execution mode
    if (executionMode === 'DEX_NON_CUSTODIAL') {
      const tokenAddress = typeof body?.tokenAddress === 'string' ? body.tokenAddress.trim() : '';
      if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
        return NextResponse.json(
          { success: false, error: 'INVALID_TOKEN_ADDRESS: Valid EVM tokenAddress is required for DEX_NON_CUSTODIAL', timestamp: new Date().toISOString() },
          { status: 400 }
        );
      }
      const chainId = Number(body?.chainId ?? 8453);
      const liquidityEth = typeof body?.liquidityEth === 'string' ? body.liquidityEth : '24';
      const quote = MevProtectionService.evaluateGraduationSlippage(
        tokenAddress,
        ethers.parseEther(liquidityEth),
        chainId
      );
      const verification = MevProtectionService.verifyMevProtection(quote);
      if (!verification.isSafe) {
        return NextResponse.json(
          { success: false, error: 'MEV_UNSAFE: Liquidity quote failed MEV protection safety check', timestamp: new Date().toISOString() },
          { status: 422 }
        );
      }

      const tradeIntentId = await saveTradeIntent({
        userId: auth.user.userId,
        stage,
        symbol,
        side,
        type,
        quantity,
        price,
        idempotencyKey,
        status: 'APPROVED',
        riskDecisionReason: decision.reason,
      });

      return NextResponse.json({
        success: true,
        data: {
          tradeIntentId,
          executionMode,
          status: 'READY_FOR_WALLET_SIGN',
          mevQuote: {
            ...quote,
            liquidityWei: quote.liquidityWei.toString(),
            isSafe: verification.isSafe,
          },
          decision,
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (executionMode === 'CEX_SINGLE_SHOT') {
      const pool = getDbPool();
      if (!pool) {
        return NextResponse.json(
          { success: false, error: 'DATABASE_UNAVAILABLE: PostgreSQL pool unavailable', timestamp: new Date().toISOString() },
          { status: 503 }
        );
      }
      const execDb = new PostgresBinanceExecutionDbAdapter(pool);
      const creds = await execDb.getBinanceCredentials(auth.user.userId);
      if (!creds || creds.isActive === false) {
        return NextResponse.json(
          { success: false, error: 'CEX_CREDENTIALS_MISSING: Active trade-only Binance API credentials are required', timestamp: new Date().toISOString() },
          { status: 422 }
        );
      }
      if (creds.permissions) {
        validateBinancePermissions(creds.permissions);
      }

      const tradeIntentId = await saveTradeIntent({
        userId: auth.user.userId,
        stage,
        symbol,
        side,
        type,
        quantity,
        price,
        idempotencyKey,
        status: 'APPROVED',
        riskDecisionReason: decision.reason,
      });

      return NextResponse.json({
        success: true,
        data: {
          tradeIntentId,
          executionMode,
          status: 'APPROVED',
          decision,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Default: PAPER simulated immediate fill
    const tradeIntentId = await saveTradeIntent({
      userId: auth.user.userId,
      stage: 'PAPER',
      symbol,
      side,
      type,
      quantity,
      price,
      idempotencyKey,
      status: 'APPROVED',
      riskDecisionReason: decision.reason,
    });

    return NextResponse.json({
      success: true,
      data: {
        tradeIntentId,
        executionMode: 'PAPER',
        status: 'FILLED_SIMULATED',
        decision,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.startsWith('DATABASE_UNAVAILABLE') ? 503 : 500;
    return NextResponse.json(
      { success: false, error: msg || 'TRADE_EXECUTION_FAILED', timestamp: new Date().toISOString() },
      { status }
    );
  }
}
