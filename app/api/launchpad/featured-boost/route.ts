/**
 * app/api/launchpad/featured-boost/route.ts
 *
 * Paid 24h / 72h Launchpad Featured Boost Slot Endpoint (Phase DD).
 * - GET: Public (Edge cached 15s), returns active FEATURED boosts, tiers, and treasuryWallet.
 * - POST: Authenticated SIWE session, verifies Base/L2 ETH payment txHash via read-only viem
 *   (or 1-click Testnet simulation when APP_ENV=testnet), enforces anti-replay on txHash,
 *   and persists boost to Neon PostgreSQL SSOT.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import { getAppEnvironment } from '@packages/shared/env-config';
import { verifyEvmTransactionReceipt } from '@packages/launchpad/evm-verifier';
import {
  FEATURED_BOOST_TIERS,
  computeFeaturedBoostWindow,
  getFeaturedBoostTier,
  isValidEvmTxHash,
} from '@packages/billing/high-margin-revenue';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [activeBoosts, platformCfg] = await Promise.all([
      defaultBillingDbAdapter.getActiveFeaturedBoosts(),
      defaultBillingDbAdapter.getPlatformFeeAndRiskConfig(),
    ]);
    return NextResponse.json(
      {
        success: true,
        data: {
          activeBoosts,
          tiers: Object.values(FEATURED_BOOST_TIERS),
          treasuryWallet: platformCfg.treasuryWallet,
        },
        timestamp: new Date().toISOString(),
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45',
        },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'FAILED_TO_LOAD_BOOSTS', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

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
    const contractAddress = typeof body?.contractAddress === 'string' ? body.contractAddress.trim() : '';
    const chain = typeof body?.chain === 'string' && body.chain.trim() ? body.chain.trim() : 'base-mainnet';
    const tier = getFeaturedBoostTier(body?.tierId || 'BOOST_24H');
    const txHashInput = typeof body?.txHash === 'string' ? body.txHash.trim() : '';

    if (!contractAddress || contractAddress.length < 16) {
      return NextResponse.json(
        { success: false, error: 'INVALID_CONTRACT_ADDRESS: Valid token contract address is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }
    if (!tier) {
      return NextResponse.json(
        { success: false, error: 'INVALID_BOOST_TIER: Supported tiers are BOOST_24H, BOOST_72H', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const appEnv = getAppEnvironment();
    let effectiveTxHash = txHashInput;

    if (txHashInput) {
      if (!isValidEvmTxHash(txHashInput)) {
        return NextResponse.json(
          { success: false, error: 'INVALID_TX_HASH: Valid 32-byte EVM txHash is required', timestamp: new Date().toISOString() },
          { status: 400 }
        );
      }
      const receipt = await verifyEvmTransactionReceipt(txHashInput, chain);
      if (receipt.status !== 'confirmed') {
        return NextResponse.json(
          { success: false, error: `BOOST_TX_NOT_CONFIRMED: ${receipt.reason || receipt.status}`, timestamp: new Date().toISOString() },
          { status: 422 }
        );
      }
    } else if (appEnv === 'testnet' || process.env.NODE_ENV !== 'production') {
      effectiveTxHash = `testnet-boost-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    } else {
      return NextResponse.json(
        {
          success: false,
          error: `PAYMENT_TX_REQUIRED: Sending ${tier.feeEth} ETH on Base L2 to Treasury is required to activate ${tier.label}.`,
          timestamp: new Date().toISOString(),
        },
        { status: 402 }
      );
    }

    const { startedAt, expiresAt } = computeFeaturedBoostWindow(tier.tierId);
    const saved = await defaultBillingDbAdapter.recordFeaturedBoost({
      contractAddress,
      chain,
      tierId: tier.tierId,
      sponsoredBy: session.walletAddress,
      txHash: effectiveTxHash,
      startedAt,
      expiresAt,
    });

    if (saved.replay) {
      return NextResponse.json(
        { success: false, error: 'REPLAY_TX_HASH: This transaction hash has already been redeemed for a Featured Boost.', timestamp: new Date().toISOString() },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          contractAddress,
          chain,
          tierId: tier.tierId,
          feeEth: tier.feeEth,
          txHash: effectiveTxHash,
          startedAt,
          expiresAt,
          activeBoosts: saved.activeBoosts,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'FEATURED_BOOST_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
