/**
 * app/api/user/owned-wallets/route.ts
 *
 * Multi-Owned Sub-Wallet Allowlist API with Cryptographic Proof-of-Ownership (Phase EG).
 * - GET: Lists authenticated user's verified owned wallets (primary + linked sub-wallets).
 *        When `?challengeFor=0x...` is provided, issues a 10-minute HMAC-bound challenge message
 *        to be signed by the target sub-wallet.
 * - POST: Verifies ECDSA signature via ethers.verifyMessage() and links the sub-wallet into `public.wallets`.
 * - DELETE ?address=0x...: Unlinks a non-primary sub-wallet owned by the authenticated user.
 * - 100% Non-Custodial: Zero private keys or seed phrases ever accepted.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import {
  linkVerifiedOwnedSubWallet,
  listUserOwnedWallets,
  unlinkOwnedSubWallet,
} from '@packages/shared/db-pool';
import {
  buildOwnedSubWalletChallenge,
  verifyOwnedSubWalletProof,
} from '@packages/agent/owned-wallet-proof';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireCapability(req, 'CONNECT_WALLET');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const challengeFor = (searchParams.get('challengeFor') || '').trim();

    if (challengeFor) {
      try {
        const challenge = buildOwnedSubWalletChallenge({
          primaryWallet: auth.walletAddress,
          subWalletAddress: challengeFor,
        });
        return NextResponse.json(
          { success: true, data: { challenge }, timestamp: new Date().toISOString() },
          { status: 200, headers: { 'Cache-Control': 'no-store' } }
        );
      } catch (err: unknown) {
        return NextResponse.json(
          {
            success: false,
            error: err instanceof Error ? err.message : 'INVALID_CHALLENGE_REQUEST',
            timestamp: new Date().toISOString(),
          },
          { status: 400 }
        );
      }
    }

    const wallets = await listUserOwnedWallets(auth.walletAddress);
    return NextResponse.json(
      {
        success: true,
        data: {
          primaryWallet: auth.walletAddress.toLowerCase(),
          wallets,
          count: wallets.length,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'OWNED_WALLETS_READ_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:owned-wallets:write:${ip}`, 15, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Owned wallet verification rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let auth;
    try {
      auth = await requireCapability(req, 'CONNECT_WALLET');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const subWalletAddress = typeof body?.subWalletAddress === 'string' ? body.subWalletAddress.trim() : '';
    const signature = typeof body?.signature === 'string' ? body.signature.trim() : '';
    const challengeToken = typeof body?.challengeToken === 'string' ? body.challengeToken.trim() : '';
    const message = typeof body?.message === 'string' ? body.message : undefined;

    const verify = verifyOwnedSubWalletProof({
      primaryWallet: auth.walletAddress,
      subWalletAddress,
      signature,
      challengeToken,
      message,
    });

    if (!verify.valid || !verify.normalizedSubWallet) {
      const isSigOrToken =
        verify.code === 'INVALID_SIGNATURE' ||
        verify.code === 'INVALID_CHALLENGE_TOKEN' ||
        verify.code === 'CHALLENGE_EXPIRED' ||
        verify.code === 'CHALLENGE_BINDING_MISMATCH';
      return NextResponse.json(
        {
          success: false,
          error: verify.reason || 'INVALID_OWNED_WALLET_PROOF',
          code: verify.code,
          timestamp: new Date().toISOString(),
        },
        { status: isSigOrToken ? 401 : 400 }
      );
    }

    const linked = await linkVerifiedOwnedSubWallet({
      userIdentifier: auth.walletAddress,
      subWalletAddress: verify.normalizedSubWallet,
    });

    return NextResponse.json(
      {
        success: true,
        data: { wallet: linked },
        timestamp: new Date().toISOString(),
      },
      { status: 201, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'OWNED_WALLET_LINK_ERROR';
    const isConflict = msg.includes('WALLET_ALREADY_CLAIMED_BY_ANOTHER_ACCOUNT');
    const isLimit = msg.includes('MAX_SUBWALLETS_REACHED') || msg.includes('INVALID_SUBWALLET_ADDRESS');
    return NextResponse.json(
      { success: false, error: msg, timestamp: new Date().toISOString() },
      { status: isConflict ? 409 : isLimit ? 400 : 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:owned-wallets:del:${ip}`, 20, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Owned wallet delete rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let auth;
    try {
      auth = await requireCapability(req, 'CONNECT_WALLET');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const address = (searchParams.get('address') || '').trim();
    if (!address) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: address query param is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const result = await unlinkOwnedSubWallet({
      userIdentifier: auth.walletAddress,
      subWalletAddress: address,
    });

    return NextResponse.json(
      { success: true, data: result, timestamp: new Date().toISOString() },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'OWNED_WALLET_DELETE_ERROR';
    const isNotFound = msg.includes('SUBWALLET_NOT_FOUND_OR_PRIMARY_PROTECTED');
    const isBadReq = msg.includes('INVALID_SUBWALLET_ADDRESS');
    return NextResponse.json(
      { success: false, error: msg, timestamp: new Date().toISOString() },
      { status: isNotFound ? 404 : isBadReq ? 400 : 500 }
    );
  }
}
