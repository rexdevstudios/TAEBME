/**
 * app/api/trading/wallet-risk/route.ts
 *
 * Public Read-Only Free On-Chain Wallet Risk Profiling Endpoint ($0/mo — Phase BY).
 * - Powered by GoPlus Address Security + Public EVM RPC Maturity + Curated Public Registry + 24h Redis cache.
 * - Replaces paid Arkham Enterprise API for counterparty, KOL, and creator wallet checks.
 * - Strictly rate-limited (30 req/min/IP) and validated.
 */

import { NextRequest, NextResponse } from 'next/server';
import { rateLimiter } from '@packages/auth/rate-limiter';
import {
  isSupportedGoPlusChainId,
  isValidEvmAddress,
  SUPPORTED_GOPLUS_CHAIN_IDS,
} from '@packages/intelligence/onchain-insider-guard';
import { fetchFreeWalletProfile } from '@packages/intelligence/free-wallet-intelligence';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:trading:wallet-risk:${ip}`, 30, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: 'TOO_MANY_REQUESTS: Wallet risk lookup rate limit exceeded',
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
          error: 'INVALID_ADDRESS: Provide a valid 42-char EVM wallet address (0x...)',
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

    const profile = await fetchFreeWalletProfile({ address, chainId });

    return NextResponse.json(
      {
        success: true,
        data: profile,
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
        error: `WALLET_RISK_ERROR: ${err instanceof Error ? err.message : String(err)}`,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
