/**
 * app/api/user/binance-credentials/route.ts
 *
 * Multi-Account Non-Withdrawal Binance CEX Credential Vault Endpoint.
 * - Requires authenticated SIWE session (`CONNECT_WALLET` capability).
 * - Write-only: NEVER returns plaintext or encrypted API keys/secrets in any response.
 * - Reuses `BinanceCredentialVault` (AES-256-GCM), `validateBinancePermissions` (rejects withdraw=true),
 *   and `assertNotPrivateKeyOrMnemonic` (`AGENTS.md` Rule 3).
 * - Strictly isolates all read/write/default/revoke operations to the authenticated user.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { defaultBillingDbAdapter, getDbPool, PostgresBinanceExecutionDbAdapter } from '@packages/shared/db-pool';
import {
  annotateKeysWithQuotaStatus,
  computeEffectiveVaultCapacity,
} from '@packages/billing/subscriptions-engine';

export const dynamic = 'force-dynamic';

async function authenticateVaultUser(req: NextRequest) {
  return await requireCapability(req, 'CONNECT_WALLET');
}

function getAdapterOrFail(): PostgresBinanceExecutionDbAdapter {
  const pool = getDbPool();
  if (!pool) {
    throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required for Binance credential vault');
  }
  return new PostgresBinanceExecutionDbAdapter(pool);
}

export async function GET(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await authenticateVaultUser(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const adapter = getAdapterOrFail();
    const [rawAccounts, planId, addonSlots] = await Promise.all([
      adapter.listBinanceCredentials(auth.walletAddress),
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
      defaultBillingDbAdapter.getUserAddonSlots(auth.walletAddress).catch(() => ({ bankrExtraSlots: 0, binanceExtraSlots: 0 })),
    ]);
    const effCap = computeEffectiveVaultCapacity(planId, addonSlots);
    const accounts = annotateKeysWithQuotaStatus(rawAccounts, {
      maxActive: effCap.maxBinanceAccounts,
      allowMainnet: effCap.allowMainnetBinance,
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          provider: 'BINANCE',
          planId: effCap.planId,
          maxAccounts: effCap.maxBinanceAccounts,
          addonSlots: effCap.binanceExtraSlots,
          allowMainnet: effCap.allowMainnetBinance,
          accounts,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'BINANCE_VAULT_READ_ERROR';
    const isUnavailable = msg.startsWith('DATABASE_UNAVAILABLE');
    return NextResponse.json(
      { success: false, error: msg, timestamp: new Date().toISOString() },
      { status: isUnavailable ? 503 : 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:binance-vault:write:${ip}`, 15, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Binance vault rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let auth;
    try {
      auth = await authenticateVaultUser(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    const secretKey = typeof body?.secretKey === 'string' ? body.secretKey.trim() : '';
    const environment = typeof body?.environment === 'string' ? body.environment.trim().toUpperCase() : 'TESTNET';
    const isDefault = Boolean(body?.isDefault);
    const permissions = {
      read: body?.permissions?.read !== false,
      trade: body?.permissions?.trade !== false,
      withdraw: Boolean(body?.permissions?.withdraw),
    };

    const [planId, addonSlots] = await Promise.all([
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
      defaultBillingDbAdapter.getUserAddonSlots(auth.walletAddress).catch(() => ({ bankrExtraSlots: 0, binanceExtraSlots: 0 })),
    ]);
    const effCap = computeEffectiveVaultCapacity(planId, addonSlots);

    if (environment === 'MAINNET' && !effCap.allowMainnetBinance) {
      return NextResponse.json(
        {
          success: false,
          error: `PLAN_MAINNET_REQUIRED: Paket ${effCap.planId} hanya mendukung Binance TESTNET. Upgrade ke TRADER atau AGENT di /billing untuk akun MAINNET.`,
          timestamp: new Date().toISOString(),
        },
        { status: 403 }
      );
    }

    const adapter = getAdapterOrFail();
    const created = await adapter.addBinanceCredential({
      userId: auth.walletAddress,
      label,
      rawApiKey: apiKey,
      rawSecretKey: secretKey,
      environment,
      permissions,
      isDefault,
      maxAllowed: effCap.maxBinanceAccounts,
    });

    return NextResponse.json(
      {
        success: true,
        data: created,
        timestamp: new Date().toISOString(),
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'BINANCE_VAULT_WRITE_ERROR';
    const isBadInput =
      msg.startsWith('FORBIDDEN_PRIVATE_KEY') ||
      msg.startsWith('SECURITY_REJECT_WITHDRAWAL') ||
      msg.startsWith('INVALID_') ||
      msg.startsWith('MAX_KEYS_REACHED');
    const isUnavailable = msg.startsWith('DATABASE_UNAVAILABLE');
    return NextResponse.json(
      { success: false, error: msg, timestamp: new Date().toISOString() },
      { status: isBadInput ? 400 : isUnavailable ? 503 : 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await authenticateVaultUser(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      return NextResponse.json(
        { success: false, error: `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: 401 }
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

    const adapter = getAdapterOrFail();
    const updated = await adapter.setDefaultBinanceCredential(auth.walletAddress, credentialId);
    if (!updated) {
      return NextResponse.json(
        { success: false, error: 'NOT_FOUND_OR_FORBIDDEN: Binance account not found in your vault', timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: true, data: { credentialId, isDefault: true }, timestamp: new Date().toISOString() },
      { status: 200 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'BINANCE_VAULT_UPDATE_ERROR';
    return NextResponse.json(
      { success: false, error: msg, timestamp: new Date().toISOString() },
      { status: msg.startsWith('DATABASE_UNAVAILABLE') ? 503 : 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await authenticateVaultUser(req);
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      return NextResponse.json(
        { success: false, error: `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    let credentialId = (searchParams.get('credentialId') || '').trim();
    if (!credentialId) {
      const body = await req.json().catch(() => ({}));
      credentialId = typeof body?.credentialId === 'string' ? body.credentialId.trim() : '';
    }

    if (!credentialId) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: credentialId is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const adapter = getAdapterOrFail();
    const revoked = await adapter.revokeBinanceCredential(auth.walletAddress, credentialId);
    if (!revoked) {
      return NextResponse.json(
        { success: false, error: 'NOT_FOUND_OR_FORBIDDEN: Binance account not found in your vault', timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: true, data: { credentialId, revoked: true }, timestamp: new Date().toISOString() },
      { status: 200 }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'BINANCE_VAULT_DELETE_ERROR';
    return NextResponse.json(
      { success: false, error: msg, timestamp: new Date().toISOString() },
      { status: msg.startsWith('DATABASE_UNAVAILABLE') ? 503 : 500 }
    );
  }
}
