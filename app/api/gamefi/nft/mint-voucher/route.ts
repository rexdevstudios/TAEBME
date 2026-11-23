import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { z } from 'zod';
import { requireActiveSession } from '@packages/auth/session';
import { defaultGameFiService } from '@packages/gamefi/gamefi-service';
import { getAuthoritativeGameFiChainConfig } from '@packages/gamefi/gamefi-chain-config';
import { defaultGameFiDbAdapter } from '@packages/shared/db-pool';
import { NftPassTier } from '@packages/shared/types/domain';

const ALLOWED_TIERS: readonly NftPassTier[] = ['BRONZE', 'SILVER', 'GOLD'] as const;

const VoucherResponseSchema = z.object({
  recipient: z.string(),
  tier: z.enum(['BRONZE', 'SILVER', 'GOLD']),
  nonce: z.string(),
  deadline: z.number(),
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
  metadataUri: z.string(),
  contractAddress: z.string(),
  chainId: z.number(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await requireActiveSession(req);

    const body = await req.json().catch(() => ({}));
    const { tier } = body || {};

    // 1. Strict tier allowlist validation
    if (!tier || !ALLOWED_TIERS.includes(tier as NftPassTier)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_TIER: Tier must be one of BRONZE, SILVER, GOLD' },
        { status: 400 }
      );
    }

    const userId = session.user.userId;
    const profile = await defaultGameFiDbAdapter.getUserGameFiProfile(userId, session.walletAddress);

    // 2. Authoritative XP threshold verification
    if (tier === 'SILVER' && profile.xp < 250) {
      return NextResponse.json(
        { success: false, error: 'INSUFFICIENT_XP: SILVER tier requires at least 250 XP' },
        { status: 403 }
      );
    }

    if (tier === 'GOLD' && profile.xp < 500) {
      return NextResponse.json(
        { success: false, error: 'INSUFFICIENT_XP: GOLD tier requires at least 500 XP' },
        { status: 403 }
      );
    }

    // 3. Authoritative PostgreSQL Collection SSOT Resolution.
    // Client-provided contract address override is strictly prohibited.
    // Silent fallback to environment variables without DB registry is strictly prohibited.
    let verifiedCollection;
    try {
      const chainConfig = getAuthoritativeGameFiChainConfig();
      const provider =
        defaultGameFiService.getProvider() ||
        (chainConfig.rpcUrl ? new ethers.JsonRpcProvider(chainConfig.rpcUrl) : null);

      verifiedCollection = await defaultGameFiService.resolveAndVerifyCollection({
        collectionName: 'RTrader Trader Pass',
        provider,
      });
    } catch (colErr: any) {
      const colMsg = colErr?.message || 'COLLECTION_RESOLUTION_FAILED';
      if (colMsg.startsWith('COLLECTION_NOT_FOUND')) {
        return NextResponse.json(
          {
            success: false,
            error: 'COLLECTION_NOT_FOUND: Authoritative collection is not registered in PostgreSQL SSOT. Fail closed.',
          },
          { status: 503 }
        );
      }
      if (
        colMsg.startsWith('COLLECTION_UNDEPLOYED') ||
        colMsg.startsWith('INVALID_CONTRACT_') ||
        colMsg.startsWith('AMBIGUOUS_COLLECTION_REGISTRY') ||
        colMsg.startsWith('PROVIDER_REQUIRED') ||
        colMsg.startsWith('CHAIN_MISMATCH') ||
        colMsg.startsWith('CONTRACT_NOT_DEPLOYED_ON_CHAIN') ||
        colMsg.startsWith('INTERFACE_VERIFICATION_FAILED') ||
        colMsg.startsWith('CONTRACT_METADATA_MISMATCH')
      ) {
        return NextResponse.json(
          {
            success: false,
            error: `COLLECTION_INVALID: ${colMsg}`,
          },
          { status: 503 }
        );
      }
      if (colMsg.startsWith('DATABASE_UNAVAILABLE')) {
        return NextResponse.json(
          {
            success: false,
            error: 'DATABASE_UNAVAILABLE: Database service temporarily unavailable. Please retry shortly.',
          },
          { status: 503 }
        );
      }
      throw colErr;
    }

    const contractAddress = verifiedCollection.contractAddress;
    const targetChainId = verifiedCollection.chainId;

    // 4. Invariant (Rule 3): Non-Custodial Guarantee.
    // NEVER store private keys, seed phrases, or custody user funds in Vercel environment variables.
    // Vercel serverless functions cannot hold or custody signing keys.
    // Production issuance delegates to an isolated external signer service (GAMEFI_SIGNER_SERVICE_URL).
    const signerServiceUrl = process.env.GAMEFI_SIGNER_SERVICE_URL;
    const isTestEnv = process.env.NODE_ENV === 'test';
    const testSignerKey = isTestEnv ? process.env.GAMEFI_VOUCHER_SIGNER_KEY : undefined;

    if (!signerServiceUrl && !testSignerKey) {
      return NextResponse.json(
        {
          success: false,
          error:
            'SIGNER_UNAVAILABLE: Isolated GameFi voucher signer service is unconfigured. Vercel cannot custody private keys (Rule 3). Fail closed.',
        },
        { status: 503 }
      );
    }

    if (signerServiceUrl) {
      try {
        const signRes = await fetch(`${signerServiceUrl}/sign-voucher`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.GAMEFI_SIGNER_API_KEY
              ? { Authorization: `Bearer ${process.env.GAMEFI_SIGNER_API_KEY}` }
              : {}),
          },
          body: JSON.stringify({
            recipient: session.walletAddress,
            tier,
            contractAddress,
            chainId: targetChainId,
          }),
          signal: AbortSignal.timeout(5000),
        });

        if (!signRes.ok) {
          return NextResponse.json(
            { success: false, error: 'SIGNER_SERVICE_ERROR: Isolated signer request failed' },
            { status: 502 }
          );
        }

        const data = await signRes.json().catch(() => ({}));
        const parseResult = VoucherResponseSchema.safeParse(data?.voucher);
        if (!parseResult.success) {
          return NextResponse.json(
            {
              success: false,
              error: 'SIGNER_INVALID_PAYLOAD: Remote signer response failed schema verification',
            },
            { status: 502 }
          );
        }

        return NextResponse.json({ success: true, voucher: parseResult.data });
      } catch (err: any) {
        if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT') {
          return NextResponse.json(
            { success: false, error: 'SIGNER_SERVICE_TIMEOUT: Isolated signer timed out after 5000ms' },
            { status: 504 }
          );
        }
        const safeError = err?.message?.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]') || 'Remote signer offline';
        return NextResponse.json(
          { success: false, error: `SIGNER_SERVICE_UNREACHABLE: ${safeError}` },
          { status: 502 }
        );
      }
    }

    // Local / Unit test signing path (NODE_ENV === 'test' only)
    const voucher = await defaultGameFiService.generateMintVoucher({
      recipientWallet: session.walletAddress,
      tier: tier as NftPassTier,
      signerPrivateKey: testSignerKey!,
      contractAddress,
      chainId: targetChainId,
      ttlSeconds: 600,
    });

    return NextResponse.json({
      success: true,
      voucher,
    });
  } catch (err: any) {
    const msg = err?.message || 'MINT_VOUCHER_FAILED';
    if (msg.startsWith('UNAUTHORIZED')) {
      return NextResponse.json({ success: false, error: msg }, { status: 401 });
    }
    if (msg.startsWith('AUTH_ACCOUNT_') || msg.startsWith('FORBIDDEN') || msg.startsWith('RBAC_FORBIDDEN')) {
      return NextResponse.json({ success: false, error: msg }, { status: 403 });
    }
    if (msg.startsWith('DATABASE_UNAVAILABLE')) {
      return NextResponse.json({ success: false, error: 'DATABASE_UNAVAILABLE: Database service temporarily unavailable. Please retry shortly.' }, { status: 503 });
    }
    return NextResponse.json(
      { success: false, error: 'MINT_VOUCHER_FAILED' },
      { status: 500 }
    );
  }
}
