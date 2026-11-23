/**
 * app/api/agent/terminal-telemetry/route.ts
 *
 * Read-Only Autonomous 4-Sub-Agent Terminal Telemetry Endpoint (Phase AR).
 * - Requires authenticated SIWE session (`CONNECT_WALLET`).
 * - Aggregates real PostgreSQL SSOT records (`trade_intents`, `token_launches`, user vaults)
 *   for the Dual-Rail Autonomous Agent Terminal UI in `/agent`.
 * - NEVER returns secrets or private keys.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import {
  getDbPool,
  listUserRecentTradeIntents,
  defaultDraftDbAdapter,
  defaultBillingDbAdapter,
  defaultProviderKeyVaultAdapter,
  PostgresBinanceExecutionDbAdapter,
} from '@packages/shared/db-pool';
import { buildAutonomousTerminalSnapshot } from '@packages/agent/autonomous-terminal-engine';
import { upstashRedis } from '@packages/shared/redis-client';

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
        {
          success: false,
          error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`,
          timestamp: new Date().toISOString(),
        },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const pool = getDbPool();
    const binanceDb = pool ? new PostgresBinanceExecutionDbAdapter(pool) : null;

    const [planId, intents, activeLaunches, bybitKeys, binanceAccounts, cachedScoutRaw] = await Promise.all([
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
      listUserRecentTradeIntents(auth.user.userId, 20).catch(() => []),
      defaultDraftDbAdapter.getActiveTokenLaunches().catch(() => []),
      defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'BYBIT').catch(() => []),
      binanceDb ? binanceDb.listBinanceCredentials(auth.walletAddress).catch(() => []) : Promise.resolve([]),
      upstashRedis.isConfigured() ? upstashRedis.get<string>('agent:scout:dataset').catch(() => null) : Promise.resolve(null),
    ]);

    let firecrawlHints:
      | Array<{ symbol: string; note: string; tokenAddress?: string; chainId?: number }>
      | undefined;
    let scoutDatasetSyncedAt: string | null = null;
    if (cachedScoutRaw) {
      try {
        const parsed = typeof cachedScoutRaw === 'string' ? JSON.parse(cachedScoutRaw) : cachedScoutRaw;
        if (Array.isArray(parsed?.hints) && parsed.hints.length > 0) {
          firecrawlHints = parsed.hints;
        }
        if (typeof parsed?.updatedAt === 'string' && parsed.updatedAt.trim()) {
          scoutDatasetSyncedAt = parsed.updatedAt.trim();
        }
      } catch {
        // Ignore malformed cache
      }
    }

    const hasZeroXApiKey = Boolean(
      process.env.ZEROX_API_KEY && !process.env.ZEROX_API_KEY.startsWith('mock_')
    );
    const hasFirecrawlApiKey = Boolean(
      process.env.FIRECRAWL_API_KEY && !process.env.FIRECRAWL_API_KEY.startsWith('mock_')
    );

    const snapshot = buildAutonomousTerminalSnapshot({
      planId,
      intents,
      activeLaunches,
      hasActiveCexKey: binanceAccounts.length > 0 || bybitKeys.length > 0,
      hasZeroXApiKey,
      hasFirecrawlApiKey,
      firecrawlHints,
      scoutDatasetSyncedAt,
    });

    return NextResponse.json(
      {
        success: true,
        data: snapshot,
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'TERMINAL_TELEMETRY_ERROR',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
