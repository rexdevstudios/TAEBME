import { NextRequest, NextResponse } from 'next/server';
import { FarcasterLensService } from '@/packages/social/farcaster-lens-service';
import { authenticateSession } from '@/packages/auth/session';
import { ethers } from 'ethers';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    // 1. SIWE Session Authentication (Fail-Closed)
    const session = await authenticateSession(req);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'UNAUTHORIZED: Valid cryptographic SIWE session required' },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { walletAddress, fid, username, custodyAddress } = body;

    const targetWallet = session.walletAddress;
    if (walletAddress && ethers.getAddress(walletAddress).toLowerCase() !== ethers.getAddress(targetWallet).toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'FORBIDDEN: Cannot verify Farcaster credentials for another wallet address' },
        { status: 403 }
      );
    }

    if (fid !== undefined && (isNaN(Number(fid)) || Number(fid) <= 0)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_FARCASTER_FID: Positive numeric FID required' },
        { status: 400 }
      );
    }

    if (username !== undefined && (typeof username !== 'string' || username.trim().length < 2)) {
      return NextResponse.json(
        { success: false, error: 'INVALID_FARCASTER_USERNAME: Valid username required' },
        { status: 400 }
      );
    }

    const verification = await FarcasterLensService.verifyFarcasterAccount({
      walletAddress: targetWallet,
      fid: fid ? Number(fid) : undefined,
      username: username ? String(username) : undefined,
      custodyAddress: custodyAddress ? String(custodyAddress) : undefined,
    });

    if (!verification.isValid) {
      const isUnavailable = verification.reason?.startsWith('FEATURE_UNAVAILABLE');
      return NextResponse.json(
        { success: false, error: verification.reason || 'FARCASTER_VERIFICATION_FAILED' },
        { status: isUnavailable ? 503 : 422 }
      );
    }

    return NextResponse.json({
      success: true,
      data: verification.profile,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || 'INTERNAL_ERROR' },
      { status: 500 }
    );
  }
}


