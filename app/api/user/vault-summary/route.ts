/**
 * app/api/user/vault-summary/route.ts
 *
 * Read-Only Multi-Vault Usage Telemetry Endpoint (Phase AL).
 * - Requires authenticated SIWE session (`CONNECT_WALLET` capability).
 * - Returns ONLY aggregate active/frozen/max counts across Bankr, Binance, Bybit V5,
 *   BYOK LLM (Gemini/OpenAI/Anthropic), and Outbound Webhooks.
 * - NEVER returns ciphertext, IV, auth tags, or raw API keys (AGENTS.md Rule 3).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import {
  getDbPool,
  defaultBillingDbAdapter,
  defaultProviderKeyVaultAdapter,
  PostgresBinanceExecutionDbAdapter,
} from '@packages/shared/db-pool';
import { buildUserVaultSummary } from '@packages/billing/subscriptions-engine';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireCapability(req, 'CONNECT_WALLET');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        {
          success: false,
          error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`,
          timestamp: new Date().toISOString(),
        },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const pool = getDbPool();
    const binanceExecDb = pool ? new PostgresBinanceExecutionDbAdapter(pool) : null;

    const [
      planId,
      addonSlots,
      bankrKeys,
      bybitKeys,
      geminiKeys,
      openaiKeys,
      anthropicKeys,
      webhookKeys,
      binanceAccounts,
    ] = await Promise.all([
      defaultBillingDbAdapter.getUserPlan(auth.walletAddress).catch(() => 'FREE' as const),
      defaultBillingDbAdapter
        .getUserAddonSlots(auth.walletAddress)
        .catch(() => ({ bankrExtraSlots: 0, binanceExtraSlots: 0 })),
      defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'BANKR').catch(() => []),
      defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'BYBIT').catch(() => []),
      defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'GEMINI').catch(() => []),
      defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'OPENAI').catch(() => []),
      defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'ANTHROPIC').catch(() => []),
      defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'WEBHOOK').catch(() => []),
      binanceExecDb ? binanceExecDb.listBinanceCredentials(auth.walletAddress).catch(() => []) : Promise.resolve([]),
    ]);

    const summary = buildUserVaultSummary({
      planId,
      addonSlots,
      bankrKeys,
      binanceAccounts,
      bybitKeys,
      llmKeys: [...geminiKeys, ...openaiKeys, ...anthropicKeys],
      webhookKeys,
    });

    return NextResponse.json(
      {
        success: true,
        data: summary,
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : 'VAULT_SUMMARY_ERROR',
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
