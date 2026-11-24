/**
 * app/api/gamefi/genesis-sbt/route.ts
 *
 * Free-Mint Genesis Pioneer SBT (0.00018 ETH ≈ $0.50 Base Protocol Mint Fee) + Referral Attribution (Phase DF).
 * - GET: Public (Edge cached 15s), returns live minted counter (X / 10,000), leaderboard,
 *   protocolFeeEth, treasuryWallet, and current user's pass status if authenticated.
 * - POST: Authenticated SIWE session, verifies Base L2 txHash on Production (1-click on Testnet),
 *   enforces 1-per-wallet & anti-replay txHash, mints Genesis Pioneer #N, and atomically credits
 *   +200 cr to minter and +50 cr to valid referrer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateSession, requireActiveSession } from '@packages/auth/session';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import { getAppEnvironment } from '@packages/shared/env-config';
import { verifyEvmTransactionReceipt } from '@packages/launchpad/evm-verifier';
import { isValidEvmTxHash } from '@packages/billing/high-margin-revenue';
import {
  GENESIS_SBT_PROTOCOL_FEE_ETH,
  GENESIS_SBT_REFERRAL_BONUS_CREDITS,
  GENESIS_SBT_SUPPLY_CAP,
  GENESIS_SBT_WELCOME_CREDITS,
  normalizeReferrerWallet,
} from '@packages/billing/genesis-sbt';
import { notifyPublicTelegramChannelBestEffort } from '@packages/notifications/webhook-dispatcher';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session = await authenticateSession(req).catch(() => null);
    const [state, platformCfg] = await Promise.all([
      defaultBillingDbAdapter.getGenesisSbtState(session?.walletAddress),
      defaultBillingDbAdapter.getPlatformFeeAndRiskConfig(),
    ]);

    return NextResponse.json(
      {
        success: true,
        data: {
          ...state,
          supplyCap: GENESIS_SBT_SUPPLY_CAP,
          mintPriceEth: '0',
          protocolFeeEth: GENESIS_SBT_PROTOCOL_FEE_ETH,
          welcomeCredits: GENESIS_SBT_WELCOME_CREDITS,
          referralBonusCredits: GENESIS_SBT_REFERRAL_BONUS_CREDITS,
          treasuryWallet: platformCfg.treasuryWallet,
        },
        timestamp: new Date().toISOString(),
      },
      {
        status: 200,
        headers: session
          ? { 'Cache-Control': 'no-store' }
          : { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45' },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'GENESIS_SBT_LOAD_FAILED', timestamp: new Date().toISOString() },
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
    const rawTx = typeof body?.txHash === 'string' ? body.txHash.trim() : '';
    const chain = typeof body?.chain === 'string' && body.chain.trim() ? body.chain.trim() : 'base-mainnet';
    const referredBy = normalizeReferrerWallet(body?.referrerWallet, session.walletAddress);
    const appEnv = getAppEnvironment();

    let effectiveTxHash = rawTx;
    if (rawTx) {
      if (!isValidEvmTxHash(rawTx)) {
        return NextResponse.json(
          { success: false, error: 'INVALID_TX_HASH: Valid 32-byte EVM txHash is required.', timestamp: new Date().toISOString() },
          { status: 400 }
        );
      }
      const receipt = await verifyEvmTransactionReceipt(rawTx, chain);
      if (receipt.status !== 'confirmed') {
        return NextResponse.json(
          { success: false, error: `MINT_TX_NOT_CONFIRMED: ${receipt.reason || receipt.status}`, timestamp: new Date().toISOString() },
          { status: 422 }
        );
      }
    } else if (appEnv === 'testnet' || process.env.NODE_ENV !== 'production') {
      effectiveTxHash = `testnet-genesis-sbt-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    } else {
      return NextResponse.json(
        {
          success: false,
          error: `PROTOCOL_FEE_TX_REQUIRED: Free Mint requires confirmed Base L2 protocol mint fee (${GENESIS_SBT_PROTOCOL_FEE_ETH} ETH) txHash.`,
          timestamp: new Date().toISOString(),
        },
        { status: 402 }
      );
    }

    const result = await defaultBillingDbAdapter.recordGenesisSbtMint({
      walletAddress: session.walletAddress,
      txHash: effectiveTxHash,
      chain,
      referredBy,
    });

    if (!result.ok) {
      const status =
        result.code === 'ALREADY_MINTED' || result.code === 'REPLAY_TX_HASH'
          ? 409
          : result.code === 'SUPPLY_EXHAUSTED'
            ? 410
            : 400;
      return NextResponse.json(
        { success: false, error: result.error || result.code || 'MINT_FAILED', timestamp: new Date().toISOString() },
        { status }
      );
    }

    const maskedWallet = `${session.walletAddress.slice(0, 6)}...${session.walletAddress.slice(-4)}`;
    await notifyPublicTelegramChannelBestEffort({
      event: 'GENESIS_SBT_MINTED',
      title: `New Genesis Pioneer #${result.pass?.serialNumber || result.totalMinted} Minted`,
      message:
        `Wallet ${maskedWallet} just claimed Free-Mint Genesis Pioneer SBT #${result.pass?.serialNumber || result.totalMinted} (${result.totalMinted} / ${GENESIS_SBT_SUPPLY_CAP.toLocaleString()}).\n` +
        `Claim yours free (+200 Credits): https://pndigi.site`,
      metadata: {
        serial: result.pass?.serialNumber || 0,
        totalMinted: result.totalMinted || 0,
        chain,
        referred: Boolean(referredBy),
      },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          pass: result.pass,
          totalMinted: result.totalMinted,
          supplyCap: GENESIS_SBT_SUPPLY_CAP,
          welcomeCreditsGranted: GENESIS_SBT_WELCOME_CREDITS,
          referralBonusGranted: referredBy ? GENESIS_SBT_REFERRAL_BONUS_CREDITS : 0,
          leaderboard: result.leaderboard,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'GENESIS_SBT_MINT_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
