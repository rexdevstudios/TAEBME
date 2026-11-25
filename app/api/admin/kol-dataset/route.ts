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
  buildCuratedKolDatasetSnapshot,
  computeAntiManipulationKolConsensus,
  loadVerifiedKolSignalsForSymbol,
  serializeKolConsensusDatasetToCsv,
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

    return NextResponse.json(
      {
        success: true,
        data: snapshot,
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
