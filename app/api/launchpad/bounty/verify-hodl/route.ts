import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { getDbPool, defaultRpcManager } from '@packages/shared/db-pool';
import { resolveNetworkDefinition } from '@packages/network-registry/rpc-manager';
import { ethers } from 'ethers';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const campaignId = searchParams.get('campaignId') || undefined;

    const pool = getDbPool();
    if (!pool) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'DATABASE_UNAVAILABLE', message: 'Neon DB pool is offline' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 503 });
    }

    let queryText = `
      SELECT 
        bc.id as claim_id,
        bc.campaign_id,
        bc.kol_id,
        bc.verification_status,
        bc.created_at,
        c.title as campaign_title,
        tl.contract_address,
        tl.chain,
        COALESCE(w.address, kp.user_id::text, bc.kol_id::text) as wallet_address
      FROM bounty_claims bc
      JOIN bounty_campaigns c ON c.id = bc.campaign_id
      JOIN token_launches tl ON tl.id = c.launch_id
      LEFT JOIN kol_profiles kp ON (kp.id = bc.kol_id OR kp.user_id = bc.kol_id)
      LEFT JOIN wallets w ON w.user_id = kp.user_id
      WHERE (LOWER(c.title) LIKE '%hold%' OR LOWER(c.title) LIKE '%hodl%' OR LOWER(c.title) LIKE '%loyalty%')
    `;
    const params: any[] = [];
    if (campaignId) {
      params.push(campaignId);
      queryText += ` AND bc.campaign_id = $1`;
    }
    queryText += ` ORDER BY bc.created_at DESC LIMIT 50`;

    const result = await pool.query(queryText, params);

    const response: ApiResponse<any[]> = {
      success: true,
      data: result.rows.map((r) => ({
        claimId: r.claim_id,
        campaignId: r.campaign_id,
        campaignTitle: r.campaign_title,
        walletAddress: r.wallet_address || r.kol_id,
        tokenAddress: r.contract_address,
        chain: r.chain,
        verificationStatus: r.verification_status,
        createdAt: r.created_at,
      })),
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 200 });
  } catch (err: any) {
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'HODL_FETCH_FAILED', message: err?.message || 'Failed to fetch HODL claims' },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 500 });
  }
}

import { requireCapability } from '@packages/auth/session';

export async function POST(req: NextRequest) {
  try {
    // SG-01: Enforce authoritative authentication and capability check
    await requireCapability(req, 'REVIEW_FLAGGED_TOKEN');

    const pool = getDbPool();
    if (!pool) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'DATABASE_UNAVAILABLE', message: 'Neon DB pool is offline' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 503 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const targetClaimId = body?.claimId || undefined;
    const targetCampaignId = body?.campaignId || undefined;

    // Query active HODL claims that have not already been settled on-chain
    let claimsQuery = `
      SELECT 
        bc.id as claim_id,
        bc.campaign_id,
        bc.kol_id,
        bc.verification_status,
        tl.contract_address,
        tl.chain,
        COALESCE(w.address, kp.user_id::text, bc.kol_id::text) as wallet_address
      FROM bounty_claims bc
      JOIN bounty_campaigns c ON c.id = bc.campaign_id
      JOIN token_launches tl ON tl.id = c.launch_id
      LEFT JOIN kol_profiles kp ON (kp.id = bc.kol_id OR kp.user_id = bc.kol_id)
      LEFT JOIN wallets w ON w.user_id = kp.user_id
      WHERE (LOWER(c.title) LIKE '%hold%' OR LOWER(c.title) LIKE '%hodl%' OR LOWER(c.title) LIKE '%loyalty%')
        AND c.is_active = true
        AND bc.verification_status != 'CLAIMED'
        AND bc.tx_hash IS NULL
    `;
    const queryParams: any[] = [];

    if (targetClaimId) {
      queryParams.push(targetClaimId);
      claimsQuery += ` AND bc.id = $${queryParams.length}`;
    } else if (targetCampaignId) {
      queryParams.push(targetCampaignId);
      claimsQuery += ` AND bc.campaign_id = $${queryParams.length}`;
    }

    claimsQuery += ` LIMIT 20`;

    const claimsRes = await pool.query(claimsQuery, queryParams);

    const reVerificationResults: Array<{
      claimId: string;
      walletAddress: string;
      tokenAddress: string;
      chain: string;
      onChainBalance: string;
      status: 'VERIFIED' | 'DISQUALIFIED' | 'UNCHANGED';
      reason?: string;
    }> = [];

    for (const r of claimsRes.rows) {
      const wallet = r.wallet_address;
      const token = r.contract_address;

      // Validate address format
      if (!ethers.isAddress(wallet) || !ethers.isAddress(token)) {
        await pool.query(
          `UPDATE bounty_claims SET verification_status = 'REJECTED' WHERE id = $1`,
          [r.claim_id]
        );
        reVerificationResults.push({
          claimId: r.claim_id,
          walletAddress: wallet,
          tokenAddress: token,
          chain: r.chain,
          onChainBalance: '0',
          status: 'DISQUALIFIED',
          reason: 'INVALID_WALLET_OR_TOKEN_ADDRESS',
        });
        continue;
      }

      const netDef = resolveNetworkDefinition(r.chain);
      let rpcUrl = '';
      let rpcError: string | null = null;

      if (!netDef) {
        reVerificationResults.push({
          claimId: r.claim_id,
          walletAddress: wallet,
          tokenAddress: token,
          chain: r.chain,
          onChainBalance: '0',
          status: 'UNCHANGED',
          reason: `UNSUPPORTED_CHAIN: Jaringan "${r.chain}" tidak terdaftar atau tidak didukung.`,
        });
        continue;
      }

      try {
        rpcUrl = await defaultRpcManager.getActiveHttpRpc(netDef.networkId, 'LAUNCHPAD');
      } catch (err: any) {
        rpcError = err?.message || 'RPC_RESOLUTION_FAILED';
      }

      // Fail-closed on RPC lookup failure: NEVER assume non-zero balance and NEVER update to VERIFIED
      if (rpcError || !rpcUrl) {
        reVerificationResults.push({
          claimId: r.claim_id,
          walletAddress: wallet,
          tokenAddress: token,
          chain: r.chain,
          onChainBalance: '0',
          status: 'UNCHANGED',
          reason: `RPC_LOOKUP_FAILED: ${rpcError || 'RPC_UNAVAILABLE'}`,
        });
        continue;
      }

      let currentBalance: bigint | null = null;

      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const erc20 = new ethers.Contract(
          token,
          ['function balanceOf(address) view returns (uint256)'],
          provider
        );
        currentBalance = await erc20.balanceOf(wallet);
      } catch (err: any) {
        rpcError = err?.message || 'RPC_TIMEOUT';
      }

      // Fail-closed on RPC failure: NEVER assume non-zero balance and NEVER update to VERIFIED
      if (currentBalance === null || rpcError) {
        reVerificationResults.push({
          claimId: r.claim_id,
          walletAddress: wallet,
          tokenAddress: token,
          chain: r.chain,
          onChainBalance: '0',
          status: 'UNCHANGED',
          reason: `RPC_LOOKUP_FAILED: ${rpcError}`,
        });
        continue;
      }

      const balanceFormatted = currentBalance.toString();

      // Zero-Sell Enforcement Rule: If balance > 0, verify; if balance === 0, disqualify
      if (currentBalance > 0n) {
        await pool.query(
          `UPDATE bounty_claims SET verification_status = $1 WHERE id = $2`,
          ['VERIFIED', r.claim_id]
        );
        reVerificationResults.push({
          claimId: r.claim_id,
          walletAddress: wallet,
          tokenAddress: token,
          chain: r.chain,
          onChainBalance: balanceFormatted,
          status: 'VERIFIED',
        });
      } else {
        await pool.query(
          `UPDATE bounty_claims SET verification_status = $1 WHERE id = $2`,
          ['REJECTED', r.claim_id]
        );
        reVerificationResults.push({
          claimId: r.claim_id,
          walletAddress: wallet,
          tokenAddress: token,
          chain: r.chain,
          onChainBalance: '0',
          status: 'DISQUALIFIED',
          reason: 'ZERO_BALANCE',
        });
      }
    }

    const response: ApiResponse<typeof reVerificationResults> = {
      success: true,
      data: reVerificationResults,
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 200 });
  } catch (err: any) {
    const message = err?.message || 'Failed to verify HODL balances';
    if (message.startsWith('UNAUTHORIZED')) {
      return NextResponse.json(
        { success: false, error: { code: 'UNAUTHORIZED', message }, timestamp: new Date().toISOString() },
        { status: 401 }
      );
    }
    if (message.startsWith('RBAC_FORBIDDEN') || message.startsWith('AUTH_ACCOUNT_')) {
      return NextResponse.json(
        { success: false, error: { code: 'FORBIDDEN', message }, timestamp: new Date().toISOString() },
        { status: 403 }
      );
    }
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'HODL_VERIFY_FAILED', message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 500 });
  }
}
