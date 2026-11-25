/**
 * app/api/cron/reconcile-orders/route.ts
 *
 * Vercel-Native Stateless Order Reconciliation Cron (Batch V2).
 * - Strictly authorized via Authorization: Bearer <CRON_SECRET> (min 16 chars, fail-closed).
 * - Zero while(true) loops, zero WebSockets, zero private keys.
 * - Flags stale EXECUTING trade intents (> 5 min) in PostgreSQL SSOT for safe reconciliation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbPool, PostgresBinanceExecutionDbAdapter } from '@packages/shared/db-pool';
import { runSafeDataRetentionSweep } from '@packages/db/data-retention';

export const dynamic = 'force-dynamic';

import { isCronAuthorized } from '@packages/auth/cron-auth';

const DEFAULT_STALE_MS = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const startMs = performance.now();

  if (!isCronAuthorized(req)) {
    return NextResponse.json(
      { success: false, error: 'UNAUTHORIZED: Valid Authorization: Bearer <CRON_SECRET> header is required', timestamp: new Date().toISOString() },
      { status: 401 }
    );
  }

  try {
    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json(
        { success: false, error: 'DATABASE_UNAVAILABLE: PostgreSQL pool not initialised', timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }

    const adapter = new PostgresBinanceExecutionDbAdapter(pool);
    const staleIntents = await adapter.getStaleExecutingIntents(DEFAULT_STALE_MS);
    const flagged: string[] = [];

    for (const intent of staleIntents) {
      await adapter.updateIntentStatus(intent.id, 'RECONCILIATION_REQUIRED');
      await adapter.createAuditLog(
        'VERCEL_CRON_RECONCILER',
        'STALE_EXECUTING_INTENT_FLAGGED',
        intent.id,
        `Flagged stale EXECUTING intent (> ${DEFAULT_STALE_MS}ms) for reconciliation`
      );
      flagged.push(intent.id);
    }

    const retention = await runSafeDataRetentionSweep({ pool });

    return NextResponse.json({
      success: true,
      data: {
        scannedStaleCount: staleIntents.length,
        flaggedIntentIds: flagged,
        retentionDeleted: retention.deleted,
        elapsedMs: Math.round(performance.now() - startMs),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg || 'RECONCILE_ORDERS_FAILED', timestamp: new Date().toISOString() },
      { status: msg.startsWith('DATABASE_UNAVAILABLE') ? 503 : 500 }
    );
  }
}
