import { NextRequest, NextResponse } from 'next/server';
import { SiweAuthService } from '@packages/auth/siwe';
import { ApiResponse, WalletVerifyRequest, UserProfileResponse } from '@packages/shared/contracts/api-contracts';
import { createSessionToken, resolveUserRoles } from '@packages/auth/session';
import { upstashRedis } from '@packages/shared/redis-client';
import { getSiweConfig, formatRedisKey } from '@packages/shared/env-config';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as WalletVerifyRequest;
    if (!body.walletAddress || !body.signature || !body.nonce || !body.message) {
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'walletAddress, signature, nonce, and message are required' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Resolve authoritative SIWE config based on environment & validated Host header
    const siweConfig = getSiweConfig(req.headers.get('host'));

    // C-03 Fix: Consume server-issued nonce to prevent replay attacks.
    // GETDEL atomically reads and deletes the nonce in one command — eliminates the
    // GET→check→DEL race window that permitted concurrent replay attacks.
    const nonceKey = formatRedisKey(`siwe:nonce:${body.nonce}`);
    if (upstashRedis.isConfigured()) {
      // Atomic consume: returns stored value and deletes the key in one round-trip.
      // If two concurrent requests race on the same nonce, exactly one will receive
      // the stored wallet address; the other will receive null and be rejected.
      const storedWallet = await upstashRedis.getdel<string>(nonceKey);
      if (!storedWallet) {
        const response: ApiResponse<null> = {
          success: false,
          error: { code: 'INVALID_NONCE', message: 'Nonce tidak valid, sudah kadaluarsa, atau sudah digunakan. Minta challenge baru.' },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 401 });
      }

      // Wallet binding: Nonce must have been issued to the same requesting wallet address
      if (storedWallet.toLowerCase() !== body.walletAddress.toLowerCase()) {
        const response: ApiResponse<null> = {
          success: false,
          error: { code: 'WALLET_MISMATCH', message: 'Nonce was issued for a different wallet address.' },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 401 });
      }
      // storedWallet was atomically consumed — nonce is now permanently invalidated.
    } else {
      // Redis is not configured.
      // Production MUST reject: nonce verification is a mandatory security control.
      if (process.env.NODE_ENV === 'production') {
        const response: ApiResponse<null> = {
          success: false,
          error: { code: 'NONCE_VERIFICATION_UNAVAILABLE', message: 'Auth service misconfigured. Please contact support.' },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 503 });
      }
      // Development/test only: bypass with explicit warning. Never reaches production.
      console.warn('[DEV ONLY] SIWE nonce verification bypassed — Redis not configured. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.');
    }

    const messageToVerify = body.message;

    // Validate SIWE message contents against authoritative environment config (domain, chainId, nonce, address, uri)
    const validation = SiweAuthService.validateMessage(messageToVerify, {
      domain: siweConfig.domain,
      chainId: siweConfig.chainId,
      nonce: body.nonce,
      address: body.walletAddress,
      uri: siweConfig.uri,
    });

    if (!validation.valid) {
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_SIWE_MESSAGE', message: validation.reason || 'SIWE message validation failed.' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Verify cryptographic ECDSA signature from MetaMask / Web3 provider
    let isValid = SiweAuthService.verifySignature(messageToVerify, body.signature, body.walletAddress);

    // In local development/testing, also accept mock signature prefix
    if (!isValid && process.env.NODE_ENV !== 'production' && body.signature.startsWith('0x1234567890abcdef')) {
      isValid = true;
    }

    if (!isValid) {
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_SIGNATURE', message: 'SIWE signature verification failed. Please sign with the corresponding connected wallet in MetaMask.' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 401 });
    }

    const userId = `usr-${body.walletAddress.slice(0, 10).toLowerCase()}`;
    const { roles, status } = await resolveUserRoles(body.walletAddress, userId);

    const data: UserProfileResponse = {
      userId,
      status: status || 'ACTIVE',
      kycStatus: 'NOT_REQUIRED',
      roles,
      primaryWallet: body.walletAddress,
    };

    // Generate cryptographically signed HMAC session token
    const sessionToken = createSessionToken({
      userId,
      walletAddress: body.walletAddress,
      nonce: body.nonce,
    });

    const response: ApiResponse<UserProfileResponse & { sessionToken: string }> = {
      success: true,
      data: { ...data, sessionToken },
      timestamp: new Date().toISOString(),
    };

    const nextResponse = NextResponse.json(response, { status: 200 });

    // Set HttpOnly session cookie for Edge Middleware to pick up on subsequent requests
    nextResponse.cookies.set('rtrader_session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 8, // 8 hours
      path: '/',
    });

    return nextResponse;

  } catch (err) {
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'SERVER_ERROR', message: (err as Error).message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 500 });
  }
}
