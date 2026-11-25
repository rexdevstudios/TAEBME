/**
 * app/api/admin/kol-verification/route.ts
 *
 * Admin RBAC Dedicated KOL Verification Queue (Phase DW).
 * - Protected by REVIEW_FLAGGED_TOKEN capability (SUPER_ADMIN, MODERATOR, RISK_ADMIN).
 * - GET: Lists KOL profiles joined with primary wallet & computed verification tier.
 * - POST: Approves (GOLD / SILVER) or Revokes a KOL profile in Neon SSOT with immutable audit log.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { defaultKolDbAdapter, getDbPool } from '@packages/shared/db-pool';
import {
  isVerifiedKol,
  resolveKolVerificationDecision,
} from '@packages/intelligence/kol-chart-overlay';

export const dynamic = 'force-dynamic';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapAuthError(authErr: unknown): NextResponse {
  const msg = authErr instanceof Error ? authErr.message : String(authErr);
  const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT_');
  return NextResponse.json(
    {
      success: false,
      error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`,
      timestamp: new Date().toISOString(),
    },
    { status: isForbidden ? 403 : 401 }
  );
}

export async function GET(req: NextRequest) {
  try {
    try {
      await requireCapability(req, 'REVIEW_FLAGGED_TOKEN');
    } catch (authErr: unknown) {
      return mapAuthError(authErr);
    }

    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json(
        {
          success: true,
          data: {
            total: 0,
            verifiedCount: 0,
            goldCount: 0,
            silverCount: 0,
            profiles: [],
          },
          timestamp: new Date().toISOString(),
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const res = await pool.query(
      `SELECT DISTINCT ON (kp.user_id)
              kp.id,
              kp.user_id,
              kp.twitter_handle,
              kp.followers_count,
              kp.trust_score,
              kp.completed_bounties,
              kp.total_earned_usd,
              kp.is_verified,
              kp.updated_at,
              w.address AS wallet_address
       FROM kol_profiles kp
       LEFT JOIN wallets w ON w.user_id = kp.user_id
       ORDER BY kp.user_id, kp.updated_at DESC
       LIMIT 200`
    );

    const profiles = res.rows
      .map((row) => {
        const walletAddress = String(row.wallet_address || '');
        const trustScore = Number(row.trust_score ?? 0);
        const computed = isVerifiedKol({
          walletAddress,
          twitterHandle: row.twitter_handle,
          trustScore,
          isVerified: row.is_verified === false ? false : undefined,
        });
        return {
          id: String(row.id),
          userId: String(row.user_id),
          walletAddress,
          twitterHandle: row.twitter_handle ? String(row.twitter_handle) : null,
          followersCount: Number(row.followers_count ?? 0),
          trustScore,
          completedBounties: Number(row.completed_bounties ?? 0),
          totalEarnedUsd: Number(row.total_earned_usd ?? 0),
          isVerified: Boolean(row.is_verified),
          computedVerified: computed.verified,
          computedTier: computed.tier,
          displayHandle: computed.handle,
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
        };
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const verifiedCount = profiles.filter((p) => p.computedVerified).length;
    const goldCount = profiles.filter((p) => p.computedTier === 'GOLD').length;
    const silverCount = profiles.filter((p) => p.computedTier === 'SILVER').length;

    return NextResponse.json(
      {
        success: true,
        data: {
          total: profiles.length,
          verifiedCount,
          goldCount,
          silverCount,
          profiles,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err?.message || 'KOL_VERIFICATION_QUEUE_LOAD_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    let session;
    try {
      session = await requireCapability(req, 'REVIEW_FLAGGED_TOKEN');
    } catch (authErr: unknown) {
      return mapAuthError(authErr);
    }

    const body = await req.json().catch(() => ({}));
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const resolved = resolveKolVerificationDecision(body?.decision);
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 240) : '';

    if (!userId || !UUID_REGEX.test(userId)) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_USER_ID: Valid KOL userId (UUID) is required.',
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    if (!resolved) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_DECISION: decision must be APPROVE_GOLD, APPROVE_SILVER, or REVOKE.',
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json(
        {
          success: false,
          error: 'DATABASE_UNAVAILABLE',
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }

    const updateRes = await pool.query(
      `UPDATE kol_profiles
       SET is_verified = $2,
           trust_score = $3,
           updated_at = NOW()
       WHERE user_id = $1
       RETURNING id, user_id, twitter_handle, trust_score, is_verified, updated_at`,
      [userId, resolved.isVerified, resolved.trustScore]
    );

    if (updateRes.rows.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'KOL_PROFILE_NOT_FOUND',
          timestamp: new Date().toISOString(),
        },
        { status: 404 }
      );
    }

    const row = updateRes.rows[0];
    await defaultKolDbAdapter.createAuditLog(
      session.user.userId,
      'ADMIN_KOL_VERIFICATION_UPDATED',
      String(row.id),
      `decision=${resolved.decision} handle=@${row.twitter_handle || 'unknown'} trustScore=${resolved.trustScore} isVerified=${resolved.isVerified}${reason ? ` reason=${reason}` : ''}`
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          id: String(row.id),
          userId: String(row.user_id),
          twitterHandle: row.twitter_handle ? String(row.twitter_handle) : null,
          trustScore: Number(row.trust_score),
          isVerified: Boolean(row.is_verified),
          resultingTier: resolved.resultingTier,
          decision: resolved.decision,
          updatedAt: new Date(row.updated_at).toISOString(),
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err?.message || 'KOL_VERIFICATION_UPDATE_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
