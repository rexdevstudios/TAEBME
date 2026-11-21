import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { defaultGameFiService } from '@packages/gamefi/gamefi-service';

export async function POST(req: NextRequest) {
  try {
    const session = await requireActiveSession(req);

    const body = await req.json().catch(() => ({}));
    const { questId } = body || {};

    if (!questId) {
      return NextResponse.json(
        { success: false, error: 'MISSING_QUEST_ID: questId parameter is required' },
        { status: 400 }
      );
    }

    const userId = session.user.userId;
    const walletAddress = session.walletAddress;

    const result = await defaultGameFiService.verifyAndCompleteQuest({
      userId,
      walletAddress,
      questId,
    });

    return NextResponse.json({
      success: true,
      profile: result.profile,
      completion: result.completion,
      creditsGranted: result.creditsGranted,
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
