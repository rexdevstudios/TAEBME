/**
 * app/api/admin/ops-summary/route.ts
 *
 * Read-Only Operational Health & 24h Telemetry Summary Endpoint (Phase AP).
 * - Strictly restricted to SUPER_ADMIN, SYSTEM_ADMIN, RISK_ADMIN, BILLING_ADMIN.
 * - Zero PII, zero secrets, zero mutations.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { getDbPool, defaultKillSwitchDbAdapter } from '@packages/shared/db-pool';
import { upstashRedis } from '@packages/shared/redis-client';
import { listActiveAutoPilotWallets } from '@packages/agent/autopilot-market-feed';
import type { Role } from '@packages/shared/types/domain';

export const dynamic = 'force-dynamic';

const ADMIN_OPS_ROLES = new Set<Role>([
  'SUPER_ADMIN',
  'SYSTEM_ADMIN',
  'RISK_ADMIN',
  'BILLING_ADMIN',
]);

export async function GET(req: NextRequest) {
  try {
    let session;
    try {
      session = await requireActiveSession(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        {
          success: false,
          error: { code: isForbidden ? 'FORBIDDEN' : 'UNAUTHORIZED', message: msg },
          timestamp: new Date().toISOString(),
        },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const isAllowed = session.user.roles.some((r) => ADMIN_OPS_ROLES.has(r));
    if (!isAllowed) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: `RBAC_FORBIDDEN: Roles [${session.user.roles.join(', ')}] cannot access admin ops summary.`,
          },
          timestamp: new Date().toISOString(),
        },
        { status: 403 }
      );
    }

    const pool = getDbPool();
    let dbConnected = false;
    const tradeIntents24h = { total: 0, approved: 0, rejected: 0, executed: 0 };
    const subscriptionsByPlan: Record<string, number> = {};

    const [activeKillSwitches, activeAutoPilotWallets, lastPulseRaw] = await Promise.all([
      defaultKillSwitchDbAdapter.getActiveKillSwitches().catch(() => []),
      listActiveAutoPilotWallets().catch(() => []),
      upstashRedis.isConfigured()
        ? upstashRedis.get<string>('agent:autopilot:last_tick').catch(() => null)
        : Promise.resolve(null),
    ]);

    let lastPulseAt: string | null = null;
    if (lastPulseRaw) {
      try {
        const parsed = typeof lastPulseRaw === 'string' ? JSON.parse(lastPulseRaw) : lastPulseRaw;
        if (parsed?.updatedAt) lastPulseAt = String(parsed.updatedAt);
      } catch {
        // ignore malformed cache
      }
    }

    if (pool) {
      try {
        await pool.query('SELECT 1');
        dbConnected = true;

        const [intentsRes, subsRes] = await Promise.all([
          pool.query(
            `SELECT status, COUNT(*)::int AS cnt
             FROM trade_intents
             WHERE created_at >= NOW() - INTERVAL '24 hours'
             GROUP BY status`
          ),
          pool.query(
            `SELECT plan_id, COUNT(*)::int AS cnt
             FROM subscriptions
             WHERE status = 'ACTIVE'
             GROUP BY plan_id`
          ),
        ]);

        for (const row of intentsRes.rows) {
          const st = String(row.status || '').toUpperCase();
          const cnt = Number(row.cnt || 0);
          tradeIntents24h.total += cnt;
          if (st === 'APPROVED') tradeIntents24h.approved += cnt;
          else if (st === 'REJECTED') tradeIntents24h.rejected += cnt;
          else if (st === 'EXECUTED') tradeIntents24h.executed += cnt;
        }

        for (const row of subsRes.rows) {
          const pid = String(row.plan_id || 'FREE').toUpperCase();
          subscriptionsByPlan[pid] = Number(row.cnt || 0);
        }
      } catch (err: unknown) {
        console.warn('[GET /api/admin/ops-summary] DB telemetry partial error:', err instanceof Error ? err.message : err);
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          database: { connected: dbConnected },
          redis: { configured: upstashRedis.isConfigured() },
          killSwitches: {
            activeCount: activeKillSwitches.length,
            scopes: activeKillSwitches.map((k: any) => String(k.scope || 'UNKNOWN')),
          },
          tradeIntents24h,
          subscriptionsByPlan,
          autoPilot: {
            activeWalletsCount: activeAutoPilotWallets.length,
            lastPulseAt,
          },
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'OPS_SUMMARY_FAILED',
          message: err instanceof Error ? err.message : 'Failed to gather ops summary',
        },
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
