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
import { getBytePlusEngineTelemetry } from '@packages/intelligence/llm-advisory-client';
import {
  EXECUTION_PLANE_LOCK_KEYS,
  evaluateOpsPreflightChecklist,
  isServerlessPulseFresh,
} from '@packages/shared/ops-preflight';
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
    const executionPlane = {
      workerOnline: false,
      mode: 'STANDBY' as 'CLOUDFLARE_CRON' | 'VPS_WORKER' | 'STANDBY',
      pendingExecutionCount: 0,
      lastExecutedAt: null as string | null,
      lastPulseAt: null as string | null,
    };

    const [activeKillSwitches, activeAutoPilotWallets, lastPulseRaw, execPulseRaw] = await Promise.all([
      defaultKillSwitchDbAdapter.getActiveKillSwitches().catch(() => []),
      listActiveAutoPilotWallets().catch(() => []),
      upstashRedis.isConfigured()
        ? upstashRedis.get<string>('agent:autopilot:last_tick').catch(() => null)
        : Promise.resolve(null),
      upstashRedis.isConfigured()
        ? upstashRedis.get<string>('agent:execution:last_pulse').catch(() => null)
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

    let execPulseAt: string | null = null;
    if (execPulseRaw) {
      try {
        const parsed = typeof execPulseRaw === 'string' ? JSON.parse(execPulseRaw) : execPulseRaw;
        if (parsed?.updatedAt) execPulseAt = String(parsed.updatedAt);
      } catch {
        // ignore malformed cache
      }
    }
    executionPlane.lastPulseAt = execPulseAt || lastPulseAt;

    if (pool) {
      try {
        await pool.query('SELECT 1');
        dbConnected = true;

        const [intentsRes, subsRes, lockRes, execPlaneRes] = await Promise.all([
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
          pool
            .query(
              `SELECT EXISTS(
                 SELECT 1 FROM pg_locks
                 WHERE locktype = 'advisory'
                   AND classid = $1
                   AND objid = $2
               ) AS held`,
              [EXECUTION_PLANE_LOCK_KEYS.key1, EXECUTION_PLANE_LOCK_KEYS.key2]
            )
            .catch(() => ({ rows: [{ held: false }] })),
          pool
            .query(
              `SELECT
                 COUNT(*) FILTER (WHERE status = 'APPROVED' AND stage IN ('TESTNET', 'LIVE'))::int AS pending_cnt,
                 MAX(created_at) FILTER (WHERE status = 'EXECUTED') AS last_exec_at
               FROM trade_intents`
            )
            .catch(() => ({ rows: [{ pending_cnt: 0, last_exec_at: null }] })),
        ]);

        const advisoryLockHeld = Boolean(lockRes.rows[0]?.held);
        const cfFresh =
          isServerlessPulseFresh(execPulseAt) || isServerlessPulseFresh(lastPulseAt);
        executionPlane.workerOnline = cfFresh || advisoryLockHeld;
        executionPlane.mode = cfFresh
          ? 'CLOUDFLARE_CRON'
          : advisoryLockHeld
            ? 'VPS_WORKER'
            : 'STANDBY';
        executionPlane.pendingExecutionCount = Number(execPlaneRes.rows[0]?.pending_cnt || 0);
        executionPlane.lastExecutedAt = execPlaneRes.rows[0]?.last_exec_at
          ? new Date(execPlaneRes.rows[0].last_exec_at).toISOString()
          : null;

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

    const aiEngine = getBytePlusEngineTelemetry();
    const preflight = evaluateOpsPreflightChecklist({
      dbConnected,
      redisConfigured: upstashRedis.isConfigured(),
      activeKillSwitchesCount: activeKillSwitches.length,
      aiEngine: {
        primaryProvider: aiEngine.primaryProvider,
        byteplusConfigured: aiEngine.configured,
        fastPoolCount: aiEngine.fastPoolSize,
        deepPoolCount: aiEngine.deepPoolSize,
        infoQuestEnabled: aiEngine.infoQuestEnabled,
      },
      executionPlane,
    });

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
          aiEngine,
          executionPlane,
          preflight,
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
