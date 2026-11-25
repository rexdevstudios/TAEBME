/**
 * app/api/agent/copilot/confirm/route.ts
 *
 * Multi-Account Human-in-the-Loop Execution Confirmation Endpoint (Phase ED).
 * - Strictly requires SIWE session + TRADE_MANUALLY RBAC + Kill-Switch + Risk Gate exposure check.
 * - Anti-IDOR: Verifies ownership of every selectedAccountId against session.walletAddress / userId.
 * - Executes CEX LIMIT/MARKET intents per selected Binance/Bybit account (saved to trade_intents SSOT)
 *   or dispatches Bankr Agent API prompts per selected Bankr vault key.
 * - Records immutable audit_logs entry (`COPILOT_MULTI_ACCOUNT_CONFIRMED`).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import {
  defaultBillingDbAdapter,
  defaultKillSwitchDbAdapter,
  defaultKolDbAdapter,
  defaultProviderKeyVaultAdapter,
  getDbPool,
  listUserOwnedWallets,
  saveTradeIntent,
} from '@packages/shared/db-pool';
import {
  submitBankrAgentPrompt,
  validateBankrAgentPromptInput,
} from '@packages/launchpad/bankr-client';
import {
  computeMultiAccountExposureCheck,
  validateOwnedWalletTransferPrompt,
  type CopilotAccountRail,
  type CopilotActionDraft,
} from '@packages/agent/copilot-engine';
import { notifyUserWebhookBestEffort } from '@packages/notifications/webhook-dispatcher';

export const dynamic = 'force-dynamic';

interface SelectedAccountInput {
  id: string;
  rail: CopilotAccountRail;
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:agent:copilot:confirm:${ip}`, 10, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Copilot confirm rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let auth;
    try {
      auth = await requireCapability(req, 'TRADE_MANUALLY');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT_');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const activeKillSwitches = await defaultKillSwitchDbAdapter.getActiveKillSwitches().catch(() => []);
    const blockedSwitch = activeKillSwitches.find((ks) => {
      const scope = String(ks.scope || '').toUpperCase();
      return ks.isActive && (scope === 'GLOBAL' || scope === 'TRADING' || scope === 'AGENT');
    });
    if (blockedSwitch) {
      return NextResponse.json(
        {
          success: false,
          error: `KILL_SWITCH_ACTIVE: Halted by ${blockedSwitch.scope} kill switch (${blockedSwitch.reason || 'admin halt'}).`,
          timestamp: new Date().toISOString(),
        },
        { status: 503 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const draft = body?.actionDraft as CopilotActionDraft | undefined;
    const rawSelected = Array.isArray(body?.selectedAccounts) ? (body.selectedAccounts as SelectedAccountInput[]) : [];

    if (!draft || !draft.kind || !draft.symbol) {
      return NextResponse.json(
        { success: false, error: 'INVALID_DRAFT: actionDraft is required.', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    // Defense-in-depth 3-Zone Transfer Allowlist Guard (Phase EF/EG)
    if (draft.kind === 'TRANSFER_OWNED' || draft.kind === 'BANKR_PROMPT') {
      const ownedRecords = await listUserOwnedWallets(auth.walletAddress).catch(() => []);
      const ownedAddresses =
        ownedRecords.length > 0 ? ownedRecords.map((w) => w.address) : [auth.walletAddress.toLowerCase()];
      const transferGuard = validateOwnedWalletTransferPrompt(String(draft.bankrPrompt || ''), ownedAddresses);
      if (!transferGuard.allowed) {
        return NextResponse.json(
          {
            success: false,
            error: transferGuard.reason || 'TRANSFER_DESTINATION_NOT_WHITELISTED',
            code: transferGuard.code,
            timestamp: new Date().toISOString(),
          },
          { status: 403 }
        );
      }
    }

    const selected = rawSelected
      .filter(
        (a) =>
          a &&
          typeof a.id === 'string' &&
          a.id.trim().length > 0 &&
          ['BINANCE', 'BYBIT', 'BANKR', 'PAPER_SIM'].includes(String(a.rail))
      )
      .slice(0, 15);

    const [platformCfg, entitlement] = await Promise.all([
      defaultBillingDbAdapter.getPlatformFeeAndRiskConfig().catch(() => null),
      defaultBillingDbAdapter.getUserEntitlement(auth.user.userId).catch(() => ({ planId: 'FREE', hasLiveTrading: false })),
    ]);

    const exposure = computeMultiAccountExposureCheck({
      amountUsdPerAccount: Number(draft.amountUsd || 0),
      selectedCount: selected.length,
      maxOrderValueUsd: platformCfg?.maxOrderValueUsd ?? 1000,
      maxDailyLossUsd: platformCfg?.maxDailyLossUsd ?? 5000,
    });

    if (!exposure.ok) {
      return NextResponse.json(
        { success: false, error: `RISK_REJECTED: ${exposure.reason}`, data: { exposure }, timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    const pool = getDbPool();
    const results: Array<{
      accountId: string;
      rail: string;
      status: 'QUEUED' | 'DISPATCHED' | 'REJECTED';
      referenceId?: string;
      detail: string;
    }> = [];

    const stage: 'PAPER' | 'TESTNET' | 'LIVE' = entitlement.hasLiveTrading ? 'TESTNET' : 'PAPER';
    const tsBucket = Math.floor(Date.now() / 1000);

    for (const acct of selected) {
      if (draft.kind === 'BANKR_PROMPT' || draft.kind === 'TRANSFER_OWNED') {
        if (acct.rail !== 'BANKR') {
          results.push({ accountId: acct.id, rail: acct.rail, status: 'REJECTED', detail: 'Non-Bankr account skipped for Bankr prompt.' });
          continue;
        }
        const promptCheck = validateBankrAgentPromptInput(draft.bankrPrompt);
        if (!promptCheck.valid) {
          results.push({ accountId: acct.id, rail: acct.rail, status: 'REJECTED', detail: promptCheck.errorMessage || 'Invalid Bankr prompt' });
          continue;
        }
        const resolved = await defaultProviderKeyVaultAdapter
          .resolveDecryptedKeyForDeploy({
            userIdentifier: auth.walletAddress,
            targetChain: 'base',
            keyId: acct.id,
            provider: 'BANKR',
          })
          .catch(() => null);
        if (!resolved?.apiKey) {
          results.push({ accountId: acct.id, rail: acct.rail, status: 'REJECTED', detail: 'Account not found or not owned by wallet.' });
          continue;
        }
        const bankrRes = await submitBankrAgentPrompt({
          prompt: promptCheck.sanitizedPrompt,
          apiKeyOverride: resolved.apiKey,
        });
        const ok = bankrRes.status === 'pending' || bankrRes.status === 'completed';
        results.push({
          accountId: acct.id,
          rail: 'BANKR',
          status: ok ? 'DISPATCHED' : 'REJECTED',
          referenceId: bankrRes.jobId,
          detail: bankrRes.message || bankrRes.status,
        });
      } else {
        // CEX_LIMIT_ORDER or CEX_MARKET_ORDER (BINANCE, BYBIT, or built-in PAPER_SIM)
        if (acct.rail !== 'BINANCE' && acct.rail !== 'BYBIT' && acct.rail !== 'PAPER_SIM') {
          results.push({ accountId: acct.id, rail: acct.rail, status: 'REJECTED', detail: 'Non-CEX account skipped for CEX order.' });
          continue;
        }

        // Strict Anti-IDOR ownership verification per account (PAPER_SIM is virtual & scoped strictly to auth.user.userId)
        let owned = acct.rail === 'PAPER_SIM' && acct.id === 'paper-sim-default';
        if (acct.rail === 'BINANCE' && pool) {
          const check = await pool
            .query('SELECT id FROM binance_credentials WHERE id = $1 AND user_id = $2 AND is_active = true LIMIT 1', [
              acct.id,
              auth.user.userId,
            ])
            .catch(() => ({ rows: [] }));
          owned = check.rows.length > 0;
        } else if (acct.rail === 'BYBIT') {
          const keys = await defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'BYBIT').catch(() => []);
          owned = keys.some((k) => k.id === acct.id);
        }

        if (!owned) {
          results.push({ accountId: acct.id, rail: acct.rail, status: 'REJECTED', detail: 'Account not found or not owned by wallet.' });
          continue;
        }

        const effectiveStage: 'PAPER' | 'TESTNET' | 'LIVE' = acct.rail === 'PAPER_SIM' ? 'PAPER' : stage;
        const idempotencyKey = `copilot:${acct.rail.toLowerCase()}:${acct.id.slice(0, 8)}:${draft.symbol}:${draft.side}:${tsBucket}`;
        const intentId = await saveTradeIntent({
          userId: auth.user.userId,
          stage: effectiveStage,
          symbol: draft.symbol,
          side: draft.side,
          type: draft.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
          quantity: Number(draft.amountUsd),
          price: draft.orderType === 'LIMIT' ? draft.limitPrice : undefined,
          idempotencyKey,
          status: 'APPROVED',
          riskDecisionReason: `COPILOT_CONFIRMED:${acct.rail}:${acct.id.slice(0, 8)}`,
        });

        results.push({
          accountId: acct.id,
          rail: acct.rail,
          status: 'QUEUED',
          referenceId: intentId,
          detail: `${draft.orderType} ${draft.side} ${draft.symbol} ($${draft.amountUsd}${draft.limitPrice ? ` @ $${draft.limitPrice}` : ''}) queued [${effectiveStage}]`,
        });
      }
    }

    const queuedOrDispatchedCount = results.filter((r) => r.status !== 'REJECTED').length;

    await defaultKolDbAdapter.createAuditLog(
      auth.user.userId,
      'COPILOT_MULTI_ACCOUNT_CONFIRMED',
      undefined,
      `kind=${draft.kind} symbol=${draft.symbol} accounts=${selected.length} totalUsd=${exposure.totalExposureUsd}`
    );

    if (queuedOrDispatchedCount > 0) {
      await notifyUserWebhookBestEffort({
        resolveWebhookUrl: async () => {
          const resolved = await defaultProviderKeyVaultAdapter
            .resolveDecryptedKeyForDeploy({
              userIdentifier: auth.walletAddress,
              targetChain: 'all',
              provider: 'WEBHOOK',
            })
            .catch(() => null);
          return resolved?.apiKey || null;
        },
        payload: {
          event: 'ORDER_APPROVED',
          title: `Copilot ${draft.orderType} ${draft.side} ${draft.symbol}`,
          message: `Confirmed across ${queuedOrDispatchedCount} account(s) · Total $${exposure.totalExposureUsd}${draft.limitPrice ? ` @ $${draft.limitPrice}` : ''}`,
          metadata: {
            kind: draft.kind,
            symbol: draft.symbol,
            accounts: queuedOrDispatchedCount,
            totalExposureUsd: exposure.totalExposureUsd,
          },
        },
      }).catch(() => {});
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          exposure,
          results,
          queuedOrDispatchedCount,
        },
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || 'COPILOT_CONFIRM_FAILED', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
