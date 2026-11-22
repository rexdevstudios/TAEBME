/**
 * app/api/user/provider-keys/verify/route.ts
 *
 * Stateless Live Connectivity Verifier for Stored BYOK LLM Keys (GEMINI, OPENAI, ANTHROPIC)
 * and Outbound Alert Webhooks (WEBHOOK).
 * - Requires authenticated SIWE session (`CONNECT_WALLET`).
 * - Strictly isolates lookup to the authenticated user's own `keyId`.
 * - Enforces TRADER / AGENT tier gate for BYOK LLM providers (`403 PLAN_BYOK_LLM_REQUIRED`).
 * - NEVER returns raw decrypted API keys or webhook URLs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { defaultBillingDbAdapter, defaultProviderKeyVaultAdapter } from '@packages/shared/db-pool';
import { SubscriptionsEngine } from '@packages/billing/subscriptions-engine';
import { verifyByokLlmKeyLive, type ByokLlmProvider } from '@packages/intelligence/llm-advisory-client';
import { dispatchOutboundAlert } from '@packages/notifications/webhook-dispatcher';
import { parseBybitKeyPair, verifyBybitCredentialLive } from '@packages/trading/bybit-vault';

const VERIFIABLE_PROVIDERS = new Set(['BYBIT', 'GEMINI', 'OPENAI', 'ANTHROPIC', 'WEBHOOK']);
const LLM_PROVIDERS = new Set<ByokLlmProvider>(['GEMINI', 'OPENAI', 'ANTHROPIC']);

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:provider-vault:verify:${ip}`, 20, 60);
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
    const keyId = typeof body?.keyId === 'string' ? body.keyId.trim() : '';
    const provider = typeof body?.provider === 'string' ? body.provider.trim().toUpperCase() : '';

    if (!keyId || !VERIFIABLE_PROVIDERS.has(provider)) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_INPUT: keyId and provider (GEMINI, OPENAI, ANTHROPIC, WEBHOOK) are required',
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    if (LLM_PROVIDERS.has(provider as ByokLlmProvider)) {
      const userPlan = await defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const);
      const cap = SubscriptionsEngine.getPlanCapacities(userPlan);
      if (cap.maxLlmKeys <= 0) {
        return NextResponse.json(
          {
            success: false,
            error:
              'PLAN_BYOK_LLM_REQUIRED: BYOK LLM verification is exclusive to Pro Terminal Trader (TRADER) and AI Autonomous Desk (AGENT) plans.',
            timestamp: new Date().toISOString(),
          },
          { status: 403 }
        );
      }
    }

    let resolved;
    try {
      resolved = await defaultProviderKeyVaultAdapter.resolveDecryptedKeyForDeploy({
        userIdentifier: auth.walletAddress,
        targetChain: 'all',
        keyId,
        provider,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'BYOK_KEY_NOT_FOUND_OR_FORBIDDEN';
      const isNotFound = msg.startsWith('BYOK_KEY_NOT_FOUND');
      return NextResponse.json(
        { success: false, error: msg, timestamp: new Date().toISOString() },
        { status: isNotFound ? 404 : 400 }
      );
    }

    if (!resolved?.apiKey) {
      return NextResponse.json(
        { success: false, error: 'BYOK_KEY_NOT_FOUND_OR_FORBIDDEN: Key not found in your vault', timestamp: new Date().toISOString() },
        { status: 404 }
      );
    }

    if (provider === 'BYBIT') {
      const { apiKey, secretKey } = parseBybitKeyPair(resolved.apiKey);
      const env: 'TESTNET' | 'MAINNET' =
        String(resolved.chainScope || '').toLowerCase() === 'mainnet' ? 'MAINNET' : 'TESTNET';
      const bybitPing = await verifyBybitCredentialLive({
        apiKey,
        secretKey,
        environment: env,
      });
      await defaultBillingDbAdapter
        .createAuditLog(
          auth.walletAddress,
          'PROVIDER_KEY_VERIFIED',
          resolved.keyId,
          bybitPing.connected
            ? `BYBIT "${resolved.label}" (${env}) ping OK (canTrade=${bybitPing.canTrade}, canWithdraw=${bybitPing.canWithdraw}, ${bybitPing.latencyMs}ms)`
            : `BYBIT "${resolved.label}" (${env}) ping FAILED (${bybitPing.error || 'unknown'}, ${bybitPing.latencyMs}ms)`
        )
        .catch(() => {});

      return NextResponse.json(
        {
          success: true,
          data: {
            keyId: resolved.keyId,
            label: resolved.label,
            provider: 'BYBIT',
            ...bybitPing,
          },
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      );
    }

    if (provider === 'WEBHOOK') {
      const startMs = performance.now();
      const delivery = await dispatchOutboundAlert({
        webhookUrl: resolved.apiKey,
        payload: {
          event: 'ORDER_APPROVED',
          title: 'POOLNET Webhook Test Ping',
          message: `Test alert berhasil dikirim untuk vault "${resolved.label}". Koneksi notifikasi real-time Anda aktif.`,
          metadata: {
            keyId: resolved.keyId,
            testPing: true,
          },
        },
      });
      const latencyMs = Math.round(performance.now() - startMs);
      await defaultBillingDbAdapter
        .createAuditLog(
          auth.walletAddress,
          'PROVIDER_KEY_VERIFIED',
          resolved.keyId,
          delivery.delivered
            ? `WEBHOOK "${resolved.label}" ping OK (HTTP ${delivery.statusCode || 200}, ${latencyMs}ms)`
            : `WEBHOOK "${resolved.label}" ping FAILED (${delivery.error || 'unknown'}, ${latencyMs}ms)`
        )
        .catch(() => {});

      return NextResponse.json(
        {
          success: true,
          data: {
            keyId: resolved.keyId,
            label: resolved.label,
            provider: 'WEBHOOK',
            connected: delivery.delivered,
            statusCode: delivery.statusCode,
            latencyMs,
            ...(delivery.error ? { error: delivery.error } : {}),
          },
          timestamp: new Date().toISOString(),
        },
        { status: 200 }
      );
    }

    const ping = await verifyByokLlmKeyLive({
      provider: provider as ByokLlmProvider,
      apiKey: resolved.apiKey,
    });

    await defaultBillingDbAdapter
      .createAuditLog(
        auth.walletAddress,
        'PROVIDER_KEY_VERIFIED',
        resolved.keyId,
        ping.connected
          ? `${provider} "${resolved.label}" ping OK (HTTP ${ping.statusCode || 200}, ${ping.latencyMs}ms)`
          : `${provider} "${resolved.label}" ping FAILED (${ping.error || 'unknown'}, ${ping.latencyMs}ms)`
      )
      .catch(() => {});

    return NextResponse.json(
      {
        success: true,
        data: {
          keyId: resolved.keyId,
          label: resolved.label,
          ...ping,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'PROVIDER_VERIFY_ERROR', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
