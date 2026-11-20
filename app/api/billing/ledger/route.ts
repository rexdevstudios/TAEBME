/**
 * app/api/billing/ledger/route.ts
 *
 * Vercel-Native Stateless Credit Ledger Statement Endpoint.
 * - Requires authenticated ACTIVE SIWE session (requireActiveSession).
 * - Returns active planId, current credit balance, and recent double-entry ledger_entries.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await requireActiveSession(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const limitParam = Number(req.nextUrl?.searchParams?.get('limit') ?? 25);
    const [planId, balance, entries] = await Promise.all([
      defaultBillingDbAdapter.getUserPlan(session.walletAddress).catch(() => 'FREE'),
      defaultBillingDbAdapter.getUserCreditBalance(session.walletAddress),
      defaultBillingDbAdapter.getUserLedgerEntries(session.walletAddress, limitParam),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        walletAddress: session.walletAddress,
        planId,
        balance,
        entries,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg || 'LEDGER_FETCH_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
