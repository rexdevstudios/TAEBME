/**
 * app/api/cron/agent-scout-sync/route.ts
 *
 * Vercel-Native Stateless Automated Scout Dataset Cron (Phase AS).
 * - Strictly authorized via Authorization: Bearer <CRON_SECRET> (min 16 chars, fail-closed).
 * - Fetches public Base trending/boosted tokens from DexScreener (+ optional Firecrawl summary
 *   if FIRECRAWL_API_KEY is configured) and caches structured hints in Upstash Redis
 *   under `agent:scout:dataset` (TTL 24h) so `/agent` Scout feed stays fresh with ZERO user credit burn.
 */

import { NextRequest, NextResponse } from 'next/server';
import { upstashRedis } from '@packages/shared/redis-client';
import { mapDexScreenerBoostRowsToScoutHints } from '@packages/agent/autonomous-terminal-engine';
import { fetchBytePlusInfoQuestCatalystHint } from '@packages/intelligence/llm-advisory-client';

import { isCronAuthorized } from '@packages/auth/cron-auth';

export const dynamic = 'force-dynamic';

export interface ScoutDatasetHint {
  symbol: string;
  note: string;
  tokenAddress?: string;
  chainId?: number;
  updatedAt: string;
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
    const nowIso = new Date().toISOString();
    const hints: ScoutDatasetHint[] = [];

    try {
      const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const rows = (await res.json()) as unknown[];
        const mapped = mapDexScreenerBoostRowsToScoutHints(rows, nowIso, 6);
        hints.push(...mapped);
      }
    } catch {
      // Non-fatal external discovery fallback
    }

    const infoQuestCatalyst = await fetchBytePlusInfoQuestCatalystHint(
      'Top Base L2 and Bitcoin spot crypto market catalyst in the last 24 hours'
    ).catch(() => null);
    if (infoQuestCatalyst) {
      hints.unshift({
        symbol: 'MACRO',
        note: `InfoQuest MCP: ${infoQuestCatalyst}`,
        updatedAt: nowIso,
      });
    }

    if (hints.length === 0) {
      hints.push({
        symbol: 'USDC',
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        chainId: 8453,
        note: 'Scout Base liquidity baseline active → 0x Swap v2 ready',
        updatedAt: nowIso,
      });
    }

    let cachedInRedis = false;
    if (upstashRedis.isConfigured()) {
      cachedInRedis = await upstashRedis.set(
        'agent:scout:dataset',
        JSON.stringify({ updatedAt: nowIso, hints }),
        86400
      );
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          hintsCollected: hints.length,
          cachedInRedis,
          elapsedMs: Math.round(performance.now() - startMs),
        },
        timestamp: nowIso,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'AGENT_SCOUT_SYNC_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
