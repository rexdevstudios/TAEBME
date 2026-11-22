/**
 * app/api/trading/execute/route.ts
 *
 * Vercel-Native Stateless Single-Shot Trading Execution Endpoint (Batch V2).
 * - RBAC: requires TRADE_MANUALLY capability (enforced by middleware + requireCapability).
 * - Risk Gate: ALL intents pass TradingRiskGate + KillSwitch + Billing Entitlement (AGENTS.md Rule 5).
 * - Non-Custodial: ZERO private keys in Vercel (AGENTS.md Rule 3). DEX swaps return MEV-checked
 *   payload for browser MetaMask signing; CEX single-shot enforces non-withdrawal credentials.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { requireCapability } from '@packages/auth/session';
import { rateLimiter } from '@packages/auth/rate-limiter';
import { TradingRiskGate } from '@packages/trading/risk-gate';
import { MevProtectionService } from '@packages/trading/mev-protection';
import { validateBinancePermissions } from '@packages/shared/types/domain';
import {
  annotateKeysWithQuotaStatus,
  computeEffectiveUserRiskLimits,
  computeEffectiveVaultCapacity,
} from '@packages/billing/subscriptions-engine';
import {
  getDbPool,
  saveTradeIntent,
  defaultKillSwitchDbAdapter,
  defaultBillingDbAdapter,
  defaultProviderKeyVaultAdapter,
  PostgresBinanceExecutionDbAdapter,
} from '@packages/shared/db-pool';
import { notifyUserWebhookBestEffort } from '@packages/notifications/webhook-dispatcher';
import {
  parseBybitKeyPair,
  submitBybitSpotOrder,
  verifyBybitCredentialLive,
} from '@packages/trading/bybit-vault';
import { resolveCexExecutionVenue } from '@packages/trading/venue-router';
import { buildDexPartnerFeePayload } from '@packages/trading/fee-monetization';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateCheck = await rateLimiter.checkRateLimit(`ratelimit:trade:exec:${ip}`, 20, 60);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: 'TOO_MANY_REQUESTS: Trade execution rate limit exceeded', timestamp: new Date().toISOString() },
        { status: 429 }
      );
    }

    let auth;
    try {
      auth = await requireCapability(req, 'TRADE_MANUALLY');
    } catch (authErr: unknown) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      const isForbidden = msg.includes('RBAC_FORBIDDEN') || msg.includes('AUTH_ACCOUNT');
      return NextResponse.json(
        { success: false, error: isForbidden ? `FORBIDDEN: ${msg}` : `UNAUTHORIZED: ${msg}`, timestamp: new Date().toISOString() },
        { status: isForbidden ? 403 : 401 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const executionMode = (body?.executionMode || 'PAPER') as 'PAPER' | 'DEX_NON_CUSTODIAL' | 'CEX_SINGLE_SHOT';
    const stage = (body?.stage || (executionMode === 'PAPER' ? 'PAPER' : 'TESTNET')) as 'PAPER' | 'TESTNET' | 'LIVE';
    const symbol = typeof body?.symbol === 'string' && body.symbol.trim() ? body.symbol.trim() : 'BTCUSDT';
    const side = body?.side === 'SELL' ? 'SELL' : 'BUY';
    const type = body?.type === 'LIMIT' ? 'LIMIT' : 'MARKET';
    const quantity = Number(body?.quantity ?? 0);
    const price = body?.price !== undefined ? Number(body.price) : undefined;
    const maxSlippagePct = Number(body?.maxSlippagePct ?? 1.0);
    const idempotencyKey =
      typeof body?.idempotencyKey === 'string' && body.idempotencyKey.trim()
        ? body.idempotencyKey.trim()
        : `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return NextResponse.json(
        { success: false, error: 'INVALID_INPUT: quantity must be a positive number', timestamp: new Date().toISOString() },
        { status: 400 }
      );
    }

    // 1. Authoritative Kill Switch, Entitlement, Per-User Clamped Risk Policy, 24h Exposure & Deterministic Risk Gate (Fail-Closed)
    const [activeKillSwitches, userEntitlement, dynamicRiskCfg, userRiskPolicy, riskExposure24h] = await Promise.all([
      defaultKillSwitchDbAdapter.getActiveKillSwitches(),
      defaultBillingDbAdapter.getUserEntitlement(auth.user.userId),
      defaultBillingDbAdapter.getPlatformFeeAndRiskConfig().catch(() => null),
      defaultBillingDbAdapter.getUserRiskPolicy(auth.walletAddress).catch(() => null),
      defaultBillingDbAdapter.getUser24hRiskExposure(auth.user.userId).catch(() => ({
        currentDailyLossUsd: 0,
        currentOpenPositions: 0,
      })),
    ]);

    const effectiveLimits = computeEffectiveUserRiskLimits({
      planId: userEntitlement.planId,
      userPolicy: userRiskPolicy,
      platformGlobalCap: dynamicRiskCfg,
    });

    if (effectiveLimits.allowedSymbols.length > 0) {
      const normalizedTarget = symbol.replace('/', '').toUpperCase();
      const matched = effectiveLimits.allowedSymbols.some(
        (allowed) => allowed.replace('/', '').toUpperCase() === normalizedTarget
      );
      if (!matched) {
        return NextResponse.json(
          {
            success: false,
            error: `SYMBOL_NOT_WHITELISTED: Symbol "${symbol}" is outside your personal allowedSymbols policy (${effectiveLimits.allowedSymbols.join(', ')}).`,
            timestamp: new Date().toISOString(),
          },
          { status: 400 }
        );
      }
    }

    if (maxSlippagePct > effectiveLimits.maxSlippagePct) {
      return NextResponse.json(
        {
          success: false,
          error: `SLIPPAGE_EXCEEDS_POLICY: Requested slippage ${maxSlippagePct}% exceeds your effective risk limit (${effectiveLimits.maxSlippagePct}%).`,
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    const { status: gateStatus, decision } = TradingRiskGate.evaluateIntent(
      {
        userId: auth.user.userId,
        stage,
        symbol,
        side,
        type,
        quantity,
        price,
        maxSlippagePct,
        idempotencyKey,
      },
      {
        maxOrderValueUsd: effectiveLimits.maxOrderValueUsd,
        maxDailyLossUsd: effectiveLimits.maxDailyLossUsd,
        currentDailyLossUsd: riskExposure24h.currentDailyLossUsd,
        maxOpenPositions: 5,
        currentOpenPositions: riskExposure24h.currentOpenPositions,
      },
      userEntitlement,
      activeKillSwitches
    );

    const resolveUserWebhookUrl = async () => {
      const hook = await defaultProviderKeyVaultAdapter
        .resolveDecryptedKeyForDeploy({
          userIdentifier: auth.walletAddress,
          targetChain: 'all',
          provider: 'WEBHOOK',
        })
        .catch(() => null);
      return hook?.apiKey || null;
    };

    if (!decision.isApproved) {
      const reasonStr = String(decision.reason || '');
      if (reasonStr.toUpperCase().includes('DAILY_LOSS') || reasonStr.toUpperCase().includes('LOSS')) {
        await notifyUserWebhookBestEffort({
          resolveWebhookUrl: resolveUserWebhookUrl,
          payload: {
            event: 'DAILY_LOSS_WARNING',
            title: `Risk Gate Blocked: ${side} ${symbol}`,
            message: `${reasonStr} (24h loss: $${riskExposure24h.currentDailyLossUsd.toFixed(2)} / cap $${effectiveLimits.maxDailyLossUsd.toFixed(2)})`,
            metadata: {
              symbol,
              side,
              executionMode,
              currentDailyLossUsd: riskExposure24h.currentDailyLossUsd,
              maxDailyLossUsd: effectiveLimits.maxDailyLossUsd,
            },
          },
        });
      }
      return NextResponse.json(
        {
          success: false,
          error: `RISK_REJECTED: ${decision.reason || 'Trade intent rejected by Risk Gate'}`,
          data: { status: gateStatus, decision },
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }

    // 2. Branch by Vercel-Native execution mode
    if (executionMode === 'DEX_NON_CUSTODIAL') {
      const tokenAddress = typeof body?.tokenAddress === 'string' ? body.tokenAddress.trim() : '';
      if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
        return NextResponse.json(
          { success: false, error: 'INVALID_TOKEN_ADDRESS: Valid EVM tokenAddress is required for DEX_NON_CUSTODIAL', timestamp: new Date().toISOString() },
          { status: 400 }
        );
      }
      const chainId = Number(body?.chainId ?? 8453);
      const liquidityEth = typeof body?.liquidityEth === 'string' ? body.liquidityEth : '24';
      const quote = MevProtectionService.evaluateGraduationSlippage(
        tokenAddress,
        ethers.parseEther(liquidityEth),
        chainId
      );
      const verification = MevProtectionService.verifyMevProtection(quote);
      if (!verification.isSafe) {
        return NextResponse.json(
          { success: false, error: 'MEV_UNSAFE: Liquidity quote failed MEV protection safety check', timestamp: new Date().toISOString() },
          { status: 422 }
        );
      }

      const tradeIntentId = await saveTradeIntent({
        userId: auth.user.userId,
        stage,
        symbol,
        side,
        type,
        quantity,
        price,
        idempotencyKey,
        status: 'APPROVED',
        riskDecisionReason: decision.reason,
      });

      await notifyUserWebhookBestEffort({
        resolveWebhookUrl: resolveUserWebhookUrl,
        payload: {
          event: 'ORDER_APPROVED',
          title: `DEX Order Approved: ${side} ${symbol}`,
          message: `Intent ${tradeIntentId} siap ditandatangani (Qty ${quantity}, MEV Safe).`,
          metadata: { tradeIntentId, symbol, side, quantity, executionMode },
        },
      });

      const partnerFee = buildDexPartnerFeePayload({
        dexSwapFeeBps: dynamicRiskCfg?.dexSwapFeeBps,
        treasuryWallet: dynamicRiskCfg?.treasuryWallet,
        chainId,
      });

      return NextResponse.json({
        success: true,
        data: {
          tradeIntentId,
          executionMode,
          status: 'READY_FOR_WALLET_SIGN',
          mevQuote: {
            ...quote,
            liquidityWei: quote.liquidityWei.toString(),
            isSafe: verification.isSafe,
          },
          partnerFee,
          decision,
        },
        timestamp: new Date().toISOString(),
      });
    }

    if (executionMode === 'CEX_SINGLE_SHOT') {
      const rawVenue =
        typeof body?.venue === 'string' && body.venue.trim() ? body.venue.trim().toUpperCase() : 'AUTO';
      const requestedCredentialId =
        typeof body?.credentialId === 'string' && body.credentialId.trim() && body.credentialId !== 'DEFAULT'
          ? body.credentialId.trim()
          : undefined;

      let venue: 'BINANCE' | 'BYBIT';
      let venueRouting: 'EXPLICIT' | 'AUTO' = 'EXPLICIT';

      if (rawVenue === 'BINANCE' || rawVenue === 'BYBIT') {
        venue = rawVenue;
      } else {
        const poolForAuto = getDbPool();
        const binanceAutoDb = poolForAuto ? new PostgresBinanceExecutionDbAdapter(poolForAuto) : null;
        const [autoBinanceAccounts, autoBybitKeys, autoAddonSlots] = await Promise.all([
          binanceAutoDb ? binanceAutoDb.listBinanceCredentials(auth.walletAddress).catch(() => []) : Promise.resolve([]),
          defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'BYBIT').catch(() => []),
          defaultBillingDbAdapter.getUserAddonSlots(auth.walletAddress).catch(() => ({ bankrExtraSlots: 0, binanceExtraSlots: 0 })),
        ]);
        const resolvedAuto = resolveCexExecutionVenue({
          requestedVenue: 'AUTO',
          planId: userEntitlement.planId,
          addonSlots: autoAddonSlots,
          binanceAccounts: autoBinanceAccounts,
          bybitKeys: autoBybitKeys,
        });
        if (!resolvedAuto.venue) {
          return NextResponse.json(
            {
              success: false,
              error: resolvedAuto.allFrozen
                ? 'CEX_ALL_KEYS_FROZEN: Seluruh akun CEX (Binance/Bybit) Anda sedang terkunci (Mainnet Lock / Over-Quota). Upgrade paket atau tambah slot di /billing.'
                : 'CEX_CREDENTIALS_MISSING: Tidak ditemukan akun CEX aktif (Binance atau Bybit V5). Tambahkan API Key trade-only di /trading terlebih dahulu.',
              timestamp: new Date().toISOString(),
            },
            { status: resolvedAuto.allFrozen ? 403 : 422 }
          );
        }
        venue = resolvedAuto.venue;
        venueRouting = 'AUTO';
      }

      if (venue === 'BYBIT') {
        const [allBybitKeys, addonSlots] = await Promise.all([
          defaultProviderKeyVaultAdapter.listKeys(auth.walletAddress, 'BYBIT').catch(() => []),
          defaultBillingDbAdapter.getUserAddonSlots(auth.walletAddress).catch(() => ({ bankrExtraSlots: 0, binanceExtraSlots: 0 })),
        ]);
        const effVaultCap = computeEffectiveVaultCapacity(userEntitlement.planId, addonSlots);
        const annotatedBybit = annotateKeysWithQuotaStatus(
          allBybitKeys.map((k) => ({
            ...k,
            environment: (String(k.chainScope || '').toLowerCase() === 'mainnet' ? 'MAINNET' : 'TESTNET') as
              | 'TESTNET'
              | 'MAINNET',
          })),
          {
            maxActive: effVaultCap.maxBinanceAccounts,
            allowMainnet: effVaultCap.allowMainnetBinance,
          }
        );

        let resolvedBybit;
        try {
          resolvedBybit = await defaultProviderKeyVaultAdapter.resolveDecryptedKeyForDeploy({
            userIdentifier: auth.walletAddress,
            targetChain: 'all',
            keyId: requestedCredentialId,
            provider: 'BYBIT',
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'CEX_CREDENTIAL_NOT_FOUND';
          return NextResponse.json(
            { success: false, error: msg, timestamp: new Date().toISOString() },
            { status: 422 }
          );
        }

        if (!resolvedBybit?.apiKey) {
          return NextResponse.json(
            {
              success: false,
              error: requestedCredentialId
                ? 'CEX_CREDENTIAL_NOT_FOUND: Selected Bybit V5 key is inactive or does not belong to your session'
                : 'CEX_CREDENTIALS_MISSING: Active trade-only Bybit V5 API credentials are required',
              timestamp: new Date().toISOString(),
            },
            { status: 422 }
          );
        }

        const matchedBybitMeta = annotatedBybit.find((k) => k.id === resolvedBybit.keyId);
        if (matchedBybitMeta && matchedBybitMeta.quotaStatus === 'FROZEN_MAINNET_LOCKED') {
          return NextResponse.json(
            {
              success: false,
              error: `KEY_FROZEN_MAINNET_LOCKED: Akun Bybit Mainnet "${matchedBybitMeta.label}" terkunci pada paket ${effVaultCap.planId}. Perpanjang TRADER/AGENT di /billing untuk membuka kembali.`,
              timestamp: new Date().toISOString(),
            },
            { status: 403 }
          );
        }
        if (matchedBybitMeta && matchedBybitMeta.quotaStatus === 'FROZEN_OVER_QUOTA') {
          return NextResponse.json(
            {
              success: false,
              error: `KEY_FROZEN_OVER_QUOTA: Akun Bybit "${matchedBybitMeta.label}" terkunci karena kuota aktif paket ${effVaultCap.planId} adalah ${effVaultCap.maxBinanceAccounts} akun. Jadikan Default atau tambah slot di /billing.`,
              timestamp: new Date().toISOString(),
            },
            { status: 403 }
          );
        }

        const bybitEnv: 'TESTNET' | 'MAINNET' =
          String(resolvedBybit.chainScope || '').toLowerCase() === 'mainnet' ? 'MAINNET' : 'TESTNET';
        const { apiKey, secretKey } = parseBybitKeyPair(resolvedBybit.apiKey);

        let exchangeOrderId: string | undefined;
        let finalStatus: 'APPROVED' | 'SUBMITTED' = 'APPROVED';

        if (body?.dispatchLive === true) {
          const permCheck = await verifyBybitCredentialLive({
            apiKey,
            secretKey,
            environment: bybitEnv,
          });
          if (!permCheck.connected) {
            return NextResponse.json(
              {
                success: false,
                error: `BYBIT_AUTH_FAILED: ${permCheck.error || 'Unable to verify Bybit V5 credentials'}`,
                timestamp: new Date().toISOString(),
              },
              { status: 422 }
            );
          }
          if (permCheck.canWithdraw) {
            return NextResponse.json(
              {
                success: false,
                error:
                  'WITHDRAWAL_ENABLED_ON_EXCHANGE: Bybit API key has Withdraw permissions enabled. Disable withdrawals on Bybit before live execution.',
                timestamp: new Date().toISOString(),
              },
              { status: 403 }
            );
          }
          if (!permCheck.canTrade) {
            return NextResponse.json(
              {
                success: false,
                error: 'BYBIT_TRADE_PERMISSION_MISSING: Bybit API key is read-only or lacks Spot trade permissions.',
                timestamp: new Date().toISOString(),
              },
              { status: 403 }
            );
          }

          const orderRes = await submitBybitSpotOrder({
            apiKey,
            secretKey,
            environment: bybitEnv,
            symbol,
            side,
            orderType: type,
            qty: quantity,
            price,
            orderLinkId: idempotencyKey,
          });
          if (!orderRes.submitted) {
            return NextResponse.json(
              {
                success: false,
                error: `BYBIT_ORDER_REJECTED: ${orderRes.error || 'Order submission failed'}`,
                timestamp: new Date().toISOString(),
              },
              { status: 422 }
            );
          }
          exchangeOrderId = orderRes.orderId;
          finalStatus = 'SUBMITTED';
        }

        const tradeIntentId = await saveTradeIntent({
          userId: auth.user.userId,
          stage,
          symbol,
          side,
          type,
          quantity,
          price,
          idempotencyKey,
          status: 'APPROVED',
          riskDecisionReason: decision.reason,
        });

        await notifyUserWebhookBestEffort({
          resolveWebhookUrl: resolveUserWebhookUrl,
          payload: {
            event: 'ORDER_APPROVED',
            title: `Bybit V5 Order ${finalStatus}: ${side} ${symbol}`,
            message: `Intent ${tradeIntentId} (${bybitEnv} · ${resolvedBybit.label}) lolos Risk Gate${exchangeOrderId ? ` · OrderId ${exchangeOrderId}` : ''}.`,
            metadata: {
              tradeIntentId,
              venue: 'BYBIT',
              symbol,
              side,
              quantity,
              executionMode,
              environment: bybitEnv,
              ...(exchangeOrderId ? { exchangeOrderId } : {}),
            },
          },
        });

        return NextResponse.json({
          success: true,
          data: {
            tradeIntentId,
            executionMode,
            venue: 'BYBIT',
            venueRouting,
            status: finalStatus,
            credentialId: resolvedBybit.keyId,
            credentialLabel: resolvedBybit.label,
            credentialEnvironment: bybitEnv,
            ...(exchangeOrderId ? { exchangeOrderId } : {}),
            decision,
          },
          timestamp: new Date().toISOString(),
        });
      }

      const pool = getDbPool();
      if (!pool) {
        return NextResponse.json(
          { success: false, error: 'DATABASE_UNAVAILABLE: PostgreSQL pool unavailable', timestamp: new Date().toISOString() },
          { status: 503 }
        );
      }
      const execDb = new PostgresBinanceExecutionDbAdapter(pool);
      const creds = await execDb.getBinanceCredentials(auth.user.userId, requestedCredentialId);
      if (!creds || creds.isActive === false) {
        return NextResponse.json(
          {
            success: false,
            error: requestedCredentialId
              ? 'CEX_CREDENTIAL_NOT_FOUND: Selected Binance account is inactive or does not belong to your session'
              : 'CEX_CREDENTIALS_MISSING: Active trade-only Binance API credentials are required',
            timestamp: new Date().toISOString(),
          },
          { status: 422 }
        );
      }

      // Soft-Freeze Anti-Loophole Enforcement (Zero Data Loss)
      const [allBinanceAccounts, addonSlots] = await Promise.all([
        execDb.listBinanceCredentials(auth.walletAddress).catch(() => []),
        defaultBillingDbAdapter.getUserAddonSlots(auth.walletAddress).catch(() => ({ bankrExtraSlots: 0, binanceExtraSlots: 0 })),
      ]);
      const effVaultCap = computeEffectiveVaultCapacity(userEntitlement.planId, addonSlots);
      const annotatedBinance = annotateKeysWithQuotaStatus(allBinanceAccounts, {
        maxActive: effVaultCap.maxBinanceAccounts,
        allowMainnet: effVaultCap.allowMainnetBinance,
      });
      const matchedMeta = annotatedBinance.find((a) => a.id === creds.id);
      if (matchedMeta && matchedMeta.quotaStatus === 'FROZEN_MAINNET_LOCKED') {
        return NextResponse.json(
          {
            success: false,
            error: `KEY_FROZEN_MAINNET_LOCKED: Akun Binance Mainnet "${matchedMeta.label}" terkunci pada paket ${effVaultCap.planId}. Perpanjang TRADER/AGENT di /billing untuk membuka kembali.`,
            timestamp: new Date().toISOString(),
          },
          { status: 403 }
        );
      }
      if (matchedMeta && matchedMeta.quotaStatus === 'FROZEN_OVER_QUOTA') {
        return NextResponse.json(
          {
            success: false,
            error: `KEY_FROZEN_OVER_QUOTA: Akun Binance "${matchedMeta.label}" terkunci karena kuota aktif paket ${effVaultCap.planId} adalah ${effVaultCap.maxBinanceAccounts} akun. Jadikan Default atau tambah slot di /billing.`,
            timestamp: new Date().toISOString(),
          },
          { status: 403 }
        );
      }
      if (creds.permissions) {
        validateBinancePermissions(creds.permissions);
      }
      await execDb.touchBinanceCredentialLastUsed(creds.id);

      const tradeIntentId = await saveTradeIntent({
        userId: auth.user.userId,
        stage,
        symbol,
        side,
        type,
        quantity,
        price,
        idempotencyKey,
        status: 'APPROVED',
        riskDecisionReason: decision.reason,
      });

      await notifyUserWebhookBestEffort({
        resolveWebhookUrl: resolveUserWebhookUrl,
        payload: {
          event: 'ORDER_APPROVED',
          title: `CEX Order Approved: ${side} ${symbol}`,
          message: `Intent ${tradeIntentId} (${creds.environment || 'TESTNET'} · ${creds.label || 'Binance Primary'}) lolos Risk Gate.`,
          metadata: { tradeIntentId, symbol, side, quantity, executionMode, environment: creds.environment || 'TESTNET' },
        },
      });

      return NextResponse.json({
        success: true,
        data: {
          tradeIntentId,
          executionMode,
          venue: 'BINANCE',
          venueRouting,
          status: 'APPROVED',
          credentialId: creds.id,
          credentialLabel: creds.label || 'Binance Primary',
          credentialEnvironment: creds.environment || 'TESTNET',
          decision,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Default: PAPER simulated immediate fill
    const tradeIntentId = await saveTradeIntent({
      userId: auth.user.userId,
      stage: 'PAPER',
      symbol,
      side,
      type,
      quantity,
      price,
      idempotencyKey,
      status: 'APPROVED',
      riskDecisionReason: decision.reason,
    });

    return NextResponse.json({
      success: true,
      data: {
        tradeIntentId,
        executionMode: 'PAPER',
        status: 'FILLED_SIMULATED',
        decision,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.startsWith('DATABASE_UNAVAILABLE') ? 503 : 500;
    return NextResponse.json(
      { success: false, error: msg || 'TRADE_EXECUTION_FAILED', timestamp: new Date().toISOString() },
      { status }
    );
  }
}
