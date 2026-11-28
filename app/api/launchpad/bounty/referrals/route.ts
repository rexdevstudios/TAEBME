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
  computeUnifiedCreatorEarnings,
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

    const emptyCreatorEarnings = computeUnifiedCreatorEarnings({
      airdropReferralCredits: 0,
      signalMarketplaceCredits: 0,
      signalSalesCount: 0,
    });

    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json({
        success: true,
        data: {
          walletAddress: session.walletAddress,
          ...emptySummary,
          creatorEarnings: emptyCreatorEarnings,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Resolve canonical Postgres users.id UUID from wallets table (session.user.userId can be synthetic `usr-0x...`)
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let dbUserId: string | null = null;
    try {
      const wRes = await pool.query(
        `SELECT user_id FROM wallets WHERE LOWER(address) = LOWER($1) LIMIT 1`,
        [session.walletAddress]
      );
      const found = wRes.rows[0]?.user_id;
      if (typeof found === 'string' && UUID_RE.test(found)) {
        dbUserId = found;
      }
    } catch {
      // Fallback below
    }
    if (!dbUserId && typeof session.user?.userId === 'string' && UUID_RE.test(session.user.userId)) {
      dbUserId = session.user.userId;
    }

    if (!dbUserId) {
      return NextResponse.json({
        success: true,
        data: {
          walletAddress: session.walletAddress,
          ...emptySummary,
          creatorEarnings: emptyCreatorEarnings,
        },
        timestamp: new Date().toISOString(),
      });
    }

    const likePattern = `${AIRDROP_REFERRAL_REFERENCE_PREFIX}%`;
    const [aggRes, recentRes, signalRevRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total_referrals,
                COALESCE(SUM(amount), 0)::numeric AS total_credits
         FROM ledger_entries
         WHERE user_id = $1::uuid
           AND currency = 'CREDITS'
           AND type = 'CREDIT'
           AND reference_id LIKE $2`,
        [dbUserId, likePattern]
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
        [dbUserId, likePattern]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS sales_count,
                COALESCE(SUM(amount), 0)::numeric AS signal_credits
         FROM ledger_entries
         WHERE user_id = $1::uuid
           AND currency = 'CREDITS'
           AND type = 'MARKETPLACE_CREATOR_REVENUE'`,
        [dbUserId]
      ),
    ]);

    const aggRow = aggRes.rows[0] || {};
    const totalReferrals = Math.max(0, Number(aggRow.total_referrals || 0));
    const totalCreditsEarned = Math.max(0, Math.round(Number(aggRow.total_credits || 0) * 100) / 100);
    const sigRow = signalRevRes.rows[0] || {};
    const creatorEarnings = computeUnifiedCreatorEarnings({
      airdropReferralCredits: totalCreditsEarned,
      signalMarketplaceCredits: Number(sigRow.signal_credits || 0),
      signalSalesCount: Number(sigRow.sales_count || 0),
    });

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
        creatorEarnings,
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
