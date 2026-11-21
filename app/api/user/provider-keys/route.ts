/**
 * app/api/user/provider-keys/route.ts
 *
 * Non-Custodial BYOK Multi-Key Provider Vault Endpoint (AES-256-GCM + Multi-Chain Scope).
 * - Requires authenticated SIWE session (`CONNECT_WALLET` capability).
 * - Write-only: NEVER returns decrypted API keys in any response.
 * - Rejects EVM private keys, Solana keypairs, and BIP-39 seed phrases (`AGENTS.md` Rule 3).
 * - Strictly isolates all read/write/revoke operations to the authenticated user's wallet.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { defaultBillingDbAdapter, defaultProviderKeyVaultAdapter } from '@packages/shared/db-pool';
import {
  SubscriptionsEngine,
  annotateKeysWithQuotaStatus,
  computeEffectiveVaultCapacity,
} from '@packages/billing/subscriptions-engine';

const ALLOWED_VAULT_PROVIDERS = new Set(['BANKR', 'GEMINI', 'OPENAI']);

export const dynamic = 'force-dynamic';

async function authenticateVaultUser(req: NextRequest) {
  return await requireCapability(req, 'CONNECT_WALLET');
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

    const { searchParams } = new URL(req.url);
    const provider = (searchParams.get('provider') || 'BANKR').toUpperCase();
    if (!ALLOWED_VAULT_PROVIDERS.has(provider)) {
      return NextResponse.json(
        { success: false, error: `INVALID_PROVIDER: Allowed providers are BANKR, GEMINI, OPENAI`, timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }
    const [rawKeys, planId, addonSlots] = await Promise.all([
      defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, provider),
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
      defaultBillingDbAdapter.getUserAddonSlots(auth.walletAddress).catch(() => ({ bankrExtraSlots: 0, binanceExtraSlots: 0 })),
    ]);
    const effCap = computeEffectiveVaultCapacity(planId, addonSlots);
    const baseCap = SubscriptionsEngine.getPlanCapacities(planId);
    const effectiveMaxKeys = provider === 'BANKR' ? effCap.maxBankrKeys : baseCap.maxLlmKeys;
    const keys = annotateKeysWithQuotaStatus(rawKeys, { maxActive: effectiveMaxKeys });

    return NextResponse.json(
      {
        success: true,
        data: {
          provider,
          planId: effCap.planId,
          maxKeys: effectiveMaxKeys,
          addonSlots: provider === 'BANKR' ? effCap.bankrExtraSlots : 0,
          keys,
          platformFallbackAvailable:
            provider === 'BANKR'
              ? Boolean(process.env.BANKR_API_KEY && !process.env.BANKR_API_KEY.startsWith('mock_'))
              : Boolean(process.env.GEMINI_API_KEY || process.env.BYTEDANCE_ARK_API_KEY),
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'VAULT_READ_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:vault:write:${ip}`, 15, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Vault rate limit exceeded', timestamp: new Date().toISOString() },
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
    const provider = typeof body?.provider === 'string' ? body.provider.trim().toUpperCase() : 'BANKR';
    if (!ALLOWED_VAULT_PROVIDERS.has(provider)) {
      return NextResponse.json(
        { success: false, error: `INVALID_PROVIDER: Allowed providers are BANKR, GEMINI, OPENAI`, timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }
    const chainScope = typeof body?.chainScope === 'string' ? body.chainScope.trim().toLowerCase() : 'all';
    const isDefault = Boolean(body?.isDefault);

    const [planId, addonSlots] = await Promise.all([
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
      defaultBillingDbAdapter.getUserAddonSlots(auth.walletAddress).catch(() => ({ bankrExtraSlots: 0, binanceExtraSlots: 0 })),
    ]);
    const effCap = computeEffectiveVaultCapacity(planId, addonSlots);
    const baseCap = SubscriptionsEngine.getPlanCapacities(planId);
    const effectiveMaxKeys = provider === 'BANKR' ? effCap.maxBankrKeys : baseCap.maxLlmKeys;

    const created = await defaultProviderKeyVaultAdapter.addKey({
      userIdentifier: auth.walletAddress,
      provider,
      label,
      rawApiKey: apiKey,
      chainScope,
      isDefault,
      maxAllowed: effectiveMaxKeys,
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
    const msg = err instanceof Error ? err.message : 'VAULT_WRITE_ERROR';
    const isBadInput =
      msg.startsWith('FORBIDDEN_PRIVATE_KEY') ||
      msg.startsWith('INVALID_') ||
      msg.startsWith('MAX_KEYS_REACHED');
    return NextResponse.json(
      { success: false, error: msg, timestamp: new Date().toISOString() },
      { status: isBadInput ? 400 : 500 }
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
    const keyId = typeof body?.keyId === 'string' ? body.keyId.trim() : '';
    const provider = typeof body?.provider === 'string' ? body.provider.trim().toUpperCase() : 'BANKR';

    if (!keyId) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: keyId is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const updated = await defaultProviderKeyVaultAdapter.setDefaultKey(auth.walletAddress, keyId, provider);
    if (!updated) {
      return NextResponse.json(
        { success: false, error: 'NOT_FOUND_OR_FORBIDDEN: Key not found in your account', timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: true, data: { keyId, isDefault: true }, timestamp: new Date().toISOString() },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'VAULT_UPDATE_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
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
    let keyId = (searchParams.get('keyId') || '').trim();
    if (!keyId) {
      const body = await req.json().catch(() => ({}));
      keyId = typeof body?.keyId === 'string' ? body.keyId.trim() : '';
    }

    if (!keyId) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: keyId is required', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const revoked = await defaultProviderKeyVaultAdapter.revokeKey(auth.walletAddress, keyId);
    if (!revoked) {
      return NextResponse.json(
        { success: false, error: 'NOT_FOUND_OR_FORBIDDEN: Key not found in your account', timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { success: true, data: { keyId, revoked: true }, timestamp: new Date().toISOString() },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'VAULT_DELETE_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
