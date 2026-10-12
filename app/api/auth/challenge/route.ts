import { NextRequest, NextResponse } from 'next/server';
import { SiweAuthService } from '@packages/auth/siwe';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { ApiResponse, WalletChallengeRequest, WalletChallengeResponse } from '@packages/shared/contracts/api-contracts';
import { upstashRedis } from '@packages/shared/redis-client';
import { getSiweConfig, formatRedisKey } from '@packages/shared/env-config';

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    
    // Rate Limiting (FAIL_CLOSED in production, graceful in dev/test)
    const ratePolicy = process.env.NODE_ENV === 'production' ? 'FAIL_CLOSED' : 'FAIL_OPEN';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:auth:challenge:${ip}`, 10, 60, ratePolicy);
    if (!rateCheck.allowed) {
      if (rateCheck.error === 'RATE_LIMITER_UNAVAILABLE') {
        const response: ApiResponse<null> = {
          success: false,
          error: { code: 'SERVICE_UNAVAILABLE', message: 'Rate limiter unavailable. Please retry later.' },
          timestamp: new Date().toISOString(),
        };
        return NextResponse.json(response, { status: 503 });
      }
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'TOO_MANY_REQUESTS', message: 'Rate limit exceeded for challenge requests. Please try again later.' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 429 });
    }

    const body = (await req.json()) as WalletChallengeRequest;
    if (!body.walletAddress) {
      const response: ApiResponse<null> = {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'walletAddress is required' },
        timestamp: new Date().toISOString(),
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Resolve authoritative SIWE config based on environment & validated Host header
    const siweConfig = getSiweConfig(req.headers.get('host'));

    const challengeResult = SiweAuthService.generateChallenge(
      siweConfig.domain,
      body.walletAddress,
      siweConfig.uri,
      siweConfig.chainId
    );

    if (!upstashRedis.isConfigured()) {
      if (process.env.NODE_ENV === 'production') {
        console.warn('[SECURITY] SIWE nonce replay protection disabled: UPSTASH_REDIS_REST_URL not configured in production!');
      }
    } else {
      // Store nonce server-side with environment namespace (TTL: 12 min, 2 min grace)
      const nonceKey = formatRedisKey(`siwe:nonce:${challengeResult.challenge.nonce}`);
      await upstashRedis.set(nonceKey, body.walletAddress.toLowerCase(), 720);
    }

    const data: WalletChallengeResponse = {
      nonce: challengeResult.challenge.nonce,
      messageToSign: challengeResult.messageText,
      expiresAt: challengeResult.challenge.expirationTime,
    };

    const response: ApiResponse<WalletChallengeResponse> = {
      success: true,
      data,
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'SERVER_ERROR', message: (err as Error).message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 500 });
  }
}
