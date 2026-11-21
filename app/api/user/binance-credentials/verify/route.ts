/**
 * app/api/user/binance-credentials/verify/route.ts
 *
 * Stateless Live Ping & Read-Only Permission Verifier for Stored Binance CEX Accounts.
 * - Requires authenticated SIWE session (`CONNECT_WALLET`).
 * - Strictly isolates lookup to the authenticated user's own `credentialId`.
 * - Decrypts in-memory using `BinanceCredentialVault.decrypt`, calls Binance `GET /api/v3/account`,
 *   and returns ONLY boolean capability telemetry (`canTrade`, `canWithdraw`, `latencyMs`) — NEVER raw keys.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { getDbPool, PostgresBinanceExecutionDbAdapter } from '@packages/shared/db-pool';
import { BinanceCredentialVault, verifyBinanceCredentialLive } from '@packages/trading/binance-vault';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:binance-vault:ping:${ip}`, 20, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Verification rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let auth;
    try {
      auth = await requireCapability(req, 'CONNECT_WALLET');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const credentialId = typeof body?.credentialId === 'string' ? body.credentialId.trim() : '';
    if (!credentialId) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: credentialId is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const pool = getDbPool();
    if (!pool) {
      return NextResponse.json(
        { success: false, error: 'DATABASE_UNAVAILABLE: PostgreSQL pool is required', timestamp: new Date().toISOString() },
        { status: 503 }
      );
    }

    const adapter = new PostgresBinanceExecutionDbAdapter(pool);
    const creds = await adapter.getBinanceCredentials(auth.walletAddress, credentialId);
    if (!creds || creds.isActive === false) {
      return NextResponse.json(
        { success: false, error: 'NOT_FOUND_OR_FORBIDDEN: Binance account not found in your vault', timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }

    const masterKeyHex = PostgresBinanceExecutionDbAdapter.resolveMasterKeyHex();
    const apiKey = await BinanceCredentialVault.decrypt(creds.encryptedApiKey, masterKeyHex, auth.walletAddress, creds.id, adapter);
    const secretKey = await BinanceCredentialVault.decrypt(creds.encryptedSecretKey, masterKeyHex, auth.walletAddress, creds.id, adapter);

    const pingResult = await verifyBinanceCredentialLive({
      apiKey,
      secretKey,
      environment: creds.environment === 'MAINNET' ? 'MAINNET' : 'TESTNET',
    });

    await adapter.touchBinanceCredentialLastUsed(creds.id);

    await adapter.createAuditLog(
      auth.walletAddress,
      'BINANCE_CREDENTIAL_VERIFIED',
      creds.id,
      pingResult.connected
        ? `Ping OK (${pingResult.environment}, canTrade=${pingResult.canTrade}, canWithdraw=${pingResult.canWithdraw}, ${pingResult.latencyMs}ms)`
        : `Ping FAILED (${pingResult.environment}): ${pingResult.error || 'unknown'}`
    );

    return NextResponse.json(
      {
        success: true,
        data: {
          credentialId: creds.id,
          label: creds.label || 'Binance Primary',
          ...pingResult,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'BINANCE_PING_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
