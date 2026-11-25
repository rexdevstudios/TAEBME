/**
 * app/api/agent/marketplace/route.ts
 *
 * Copy-Trading / Auto-Pilot Signal Preset Marketplace Endpoint (Phase DE).
 * - GET: Public (Edge cached 15s), lists published strategy presets & 80/20 split terms.
 * - POST: Authenticated SIWE session:
 *     - action === 'PUBLISH': publishes a risk-gated Auto-Pilot preset to Neon SSOT.
 *     - action === 'SUBSCRIBE': deducts priceCredits from subscriber, credits 80% to creator
 *       and 20% to platform treasury atomically in credit_ledger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { defaultBillingDbAdapter, getDbPool } from '@packages/shared/db-pool';
import {
  MARKETPLACE_CREATOR_SHARE_PCT,
  MARKETPLACE_PLATFORM_FEE_PCT,
  validateSignalPresetInput,
} from '@packages/agent/signal-marketplace';
import {
  enrichMarketplacePresetsWithKolStatus,
  type KolProfileSample,
} from '@packages/intelligence/kol-chart-overlay';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const rawPresets = await defaultBillingDbAdapter.getMarketplacePresets();
    const kolMap = new Map<string, KolProfileSample>();
    const pool = getDbPool();
    if (pool && rawPresets.length > 0) {
      try {
        const wallets = Array.from(
          new Set(rawPresets.map((p) => String(p.creatorWallet || '').trim().toLowerCase()).filter(Boolean))
        );
        if (wallets.length > 0) {
          const res = await pool.query(
            `SELECT LOWER(w.address) AS wallet_address, kp.twitter_handle, kp.trust_score
             FROM wallets w
             JOIN kol_profiles kp ON kp.user_id = w.user_id
             WHERE LOWER(w.address) = ANY($1::text[])`,
            [wallets]
          );
          for (const row of res.rows) {
            kolMap.set(String(row.wallet_address).toLowerCase(), {
              walletAddress: String(row.wallet_address),
              twitterHandle: row.twitter_handle,
              trustScore: Number(row.trust_score ?? 0),
            });
          }
        }
      } catch {
        // Non-blocking enrichment fallback
      }
    }
    const presets = enrichMarketplacePresetsWithKolStatus(rawPresets, kolMap);
    return NextResponse.json(
      {
        success: true,
        data: {
          presets,
          creatorSharePct: MARKETPLACE_CREATOR_SHARE_PCT,
          platformFeePct: MARKETPLACE_PLATFORM_FEE_PCT,
        },
        timestamp: new Date().toISOString(),
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45',
        },
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'MARKETPLACE_LOAD_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
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

    const body = await req.json().catch(() => ({}));
    const action = typeof body?.action === 'string' ? body.action.trim().toUpperCase() : '';

    if (action === 'PUBLISH') {
      const check = validateSignalPresetInput(body);
      if (!check.ok || !check.sanitized) {
        return NextResponse.json(
          { success: false, error: check.error || 'INVALID_PRESET', timestamp: new Date().toISOString() },
          { status: 400 }
        );
      }
      const created = await defaultBillingDbAdapter.publishMarketplacePreset({
        ...check.sanitized,
        creatorWallet: session.walletAddress,
      });
      return NextResponse.json(
        { success: true, data: created, timestamp: new Date().toISOString() },
        { status: 201 }
      );
    }

    if (action === 'SUBSCRIBE') {
      const presetId = typeof body?.presetId === 'string' ? body.presetId.trim() : '';
      if (!presetId) {
        return NextResponse.json(
          { success: false, error: 'MISSING_PRESET_ID: presetId is required', timestamp: new Date().toISOString() },
          { status: 400 }
        );
      }
      const subRes = await defaultBillingDbAdapter.subscribeMarketplacePreset(
        session.walletAddress,
        presetId
      );
      if (!subRes.ok) {
        const status = subRes.error?.includes('INSUFFICIENT_CREDITS')
          ? 402
          : subRes.error?.includes('NOT_FOUND')
            ? 404
            : 400;
        return NextResponse.json(
          { success: false, error: subRes.error || 'SUBSCRIBE_FAILED', timestamp: new Date().toISOString() },
          { status }
        );
      }
      return NextResponse.json(
        { success: true, data: subRes, timestamp: new Date().toISOString() },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { success: false, error: 'INVALID_ACTION: Supported actions are PUBLISH and SUBSCRIBE', timestamp: new Date().toISOString() },
      { status: 400 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'MARKETPLACE_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
