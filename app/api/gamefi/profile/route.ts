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
    const [baseProfile, completedQuests, nfts] = await Promise.all([
      defaultGameFiDbAdapter.getUserGameFiProfile(userId, session.walletAddress),
      defaultGameFiDbAdapter.getCompletedQuestIds(userId, session.walletAddress),
      defaultGameFiDbAdapter.getUserNfts(session.walletAddress),
    ]);

    const todayKey = getUtcDailyQuestKey();
    const profile = {
      ...baseProfile,
      passTier: computePassTier(baseProfile.xp),
      completedQuests,
      dailyCheckInAvailable: !completedQuests.includes(todayKey),
    };

    return NextResponse.json({
      success: true,
      profile,
      nfts,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'GAMEFI_PROFILE_ERROR' },
      { status: 500 }
    );
  }
}
