/**
 * app/api/admin/launchpad/snapshots/finalize/route.ts
 *
 * B3.2 — POST /api/admin/launchpad/snapshots/finalize
 *
 * Seals a DRAFT snapshot: computes the final Merkle tree, persists leaf-level
 * proofs into bounty_merkle_snapshot_recipients, and transitions status to FINALIZED.
 * - Requires MANAGE_SNAPSHOTS capability (SUPER_ADMIN or LAUNCH_ADMIN).
 * - Triggers fn_bms_finalization_check() PostgreSQL trigger on UPDATE.
 * - After finalization the snapshot is immutable (Tier 1 & Tier 2 columns frozen).
 * - Does NOT perform on-chain operations (B3.3 scope).
 *
 * Request body:
 *   { snapshotId: string }
 *
 * Response:
 *   { snapshotId, status: 'FINALIZED', merkleRoot, totalRewardTokens, totalRecipients, treeDepth }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { defaultBountyMerkleSnapshotDbAdapter, getDbPool, ensureUserEntity } from '@packages/shared/db-pool';
import { BountyMerkleSnapshotService } from '@packages/launchpad/bounty-merkle-snapshot-service';

const _snapshotSvc = new BountyMerkleSnapshotService(defaultBountyMerkleSnapshotDbAdapter);

export async function POST(req: NextRequest) {
  try {
    // 1. RBAC
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
    const { snapshotId } = body as { snapshotId?: string };

    if (!snapshotId || typeof snapshotId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: snapshotId is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const pool = getDbPool();
    const actorUuid = pool ? await ensureUserEntity(pool, session.walletAddress).catch(() => undefined) : undefined;

    // 3. Finalize via service (uses real FinalizeSnapshotParams interface)
    const result = await _snapshotSvc.finalizeSnapshot({
      snapshotId,
      finalizedBy: actorUuid,
    });

    return NextResponse.json({
      success: true,
      data: {
        snapshotId: result.snapshot.id,
        status: result.snapshot.status,
        merkleRoot: result.merkleRoot,
        treeDepth: result.treeDepth,
        totalRewardTokens: result.totalRewardTokens.toString(),
        totalRecipients: result.totalRecipients,
        finalizedAt: result.snapshot.finalized_at?.toISOString() ?? new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.startsWith('SNAPSHOT_NOT_FOUND')) {
      return NextResponse.json(
        { success: false, error: msg, timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }
    if (
      msg.startsWith('SNAPSHOT_ALREADY_FINALIZED') ||
      msg.startsWith('INVALID_STATUS_TRANSITION')
    ) {
      return NextResponse.json(
        { success: false, error: msg, timestamp: new Date().toISOString() },
        { status: 409 }
      );
    }
    if (msg.startsWith('DATABASE_UNAVAILABLE')) {
      return NextResponse.json(
        { success: false, error: 'Database temporarily unavailable. Please retry.', timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { success: false, error: msg || 'SNAPSHOT_FINALIZE_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
