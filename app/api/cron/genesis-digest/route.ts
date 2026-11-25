/**
 * app/api/cron/genesis-digest/route.ts
 *
 * Vercel-Native Stateless Weekly Genesis Referral & Prop Cup Digest Cron (Phase DN).
 * - Strictly authorized via Authorization: Bearer <CRON_SECRET> (min 16 chars, fail-closed 401).
 * - Reuses dispatchOutboundAlert() (SSRF-safe, auto-detects Telegram Bot API / Discord / HTTPS).
 * - Supports ?dryRun=1 to preview the formatted digest without external network dispatch.
 */

import { NextRequest, NextResponse } from 'next/server';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import {
  GENESIS_SBT_SUPPLY_CAP,
  formatWeeklyGenesisDigestMessage,
} from '@packages/billing/genesis-sbt';
import {
  dispatchOutboundAlert,
  resolvePublicTelegramDigestUrl,
} from '@packages/notifications/webhook-dispatcher';

import { isCronAuthorized } from '@packages/auth/cron-auth';

export const dynamic = 'force-dynamic';

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
    const [genesisState, propState] = await Promise.all([
      defaultBillingDbAdapter.getGenesisSbtState(),
      defaultBillingDbAdapter.getPropChallengeState(),
    ]);

    const digestMessage = formatWeeklyGenesisDigestMessage({
      totalMinted: genesisState.totalMinted,
      supplyCap: GENESIS_SBT_SUPPLY_CAP,
      leaderboard: genesisState.leaderboard,
      verifiedPropTraders: propState.verifiedTradersCount,
      siteOrigin: process.env.NEXT_PUBLIC_APP_URL || 'https://pndigi.site',
    });

    const targetUrl = resolvePublicTelegramDigestUrl();
    if (dryRun || !targetUrl) {
      return NextResponse.json(
        {
          success: true,
          data: {
            dryRun,
            dispatched: false,
            reason: dryRun ? 'DRY_RUN' : 'DIGEST_TARGET_NOT_CONFIGURED',
            totalMinted: genesisState.totalMinted,
            verifiedPropTraders: propState.verifiedTradersCount,
            preview: digestMessage,
            elapsedMs: Math.round(performance.now() - startMs),
          },
          timestamp: new Date().toISOString(),
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const dispatchRes = await dispatchOutboundAlert({
      webhookUrl: targetUrl,
      payload: {
        event: 'GENESIS_WEEKLY_DIGEST',
        title: 'POOLNET Weekly Genesis Sprint Digest',
        message: digestMessage,
        metadata: {
          minted: genesisState.totalMinted,
          cap: GENESIS_SBT_SUPPLY_CAP,
          verifiedPropTraders: propState.verifiedTradersCount,
        },
      },
    });

    return NextResponse.json(
      {
        success: dispatchRes.delivered,
        data: {
          dryRun: false,
          dispatched: dispatchRes.delivered,
          httpStatus: dispatchRes.statusCode,
          error: dispatchRes.delivered ? undefined : dispatchRes.error,
          totalMinted: genesisState.totalMinted,
          verifiedPropTraders: propState.verifiedTradersCount,
          elapsedMs: Math.round(performance.now() - startMs),
        },
        timestamp: new Date().toISOString(),
      },
      { status: dispatchRes.delivered ? 200 : 502, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        success: false,
        error: msg || 'GENESIS_DIGEST_CRON_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
