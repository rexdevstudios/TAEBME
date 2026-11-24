/**
 * app/api/admin/genesis-snapshot/route.ts
 *
 * Admin RBAC Post-Genesis Pioneer Snapshot & Merkle Whitelist Exporter (Phase DK).
 * - Strictly protected by MANAGE_BILLING_PLANS capability (fail-closed 401/403).
 * - Supports ?format=json (Merkle-ready whitelist with tier & allocationWeight)
 *   and ?format=csv (formula-injection-safe downloadable spreadsheet).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import {
  GENESIS_SBT_SUPPLY_CAP,
  buildGenesisMerkleWhitelist,
  serializeGenesisSnapshotToCsv,
} from '@packages/billing/genesis-sbt';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    try {
      await requireCapability(req, 'MANAGE_BILLING_PLANS');
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
    const records = await defaultBillingDbAdapter.getAllGenesisSbtRecords();

    if (format === 'csv') {
      const csv = serializeGenesisSnapshotToCsv(records);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="poolnet-genesis-pioneer-snapshot.csv"',
          'Cache-Control': 'no-store',
        },
      });
    }

    const whitelist = buildGenesisMerkleWhitelist(records);
    return NextResponse.json(
      {
        success: true,
        data: {
          totalMinted: records.length,
          supplyCap: GENESIS_SBT_SUPPLY_CAP,
          isSoldOut: records.length >= GENESIS_SBT_SUPPLY_CAP,
          generatedAt: new Date().toISOString(),
          whitelist,
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
        error: err?.message || 'GENESIS_SNAPSHOT_EXPORT_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
