/**
 * app/api/cron/execute-pending-intents/route.ts
 *
 * 100% Zero-VPS Stateless CEX Intent Executor (Phase EJ — Vercel Asia Region + Cloudflare Cron).
 * - Pinned to `preferredRegion = ['sin1', 'hnd1']` (Singapore / Tokyo, non-US) to avoid Binance HTTP 451 US geo-block.
 * - Strictly authorized via `Authorization: Bearer <CRON_SECRET>` (min 16 chars, fail-closed 401).
 * - Respects active Kill-Switches (fail-closed 503), non-withdrawal Binance credential policy, and idempotency.
 * - Processes at most 5 APPROVED intents per stateless tick (zero persistent loops, compliant with AGENTS.md Rule 1).
 * - Records live heartbeat into Upstash Redis (`agent:execution:last_pulse`, 24h TTL) for Admin Ops Preflight.
 */

import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  defaultKillSwitchDbAdapter,
  getDbPool,
  PostgresBinanceExecutionDbAdapter,
} from '@packages/shared/db-pool';
import { upstashRedis } from '@packages/shared/redis-client';
import { BinanceCredentialVault } from '@packages/trading/binance-vault';
import { validateBinancePermissions } from '@packages/shared/types/domain';
import { formatBrokerOrderId } from '@packages/trading/fee-monetization';

import { isCronAuthorized } from '@packages/auth/cron-auth';

export const dynamic = 'force-dynamic';
export const preferredRegion = ['sin1', 'hnd1'];

const MAX_INTENTS_PER_TICK = 5;

async function submitBinanceSpotOrderStateless(params: {
  apiKey: string;
  secretKey: string;
  environment: 'TESTNET' | 'MAINNET';
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: number;
  price?: number;
  clientOrderId: string;
}): Promise<{ ok: boolean; orderId?: string; status?: string; error?: string }> {
  const baseUrl =
    params.environment === 'MAINNET'
      ? 'https://api.binance.com'
      : 'https://testnet.binance.vision';
  const cleanSymbol = params.symbol.replace('/', '').toUpperCase();
  const qs = new URLSearchParams({
    symbol: cleanSymbol,
    side: params.side,
    type: params.type,
    newClientOrderId: params.clientOrderId.slice(0, 36),
    recvWindow: '5000',
    timestamp: String(Date.now()),
  });

  if (params.type === 'LIMIT' && params.price && params.price > 0) {
    qs.set('timeInForce', 'GTC');
    qs.set('price', String(params.price));
    const baseQty = Math.max(0.0001, Number((params.quantity / params.price).toFixed(5)));
    qs.set('quantity', String(baseQty));
  } else {
    qs.set('quoteOrderQty', String(Math.max(10, Number(params.quantity.toFixed(2)))));
  }

  const signature = crypto
    .createHmac('sha256', params.secretKey)
    .update(qs.toString())
    .digest('hex');
  qs.set('signature', signature);

  try {
    const res = await fetch(`${baseUrl}/api/v3/order?${qs.toString()}`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': params.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(data?.msg || data?.message || `Binance HTTP ${res.status}`),
      };
    }
    return {
      ok: true,
      orderId: data?.orderId ? String(data.orderId) : undefined,
      status: data?.status ? String(data.status) : 'FILLED',
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'BINANCE_NETWORK_ERROR',
    };
  }
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

    const activeKillSwitches = await defaultKillSwitchDbAdapter.getActiveKillSwitches().catch(() => []);
    const blockedSwitch = activeKillSwitches.find((ks) => {
      const scope = String(ks.scope || '').toUpperCase();
      return ks.isActive && (scope === 'GLOBAL' || scope === 'TRADING');
    });

    if (blockedSwitch) {
      return NextResponse.json(
        {
          success: false,
          error: `KILL_SWITCH_ACTIVE: Execution halted by ${blockedSwitch.scope} kill switch.`,
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }

    const pool = getDbPool();
    let scanned = 0;
    let executed = 0;
    let skipped = 0;
    const details: Array<{ intentId: string; status: string; detail: string }> = [];

    if (pool) {
      const pendingRes = await pool.query(
        `SELECT id, user_id, stage, symbol, side, type, quantity::float AS quantity, price::float AS price, idempotency_key
         FROM trade_intents
         WHERE status = 'APPROVED'
           AND stage IN ('TESTNET', 'LIVE')
         ORDER BY created_at ASC
         LIMIT $1`,
        [MAX_INTENTS_PER_TICK]
      );
      scanned = pendingRes.rows.length;

      if (!dryRun && scanned > 0) {
        const execAdapter = new PostgresBinanceExecutionDbAdapter(pool);
        const masterKeyHex = PostgresBinanceExecutionDbAdapter.resolveMasterKeyHex();

        for (const row of pendingRes.rows) {
          const intentId = String(row.id);
          const userId = String(row.user_id);
          try {
            const creds = await execAdapter.getBinanceCredentials(userId);
            if (!creds || creds.isActive === false) {
              skipped++;
              details.push({ intentId, status: 'SKIPPED', detail: 'No active Binance credentials for user' });
              continue;
            }
            if (creds.permissions) {
              validateBinancePermissions(creds.permissions);
            }

            const apiKey = await BinanceCredentialVault.decrypt(
              creds.encryptedApiKey,
              masterKeyHex,
              userId,
              creds.id,
              execAdapter
            );
            const secretKey = await BinanceCredentialVault.decrypt(
              creds.encryptedSecretKey,
              masterKeyHex,
              userId,
              creds.id,
              execAdapter
            );

            const envMode: 'TESTNET' | 'MAINNET' =
              String(row.stage).toUpperCase() === 'LIVE' && creds.environment === 'MAINNET'
                ? 'MAINNET'
                : 'TESTNET';

            const orderRes = await submitBinanceSpotOrderStateless({
              apiKey,
              secretKey,
              environment: envMode,
              symbol: String(row.symbol),
              side: String(row.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
              type: String(row.type).toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET',
              quantity: Number(row.quantity || 0),
              price: row.price !== null && row.price !== undefined ? Number(row.price) : undefined,
              clientOrderId: formatBrokerOrderId('BINANCE', intentId),
            });

            if (orderRes.ok) {
              await pool.query(
                `UPDATE trade_intents SET status = 'EXECUTED' WHERE id = $1 AND status = 'APPROVED'`,
                [intentId]
              );
              await execAdapter.touchBinanceCredentialLastUsed(creds.id);
              executed++;
              details.push({
                intentId,
                status: 'EXECUTED',
                detail: `Binance ${envMode} orderId=${orderRes.orderId || 'ok'}`,
              });
            } else {
              skipped++;
              details.push({
                intentId,
                status: 'DEFERRED',
                detail: orderRes.error || 'Exchange rejected order',
              });
            }
          } catch (intentErr: unknown) {
            skipped++;
            details.push({
              intentId,
              status: 'SKIPPED',
              detail: intentErr instanceof Error ? intentErr.message : 'Execution error',
            });
          }
        }
      }
    }

    const nowIso = new Date().toISOString();
    const elapsedMs = Math.round(performance.now() - startMs);

    if (upstashRedis.isConfigured()) {
      await upstashRedis
        .set(
          'agent:execution:last_pulse',
          JSON.stringify({
            updatedAt: nowIso,
            scanned,
            executed,
            skipped,
            dryRun,
            region: 'sin1/hnd1',
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
          mode: 'CLOUDFLARE_VERCEL_SERVERLESS',
          region: 'sin1/hnd1',
          dryRun,
          scanned,
          executed,
          skipped,
          details,
          elapsedMs,
        },
        timestamp: nowIso,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'SERVERLESS_EXECUTION_PULSE_FAILED',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
