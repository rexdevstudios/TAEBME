/**
 * app/api/user/activity/route.ts
 *
 * Read-Only User Security Activity Feed Endpoint.
 * - Requires authenticated SIWE session (`CONNECT_WALLET`).
 * - Strictly scoped to `actor_id = authenticated user` (uses `idx_audit_actor_date`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireCapability(req, 'CONNECT_WALLET');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const limit = Number(searchParams.get('limit') || 10);
    const activities = await defaultBillingDbAdapter.getUserSecurityActivity(auth.walletAddress, limit);

    return NextResponse.json(
      {
        success: true,
        data: { activities },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'ACTIVITY_READ_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
