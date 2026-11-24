import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { defaultGameFiService } from '@packages/gamefi/gamefi-service';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import { getAppEnvironment } from '@packages/shared/env-config';
import { ethStringToWei, verifyEvmNativePayment } from '@packages/launchpad/evm-verifier';
import {
  BOOSTED_CHECKIN_BONUS_CREDITS,
  BOOSTED_CHECKIN_FEE_ETH,
  isValidEvmTxHash,
} from '@packages/billing/high-margin-revenue';

export async function POST(req: NextRequest) {
  try {
    const session = await requireActiveSession(req);

    const body = await req.json().catch(() => ({}));
    const { questId, mode, txHash, chain } = body || {};

    if (!questId) {
      return NextResponse.json(
        { success: false, error: 'MISSING_QUEST_ID: questId parameter is required' },
        { status: 400 }
      );
    }

    const isBoosted = mode === 'ONCHAIN_BOOSTED' && questId === 'daily_checkin';
    let verifiedBoostTxHash: string | null = null;

    if (isBoosted) {
      const appEnv = getAppEnvironment();
      const rawTx = typeof txHash === 'string' ? txHash.trim() : '';
      if (rawTx) {
        if (!isValidEvmTxHash(rawTx)) {
          return NextResponse.json(
            { success: false, error: 'INVALID_TX_HASH: Valid 32-byte EVM txHash is required for On-Chain Boosted Check-In.' },
            { status: 400 }
          );
        }
        const platformCfg = await defaultBillingDbAdapter.getPlatformFeeAndRiskConfig();
        const paymentCheck = await verifyEvmNativePayment({
          txHash: rawTx,
          chain: typeof chain === 'string' && chain.trim() ? chain.trim() : 'base-mainnet',
          expectedFrom: session.walletAddress,
          expectedTo: platformCfg.treasuryWallet,
          minValueWei: ethStringToWei(BOOSTED_CHECKIN_FEE_ETH),
        });
        if (paymentCheck.status !== 'confirmed') {
          return NextResponse.json(
            { success: false, error: `BOOST_TX_NOT_CONFIRMED: ${paymentCheck.reason || paymentCheck.status}` },
            { status: 422 }
          );
        }
        const globalRedeem = await defaultBillingDbAdapter.redeemGlobalPaymentTxHash({
          txHash: rawTx,
          purpose: 'BOOSTED_CHECKIN',
          walletAddress: session.walletAddress,
        });
        if (!globalRedeem.ok) {
          return NextResponse.json(
            { success: false, error: globalRedeem.error || 'GLOBAL_REPLAY_TX_HASH' },
            { status: 409 }
          );
        }
        verifiedBoostTxHash = rawTx;
      } else if (appEnv === 'testnet' || process.env.NODE_ENV !== 'production') {
        verifiedBoostTxHash = `testnet-boost-checkin-${Date.now()}`;
      } else {
        return NextResponse.json(
          {
            success: false,
            error: `PAYMENT_TX_REQUIRED: Sending ${BOOSTED_CHECKIN_FEE_ETH} ETH on Base L2 to Treasury is required for On-Chain Boosted Check-In.`,
          },
          { status: 402 }
        );
      }
    }

    const userId = session.user.userId;
    const walletAddress = session.walletAddress;

    const result = await defaultGameFiService.verifyAndCompleteQuest({
      userId,
      walletAddress,
      questId,
    });

    let bonusCreditsGranted = 0;
    if (isBoosted && verifiedBoostTxHash) {
      bonusCreditsGranted = BOOSTED_CHECKIN_BONUS_CREDITS;
      try {
        await defaultBillingDbAdapter.recordLedgerEntry({
          userId: walletAddress,
          amount: bonusCreditsGranted,
          currency: 'CREDITS',
          type: 'ONCHAIN_BOOSTED_CHECKIN_BONUS',
          referenceId: `boosted-checkin:${verifiedBoostTxHash}`,
          description: `On-Chain Boosted Daily Check-In (${BOOSTED_CHECKIN_FEE_ETH} ETH): +${bonusCreditsGranted} Bonus Credits`,
        });
      } catch {
        // Non-blocking fallback
      }
    }

    return NextResponse.json({
      success: true,
      profile: result.profile,
      completion: result.completion,
      creditsGranted: result.creditsGranted + bonusCreditsGranted,
      boosted: isBoosted,
      bonusCreditsGranted,
      txHash: verifiedBoostTxHash,
    });
  } catch (err: any) {
    const msg = err?.message || 'QUEST_COMPLETION_FAILED';
    if (msg.startsWith('UNAUTHORIZED')) {
      return NextResponse.json({ success: false, error: msg }, { status: 401 });
    }
    if (msg.startsWith('AUTH_ACCOUNT_') || msg.startsWith('FORBIDDEN') || msg.startsWith('RBAC_FORBIDDEN')) {
      return NextResponse.json({ success: false, error: msg }, { status: 403 });
    }
    if (msg.startsWith('DATABASE_UNAVAILABLE')) {
      return NextResponse.json({ success: false, error: 'DATABASE_UNAVAILABLE: Database service temporarily unavailable. Please retry shortly.' }, { status: 503 });
    }
    return NextResponse.json(
      { success: false, error: msg },
      { status: 400 }
    );
  }
}
