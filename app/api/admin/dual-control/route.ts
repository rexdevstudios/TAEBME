/**
 * app/api/admin/dual-control/route.ts
 *
 * SOP-07 Strict Dual-Control Governance Endpoint (Phase AW).
 * - GET: Lists recent dual-control requests from PostgreSQL SSOT (`dual_control_requests`).
 * - POST (`operation: 'PROPOSE'`): Admin #1 initiates a `PENDING` dual-control request.
 * - POST (`operation: 'APPROVE'`): Admin #2 approves a `PENDING` request (strictly forbids self-approval).
 * - Restricted to `SUPER_ADMIN`, `SYSTEM_ADMIN`, `RISK_ADMIN`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { DualControlManager, type DualControlActionType } from '@packages/admin/dual-control';
import { defaultDualControlDbAdapter } from '@packages/shared/db-pool';
import type { Role } from '@packages/shared/types/domain';

export const dynamic = 'force-dynamic';

const DUAL_CONTROL_ADMIN_ROLES = new Set<Role>([
  'SUPER_ADMIN',
  'SYSTEM_ADMIN',
  'RISK_ADMIN',
]);

const ALLOWED_ACTION_TYPES = new Set<DualControlActionType>([
  'OVERRIDE_RISK',
  'UPDATE_RPC',
  'REFUND_USER',
  'CHANGE_FEE',
  'FREEZE_TOKEN',
  'FREEZE_ACCOUNT',
]);

async function authenticateDualControlAdmin(req: NextRequest) {
  const session = await requireActiveSession(req);
  const isAllowed = session.user.roles.some((r) => DUAL_CONTROL_ADMIN_ROLES.has(r));
  if (!isAllowed) {
    throw new Error(
      `RBAC_FORBIDDEN: Roles [${session.user.roles.join(', ')}] cannot manage dual-control requests.`
    );
  }
  return session;
}

export async function GET(req: NextRequest) {
  try {
    await authenticateDualControlAdmin(req);
    const { searchParams } = new URL(req.url);
    const limit = Number(searchParams.get('limit') || 15);
    const requests = await defaultDualControlDbAdapter.listRecentRequests(limit);

    return NextResponse.json(
      {
        success: true,
        data: {
          requests,
          count: requests.length,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isForbidden = msg.startsWith('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT_');
    const isUnauth = msg.startsWith('UNAUTHORIZED') || msg.includes('AUTH_SESSION');
    const status = isForbidden ? 403 : isUnauth ? 401 : 500;
    return NextResponse.json(
      {
        success: false,
        error: {
          code: isForbidden ? 'FORBIDDEN' : isUnauth ? 'UNAUTHORIZED' : 'DUAL_CONTROL_LIST_FAILED',
          message: msg,
        },
        timestamp: new Date().toISOString(),
      },
      { status }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await authenticateDualControlAdmin(req);
    const body = await req.json().catch(() => ({}));
    const operation = String(body?.operation || 'PROPOSE').trim().toUpperCase();

    if (operation === 'APPROVE') {
      const requestId = typeof body?.requestId === 'string' ? body.requestId.trim() : '';
      if (!requestId) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'BAD_REQUEST',
              message: 'DUAL_CONTROL_INVALID_INPUT: requestId is required for APPROVE operation',
            },
            timestamp: new Date().toISOString(),
          },
          { status: 400 }
        );
      }

      const approved = await DualControlManager.approveAction(
        requestId,
        session.user.userId,
        defaultDualControlDbAdapter
      );

      return NextResponse.json(
        {
          success: true,
          data: {
            operation: 'APPROVE',
            request: approved,
          },
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      );
    }

    if (operation !== 'PROPOSE') {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: `DUAL_CONTROL_INVALID_OPERATION: Unsupported operation "${operation}". Must be PROPOSE or APPROVE.`,
          },
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    const rawActionType = String(body?.actionType || 'OVERRIDE_RISK')
      .trim()
      .toUpperCase() as DualControlActionType;
    if (!ALLOWED_ACTION_TYPES.has(rawActionType)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'BAD_REQUEST',
            message: `DUAL_CONTROL_INVALID_ACTION_TYPE: "${rawActionType}" is not a valid DualControlActionType`,
          },
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    const scope = String(body?.scope || 'GLOBAL').trim().toUpperCase();
    const killSwitchAction = String(body?.killSwitchAction || 'ACTIVATE').trim().toUpperCase();
    const reason =
      typeof body?.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim().slice(0, 240)
        : `Dual-control ${rawActionType} (${scope})`;

    const customPayload =
      body?.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};

    const created = await DualControlManager.requestAction(
      rawActionType,
      session.user.userId,
      {
        ...customPayload,
        scope,
        killSwitchAction,
      },
      reason,
      defaultDualControlDbAdapter
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          operation: 'PROPOSE',
          request: created,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isSelfApproval = msg.startsWith('DUAL_CONTROL_SELF_APPROVAL_FORBIDDEN');
    const isForbidden = isSelfApproval || msg.startsWith('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT_');
    const isUnauth = msg.startsWith('UNAUTHORIZED') || msg.includes('AUTH_SESSION');
    const isNotFound = msg.startsWith('DUAL_CONTROL_NOT_FOUND');
    const isValidation = !isSelfApproval && !isNotFound && msg.startsWith('DUAL_CONTROL_');

    const status = isForbidden ? 403 : isUnauth ? 401 : isNotFound ? 404 : isValidation ? 400 : 500;
    const code = isSelfApproval
      ? 'DUAL_CONTROL_SELF_APPROVAL_FORBIDDEN'
      : isForbidden
      ? 'FORBIDDEN'
      : isUnauth
      ? 'UNAUTHORIZED'
      : isNotFound
      ? 'NOT_FOUND'
      : isValidation
      ? 'BAD_REQUEST'
      : 'DUAL_CONTROL_MUTATION_FAILED';

    return NextResponse.json(
      {
        success: false,
        error: { code, message: msg },
        timestamp: new Date().toISOString(),
      },
      { status }
    );
  }
}
