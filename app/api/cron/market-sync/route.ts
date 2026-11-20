/**
 * app/api/cron/market-sync/route.ts
 *
 * Vercel-Native Stateless Market Snapshot Sync Cron (Batch V3).
 * Replaces legacy dexscreener-fasttrack-poller loop in src/.
 * - Strictly authorized via Authorization: Bearer <CRON_SECRET> (min 16 chars, fail-closed).
 * - Fetches active launchpad tokens from Neon SSOT, queries public DexScreener REST API,
 *   and caches the summary in Upstash Redis (graceful fallback if unconfigured).
 */

import { NextRequest, NextResponse } from 'next/server';
import { defaultDraftDbAdapter } from '@packages/shared/db-pool';
import { upstashRedis } from '@packages/shared/redis-client';

export const dynamic = 'force-dynamic';

function isCronAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret || cronSecret.length < 16) return false;
  const authHeader = req.headers.get('authorization');
  return Boolean(authHeader && authHeader === `Bearer ${cronSecret}`);
}

export async function GET(req: NextRequest) {
  const startMs = performance.now();

  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { success: false, error: 'UNAUTHORIZED: Valid Authorization: Bearer <CRON_SECRET> header is required', timestamp: new Date().toISOString() },
      { status: 401 }
    );
  }

  try {
    const launches = await defaultDraftDbAdapter.getActiveTokenLaunches();
    const addresses = launches
      .map((t: any) => String(t.contractAddress || '').trim())
      .filter((addr: string) => /^0x[a-fA-F0-9]{40}$/.test(addr))
      .slice(0, 10);

    let pairsFound = 0;
    const snapshots: Array<{ address: string; priceUsd?: string; liquidityUsd?: number; volume24h?: number }> = [];

    if (addresses.length > 0) {
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${addresses.join(',')}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (res.ok) {
          const json = (await res.json()) as { pairs?: any[] };
          const pairs = Array.isArray(json.pairs) ? json.pairs : [];
          pairsFound = pairs.length;
          for (const p of pairs.slice(0, 20)) {
            snapshots.push({
              address: p?.baseToken?.address || '',
              priceUsd: p?.priceUsd,
              liquidityUsd: p?.liquidity?.usd,
              volume24h: p?.volume?.h24,
            });
          }
        }
      } catch {
        // Non-fatal external market API fallback
      }
    }

    let cachedInRedis = false;
    if (upstashRedis.isConfigured()) {
      cachedInRedis = await upstashRedis.set(
        'market:dexscreener:snapshot',
        JSON.stringify({ updatedAt: new Date().toISOString(), count: snapshots.length, snapshots }),
        300
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        activeTokensChecked: addresses.length,
        pairsFound,
        cachedInRedis,
        elapsedMs: Math.round(performance.now() - startMs),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg || 'MARKET_SYNC_FAILED', timestamp: new Date().toISOString() },
      { status: msg.startsWith('DATABASE_UNAVAILABLE') ? 503 : 500 }
    );
  }
}
