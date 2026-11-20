/**
 * app/api/launchpad/bankr-deploy/route.ts
 *
 * Vercel-Native Stateless Bankr Gas-Sponsored Token Deployment Endpoint.
 * - Protected by Edge Middleware SIWE + RBAC PUBLISH_LAUNCH + rateLimiter.
 * - Zero private keys in Vercel (uses BANKR_API_KEY REST header only).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { deployTokenViaBankrApi, type BankrSupportedChain } from '@packages/launchpad/bankr-client';
import { SubscriptionsEngine } from '@packages/billing/subscriptions-engine';
import { defaultBillingDbAdapter, getDbPool } from '@packages/shared/db-pool';

export const dynamic = 'force-dynamic';

const VALID_CHAINS = new Set<BankrSupportedChain>(['base', 'robinhood', 'arbitrum', 'arc']);

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:bankr:deploy:${ip}`, 10, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Bankr deploy rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let auth;
    try {
      auth = await requireCapability(req, 'PUBLISH_LAUNCH');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const tokenName = typeof body?.tokenName === 'string' ? body.tokenName.trim() : '';
    const tokenSymbol = typeof body?.tokenSymbol === 'string' ? body.tokenSymbol.trim() : '';
    const chain = (typeof body?.chain === 'string' ? body.chain.trim().toLowerCase() : 'base') as BankrSupportedChain;

    if (tokenName.length < 2 || tokenSymbol.length < 2) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: tokenName and tokenSymbol (min 2 chars) are required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }
    if (!VALID_CHAINS.has(chain)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_CHAIN: Supported chains are base, robinhood, arbitrum, arc', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const result = await deployTokenViaBankrApi({
      tokenName,
      tokenSymbol,
      description: typeof body?.description === 'string' ? body.description : undefined,
      image: typeof body?.image === 'string' ? body.image : undefined,
      websiteUrl: typeof body?.websiteUrl === 'string' ? body.websiteUrl : undefined,
      tweetUrl: typeof body?.tweetUrl === 'string' ? body.tweetUrl : undefined,
      chain,
      feeRecipient: body?.feeRecipient,
      degenMode: body?.degenMode !== false,
      simulateOnly: Boolean(body?.simulateOnly),
    });

    const httpStatus =
      result.status === 'deployed' || result.status === 'simulated'
        ? 200
        : result.status === 'unknown'
        ? 504
        : 422;

    const isSuccess = result.status === 'deployed' || result.status === 'simulated';
    let remainingCredits: number | undefined;
    if (isSuccess) {
      try {
        if (getDbPool() && auth?.walletAddress) {
          await SubscriptionsEngine.deductMeteredCredits(
            auth.walletAddress,
            50,
            'TOKEN_LAUNCH_BANKR',
            result.txHash || result.tokenAddress || `bankr-${tokenSymbol}-${Date.now()}`,
            defaultBillingDbAdapter
          );
          remainingCredits = await defaultBillingDbAdapter.getUserCreditBalance(auth.walletAddress);
        }
      } catch {
        // Non-blocking fallback
      }
    }

    return NextResponse.json(
      {
        success: isSuccess,
        data: {
          ...result,
          creditsBurned: isSuccess ? 50 : 0,
          remainingCredits,
        },
        error: result.status === 'failed' || result.status === 'unknown' ? result.message : undefined,
        timestamp: new Date().toISOString(),
      },
      { status: httpStatus }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'BANKR_DEPLOY_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
