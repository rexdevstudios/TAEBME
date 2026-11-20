/**
 * app/api/admin/launchpad/snapshots/draft/route.ts
 *
 * B3.2 — POST /api/admin/launchpad/snapshots/draft
 *
 * Creates a new DRAFT Merkle snapshot for a token launch.
 * - Requires MANAGE_SNAPSHOTS capability (SUPER_ADMIN or LAUNCH_ADMIN).
 * - Idempotent: returns existing DRAFT when idempotencyKey matches.
 * - Does NOT perform on-chain operations (B3.3 scope).
 *
 * Request body:
 *   { launchId: string, campaignId?: string, idempotencyKey?: string }
 *
 * Response:
 *   { snapshotId, status: 'DRAFT', recipientCount, totalRewardTokens, merkleRoot, idempotencyKey }
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireCapability } from '@packages/auth/session';
import { defaultBountyMerkleSnapshotDbAdapter, getDbPool, ensureUserEntity } from '@packages/shared/db-pool';
import { BountyMerkleSnapshotService } from '@packages/launchpad/bounty-merkle-snapshot-service';

const _snapshotSvc = new BountyMerkleSnapshotService(defaultBountyMerkleSnapshotDbAdapter);

export async function POST(req: NextRequest) {
  try {
    // 1. RBAC — MANAGE_SNAPSHOTS required
    let session;
    try {
      session = await requireCapability(req, 'MANAGE_SNAPSHOTS');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    // 2. Parse body
    const body = await req.json().catch(() => ({}));
    const { launchId, campaignId, idempotencyKey } = body as {
      launchId?: string;
      campaignId?: string;
      idempotencyKey?: string;
    };

    if (!launchId || typeof launchId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: launchId is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const resolvedIdempotencyKey = idempotencyKey || randomUUID();

    const pool = getDbPool();
    const actorUuid = pool ? await ensureUserEntity(pool, session.walletAddress).catch(() => undefined) : undefined;

    // 3. Create draft via service (using real CreateSnapshotDraftParams interface)
    const { snapshot, isExisting } = await _snapshotSvc.createDraftSnapshot({
      launchId,
      campaignId: campaignId || undefined,
      idempotencyKey: resolvedIdempotencyKey,
      createdBy: actorUuid,
    });

    return NextResponse.json({
      success: true,
      data: {
        snapshotId: snapshot.id,
        status: snapshot.status,
        recipientCount: snapshot.total_recipients,
        totalRewardTokens: snapshot.total_reward_tokens?.toString() ?? '0',
        merkleRoot: snapshot.merkle_root ?? null,
        idempotencyKey: resolvedIdempotencyKey,
        isExisting,
      },
      timestamp: new Date().toISOString(),
    }, { status: isExisting ? 200 : 201 });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.startsWith('LAUNCH_NOT_FOUND')) {
      return NextResponse.json(
        { success: false, error: msg, timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }
    if (msg.startsWith('NO_VERIFIED_CLAIMS')) {
      return NextResponse.json(
        { success: false, error: msg, timestamp: new Date().toISOString() },
        { status: 422 }
      );
    }
    if (msg.startsWith('DATABASE_UNAVAILABLE')) {
      return NextResponse.json(
        { success: false, error: 'Database temporarily unavailable. Please retry.', timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { success: false, error: msg || 'SNAPSHOT_DRAFT_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
