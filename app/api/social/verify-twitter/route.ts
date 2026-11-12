import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { KolService } from '@packages/social/kol-service';

/**
 * POST /api/social/verify-twitter
 *
 * SEC-01 HARDENED: Requires server-issued single-use `nonce` from
 * POST /api/social/attest-nonce in addition to timestamp and signature.
 *
 * Validation order (fail-fast, fail-closed):
 *   1. Input presence check (walletAddress, twitterHandle, signature, timestamp, nonce)
 *   2. Handle format validation
 *   3. Timestamp mandatory check (TIMESTAMP_REQUIRED if absent/invalid)
 *   4. Nonce consumption via GETDEL (atomic; replay = reject immediately)
 *   5. Signature verification via verifySocialAttestation()
 *
 * NOTE: Nonce is consumed BEFORE signature verification so that a replay attempt
 * fails even if the attacker has a valid signature for an expired nonce.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { walletAddress, twitterHandle, signature, timestamp, nonce } = body;

    if (!walletAddress || !twitterHandle) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'walletAddress and twitterHandle are required' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 400 });
    }

    // SEC-03: Normalize handle to lowercase at API boundary
    const cleanHandle = String(twitterHandle).replace(/^@/, '').trim().toLowerCase();
    if (!KolService.isValidTwitterHandle(cleanHandle)) {
      const res: ApiResponse<null> = {
        success: false,
        error: {
          code: 'INVALID_TWITTER_HANDLE',
          message: 'Twitter handle must be 1-15 characters containing only letters, numbers, and underscores',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 400 });
    }

    // B-06 Hardening: Require cryptographic signature attestation
    if (!signature) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Cryptographic social attestation signature is required' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 400 });
    }

    // SEC-01: Timestamp is now MANDATORY — no legacy fallback
    if (timestamp === undefined || timestamp === null || timestamp === '') {
      const res: ApiResponse<null> = {
        success: false,
        error: {
          code: 'TIMESTAMP_REQUIRED',
          message: 'timestamp is required. Sign the attestation message that includes a server-provided timestamp.',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 400 });
    }
    const parsedTimestamp = Number(timestamp);
    if (isNaN(parsedTimestamp) || parsedTimestamp <= 0) {
      const res: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_TIMESTAMP', message: 'timestamp must be a positive integer (Unix ms)' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 400 });
    }

    // SEC-01: Nonce is MANDATORY — no attestation without server-issued nonce
    if (!nonce || typeof nonce !== 'string' || nonce.trim() === '') {
      const res: ApiResponse<null> = {
        success: false,
        error: {
          code: 'NONCE_REQUIRED',
          message: 'nonce is required. Obtain a single-use nonce from POST /api/social/attest-nonce first.',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 400 });
    }

    // SEC-01: Consume nonce FIRST (atomic GETDEL) before signature check.
    // If nonce was already used, or does not exist (expired), reject immediately.
    // This ensures replay attacks fail even if the attacker has a valid signature.
    const nonceValid = await KolService.consumeAttestationNonce(String(walletAddress), cleanHandle, String(nonce));
    if (!nonceValid) {
      const res: ApiResponse<null> = {
        success: false,
        error: {
          code: 'NONCE_INVALID',
          message:
            'Nonce is invalid, expired, or has already been used. Request a new nonce from POST /api/social/attest-nonce.',
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 401 });
    }

    // Signature verification (nonce already consumed — this cannot be replayed)
    // SEC-01: nonce is passed so verifySocialAttestation reconstructs the full
    // message (wallet+handle+timestamp+nonce) for ECDSA recovery.
    const verification = KolService.verifySocialAttestation(
      String(walletAddress),
      cleanHandle,
      String(signature),
      parsedTimestamp,
      String(nonce)  // SEC-01: nonce is part of the signed message for cryptographic binding
    );
    if (!verification.isValid) {
      const res: ApiResponse<null> = {
        success: false,
        error: {
          code: verification.reason || 'INVALID_SIGNATURE',
          message: `Cryptographic social attestation failed: ${verification.reason}`,
        },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(res, { status: 401 });
    }

    const response: ApiResponse<{
      walletAddress: string;
      twitterHandle: string;
      isWalletAttested: boolean;
      isVerified: boolean;
      verifiedAt: string;
      attestationMessage: string;
      note: string;
    }> = {
      success: true,
      data: {
        walletAddress,
        twitterHandle: cleanHandle,
        isWalletAttested: true,
        // Proves wallet intent; official Twitter ownership requires Twitter OAuth or verified Tweet Proof
        isVerified: false,
        verifiedAt: new Date().toISOString(),
        attestationMessage: KolService.getAttestationMessage(String(walletAddress), cleanHandle, parsedTimestamp, String(nonce)),
        note: 'Wallet intent successfully attested. Twitter ownership verification is pending OAuth or tweet proof.',
      },
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (error) {
    const res: ApiResponse<null> = {
      success: false,
      error: { code: 'VERIFICATION_ERROR', message: (error as Error).message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(res, { status: 500 });
  }
}
