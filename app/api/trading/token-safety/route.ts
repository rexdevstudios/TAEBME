/**
 * app/api/trading/token-safety/route.ts
 *
 * Public Read-Only On-Chain Anti-Insider, Wallet Cluster & Honeypot Audit Endpoint (Phase BW).
 * - Powered by GoPlus Security Public API + 15-minute Upstash Redis cache ($0 cost).
 * - Strictly rate-limited (30 req/min/IP) and validated (EVM address + supported 6 EVM chains).
 */

import { NextRequest, NextResponse } from 'next/server';
import { rateLimiter } from '@packages/auth/rate-limiter';
import {
  fetchOnChainTokenSecurity,
  isSupportedGoPlusChainId,
  isValidEvmAddress,
  SUPPORTED_GOPLUS_CHAIN_IDS,
} from '@packages/intelligence/onchain-insider-guard';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:trading:token-safety:${ip}`, 30, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: 'TOO_MANY_REQUESTS: Token safety lookup rate limit exceeded',
          timestamp: new Date().toISOString(),
        },
        { status: 429 }
      );
    }

    const { searchParams } = new URL(req.url);
    const address = String(searchParams.get('address') || '').trim();
    const chainIdRaw = searchParams.get('chainId');
    const chainId = chainIdRaw !== null && chainIdRaw !== '' ? Number(chainIdRaw) : 8453;

    if (!isValidEvmAddress(address)) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_ADDRESS: Provide a valid 42-char EVM token contract address (0x...)',
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    if (!Number.isInteger(chainId) || !isSupportedGoPlusChainId(chainId)) {
      return NextResponse.json(
        {
          success: false,
          error: `UNSUPPORTED_CHAIN: Supported EVM chainIds are ${SUPPORTED_GOPLUS_CHAIN_IDS.join(', ')}`,
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    const report = await fetchOnChainTokenSecurity({ address, chainId });

    return NextResponse.json(
      {
        success: true,
        data: report,
        timestamp: new Date().toISOString(),
      },
      {
        status: 200,
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        },
      }
    );
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: `TOKEN_SAFETY_ERROR: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
