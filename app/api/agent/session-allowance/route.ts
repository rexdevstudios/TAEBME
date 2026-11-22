/**
 * app/api/agent/session-allowance/route.ts
 *
 * Non-Custodial ERC-4337 / ERC-7715 Session Allowance Spec Builder & Validator (Phase AS).
 * - Requires authenticated SIWE session (`CONNECT_WALLET`).
 * - Strictly rejects private keys or mnemonics (`AGENTS.md` Rule 3).
 * - Clamps daily on-chain spend allowance against the user's active billing tier ceiling.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { defaultBillingDbAdapter } from '@packages/shared/db-pool';
import { validateSessionAllowanceSpec } from '@packages/agent/session-allowance';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
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

    const body = await req.json().catch(() => ({}));
    const userPlan = await defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const);

    let validated;
    try {
      validated = validateSessionAllowanceSpec(
        {
          delegateAddress: typeof body?.delegateAddress === 'string' ? body.delegateAddress : auth.walletAddress,
          chainId: Number(body?.chainId ?? 8453),
          dailySpendCapUsd: Number(body?.dailySpendCapUsd ?? 100),
          expiresAtIso:
            typeof body?.expiresAtIso === 'string'
              ? body.expiresAtIso
              : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          allowedContracts: Array.isArray(body?.allowedContracts)
            ? body.allowedContracts
            : ['0x0000000000001fF3684f28c67538d4D072C22734'],
          allowedActions: Array.isArray(body?.allowedActions) ? body.allowedActions : ['SWAP_DEX'],
        },
        userPlan
      );
    } catch (valErr: unknown) {
      return NextResponse.json(
        {
          success: false,
          error: valErr instanceof Error ? valErr.message : 'INVALID_SESSION_ALLOWANCE_SPEC',
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    await defaultBillingDbAdapter
      .createAuditLog(
        auth.walletAddress,
        'SESSION_ALLOWANCE_PREPARED',
        validated.delegateAddress,
        `ERC-7715 spec validated (cap=$${validated.effectiveDailySpendCapUsd}/day, chain=${validated.chainId}, actions=${validated.allowedActions.join(',')})`
      )
      .catch(() => {});

    return NextResponse.json(
      {
        success: true,
        data: validated,
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'SESSION_ALLOWANCE_ERROR',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
