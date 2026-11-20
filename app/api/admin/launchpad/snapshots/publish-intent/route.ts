/**
 * app/api/admin/launchpad/snapshots/publish-intent/route.ts
 *
 * B3.2 — POST /api/admin/launchpad/snapshots/publish-intent
 *
 * Creates a publication intent record (bounty_merkle_publication_intents) for a
 * FINALIZED snapshot.  The execution-plane BountyMerklePublicationWorker (B3.3)
 * will poll this table and perform the on-chain setBountyMerkleRoot transaction.
 *
 * Key invariants:
 * - Requires MANAGE_SNAPSHOTS capability (SUPER_ADMIN or LAUNCH_ADMIN).
 * - Only FINALIZED snapshots may receive a publication intent.
 * - Does NOT sign, broadcast, or interact with any RPC node (B3.3 scope).
 * - Idempotent: returns existing CREATED intent if one already exists for this snapshot.
 *
 * Request body:
 *   { snapshotId: string }
 *
 * Response:
 *   { intentId: string, snapshotId: string, status: 'CREATED', merkleRoot: string, tokenAddress: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireCapability } from '@packages/auth/session';
import { defaultBountyMerkleSnapshotDbAdapter, getDbPool, ensureUserEntity } from '@packages/shared/db-pool';

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

    // 3. Load snapshot — must be FINALIZED
    const snapshot = await defaultBountyMerkleSnapshotDbAdapter.getSnapshot(snapshotId);
    if (!snapshot) {
      return NextResponse.json(
        { success: false, error: `SNAPSHOT_NOT_FOUND: Snapshot ${snapshotId} does not exist`, timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }

    if (snapshot.status !== 'FINALIZED') {
      return NextResponse.json(
        {
          success: false,
          error: `SNAPSHOT_NOT_FINALIZED: Snapshot ${snapshotId} is in status ${snapshot.status}. Only FINALIZED snapshots may be published.`,
          timestamp: new Date().toISOString(),
        },
        { status: 409 }
      );
    }

    if (!snapshot.merkle_root) {
      return NextResponse.json(
        { success: false, error: 'SNAPSHOT_MISSING_ROOT: Snapshot does not have a merkle_root. Re-finalize the snapshot.', timestamp: new Date().toISOString() },
        { status: 422 }
      );
    }

    // 4. Check for existing pending intent (idempotency)
    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json(
        { success: false, error: 'DATABASE_UNAVAILABLE: PostgreSQL pool not initialised', timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }

    const existingRes = await pool.query(
      `SELECT id, status FROM bounty_merkle_publication_intents
       WHERE snapshot_id = $1 AND status NOT IN ('ABANDONED', 'REPLACED')
       ORDER BY created_at DESC LIMIT 1`,
      [snapshotId]
    );

    if (existingRes.rows.length > 0) {
      const existing = existingRes.rows[0];
      return NextResponse.json({
        success: true,
        data: {
          intentId: existing.id,
          snapshotId,
          status: existing.status,
          merkleRoot: snapshot.merkle_root,
          tokenAddress: snapshot.token_address,
          idempotent: true,
          message: `Existing publication intent (${existing.status}) returned.`,
        },
        timestamp: new Date().toISOString(),
      }, { status: 200 });
    }

    // 5. Insert new CREATED intent (strictly aligned with bounty_merkle_publication_intents schema)
    const intentId = randomUUID();
    const idempotencyKey = `publish-intent:${snapshotId}`;
    const actorUuid = await ensureUserEntity(pool, session.walletAddress).catch(() => null);
    await pool.query(
      `INSERT INTO bounty_merkle_publication_intents (
         id, snapshot_id, chain_id, contract_address, token_address,
         expected_root, idempotency_key, status, created_by, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'CREATED', $8, NOW(), NOW()
       )`,
      [
        intentId,
        snapshotId,
        snapshot.chain_id.toString(),
        snapshot.contract_address,
        snapshot.token_address,
        snapshot.merkle_root,
        idempotencyKey,
        actorUuid,
      ]
    );

    // 6. Write audit log (non-blocking)
    try {
      await defaultBountyMerkleSnapshotDbAdapter.createAuditLog({
        snapshot_id: snapshotId,
        event_type: 'PUBLICATION_INTENT_CREATED',
        event_source: 'ADMIN_API',
        old_state: { status: snapshot.status },
        new_state: { intentId, intentStatus: 'CREATED' },
        metadata: { actorId: session.user.userId, intentId },
        severity: 'INFO',
      });
    } catch {
      // Non-blocking
    }

    return NextResponse.json({
      success: true,
      data: {
        intentId,
        snapshotId,
        status: 'CREATED',
        merkleRoot: snapshot.merkle_root,
        tokenAddress: snapshot.token_address,
        chainId: snapshot.chain_id.toString(),
        contractAddress: snapshot.contract_address,
        message: 'Publication intent created. The execution-plane worker will broadcast the transaction.',
      },
      timestamp: new Date().toISOString(),
    }, { status: 201 });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.startsWith('DATABASE_UNAVAILABLE')) {
      return NextResponse.json(
        { success: false, error: 'Database temporarily unavailable. Please retry.', timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { success: false, error: msg || 'PUBLISH_INTENT_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
