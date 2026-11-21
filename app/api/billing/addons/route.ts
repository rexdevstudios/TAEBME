/**
 * app/api/billing/addons/route.ts
 *
 * Permanent Capacity Add-On Store Endpoint (Reuses `ledger_entries`, Zero New Tables).
 * - GET: returns catalog + authenticated user's permanent extra slots & effective vault capacities.
 * - POST: purchases a permanent slot add-on (`ADDON_BANKR_SLOTS` or `ADDON_BINANCE_SLOTS`) using Credits.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import {
  CAPACITY_ADDON_CATALOG,
  computeEffectiveVaultCapacity,
  type CapacityAddonType,
} from '@packages/billing/subscriptions-engine';

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

    const [planId, addonSlots, creditBalance] = await Promise.all([
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
      defaultBillingDbAdapter.getUserAddonSlots(auth.walletAddress).catch(() => ({ bankrExtraSlots: 0, binanceExtraSlots: 0 })),
      defaultBillingDbAdapter.getUserCreditBalance(auth.walletAddress).catch(() => 0),
    ]);

    const effectiveCapacity = computeEffectiveVaultCapacity(planId, addonSlots);

    return NextResponse.json(
      {
        success: true,
        data: {
          catalog: Object.values(CAPACITY_ADDON_CATALOG),
          planId: effectiveCapacity.planId,
          creditBalance,
          addonSlots,
          effectiveCapacity,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'ADDON_READ_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:billing:addon:${ip}`, 10, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Add-on purchase rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

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

    const body = await req.json().catch(() => ({}));
    const addonType = (typeof body?.addonType === 'string' ? body.addonType.trim().toUpperCase() : '') as CapacityAddonType;
    if (!(addonType in CAPACITY_ADDON_CATALOG)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_ADDON_TYPE: Choose ADDON_BANKR_SLOTS or ADDON_BINANCE_SLOTS', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const receipt = await defaultBillingDbAdapter.purchaseCapacityAddon(auth.walletAddress, addonType);
    const planId = await defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const);
    const effectiveCapacity = computeEffectiveVaultCapacity(planId, receipt.totalAddonSlots);

    return NextResponse.json(
      {
        success: true,
        data: {
          ...receipt,
          effectiveCapacity,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'ADDON_PURCHASE_ERROR';
    const isInsufficient = msg.includes('BILLING_INSUFFICIENT_CREDITS');
    return NextResponse.json(
      { success: false, error: msg, timestamp: new Date().toISOString() },
      { status: isInsufficient ? 402 : 500 }
    );
  }
}
