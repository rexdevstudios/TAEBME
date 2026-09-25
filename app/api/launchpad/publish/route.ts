import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { defaultDraftDbAdapter, getDbPool } from '@packages/shared/db-pool';
import { requireCapability } from '@packages/auth/session';
import { ethers } from 'ethers';

export const dynamic = 'force-dynamic';

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export async function POST(req: NextRequest) {
  try {
    // H-01 Fix: Enforce authenticated session with PUBLISH_LAUNCH capability.
    // requireCapability throws UNAUTHORIZED (401) if no session, RBAC_FORBIDDEN (403) if wrong role.
    const session = await requireCapability(req, 'PUBLISH_LAUNCH');

    const body = await req.json();
    const { draftId, contractAddress, chain, txHash, currentSupply, graduationThreshold } = body;

    // 1. Input Validation
    if (!draftId || !isUuid(draftId)) {
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_DRAFT_ID', message: 'draftId harus berupa format UUID yang valid.' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (!contractAddress || !ethers.isAddress(contractAddress)) {
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_CONTRACT_ADDRESS', message: 'contractAddress harus berupa alamat Ethereum/EVM yang sah.' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    // 2. H-07 Fix: Verify authenticated user owns the draft before publishing.
    // SUPER_ADMIN and LAUNCH_ADMIN may bypass ownership check (platform operators).
    const isAdmin = session.user.roles.some((r) => r === 'SUPER_ADMIN' || r === 'LAUNCH_ADMIN');
    if (!isAdmin) {
      const pool = getDbPool();
      // H-07 Fix: DB unavailable must fail-closed — cannot verify draft ownership without DB.
      // A non-admin user bypassing ownership check would allow publishing any draft.
      if (!pool) {
        const response: ApiResponse<null> = {
          success: false,
          error: { code: 'DB_UNAVAILABLE', message: 'Cannot verify draft ownership. Please retry later.' },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 503 });
      }
      const draftRes = await pool.query(
        `SELECT creator_id FROM launch_drafts WHERE id = $1 LIMIT 1`,
        [draftId]
      );
      if (draftRes.rows.length === 0) {
        const response: ApiResponse<null> = {
          success: false,
          error: { code: 'DRAFT_NOT_FOUND', message: 'Launch draft tidak ditemukan.' },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 404 });
      }
      // creator_id is a UUID; session.user.userId is usr-<walletPrefix>.
      // Compare by wallet address stored in session vs draft's wallet-linked creator.
      const walletRes = await pool.query(
        `SELECT u.id FROM users u JOIN wallets w ON w.user_id = u.id WHERE u.id = $1 AND LOWER(w.address) = LOWER($2) LIMIT 1`,
        [draftRes.rows[0].creator_id, session.walletAddress]
      );
      if (walletRes.rows.length === 0) {
        const response: ApiResponse<null> = {
          success: false,
          error: { code: 'FORBIDDEN', message: 'Anda tidak memiliki izin untuk mempublikasikan draft ini.' },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 403 });
      }
    }

    // 3. Publish Launch Draft into PostgreSQL SSOT
    if (!defaultDraftDbAdapter.publishLaunchDraft) {
      throw new Error('publishLaunchDraft adapter method not implemented.');
    }

    const result = await defaultDraftDbAdapter.publishLaunchDraft({
      draftId,
      contractAddress,
      chain: chain || 'base-mainnet',
      txHash,
      currentSupply,
      graduationThreshold: graduationThreshold ? Number(graduationThreshold) : undefined,
    });

    const response: ApiResponse<{
      launchId: string;
      contractAddress: string;
      status: 'PUBLISHED';
      publishedAt: string;
      actorId: string;
    }> = {
      success: true,
      data: {
        launchId: result.launchId,
        contractAddress: result.contractAddress,
        status: 'PUBLISHED',
        publishedAt: new Date().toISOString(),
        actorId: session.user.userId,
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 201 });
  } catch (err: any) {
    console.error('[POST /api/launchpad/publish] Error:', err);
    // requireCapability throws plain errors with UNAUTHORIZED/RBAC_FORBIDDEN prefix
    const isUnauthorized = err?.message?.startsWith('UNAUTHORIZED');
    const isForbidden = err?.message?.startsWith('RBAC_FORBIDDEN') || err?.message?.startsWith('AUTH_ACCOUNT_');
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'PUBLISH_FAILED', message: err?.message || 'Failed to publish token launch' },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: isUnauthorized ? 401 : isForbidden ? 403 : 500 });
  }
}
