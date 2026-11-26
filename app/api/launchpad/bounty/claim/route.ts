import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { BountyEscrowService } from '@packages/launchpad/bounty-escrow';
import { FirecrawlScraperService } from '@packages/intelligence/firecrawl-scraper';
import { BountyCampaign, BountyClaim, KolProfile } from '@packages/shared/types/domain';
import { defaultBountyDbAdapter, defaultKolDbAdapter, getDbPool, getTrustEvidenceService, defaultRpcManager, defaultBountyMerkleSnapshotDbAdapter } from '@packages/shared/db-pool';
import { requireActiveSession } from '@packages/auth/session';
import { BountyMerkleSnapshotService } from '@packages/launchpad/bounty-merkle-snapshot-service';
import { MerkleProofService, OnChainVerificationProvider } from '@packages/launchpad/merkle-proof-service';
import { normalizeReferrerWallet } from '@packages/billing/genesis-sbt';
import { AIRDROP_REFERRAL_BONUS_CREDITS } from '@packages/shared/airdrop-referral';

// ── Singleton services (safe for Vercel serverless — stateless, DB-read-only) ─
const _snapshotSvc = new BountyMerkleSnapshotService(defaultBountyMerkleSnapshotDbAdapter);
const _proofSvc = new MerkleProofService(_snapshotSvc);


/**
 * GET /api/launchpad/bounty/claim
 *
 * B3.2 Refactoring — Serves pre-computed Merkle proofs from the PUBLISHED
 * active snapshot stored in bounty_merkle_snapshot_recipients.
 *
 * Legacy behaviour (dynamic tree recomputation on every request) has been
 * replaced to eliminate Merkle root drift: the proof returned here always
 * corresponds to the root that was submitted on-chain via setBountyMerkleRoot.
 *
 * Query parameters:
 *   walletAddress  (required) — recipient wallet to look up
 *   tokenAddress   (optional) — ERC-20 token contract address
 *   campaignId     (optional) — resolves tokenAddress from bounty_campaigns if omitted
 *   snapshotId     (optional) — look up a specific snapshot instead of the active PUBLISHED one
 *
 * Response (backward-compatible):
 *   {
 *     snapshotId, tokenAddress, walletAddress, tokenAmount, chain,
 *     isEligible, isClaimed, claimId,
 *     merkleRoot, merkleProof, leafIndex, leafHash,
 *     canClaimOnChain, isSnapshotPublished,
 *     publishedTxHash, publishedAt
 *   }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const walletAddress = searchParams.get('walletAddress');
  const snapshotIdParam = searchParams.get('snapshotId') || undefined;
  const campaignId = searchParams.get('campaignId') || undefined;
  let tokenAddress = searchParams.get('tokenAddress') || undefined;

  // Validate walletAddress early — required param
  if (!walletAddress) {
    const res: ApiResponse<null> = {
      success: false,
      error: { code: 'MISSING_WALLET', message: 'walletAddress query parameter is required' },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(res, { status: 400 });
  }

  if (!ethers.isAddress(walletAddress)) {
    const res: ApiResponse<null> = {
      success: false,
      error: { code: 'INVALID_WALLET', message: 'walletAddress must be a valid Ethereum address' },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(res, { status: 400 });
  }

  // Resolve tokenAddress from campaign if not provided directly
  let resolvedChain = 'base-mainnet';
  let resolvedChainId: bigint | undefined;
  let resolvedContractAddress: string | undefined;

  if (!tokenAddress && campaignId) {
    const pool = getDbPool();
    if (pool) {
      try {
        const cRes = await pool.query(
          `SELECT tl.contract_address, tl.token_address, tl.chain, tl.chain_id, tl.network_id
           FROM bounty_campaigns bc
           JOIN token_launches tl ON tl.id = bc.launch_id
           WHERE bc.id = $1 LIMIT 1`,
          [campaignId]
        );
        if (cRes.rows.length > 0) {
          const row = cRes.rows[0];
          tokenAddress = row.token_address || row.contract_address;
          resolvedContractAddress = row.contract_address;
          if (row.chain) resolvedChain = row.chain;
          if (row.network_id) resolvedChain = row.network_id;
          if (row.chain_id) resolvedChainId = BigInt(row.chain_id);
        }
      } catch {
        // Non-blocking — fall through to ineligible response
      }
    }
  }

  // If we still have no tokenAddress, return an ineligible response
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    return NextResponse.json({
      success: true,
      data: {
        snapshotId: null,
        tokenAddress: tokenAddress ?? '0x0000000000000000000000000000000000000000',
        walletAddress: ethers.getAddress(walletAddress),
        tokenAmount: '0',
        chain: resolvedChain,
        isEligible: false,
        isClaimed: false,
        merkleRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
        merkleProof: [],
        leafIndex: -1,
        leafHash: null,
        canClaimOnChain: false,
        isSnapshotPublished: false,
        publishedTxHash: null,
        publishedAt: null,
      },
      timestamp: new Date().toISOString(),
    });
  }
  // ── B3.2.3: Provider construction is MANDATORY and FAIL-CLOSED ───────────
  // Any RPC manager failure is a hard error — no silent fallback to unverified delivery.
  //
  // We first attempt to load the active snapshot to discover the correct network_id
  // for the RPC endpoint (best-effort — if DB fails here we fall back to resolvedChain
  // since verifyOnChainMerkleRootConsistency will independently validate the chainId).
  // Then we call defaultRpcManager.getActiveHttpRpc().  If that throws, we return 503.
  let networkIdForRpc = resolvedChain;
  try {
    const snap = await defaultBountyMerkleSnapshotDbAdapter.getActivePublishedSnapshot?.(
      tokenAddress,
      resolvedChainId,
      resolvedContractAddress
    );
    if (snap?.network_id) {
      networkIdForRpc = snap.network_id;
    }
  } catch {
    // Non-blocking: use best-effort resolvedChain.
    // verifyOnChainMerkleRootConsistency validates chainId independently.
  }

  let rpcUrl: string;
  try {
    rpcUrl = await defaultRpcManager.getActiveHttpRpc(networkIdForRpc, 'LAUNCHPAD');
  } catch (rpcErr: unknown) {
    const rpcMsg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: `RPC provider unavailable for network ${networkIdForRpc}. Cannot verify on-chain root. ${rpcMsg}`,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }

  if (!rpcUrl || rpcUrl.trim() === '') {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'PROVIDER_UNAVAILABLE',
          message: `RPC manager returned an empty URL for network ${networkIdForRpc}. Cannot verify on-chain root.`,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }

  const provider: OnChainVerificationProvider = new ethers.JsonRpcProvider(rpcUrl);

  try {
    // B3.2.3: provider is REQUIRED; MerkleProofService throws PROVIDER_REQUIRED if absent.
    // Single snapshot resolution: service resolves snapshot once for both proof lookup
    // and on-chain verification — no race condition between independent DB calls.
    // publishedTxHash and publishedAt are carried directly from proofResult
    // (populated by MerkleProofService from the single loaded snapshot record).
    const proofResult = await _proofSvc.getClaimProof(
      tokenAddress,
      walletAddress,
      resolvedChainId,
      resolvedContractAddress,
      snapshotIdParam,
      provider  // B3.2.3: mandatory — fail-closed
    );

    return NextResponse.json({
      success: true,
      data: {
        snapshotId: proofResult.snapshotId,
        tokenAddress: proofResult.tokenAddress || ethers.getAddress(tokenAddress),
        walletAddress: proofResult.walletAddress || ethers.getAddress(walletAddress),
        tokenAmount: proofResult.tokenAmount,
        chain: (proofResult as any).chain || resolvedChain,
        isEligible: proofResult.isEligible,
        isClaimed: false, // On-chain claimed status is verified at settlement (settle/route.ts)
        merkleRoot: proofResult.merkleRoot,
        merkleProof: proofResult.merkleProof,
        leafIndex: proofResult.leafIndex,
        leafHash: (proofResult as any).leafHash ?? null,
        canClaimOnChain: proofResult.canClaimOnChain,
        isSnapshotPublished: proofResult.isSnapshotPublished,
        publishedTxHash: (proofResult as any).publishedTxHash ?? null,
        publishedAt: (proofResult as any).publishedAt ?? null,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('INVALID_TOKEN_ADDRESS') || msg.startsWith('INVALID_WALLET_ADDRESS')) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_INPUT', message: msg }, timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }
    if (msg.startsWith('DATABASE_UNAVAILABLE')) {
      return NextResponse.json(
        { success: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'Database temporarily unavailable. Please retry.' }, timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }
    // B3.2.3 — All on-chain / snapshot-identity verification failures are fatal.
    if (
      msg.startsWith('ON_CHAIN_ROOT_MISMATCH') ||
      msg.startsWith('ON_CHAIN_CHAIN_MISMATCH') ||
      msg.startsWith('ON_CHAIN_VERIFY_FAIL') ||
      msg.startsWith('PROOF_SNAPSHOT_MISMATCH') ||
      msg.startsWith('PROVIDER_REQUIRED')
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'ON_CHAIN_VERIFICATION_FAILED',
            message: 'On-chain Merkle root verification failed. The snapshot may be stale or superseded. Please retry.',
          },
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { success: false, error: { code: 'INTERNAL_ERROR', message: msg }, timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}


export async function POST(req: NextRequest) {
  try {
    // C-04 Fix & AUTH-02 Hardening: Require authenticated session and ACTIVE account status.
    // This binds the claim to the authenticated wallet and fails closed if suspended/frozen.
    const session = await requireActiveSession(req);

    const body = await req.json();
    const {
      campaignId,
      proofUrl,
      claimType,
      tokenAddress,
      chain,
      twitterHandle,
    } = body;

    // C-04 Fix: walletAddress is derived from the authenticated session, not the request body.
    // This prevents an attacker from claiming on behalf of another wallet.
    const walletAddress = session.walletAddress;

    const finalProofUrl =
      proofUrl ||
      (claimType === 'HOLD'
        ? `hodl://${walletAddress}`
        : claimType === 'STAKE'
        ? `vault-staking://${walletAddress}`
        : '');

    if (!campaignId || !finalProofUrl) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'campaignId and proofUrl are required' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 400 });
    }

    // Resolve official KOL profile from SSOT (or register if new).
    // C-04 Fix: followersCount is NOT accepted from the request body.
    // It defaults to 0 and must be updated via a verified API integration only.
    // C-04 Fix: twitterHandle is NOT accepted from the request body.
    // Binding a Twitter/X identity requires Twitter OAuth verification — not self-assertion.
    // twitterHandle from body is intentionally discarded here.
    let kol = await defaultKolDbAdapter.getKolProfile(walletAddress);
    if (!kol) {
      kol = await defaultKolDbAdapter.upsertKolProfile({
        userId: walletAddress,
        // twitterHandle omitted — requires Twitter OAuth verification before binding
        followersCount: 0,   // Will be populated by verified Twitter API integration
        trustScore: 50,      // Default neutral trust score; elevated by verified actions only
        isVerified: false,   // Requires explicit verification step
      });
    }

    // Resolve token contract address & chain from campaign launch if not supplied
    let resolvedTokenAddress = tokenAddress;
    let resolvedChain = chain;

    if (!resolvedTokenAddress) {
      const pool = getDbPool();
      if (pool) {
        try {
          const cRes = await pool.query(
            `SELECT tl.contract_address, tl.chain 
             FROM bounty_campaigns bc 
             JOIN token_launches tl ON tl.id = bc.launch_id 
             WHERE bc.id = $1 LIMIT 1`,
            [campaignId]
          );
          if (cRes.rows.length > 0) {
            resolvedTokenAddress = cRes.rows[0].contract_address;
            resolvedChain = cRes.rows[0].chain;
          }
        } catch {
          // Graceful fallback
        }
      }
    }

    // Wire TrustEvidenceService for DB-persisted World ID anti-replay (S-01 fix).
    // getTrustEvidenceService() returns null when DATABASE_URL is absent (dev/test),
    // in which case BountyEscrowService falls back to in-memory safely.
    const trustService = getTrustEvidenceService();
    const service = new BountyEscrowService(defaultBountyDbAdapter, undefined, trustService ?? undefined, defaultRpcManager);

    const result = await service.submitAndVerifyClaim(campaignId, kol, finalProofUrl, {
      claimType,
      tokenAddress: resolvedTokenAddress,
      chain: resolvedChain,
      walletAddress,
      authenticatedUserId: session.user.userId,
    });

    if (result.success && result.claim) {
      let referralBonusGranted = 0;
      const referredBy = normalizeReferrerWallet(body?.referrerWallet, walletAddress);
      if (referredBy) {
        const pool = getDbPool();
        if (pool) {
          try {
            const refUserRes = await pool.query(
              `SELECT user_id FROM wallets WHERE LOWER(address) = LOWER($1) LIMIT 1`,
              [referredBy]
            );
            const refUserId = refUserRes.rows[0]?.user_id;
            if (refUserId) {
              const refId = `bounty_ref:${campaignId}:${result.claim.id}`;
              const ins = await pool.query(
                `INSERT INTO ledger_entries (user_id, amount, currency, type, reference_id, description, created_at)
                 SELECT $1::uuid, $2::numeric, 'CREDITS', 'CREDIT', $3::varchar, $4::text, NOW()
                 WHERE NOT EXISTS (SELECT 1 FROM ledger_entries WHERE reference_id = $3::varchar)`,
                [
                  refUserId,
                  AIRDROP_REFERRAL_BONUS_CREDITS,
                  refId,
                  `Airdrop Referral Bonus (+${AIRDROP_REFERRAL_BONUS_CREDITS} cr) for campaign ${campaignId}`,
                ]
              );
              if (Number(ins.rowCount || 0) > 0) {
                referralBonusGranted = AIRDROP_REFERRAL_BONUS_CREDITS;
              }
            }
          } catch {
            // Non-blocking referral credit bonus
          }
        }
      }

      const response: ApiResponse<typeof result & { referralBonusGranted?: number }> = {
        success: true,
        data: { ...result, ...(referralBonusGranted > 0 ? { referralBonusGranted } : {}) },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 200 });
    } else {
      let statusCode = 422;
      let errorCode = 'VERIFICATION_REJECTED';
      if (result.reason?.startsWith('ACCOUNT_UNDER_REVIEW')) {
        statusCode = 403;
        errorCode = 'ACCOUNT_UNDER_REVIEW';
      } else if (result.reason?.startsWith('INSUFFICIENT_TRUST_TIER')) {
        statusCode = 422;
        errorCode = 'INSUFFICIENT_TRUST_TIER';
      } else if (result.reason?.startsWith('TRUST_SERVICE_UNAVAILABLE')) {
        statusCode = 503;
        errorCode = 'TRUST_SERVICE_UNAVAILABLE';
      } else if (result.reason?.startsWith('INVALID_CAMPAIGN_CONFIG')) {
        statusCode = 500;
        errorCode = 'INVALID_CAMPAIGN_CONFIG';
      }

      const response: ApiResponse<typeof result> = {
        success: false,
        error: { code: errorCode, message: result.reason || 'Verification rejected' },
        data: result,
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: statusCode });
    }
  } catch (error) {
    const errMessage = (error as Error)?.message || '';
    if (errMessage.startsWith('UNAUTHORIZED')) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'UNAUTHORIZED', message: errMessage },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 401 });
    }

    if (errMessage.startsWith('AUTH_ACCOUNT_') || errMessage.startsWith('FORBIDDEN') || errMessage.startsWith('RBAC_FORBIDDEN')) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'FORBIDDEN', message: errMessage },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 403 });
    }

    if (errMessage.startsWith('DATABASE_UNAVAILABLE')) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'DATABASE_UNAVAILABLE', message: 'Database service temporarily unavailable. Please retry shortly.' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 503 });
    }

    const res: ApiResponse<null> = {
      success: false,
      error: { code: 'CLAIM_SUBMISSION_FAILED', message: (error as Error).message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(res, { status: 400 });
  }
}
