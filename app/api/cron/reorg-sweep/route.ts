/**
 * app/api/cron/reorg-sweep/route.ts
 *
 * Vercel-Native Post-Publication Reorg Sweeper Cron Endpoint.
 * - Strictly authorized via Authorization: Bearer <CRON_SECRET> (min 16 chars, fail-closed).
 * - 100% read-only on-chain verification (ZERO private keys, ZERO while(true) loops).
 * - Audits PUBLISHED snapshots in PostgreSQL SSOT against on-chain bountyMerkleRoots(tokenAddress).
 */

import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import {
  defaultBountyMerkleSnapshotDbAdapter,
  defaultRpcManager,
} from '@packages/shared/db-pool';
import { PublishedSnapshotReorgSweeper } from '@packages/launchpad/reorg-sweeper';

export const dynamic = 'force-dynamic';

function isCronAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret || cronSecret.length < 16) {
    return false;
  }
  const authHeader = req.headers.get('authorization');
  return Boolean(authHeader && authHeader === `Bearer ${cronSecret}`);
}

export async function GET(req: NextRequest) {
  const startMs = performance.now();

  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      {
        success: false,
        error: 'UNAUTHORIZED: Valid Authorization: Bearer <CRON_SECRET> header is required',
        timestamp: new Date().toISOString(),
      },
      { status: 401 }
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const networkId = searchParams.get('networkId')?.trim() || undefined;

    const sweeper = new PublishedSnapshotReorgSweeper(
      defaultBountyMerkleSnapshotDbAdapter,
      async (netId) => {
        const rpcUrl = await defaultRpcManager.getActiveHttpRpc(netId, 'LAUNCHPAD');
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        return {
          getNetwork: async () => {
            const net = await provider.getNetwork();
            return { chainId: net.chainId };
          },
          call: async (tx) => provider.call(tx),
        };
      }
    );

    const report = await sweeper.sweepOnce(networkId);
    const elapsedMs = Math.round(performance.now() - startMs);

    return NextResponse.json(
      {
        success: true,
        data: {
          ...report,
          networkId: networkId ?? 'all',
          elapsedMs,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.startsWith('DATABASE_UNAVAILABLE') ? 503 : 500;
    return NextResponse.json(
      {
        success: false,
        error: msg || 'REORG_SWEEP_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status }
    );
  }
}
