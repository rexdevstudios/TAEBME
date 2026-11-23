import { NextRequest, NextResponse } from 'next/server';
import { authenticateSession } from '@packages/auth/session';
import { defaultGameFiDbAdapter } from '@packages/shared/db-pool';
import { computePassTier, getUtcDailyQuestKey } from '@packages/gamefi/gamefi-service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session = await authenticateSession(req);
    if (!session || !session.walletAddress) {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED: SIWE session required to view GameFi profile' },
        { status: 401 }
      );
    }

    const userId = session.user.userId;
    const [baseProfile, completedQuests, nfts, sybilEligible, tradeOrLaunchEligible] = await Promise.all([
      defaultGameFiDbAdapter.getUserGameFiProfile(userId, session.walletAddress),
      defaultGameFiDbAdapter.getCompletedQuestIds(userId, session.walletAddress),
      defaultGameFiDbAdapter.getUserNfts(session.walletAddress),
      defaultGameFiDbAdapter.hasSybilEvidence(userId, session.walletAddress).catch(() => false),
      defaultGameFiDbAdapter.hasTradeOrLaunchActivity(userId, session.walletAddress).catch(() => false),
    ]);

    const todayKey = getUtcDailyQuestKey();
    const dailyCheckInAvailable = !completedQuests.includes(todayKey);
    const nftMintingStatus = {
      available: Boolean(process.env.GAMEFI_SIGNER_SERVICE_URL),
    };
    const profile = {
      ...baseProfile,
      passTier: computePassTier(baseProfile.xp),
      completedQuests,
      dailyCheckInAvailable,
      questEligibility: {
        daily_checkin: dailyCheckInAvailable,
        connect_siwe: true,
        verify_sybil: sybilEligible,
        first_trade_or_launch: tradeOrLaunchEligible,
      },
      nftMintingStatus,
    };

    return NextResponse.json({
      success: true,
      profile,
      nfts,
      nftMintingStatus,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'GAMEFI_PROFILE_ERROR' },
      { status: 500 }
    );
  }
}
