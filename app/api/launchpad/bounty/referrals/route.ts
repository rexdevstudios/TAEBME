/**
 * app/api/launchpad/bounty/referrals/route.ts
 *
 * Stateless Airdrop Referral Stats Endpoint (Phase EY).
 * - Requires authenticated ACTIVE SIWE session (fail-closed 401/403).
 * - Queries PostgreSQL `ledger_entries` using `idx_ledger_user_date` (`user_id`)
 *   for canonical `bounty_ref:%` credit entries (zero DDL migration).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { getDbPool } from '@packages/shared/db-pool';
import {
  AIRDROP_REFERRAL_BONUS_CREDITS,
  AIRDROP_REFERRAL_REFERENCE_PREFIX,
  parseAirdropReferralReferenceId,
  type AirdropReferralRecentItem,
  type AirdropReferralStatsSummary,
} from '@packages/shared/airdrop-referral';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await requireActiveSession(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('AUTH_ACCOUNT_') || msg.includes('FORBIDDEN');
      return NextResponse.json(
        {
          success: false,
          error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`,
          timestamp: new Date().toISOString(),
        },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const emptySummary: AirdropReferralStatsSummary = {
      totalReferrals: 0,
      totalCreditsEarned: 0,
      bonusPerReferral: AIRDROP_REFERRAL_BONUS_CREDITS,
      recentReferrals: [],
    };

    const pool = getDbPool();
    if (!pool || !session.user?.userId) {
      return NextResponse.json({
        success: true,
        data: {
          walletAddress: session.walletAddress,
          ...emptySummary,
        },
        timestamp: new Date().toISOString(),
      });
    }

    const likePattern = `${AIRDROP_REFERRAL_REFERENCE_PREFIX}%`;
    const [aggRes, recentRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total_referrals,
                COALESCE(SUM(amount), 0)::numeric AS total_credits
         FROM ledger_entries
         WHERE user_id = $1::uuid
           AND currency = 'CREDITS'
           AND type = 'CREDIT'
           AND reference_id LIKE $2`,
        [session.user.userId, likePattern]
      ),
      pool.query(
        `SELECT id, amount::numeric AS amount, reference_id AS "referenceId",
                COALESCE(description, '') AS description, created_at AS "createdAt"
         FROM ledger_entries
         WHERE user_id = $1::uuid
           AND currency = 'CREDITS'
           AND type = 'CREDIT'
           AND reference_id LIKE $2
         ORDER BY created_at DESC
         LIMIT 10`,
        [session.user.userId, likePattern]
      ),
    ]);

    const aggRow = aggRes.rows[0] || {};
    const totalReferrals = Math.max(0, Number(aggRow.total_referrals || 0));
    const totalCreditsEarned = Math.max(0, Math.round(Number(aggRow.total_credits || 0) * 100) / 100);

    const recentReferrals: AirdropReferralRecentItem[] = [];
    for (const row of recentRes.rows || []) {
      const parsed = parseAirdropReferralReferenceId(row.referenceId);
      if (!parsed) continue;
      recentReferrals.push({
        id: String(row.id),
        campaignId: parsed.campaignId,
        claimId: parsed.claimId,
        amount: Number(row.amount || AIRDROP_REFERRAL_BONUS_CREDITS),
        description: String(row.description || ''),
        createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : '',
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        walletAddress: session.walletAddress,
        totalReferrals,
        totalCreditsEarned,
        bonusPerReferral: AIRDROP_REFERRAL_BONUS_CREDITS,
        recentReferrals,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        success: false,
        error: msg || 'REFERRAL_STATS_FETCH_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
