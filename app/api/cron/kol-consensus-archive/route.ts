/**
 * app/api/cron/kol-consensus-archive/route.ts
 *
 * Vercel-Native Stateless Scheduled AI Consensus Dataset Archive Cron (Phase DX).
 * - Strictly authorized via Authorization: Bearer <CRON_SECRET> (min 16 chars, fail-closed 401).
 * - Reuses loadVerifiedKolSignalsForSymbol(), computeAntiManipulationKolConsensus(),
 *   buildCuratedKolDatasetSnapshot(), and fetchPublicSpotPricesForSymbols().
 * - Persists time-series snapshot + reference spot prices to `scraped_documents`
 *   (domain = 'kol_consensus_archive', zero schema migration).
 * - Supports ?dryRun=1 to preview the archive payload without writing to PostgreSQL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbPool } from '@packages/shared/db-pool';
import { TOP_LIQUID_CEX_PAIRS } from '@packages/shared/market-pairs';
import {
  KOL_CONSENSUS_ARCHIVE_DOMAIN,
  buildCuratedKolDatasetSnapshot,
  computeAntiManipulationKolConsensus,
  fetchPublicSpotPricesForSymbols,
  loadVerifiedKolSignalsForSymbol,
  type KolConsensusReport,
} from '@packages/intelligence/kol-chart-overlay';

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
    const pool = getDbPool();
    const symbols = TOP_LIQUID_CEX_PAIRS.map((p) => p.symbol);

    const [reports, spotPrices] = await Promise.all([
      Promise.all(
        symbols.map(async (symbol): Promise<KolConsensusReport> => {
          const signals = await loadVerifiedKolSignalsForSymbol(pool, symbol);
          return computeAntiManipulationKolConsensus({
            tokenSymbol: symbol,
            signals,
            isHoneypot: false,
          });
        })
      ),
      fetchPublicSpotPricesForSymbols(symbols),
    ]);

    const nowIso = new Date().toISOString();
    const snapshot = buildCuratedKolDatasetSnapshot({ reports, generatedAt: nowIso });
    const targetUrl = `kol-consensus://archive/${nowIso}`;

    let persisted = false;
    let archiveId: string | null = null;

    if (!dryRun && pool) {
      const insertRes = await pool.query(
        `INSERT INTO scraped_documents (target_url, domain, extracted_metadata, scraped_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         RETURNING id`,
        [
          targetUrl,
          KOL_CONSENSUS_ARCHIVE_DOMAIN,
          JSON.stringify({ snapshot, spotPrices }),
        ]
      );
      if (insertRes.rows.length > 0) {
        persisted = true;
        archiveId = String(insertRes.rows[0].id);
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          dryRun,
          persisted,
          archiveId,
          targetUrl,
          totalSymbols: snapshot.totalSymbols,
          activeConsensusSymbols: snapshot.activeConsensusSymbols,
          spotPricesCaptured: Object.keys(spotPrices).length,
          guardrailsVersion: snapshot.guardrailsVersion,
          elapsedMs: Math.round(performance.now() - startMs),
        },
        timestamp: nowIso,
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
