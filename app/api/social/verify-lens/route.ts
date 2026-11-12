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
    const { walletAddress, handle, profileId } = body;

    const targetWallet = session.walletAddress;
    if (walletAddress && ethers.getAddress(walletAddress).toLowerCase() !== ethers.getAddress(targetWallet).toLowerCase()) {
      return NextResponse.json(
        { success: false, error: 'FORBIDDEN: Cannot verify Lens credentials for another wallet address' },
        { status: 403 }
      );
    }

    if (!handle || typeof handle !== 'string' || handle.trim().length < 3) {
      return NextResponse.json(
        { success: false, error: 'INVALID_HANDLE: Valid Lens handle required' },
        { status: 400 }
      );
    }

    const verification = await FarcasterLensService.verifyLensProfile({
      walletAddress: targetWallet,
      handle,
      profileId,
    });

    if (!verification.isValid) {
      const isUnavailable = verification.reason?.startsWith('FEATURE_UNAVAILABLE');
      return NextResponse.json(
        { success: false, error: verification.reason || 'LENS_VERIFICATION_FAILED' },
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


