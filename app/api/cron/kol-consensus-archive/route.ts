/**
 * app/api/cron/kol-consensus-archive/route.ts
 *
 * Vercel-Native Stateless Scheduled AI Consensus Dataset Archive Cron (Phase DX / EB).
 * - Strictly authorized via Authorization: Bearer <CRON_SECRET> (min 16 chars, fail-closed 401).
 * - Reuses shared captureAndArchiveKolConsensusSnapshot() SSOT helper (zero SQL duplication).
 * - Supports ?dryRun=1 to preview the archive payload without writing to PostgreSQL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '@packages/shared/db-pool';
import { TOP_LIQUID_CEX_PAIRS } from '@packages/shared/market-pairs';
import { captureAndArchiveKolConsensusSnapshot } from '@packages/intelligence/kol-chart-overlay';

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
      {
        success: false,
        error: 'UNAUTHORIZED: Valid Authorization: Bearer <CRON_SECRET> header is required',
        timestamp: new Date().toISOString(),
      },
      { status: 401 }
    );
  }

  try {
    const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
    const result = await captureAndArchiveKolConsensusSnapshot({
      pool: getDbPool(),
      symbols: TOP_LIQUID_CEX_PAIRS.map((p) => p.symbol),
      dryRun,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          dryRun: result.dryRun,
          persisted: result.persisted,
          archiveId: result.archiveId,
          targetUrl: result.targetUrl,
          totalSymbols: result.snapshot.totalSymbols,
          activeConsensusSymbols: result.snapshot.activeConsensusSymbols,
          spotPricesCaptured: result.spotPricesCaptured,
          guardrailsVersion: result.snapshot.guardrailsVersion,
          elapsedMs: Math.round(performance.now() - startMs),
        },
        timestamp: result.snapshot.generatedAt,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'KOL_CONSENSUS_ARCHIVE_CRON_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
