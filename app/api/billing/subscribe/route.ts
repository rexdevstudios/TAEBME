/**
 * app/api/billing/subscribe/route.ts
 *
 * Vercel-Native Stateless Subscription Tier Activation & On-Chain Settlement Endpoint.
 * - Requires authenticated ACTIVE SIWE session (requireActiveSession).
 * - Supports:
 *   1. FREE tier instant activation.
 *   2. Paid tiers (CREATOR, TRADER, AGENT) via verified on-chain Base/L2 txHash
 *      (verified fail-closed via verifyEvmTransactionReceipt — zero private keys).
 *   3. Testnet instant activation when APP_ENV=testnet so operators can test all tiers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { SubscriptionsEngine, type PlanId } from '@packages/billing/subscriptions-engine';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import { getAppEnvironment } from '@packages/shared/env-config';
import { verifyEvmTransactionReceipt } from '@packages/launchpad/evm-verifier';

export const dynamic = 'force-dynamic';

const VALID_PLANS = new Set<PlanId>(['FREE', 'CREATOR', 'TRADER', 'AGENT']);

export async function POST(req: NextRequest) {
  try {
    let session;
    try {
      session = await requireActiveSession(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const rawPlan = typeof body?.planId === 'string' ? body.planId.trim().toUpperCase() : '';
    if (!VALID_PLANS.has(rawPlan as PlanId)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_PLAN: Supported plans are FREE, CREATOR, TRADER, AGENT', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const planId = rawPlan as PlanId;
    const txHash = typeof body?.txHash === 'string' ? body.txHash.trim() : '';
    const chain = typeof body?.chain === 'string' ? body.chain.trim() : 'base-mainnet';
    const appEnv = getAppEnvironment();

    let referenceId = 'free-tier-activation';

    if (planId !== 'FREE') {
      if (txHash) {
        if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
          return NextResponse.json(
            { success: false, error: 'INVALID_TX_HASH: Valid 32-byte hex transaction hash is required', timestamp: new Date().toISOString() },
            { status: 400 }
          );
        }
        const receipt = await verifyEvmTransactionReceipt(txHash, chain);
        if (receipt.status !== 'confirmed') {
          return NextResponse.json(
            { success: false, error: `PAYMENT_TX_NOT_CONFIRMED: ${receipt.reason || receipt.status}`, timestamp: new Date().toISOString() },
            { status: 422 }
          );
        }
        referenceId = txHash;
      } else if (appEnv === 'testnet' || process.env.NODE_ENV !== 'production') {
        referenceId = `testnet-grant-${Date.now()}`;
      } else {
        return NextResponse.json(
          {
            success: false,
            error: 'PAYMENT_TX_REQUIRED: In production, upgrading to a paid tier requires a confirmed on-chain Base payment txHash.',
            timestamp: new Date().toISOString(),
          },
          { status: 402 }
        );
      }
    }

    await SubscriptionsEngine.grantMonthlyPlanCredits(
      session.walletAddress,
      planId,
      referenceId,
      defaultBillingDbAdapter
    );

    const newBalance = await defaultBillingDbAdapter.getUserCreditBalance(session.walletAddress);

    return NextResponse.json({
      success: true,
      data: {
        planId,
        credits: newBalance,
        referenceId,
        unlockedCreatorRole: planId === 'CREATOR' || planId === 'AGENT',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg || 'SUBSCRIPTION_UPDATE_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
