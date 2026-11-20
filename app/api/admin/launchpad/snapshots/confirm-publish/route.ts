/**
 * app/api/admin/launchpad/snapshots/confirm-publish/route.ts
 *
 * Vercel-First Non-Custodial Snapshot Publication Confirmation
 *
 * Allows an authorized Protocol Admin (MANAGE_SNAPSHOTS: SUPER_ADMIN or LAUNCH_ADMIN)
 * who signed `setBountyMerkleRoot(tokenAddress, merkleRoot)` directly via MetaMask/Safe
 * to confirm the mined transaction and promote the snapshot FINALIZED → PUBLISHED in PostgreSQL SSOT.
 *
 * Key Invariants:
 * - Zero private keys in Vercel (AGENTS.md Rule 3).
 * - Stateless request-response only (AGENTS.md Rule 1).
 * - Fail-closed: verifies BOTH confirmed EVM tx receipt AND on-chain contract Merkle root match
 *   via BountyMerkleSnapshotService.verifyOnChainMerkleRootConsistency() before marking PUBLISHED.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { requireCapability } from '@packages/auth/session';
import {
  defaultBountyMerkleSnapshotDbAdapter,
  defaultRpcManager,
  getDbPool,
  ensureUserEntity,
} from '@packages/shared/db-pool';
import { BountyMerkleSnapshotService } from '@packages/launchpad/bounty-merkle-snapshot-service';
import { verifyEvmTransactionReceipt } from '@packages/launchpad/evm-verifier';

export const dynamic = 'force-dynamic';

const _snapshotSvc = new BountyMerkleSnapshotService(defaultBountyMerkleSnapshotDbAdapter);

export async function POST(req: NextRequest) {
  try {
    // 1. RBAC — MANAGE_SNAPSHOTS required (SUPER_ADMIN or LAUNCH_ADMIN)
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

    // 2. Validate inputs
    const body = await req.json().catch(() => ({}));
    const { snapshotId, txHash } = body as { snapshotId?: string; txHash?: string };

    if (!snapshotId || typeof snapshotId !== 'string') {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: snapshotId is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }
    if (!txHash || typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_TX_HASH: Valid 32-byte hex txHash is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    // 3. Load snapshot & enforce FINALIZED precondition
    const snapshot = await defaultBountyMerkleSnapshotDbAdapter.getSnapshot(snapshotId);
    if (!snapshot) {
      return NextResponse.json(
        { success: false, error: `SNAPSHOT_NOT_FOUND: Snapshot ${snapshotId} does not exist`, timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }
    if (snapshot.status === 'PUBLISHED') {
      return NextResponse.json({
        success: true,
        data: {
          snapshotId: snapshot.id,
          status: snapshot.status,
          merkleRoot: snapshot.merkle_root,
          publicationTxHash: snapshot.publication_tx_hash,
          idempotent: true,
        },
        timestamp: new Date().toISOString(),
      }, { status: 200 });
    }
    if (snapshot.status !== 'FINALIZED' || !snapshot.merkle_root) {
      return NextResponse.json(
        {
          success: false,
          error: `SNAPSHOT_NOT_FINALIZED: Snapshot ${snapshotId} has status ${snapshot.status}. Only FINALIZED snapshots may be confirmed.`,
          timestamp: new Date().toISOString(),
        },
        { status: 409 }
      );
    }

    // 4. Verify mined EVM transaction receipt (fail-closed)
    const receiptCheck = await verifyEvmTransactionReceipt(txHash, snapshot.network_id);
    if (receiptCheck.status !== 'confirmed' || receiptCheck.blockNumber === undefined) {
      return NextResponse.json(
        {
          success: false,
          error: `TX_NOT_CONFIRMED: Receipt verification failed (${receiptCheck.status}): ${receiptCheck.reason || 'unconfirmed'}`,
          timestamp: new Date().toISOString(),
        },
        { status: 422 }
      );
    }

    // 5. Verify on-chain contract Merkle root consistency (fail-closed)
    let rpcUrl: string;
    try {
      rpcUrl = await defaultRpcManager.getActiveHttpRpc(snapshot.network_id, 'LAUNCHPAD');
    } catch (rpcErr: unknown) {
      return NextResponse.json(
        {
          success: false,
          error: `PROVIDER_UNAVAILABLE: ${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)}`,
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const consistency = await _snapshotSvc.verifyOnChainMerkleRootConsistency(snapshotId, {
      getNetwork: async () => {
        const net = await provider.getNetwork();
        return { chainId: net.chainId };
      },
      call: async (tx) => provider.call(tx),
    });

    if (!consistency.matched) {
      return NextResponse.json(
        {
          success: false,
          error: `ON_CHAIN_ROOT_MISMATCH: Contract root ${consistency.onChainRoot} does not match snapshot root ${snapshot.merkle_root}`,
          timestamp: new Date().toISOString(),
        },
        { status: 422 }
      );
    }

    // 6. Promote FINALIZED → PUBLISHED atomically in PostgreSQL SSOT
    const pool = getDbPool();
    const actorUuid = pool ? await ensureUserEntity(pool, session.walletAddress).catch(() => null) : null;

    const published = await defaultBountyMerkleSnapshotDbAdapter.markSnapshotPublished(snapshotId, txHash, {
      confirmedBlockNumber: receiptCheck.blockNumber,
      confirmedRoot: consistency.onChainRoot,
      publishedBy: actorUuid,
      auditLog: {
        snapshot_id: snapshotId,
        event_type: 'SNAPSHOT_PUBLISHED_VERCEL_CONFIRM',
        event_source: 'ADMIN_API',
        old_state: { status: 'FINALIZED' },
        new_state: { status: 'PUBLISHED', publication_tx_hash: txHash, confirmed_block_number: receiptCheck.blockNumber.toString() },
        metadata: { actorWallet: session.walletAddress, confirmedRoot: consistency.onChainRoot },
        severity: 'INFO',
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        snapshotId: published.id,
        status: published.status,
        merkleRoot: published.merkle_root,
        publicationTxHash: published.publication_tx_hash,
        confirmedBlockNumber: published.confirmed_block_number?.toString() ?? receiptCheck.blockNumber.toString(),
      },
      timestamp: new Date().toISOString(),
    }, { status: 200 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('DATABASE_UNAVAILABLE')) {
      return NextResponse.json(
        { success: false, error: 'Database temporarily unavailable. Please retry.', timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { success: false, error: msg || 'SNAPSHOT_CONFIRM_PUBLISH_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
