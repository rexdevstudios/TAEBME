import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { KolService } from '@packages/social/kol-service';
import { ArkhamIntelligenceService } from '@packages/intelligence/arkham-enrichment';
import { KolProfile } from '@packages/shared/types/domain';
import { defaultKolDbAdapter, HandleConflictError } from '@packages/shared/db-pool';


export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId') || searchParams.get('walletAddress');

  if (!userId) {
    const res: ApiResponse<null> = {
      success: false,
      error: { code: 'MISSING_USER_ID', message: 'userId or walletAddress parameter is required' },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(res, { status: 400 });
  }

  const profile = await defaultKolDbAdapter.getKolProfile(userId);
  const response: ApiResponse<KolProfile | null> = {
    success: true,
    data: profile,
    timestamp: new Date().toISOString(),
  };
  return NextResponse.json(response);
}

import { authenticateSession } from '@packages/auth/session';

import { FarcasterLensService } from '@packages/social/farcaster-lens-service';

export async function POST(req: NextRequest) {
  try {
    // SG-02: Require valid authenticated session
    const session = await authenticateSession(req);
    if (!session) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Valid SIWE session required to manage KOL profile' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { userId, walletAddress, twitterHandle, followersCount, farcasterFid, farcasterUsername, lensHandle } = body;

    const authoritativeUserId = session.user.userId;
    const authoritativeWallet = session.walletAddress;

    // Reject explicit identity spoofing / cross-user tampering
    if (userId && userId !== authoritativeUserId && userId.toLowerCase() !== authoritativeWallet.toLowerCase()) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'FORBIDDEN', message: 'Cannot create or modify a profile for another user' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 403 });
    }

    if (walletAddress && walletAddress.toLowerCase() !== authoritativeWallet.toLowerCase()) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'FORBIDDEN', message: 'Cannot create or modify a profile for another wallet' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 403 });
    }

    if (!twitterHandle || typeof twitterHandle !== 'string') {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'twitterHandle is required and must be a string' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 400 });
    }

    // SEC-03: Normalize handle to lowercase at the API boundary
    const cleanHandle = String(twitterHandle).replace(/^@/, '').trim().toLowerCase();
    if (!KolService.isValidTwitterHandle(cleanHandle)) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_TWITTER_HANDLE', message: 'Twitter handle must be 1-15 characters containing only letters, numbers, and underscores' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 400 });
    }

    // Handle conflict check to prevent handle squatting against other users
    const existingWithHandle = await defaultKolDbAdapter.getKolProfile(cleanHandle);
    if (existingWithHandle && existingWithHandle.userId.toLowerCase() !== authoritativeUserId.toLowerCase()) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'HANDLE_CONFLICT', message: 'Twitter handle is already associated with another profile' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 409 });
    }

    const arkham = new ArkhamIntelligenceService();
    const service = new KolService(defaultKolDbAdapter, arkham);

    // B-06 Hardening: Client cannot supply arbitrary followersCount or self-verify.
    // Preserve existing verified followersCount if profile exists, otherwise initialize to 0.
    const existing = await defaultKolDbAdapter.getKolProfile(authoritativeUserId);
    const resolvedFollowers = existing ? existing.followersCount : 0;

    // Verify asserted Web3 identities against authoritative providers before granting reputation
    let isWeb3Verified = false;
    let validatedFid: number | undefined;
    let validatedFarcasterUser: string | undefined;
    let validatedLens: string | undefined;

    if (farcasterFid) {
      const fcRes = await FarcasterLensService.verifyFarcasterAccount({
        walletAddress: authoritativeWallet,
        fid: Number(farcasterFid),
        username: farcasterUsername ? String(farcasterUsername) : undefined,
      });
      if (fcRes.isValid) {
        isWeb3Verified = true;
        validatedFid = fcRes.profile?.farcasterFid;
        validatedFarcasterUser = fcRes.profile?.farcasterUsername;
      }
    }

    if (lensHandle) {
      const lensRes = await FarcasterLensService.verifyLensProfile({
        walletAddress: authoritativeWallet,
        handle: String(lensHandle),
      });
      if (lensRes.isValid) {
        isWeb3Verified = true;
        validatedLens = lensRes.profile?.lensHandle;
      }
    }

    const profile = await service.registerOrUpdateKol(
      authoritativeUserId,
      authoritativeWallet,
      cleanHandle,
      resolvedFollowers,
      validatedFid,
      validatedFarcasterUser,
      validatedLens,
      isWeb3Verified
    );

    const response: ApiResponse<KolProfile> = {
      success: true,
      data: profile,
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    // SEC-02: Catch twitter_handle uniqueness conflict from PostgreSQL (error 23505)
    // specifically and map it to HTTP 409. All other errors remain HTTP 400.
    if (error instanceof HandleConflictError) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'HANDLE_CONFLICT', message: 'Twitter handle is already associated with another profile' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 409 });
    }
    const res: ApiResponse<null> = {
      success: false,
      error: { code: 'REGISTRATION_FAILED', message: (error as Error).message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(res, { status: 400 });
  }
}
