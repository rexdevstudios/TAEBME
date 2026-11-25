/**
 * app/api/admin/kol-dataset/route.ts
 *
 * Admin RBAC Curated Anti-Manipulation KOL Consensus AI Dataset Exporter (Phase DW).
 * - Protected by REVIEW_FLAGGED_TOKEN capability (fail-closed 401/403).
 * - Aggregates Verified KOL signals across TOP_LIQUID_CEX_PAIRS via shared SSOT loader.
 * - Supports ?format=json (structured ML/eval snapshot) and ?format=csv (OWASP formula-safe).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { getDbPool } from '@packages/shared/db-pool';
import { TOP_LIQUID_CEX_PAIRS } from '@packages/shared/market-pairs';
import {
  KOL_CONSENSUS_ARCHIVE_DOMAIN,
  buildCuratedKolDatasetSnapshot,
  computeAntiManipulationKolConsensus,
  evaluateKolConsensusBacktest,
  fetchPublicSpotPricesForSymbols,
  loadVerifiedKolSignalsForSymbol,
  serializeKolConsensusDatasetToCsv,
  type KolBacktestSummary,
  type KolConsensusArchiveEntry,
  type KolConsensusReport,
} from '@packages/intelligence/kol-chart-overlay';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    try {
      await requireCapability(req, 'REVIEW_FLAGGED_TOKEN');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        {
          success: false,
          error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`,
          timestamp: new Date().toISOString(),
        },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const format = (req.nextUrl.searchParams.get('format') || 'json').trim().toLowerCase();
    const pool = getDbPool();

    const reports: KolConsensusReport[] = await Promise.all(
      TOP_LIQUID_CEX_PAIRS.map(async (pair) => {
        const signals = await loadVerifiedKolSignalsForSymbol(pool, pair.symbol);
        return computeAntiManipulationKolConsensus({
          tokenSymbol: pair.symbol,
          signals,
          isHoneypot: false,
        });
      })
    );

    const snapshot = buildCuratedKolDatasetSnapshot({ reports });

    if (format === 'csv') {
      const csv = serializeKolConsensusDatasetToCsv(snapshot);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="poolnet-kol-ai-consensus-dataset.csv"',
          'Cache-Control': 'no-store',
        },
      });
    }

    let backtest: KolBacktestSummary = {
      totalArchives: 0,
      evaluatedSignals: 0,
      wins: 0,
      losses: 0,
      winRatePct: 0,
      avgDirectionalReturnPct: 0,
    };

    if (pool) {
      try {
        const archiveRes = await pool.query(
          `SELECT extracted_metadata, scraped_at
           FROM scraped_documents
           WHERE domain = $1
           ORDER BY scraped_at DESC
           LIMIT 60`,
          [KOL_CONSENSUS_ARCHIVE_DOMAIN]
        );
        if (archiveRes.rows.length > 0) {
          const archives: KolConsensusArchiveEntry[] = archiveRes.rows
            .map((r) => {
              const meta = r.extracted_metadata || {};
              if (!meta?.snapshot) return null;
              return {
                archivedAt: new Date(r.scraped_at).toISOString(),
                snapshot: meta.snapshot,
                spotPrices: meta.spotPrices || {},
              };
            })
            .filter((x): x is KolConsensusArchiveEntry => x !== null);

          const currentSpotPrices = await fetchPublicSpotPricesForSymbols(
            TOP_LIQUID_CEX_PAIRS.map((p) => p.symbol)
          );
          backtest = evaluateKolConsensusBacktest({ archives, currentSpotPrices });
        }
      } catch {
        // Non-blocking telemetry fallback
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          ...snapshot,
          archiveCount: backtest.totalArchives,
          backtest,
        },
        timestamp: new Date().toISOString(),
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        success: false,
        error: err?.message || 'KOL_DATASET_EXPORT_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
