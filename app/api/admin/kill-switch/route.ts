import { NextRequest, NextResponse } from 'next/server';
import { requireCapability, authenticateSession } from '@packages/auth/session';
import { KillSwitchManager } from '@packages/admin/kill-switch-manager';
import { defaultKillSwitchDbAdapter, defaultDualControlDbAdapter } from '@packages/shared/db-pool';
import { DualControlManager, DualControlRequestRecord } from '@packages/admin/dual-control';
import { UpstashRedisPubSubAdapter } from '@packages/network-registry/redis-pubsub-adapter';
import { upstashRedis } from '@packages/shared/redis-client';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { formatRedisKey } from '@packages/shared/env-config';

export const dynamic = 'force-dynamic';

const pubsub = new UpstashRedisPubSubAdapter(upstashRedis);

export async function GET(req: NextRequest) {
  try {
    const session = await authenticateSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message: 'Valid SIWE session required' } },
        { status: 401 }
      );
    }

    const isAdmin = session.user.roles.some((r) => r === 'SUPER_ADMIN' || r === 'SYSTEM_ADMIN' || r === 'RISK_ADMIN');
    if (!isAdmin) {
      return NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message: 'Admin access required to view kill switches' } },
        { status: 403 }
      );
    }

    const activeSwitches = await defaultKillSwitchDbAdapter.getActiveKillSwitches();
    const isGlobalHalted = activeSwitches.some((ks) => ks.scope === 'GLOBAL' && ks.isActive);

    const response: ApiResponse<{
      isGlobalHalted: boolean;
      activeSwitches: typeof activeSwitches;
    }> = {
      success: true,
      data: {
        isGlobalHalted,
        activeSwitches,
      },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: { code: 'SERVER_ERROR', message: err?.message || 'Failed to get kill switch state' } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    // Requires OVERRIDE_RISK_ENGINE capability (SUPER_ADMIN role)
    const session = await requireCapability(req, 'OVERRIDE_RISK_ENGINE');

    const body = await req.json().catch(() => ({}));
    const { action, scope, targetId, reason, killSwitchId, dualControlRequestId } = body;

    const targetScope = (scope || 'GLOBAL').toUpperCase() as 'GLOBAL' | 'USER' | 'AGENT' | 'TOKEN';
    const cleanReason = reason || 'Admin triggered emergency kill switch';

    // Dual-Control Break-Glass Verification (SOP-07 & DOC-01 §3)
    // Mandatory Strict Dual-Control: No unilateral mutation permitted for any role or action.
    if (!dualControlRequestId || typeof dualControlRequestId !== 'string' || dualControlRequestId.trim().length === 0) {
      throw new Error('DUAL_CONTROL_REQUIRED: Dual-control approval request ID is required for all kill switch mutations');
    }

    // Validate and consume the approved dual-control request atomically
    const dualControlRecord = await DualControlManager.consumeApprovedRequest(
      dualControlRequestId.trim(),
      'OVERRIDE_RISK',
      targetScope,
      session.user.userId,
      defaultDualControlDbAdapter
    );

    if (action === 'DEACTIVATE') {
      const targetIdToDeactivate = killSwitchId || targetScope;

      // 1. Deactivate in PostgreSQL SSOT
      try {
        await defaultKillSwitchDbAdapter.deactivateKillSwitch(targetIdToDeactivate, session.user.userId);
        await defaultKillSwitchDbAdapter.createAuditLog(
          session.user.userId,
          'KILL_SWITCH_DEACTIVATED',
          targetIdToDeactivate,
          `Kill switch deactivated via Dual-Control Approval [Req: ${dualControlRecord.id}, Proposer: ${dualControlRecord.requestedBy}, Approver: ${dualControlRecord.approvedBy}]. Reason: ${cleanReason}`
        );
      } catch (dbErr: any) {
        console.error('[Admin Kill Switch] DB Deactivation error:', dbErr);
        return NextResponse.json(
          { success: false, error: { code: 'DB_FAILURE', message: dbErr?.message || 'Database deactivation failed' } },
          { status: 500 }
        );
      }

      // 2. Propagate to Redis (Notification & Secondary Cache Layer - Non-blocking for PostgreSQL SSOT)
      let notificationStatus: 'DELIVERED' | 'DEGRADED' | 'SKIPPED' = 'SKIPPED';
      let notificationWarning: string | undefined;

      if (upstashRedis.isConfigured()) {
        try {
          const payload = JSON.stringify({
            event: 'KILL_SWITCH_DEACTIVATED',
            killSwitchId: targetIdToDeactivate,
            reason: cleanReason,
            timestamp: new Date().toISOString(),
          });
          await pubsub.publish('kill_switch_triggered_pubsub', payload);
          const setOk = await upstashRedis.set(formatRedisKey(`killswitch:${targetScope.toLowerCase()}`), 'INACTIVE');
          if (!setOk) {
            throw new Error('Redis status key update failed');
          }
          notificationStatus = 'DELIVERED';
        } catch (redisErr: any) {
          const errMsg = redisErr?.message || 'Redis propagation failed';
          console.error('[Admin Kill Switch] Redis propagation error on DEACTIVATE (PostgreSQL SSOT preserved):', redisErr);
          notificationStatus = 'DEGRADED';
          notificationWarning = `Redis notification propagation failed: ${errMsg}. PostgreSQL operational SSOT mutation succeeded.`;

          // Explicit audit log for degraded notification
          try {
            await defaultKillSwitchDbAdapter.createAuditLog(
              session.user.userId,
              'KILL_SWITCH_NOTIFICATION_DEGRADED',
              targetIdToDeactivate,
              `DEACTIVATE notification degraded: ${errMsg}. PostgreSQL SSOT remains DEACTIVATED.`
            );
          } catch (auditErr: any) {
            console.error('[Admin Kill Switch] Failed to write notification degradation audit log:', auditErr);
          }
        }
      }

      const response: ApiResponse<{
        status: 'DEACTIVATED';
        scope: string;
        reason: string;
        dualControlId?: string;
        notificationStatus: 'DELIVERED' | 'DEGRADED' | 'SKIPPED';
        warning?: string;
      }> = {
        success: true,
        data: {
          status: 'DEACTIVATED',
          scope: targetScope,
          reason: cleanReason,
          dualControlId: dualControlRecord.id,
          notificationStatus,
          ...(notificationWarning ? { warning: notificationWarning } : {}),
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 200 });
    }

    // Default action: ACTIVATE
    const activatedAt = new Date().toISOString();
    const recordPayload = {
      scope: targetScope,
      targetId,
      isActive: true,
      reason: cleanReason,
      activatedBy: session.user.userId,
    };

    // 1. Activate in PostgreSQL SSOT
    let id: string;
    try {
      id = await defaultKillSwitchDbAdapter.activateKillSwitch(recordPayload);
      const auditReason = `Emergency kill switch activated via Dual-Control Approval [Req: ${dualControlRecord.id}, Proposer: ${dualControlRecord.requestedBy}, Approver: ${dualControlRecord.approvedBy}]. Reason: ${cleanReason}`;

      await defaultKillSwitchDbAdapter.createAuditLog(
        session.user.userId,
        `KILL_SWITCH_ACTIVATED_${targetScope}`,
        id,
        auditReason
      );
    } catch (dbErr: any) {
      console.error('[Admin Kill Switch] DB Activation error:', dbErr);
      return NextResponse.json(
        { success: false, error: { code: 'DB_FAILURE', message: dbErr?.message || 'Database activation failed' } },
        { status: 500 }
      );
    }

    // 2. Propagate to Redis (Notification & Secondary Cache Layer - Non-blocking for PostgreSQL SSOT)
    let notificationStatus: 'DELIVERED' | 'DEGRADED' | 'SKIPPED' = 'SKIPPED';
    let notificationWarning: string | undefined;

    if (upstashRedis.isConfigured()) {
      try {
        const payload = JSON.stringify({
          event: 'KILL_SWITCH_ACTIVATED',
          scope: targetScope,
          targetId,
          reason: cleanReason,
          id,
          timestamp: activatedAt,
        });
        await pubsub.publish('kill_switch_triggered_pubsub', payload);
        const setOk = await upstashRedis.set(formatRedisKey(`killswitch:${targetScope.toLowerCase()}`), 'ACTIVE');
        if (!setOk) {
          throw new Error('Redis status key update failed');
        }
        notificationStatus = 'DELIVERED';
      } catch (redisErr: any) {
        const errMsg = redisErr?.message || 'Redis propagation failed';
        console.error('[Admin Kill Switch] Redis propagation error on ACTIVATE (PostgreSQL SSOT preserved):', redisErr);
        notificationStatus = 'DEGRADED';
        notificationWarning = `Redis notification propagation failed: ${errMsg}. PostgreSQL operational SSOT mutation succeeded.`;

        // Explicit audit log for degraded notification
        try {
          await defaultKillSwitchDbAdapter.createAuditLog(
            session.user.userId,
            `KILL_SWITCH_NOTIFICATION_DEGRADED_${targetScope}`,
            id,
            `ACTIVATE notification degraded for ${targetScope}: ${errMsg}. PostgreSQL SSOT remains ACTIVE.`
          );
        } catch (auditErr: any) {
          console.error('[Admin Kill Switch] Failed to write notification degradation audit log:', auditErr);
        }
      }
    }

    const response: ApiResponse<{
      id: string;
      activatedAt: string;
      scope: 'GLOBAL' | 'USER' | 'AGENT' | 'TOKEN';
      targetId: string | undefined;
      isActive: boolean;
      reason: string;
      activatedBy: string;
      dualControlId?: string;
      notificationStatus: 'DELIVERED' | 'DEGRADED' | 'SKIPPED';
      warning?: string;
    }> = {
      success: true,
      data: {
        id,
        activatedAt,
        ...recordPayload,
        dualControlId: dualControlRecord.id,
        notificationStatus,
        ...(notificationWarning ? { warning: notificationWarning } : {}),
      },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 200 });
  } catch (err: any) {
    const message = err?.message || 'Failed to toggle kill switch';
    const isUnauthorized = message.startsWith('UNAUTHORIZED');
    const isForbidden = message.startsWith('RBAC_FORBIDDEN') ||
                        message.startsWith('AUTH_ACCOUNT_') ||
                        message.startsWith('DUAL_CONTROL_SELF_APPROVAL_FORBIDDEN') ||
                        message.startsWith('DUAL_CONTROL_REQUIRED');
    const isBadRequest = !isForbidden && message.startsWith('DUAL_CONTROL_');
    if (isUnauthorized || isForbidden || isBadRequest) {
      console.warn('[POST /api/admin/kill-switch] Rejected:', message);
    } else {
      console.error('[POST /api/admin/kill-switch] Error:', err);
    }
    const code = isUnauthorized
      ? 'UNAUTHORIZED'
      : message.startsWith('DUAL_CONTROL_REQUIRED')
      ? 'DUAL_CONTROL_REQUIRED'
      : isForbidden
      ? 'FORBIDDEN'
      : isBadRequest
      ? 'BAD_REQUEST'
      : 'KILL_SWITCH_FAILED';
    return NextResponse.json(
      {
        success: false,
        error: { code, message },
      },
      { status: isUnauthorized ? 401 : isForbidden ? 403 : isBadRequest ? 400 : 500 }
    );
  }
}
