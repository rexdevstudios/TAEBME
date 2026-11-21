import { NextRequest, NextResponse } from 'next/server';
import { requireActiveSession } from '@packages/auth/session';
import { listRecentAuditLogs, type AuditLogRecord } from '@packages/shared/db-pool';
import type { ApiResponse } from '@packages/shared/contracts/api-contracts';
import type { Role } from '@packages/shared/types/domain';

export const dynamic = 'force-dynamic';

const ADMIN_AUDIT_ROLES = new Set<Role>([
  'SUPER_ADMIN',
  'SYSTEM_ADMIN',
  'RISK_ADMIN',
  'LAUNCH_ADMIN',
  'BILLING_ADMIN',
  'MODERATOR',
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

    const isAllowed = session.user.roles.some((r) => ADMIN_AUDIT_ROLES.has(r));
    if (!isAllowed) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: `RBAC_FORBIDDEN: Roles [${session.user.roles.join(', ')}] cannot view governance audit logs.`,
          },
          timestamp: new Date().toISOString(),
        },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const limitParam = Number(searchParams.get('limit') || 20);
    const actionFilter = searchParams.get('action') || undefined;

    const entries = await listRecentAuditLogs(limitParam, actionFilter);

    const response: ApiResponse<{ entries: AuditLogRecord[]; count: number }> = {
      success: true,
      data: {
        entries,
        count: entries.length,
      },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 200 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        success: false,
        error: { code: 'AUDIT_LOGS_READ_FAILED', message: msg },
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
