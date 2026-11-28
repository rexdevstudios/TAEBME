/**
 * app/api/cron/chain-events-sync/route.ts
 *
 * Vercel-Native Stateless Incremental On-Chain Event Mirror Cron (Phase FN).
 * - Strictly fail-closed via `Authorization: Bearer <CRON_SECRET>` (`isCronAuthorized`).
 * - 100% read-only on-chain `eth_getLogs` using Phase FM Multi-RPC `fallback()`.
 * - Mirrors `TokenCreated`, `TokenPurchased`, and `TokenGraduated` into Neon PostgreSQL
 *   (`chain_events` + `token_launches`) with deterministic UUID `ON CONFLICT` idempotency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCronAuthorized } from '@packages/auth/cron-auth';
import { defaultBillingDbAdapter, getDbPool } from '@packages/shared/db-pool';
import { getAppEnvironment } from '@packages/shared/env-config';
import { getEvmPublicClient } from '@packages/launchpad/evm-verifier';
import {
  applyMirroredEventsToPostgres,
  computeIncrementalBlockWindow,
  decodeLaunchpadEventLog,
  type MirroredLaunchpadEvent,
} from '@packages/launchpad/chain-event-mirror';

export const dynamic = 'force-dynamic';

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
    const defaultNet = getAppEnvironment() === 'testnet' ? 'base-sepolia' : 'base-mainnet';
    const networkId = (searchParams.get('networkId') || defaultNet).trim().toLowerCase();
    const overrideContract = (searchParams.get('contractAddress') || '').trim();

    const platformCfg = await defaultBillingDbAdapter.getPlatformFeeAndRiskConfig().catch(() => null);
    const launchpadContract =
      /^0x[a-fA-F0-9]{40}$/.test(overrideContract)
        ? overrideContract
        : platformCfg?.launchpadContractAddress && /^0x[a-fA-F0-9]{40}$/.test(platformCfg.launchpadContractAddress)
          ? platformCfg.launchpadContractAddress
          : null;

    if (!launchpadContract) {
      return NextResponse.json(
        {
          success: true,
          data: {
            status: 'SKIPPED_NO_CONTRACT',
            networkId,
            elapsedMs: Math.round(performance.now() - startMs),
          },
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      );
    }

    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json(
        {
          success: false,
          error: 'DATABASE_UNAVAILABLE: PostgreSQL SSOT pool is not connected',
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }

    const client = getEvmPublicClient(networkId);
    if (!client) {
      return NextResponse.json(
        {
          success: false,
          error: `UNSUPPORTED_NETWORK: No EVM RPC client configured for '${networkId}'`,
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    const [cursorRes, latestBlock] = await Promise.all([
      pool.query(
        `SELECT MAX(block_number)::text AS last_block
         FROM chain_events
         WHERE network_id = $1`,
        [networkId]
      ),
      client.getBlockNumber(),
    ]);

    const rawLast = cursorRes.rows[0]?.last_block;
    const lastIndexedBlock = rawLast !== null && rawLast !== undefined ? BigInt(rawLast) : null;

    const window = computeIncrementalBlockWindow({
      lastIndexedBlock,
      latestBlock,
      maxBlockSpan: 2000n,
      finalityLag: 1n,
    });

    if (!window) {
      return NextResponse.json(
        {
          success: true,
          data: {
            status: 'CAUGHT_UP',
            networkId,
            launchpadContract,
            latestBlock: latestBlock.toString(),
            lastIndexedBlock: lastIndexedBlock?.toString() ?? null,
            logsScanned: 0,
            eventsInserted: 0,
            launchesUpdated: 0,
            elapsedMs: Math.round(performance.now() - startMs),
          },
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      );
    }

    const rawLogs = await client.getLogs({
      address: launchpadContract as `0x${string}`,
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
    });

    const decodedEvents: MirroredLaunchpadEvent[] = [];
    for (const log of rawLogs) {
      const rawTopics = Array.isArray((log as any).topics) ? ((log as any).topics as readonly `0x${string}`[]) : [];
      const parsed = decodeLaunchpadEventLog({
        address: log.address,
        data: log.data,
        topics: rawTopics,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      });
      if (parsed) decodedEvents.push(parsed);
    }

    const applied = await applyMirroredEventsToPostgres(pool, networkId, decodedEvents);

    return NextResponse.json(
      {
        success: true,
        data: {
          status: 'SYNCED',
          networkId,
          launchpadContract,
          fromBlock: window.fromBlock.toString(),
          toBlock: window.toBlock.toString(),
          latestBlock: latestBlock.toString(),
          logsScanned: rawLogs.length,
          eventsDecoded: decodedEvents.length,
          eventsInserted: applied.eventsInserted,
          launchesUpdated: applied.launchesUpdated,
          elapsedMs: Math.round(performance.now() - startMs),
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'CHAIN_EVENTS_SYNC_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
