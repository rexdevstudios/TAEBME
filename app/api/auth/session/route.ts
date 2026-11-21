import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { authenticateSession } from '@packages/auth/session';
import { RbacGuard, type Capability } from '@packages/auth/rbac-middleware';
import { defaultBillingDbAdapter, getDbPool } from '@packages/shared/db-pool';
import type { PlanId } from '@packages/billing/subscriptions-engine';
import type { Role } from '@packages/shared/types/domain';

export interface SessionEntitlements {
  paperTrading: boolean;
  viewLaunchpad: boolean;
  createLaunch: boolean;
  liveTrading: boolean;
  aiProposals: boolean;
  priorityScrape: boolean;
}

export interface SessionData {
  authenticated: boolean;
  userId: string | null;
  walletAddress: string | null;
  userRole:
    | 'GUEST'
    | 'TRADER'
    | 'CREATOR'
    | 'MODERATOR'
    | 'BILLING_ADMIN'
    | 'RISK_ADMIN'
    | 'LAUNCH_ADMIN'
    | 'SYSTEM_ADMIN'
    | 'SUPER_ADMIN';
  roles: Role[];
  capabilities: Capability[];
  planId?: PlanId;
  entitlements: SessionEntitlements;
  credits: number;
  issuedAt?: number;
}

function computeEntitlements(planId: PlanId, isAdmin: boolean): SessionEntitlements {
  if (isAdmin || planId === 'AGENT') {
    return {
      paperTrading: true,
      viewLaunchpad: true,
      createLaunch: true,
      liveTrading: true,
      aiProposals: true,
      priorityScrape: true,
    };
  }
  if (planId === 'CREATOR') {
    return {
      paperTrading: true,
      viewLaunchpad: true,
      createLaunch: true,
      liveTrading: false,
      aiProposals: false,
      priorityScrape: true,
    };
  }
  if (planId === 'TRADER') {
    return {
      paperTrading: true,
      viewLaunchpad: true,
      createLaunch: false,
      liveTrading: true,
      aiProposals: false,
      priorityScrape: true,
    };
  }
  return {
    paperTrading: true,
    viewLaunchpad: true,
    createLaunch: false,
    liveTrading: false,
    aiProposals: false,
    priorityScrape: false,
  };
}

export async function GET(req: NextRequest) {
  try {
    const session = await authenticateSession(req);

    if (!session) {
      const response: ApiResponse<SessionData> = {
        success: true,
        data: {
          authenticated: false,
          userId: null,
          walletAddress: null,
          userRole: 'GUEST',
          roles: [],
          capabilities: [],
          planId: 'FREE',
          entitlements: computeEntitlements('FREE', false),
          credits: 0,
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 200 });
    }

    const roles = session.user.roles;
    let userRole: SessionData['userRole'] = 'TRADER';
    if (roles.includes('SUPER_ADMIN')) {
      userRole = 'SUPER_ADMIN';
    } else if (roles.includes('SYSTEM_ADMIN')) {
      userRole = 'SYSTEM_ADMIN';
    } else if (roles.includes('LAUNCH_ADMIN')) {
      userRole = 'LAUNCH_ADMIN';
    } else if (roles.includes('RISK_ADMIN')) {
      userRole = 'RISK_ADMIN';
    } else if (roles.includes('BILLING_ADMIN')) {
      userRole = 'BILLING_ADMIN';
    } else if (roles.includes('MODERATOR')) {
      userRole = 'MODERATOR';
    } else if (roles.includes('CREATOR')) {
      userRole = 'CREATOR';
    }

    const capabilities = RbacGuard.getCapabilitiesForRoles(roles);
    const isAdmin = userRole === 'SUPER_ADMIN' || userRole === 'SYSTEM_ADMIN';
    let planId: PlanId = isAdmin ? 'AGENT' : 'FREE';
    let credits = 15000;

    try {
      if (getDbPool()) {
        const dbPlan = await defaultBillingDbAdapter.getUserPlan(session.walletAddress);
        planId = isAdmin && dbPlan === 'FREE' ? 'AGENT' : dbPlan;
        credits = await defaultBillingDbAdapter.getUserCreditBalance(session.walletAddress);
      }
    } catch {
      // Fallback when DB unavailable or unconfigured in test
    }

    const response: ApiResponse<SessionData> = {
      success: true,
      data: {
        authenticated: true,
        userId: session.user.userId,
        walletAddress: session.walletAddress,
        userRole,
        roles,
        capabilities,
        planId,
        entitlements: computeEntitlements(planId, isAdmin),
        credits,
        issuedAt: session.issuedAt,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    const isDbUnavailable = (err as Error).message?.includes('DATABASE_UNAVAILABLE');
    const errorResponse: ApiResponse<null> = {
      success: false,
      error: {
        code: isDbUnavailable ? 'SERVICE_UNAVAILABLE' : 'SERVER_ERROR',
        message: (err as Error).message,
      },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(errorResponse, { status: isDbUnavailable ? 503 : 500 });
  }
}
