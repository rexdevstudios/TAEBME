import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { BountyEscrowService, BountyClaimItem } from '@packages/launchpad/bounty-escrow';
import { FirecrawlScraperService } from '@packages/intelligence/firecrawl-scraper';
import { BountyCampaign, BountyClaim, KolProfile } from '@packages/shared/types/domain';
import { defaultBountyDbAdapter, defaultKolDbAdapter, getDbPool } from '@packages/shared/db-pool';
import { authenticateSession } from '@packages/auth/session';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const walletAddress = searchParams.get('walletAddress');
  const campaignId = searchParams.get('campaignId') || undefined;
  let tokenAddress = searchParams.get('tokenAddress') || undefined;

  let resolvedChain = 'base-mainnet';
  if (!tokenAddress && campaignId) {
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
          tokenAddress = cRes.rows[0].contract_address;
          if (cRes.rows[0].chain) {
            resolvedChain = cRes.rows[0].chain;
          }
        }
      } catch {
        // Non-blocking
      }
    }
  }
  if (!tokenAddress) {
    tokenAddress = '0x0000000000000000000000000000000000000000';
  }

  if (!walletAddress) {
    const res: ApiResponse<null> = {
      success: false,
      error: { code: 'MISSING_WALLET', message: 'walletAddress query parameter is required' },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(res, { status: 400 });
  }

  // Fetch verified claims directly from PostgreSQL SSOT
  const verifiedClaims = defaultBountyDbAdapter.getVerifiedClaims
    ? await defaultBountyDbAdapter.getVerifiedClaims(campaignId)
    : [];

  // Generate Merkle Tree for verified claims
  const tree = BountyEscrowService.generateBountyMerkleTree(verifiedClaims);
  const targetItem = verifiedClaims.find(
    (c) => c.walletAddress.toLowerCase() === walletAddress.toLowerCase()
  );

  const proof = targetItem ? tree.getProof(targetItem.walletAddress, targetItem.tokenAmount) : [];
  const tokenAmount = targetItem ? targetItem.tokenAmount.toString() : '0';

  const response: ApiResponse<{
    tokenAddress: string;
    walletAddress: string;
    tokenAmount: string;
    chain: string;
    isEligible: boolean;
    isClaimed: boolean;
    claimId?: string;
    merkleRoot: string;
    merkleProof: string[];
  }> = {
    success: true,
    data: {
      tokenAddress,
      walletAddress,
      tokenAmount,
      chain: resolvedChain,
      isEligible: !!targetItem && !targetItem.isClaimed,
      isClaimed: !!targetItem?.isClaimed,
      claimId: targetItem?.claimId || undefined,
      merkleRoot: tree.root,
      merkleProof: proof,
    },
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(response);
}

export async function POST(req: NextRequest) {
  try {
    // C-04 Fix: Require authenticated session for claim submission.
    // This binds the claim to the authenticated wallet, preventing identity spoofing.
    const session = await authenticateSession(req);
    if (!session) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Valid SIWE session required to submit a bounty claim.' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 401 });
    }

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

    const service = new BountyEscrowService(defaultBountyDbAdapter);

    const result = await service.submitAndVerifyClaim(campaignId, kol, finalProofUrl, {
      claimType,
      tokenAddress: resolvedTokenAddress,
      chain: resolvedChain,
      walletAddress,
    });

    if (result.success && result.claim) {
      const response: ApiResponse<typeof result> = {
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 200 });
    } else {
      const response: ApiResponse<typeof result> = {
        success: false,
        error: { code: 'VERIFICATION_REJECTED', message: result.reason || 'Verification rejected' },
        data: result,
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 422 });
    }
  } catch (error) {
    const res: ApiResponse<null> = {
      success: false,
      error: { code: 'CLAIM_SUBMISSION_FAILED', message: (error as Error).message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(res, { status: 400 });
  }
}
