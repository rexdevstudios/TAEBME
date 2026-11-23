/**
 * app/api/cron/autopilot-tick/route.ts
 *
 * Vercel-Native Stateless Auto-Pilot Multi-Tenant Sweep Endpoint (Phase BO).
 * - Strictly authorized via Authorization: Bearer <CRON_SECRET> (min 16 chars, fail-closed 401).
 * - Designed to be triggered every 5 minutes by our free Cloudflare Worker Cron (every 5m).
 * - Zero persistent loops, zero WebSockets, zero private keys (`AGENTS.md` Rule 1 & Rule 3).
 * - Enforces live tier re-validation (TRADER/AGENT), Global Kill-Switch, and 15m idempotency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { upstashRedis } from '@packages/shared/redis-client';
import type { AutoPilotMarketSignal } from '@packages/agent/autopilot-cycle-runner';
import { runMultiTenantAutoPilotSweep } from '@packages/agent/autopilot-sweep';

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
    const marketSignals: AutoPilotMarketSignal[] = [];

    if (upstashRedis.isConfigured()) {
      const rawScout = await upstashRedis.get<string>('agent:scout:dataset').catch(() => null);
      if (rawScout) {
        try {
          const parsed = typeof rawScout === 'string' ? JSON.parse(rawScout) : rawScout;
          if (Array.isArray(parsed?.hints)) {
            for (const hint of parsed.hints.slice(0, 6)) {
              if (hint?.symbol) {
                marketSignals.push({
                  symbol: String(hint.symbol).trim().toUpperCase(),
                  confidenceScore: 78,
                  suggestedOrderUsd: 100,
                  source: 'SCOUT_DEXSCREENER',
                });
              }
            }
          }
        } catch {
          // Non-fatal malformed scout cache
        }
      }
    }

    const sweep = await runMultiTenantAutoPilotSweep({
      dryRun,
      stage: dryRun ? 'PAPER' : 'TESTNET',
      marketSignals,
    });

    const nowIso = new Date().toISOString();
    const elapsedMs = Math.round(performance.now() - startMs);
    if (upstashRedis.isConfigured()) {
      await upstashRedis
        .set(
          'agent:autopilot:last_tick',
          JSON.stringify({
            updatedAt: nowIso,
            scannedWallets: sweep.scannedWallets,
            executedWallets: sweep.executedWallets,
            totalQueued: sweep.totalQueued,
            scoutSignalsLoaded: marketSignals.length,
            dryRun,
            elapsedMs,
          }),
          86400
        )
        .catch(() => false);
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          ...sweep,
          dryRun,
          scoutSignalsLoaded: marketSignals.length,
          elapsedMs,
        },
        timestamp: nowIso,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'AUTOPILOT_CRON_TICK_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
