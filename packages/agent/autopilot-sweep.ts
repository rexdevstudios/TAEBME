/**
 * packages/agent/autopilot-sweep.ts
 *
 * Stateless Multi-Tenant Auto-Pilot Tick & Sweep Engine (Shared by Vercel Cron & 24/7 Worker).
 * - Zero auto-start on import, zero persistent loops, zero private keys.
 * - Re-validates live billing tier (`TRADER`/`AGENT`), Global Kill-Switch, and 15m idempotency.
 */

import {
  defaultBillingDbAdapter,
  defaultKillSwitchDbAdapter,
  defaultProviderKeyVaultAdapter,
  listUserRecentTradeIntents,
  saveTradeIntent,
} from '../shared/db-pool';
import { upstashRedis } from '../shared/redis-client';
import { notifyUserWebhookBestEffort } from '../notifications/webhook-dispatcher';
import {
  runAutonomousCycleEvaluation,
  type AutoPilotMarketSignal,
  type AutoPilotOpenPosition,
} from './autopilot-cycle-runner';
import { buildTradeIntentsFromAutoPilotReport } from './autopilot-intent-bridge';
import type { AutoPilotConfig } from './autopilot-policy';
import {
  clearAutoPilotPeakPrice,
  computeDynamicSignalConfidence,
  deriveOpenPositionsFromTradeIntents,
  fetchAutoPilot24hTickers,
  fetchAutoPilotSpotPrices,
  hydrateOpenPositionsWithLivePrices,
  hydrateOpenPositionsWithPeakPrices,
  listActiveAutoPilotWallets,
  syncActiveAutoPilotRegistry,
} from './autopilot-market-feed';
import { SubscriptionsEngine, type PlanId } from '../billing/subscriptions-engine';
import { parseBybitKeyPair, submitBybitSpotOrder } from '../trading/bybit-vault';

export interface AutoPilotWorkerTickOptions {
  userId: string;
  walletAddress: string;
  planId: PlanId;
  stage: 'PAPER' | 'TESTNET' | 'LIVE';
  config: AutoPilotConfig;
  marketSignals: AutoPilotMarketSignal[];
  openPositions: AutoPilotOpenPosition[];
  dryRun?: boolean;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  bybitCredentialOverride?: { apiKey: string; secretKey: string; environment: 'TESTNET' | 'MAINNET' } | null;
}

export async function runAutoPilotWorkerTick(opts: AutoPilotWorkerTickOptions): Promise<{
  queuedCount: number;
  cexExecutedCount: number;
  dryRun: boolean;
  killSwitchActive: boolean;
  intentKeys: string[];
}> {
  const activeKillSwitches = await defaultKillSwitchDbAdapter.getActiveKillSwitches().catch(() => []);
  const killSwitchActive = Array.isArray(activeKillSwitches) && activeKillSwitches.length > 0;

  const report = runAutonomousCycleEvaluation({
    planId: opts.planId,
    config: opts.config,
    killSwitchActive,
    marketSignals: opts.marketSignals,
    openPositions: opts.openPositions,
  });

  const intents = buildTradeIntentsFromAutoPilotReport({
    userId: opts.userId,
    stage: opts.stage,
    report,
    nowMs: opts.nowMs,
  });

  const intentKeys: string[] = [];
  let cexExecutedCount = 0;
  const planCap = SubscriptionsEngine.getPlanCapacities(opts.planId);
  const canAutoExecuteCex =
    !opts.dryRun &&
    Boolean(opts.config.autoExecuteCex) &&
    opts.config.rail === 'CEX_AUTO' &&
    planCap.autoPilotEnabled;

  for (const intent of intents) {
    intentKeys.push(intent.idempotencyKey);
    if (!opts.dryRun) {
      await saveTradeIntent(intent);
      if (intent.side === 'SELL') {
        await clearAutoPilotPeakPrice(opts.walletAddress, intent.symbol).catch(() => {});
      }

      let cexOrderId: string | undefined;
      if (canAutoExecuteCex) {
        try {
          let cred = opts.bybitCredentialOverride || null;
          if (!cred) {
            const preferMainnet = opts.stage === 'LIVE' && planCap.allowMainnetBinance;
            const resolved = await defaultProviderKeyVaultAdapter
              .resolveDecryptedKeyForDeploy({
                userIdentifier: opts.walletAddress,
                targetChain: preferMainnet ? 'mainnet' : 'testnet',
                provider: 'BYBIT',
              })
              .catch(() => null);
            if (resolved?.apiKey) {
              const pair = parseBybitKeyPair(resolved.apiKey);
              cred = {
                apiKey: pair.apiKey,
                secretKey: pair.secretKey,
                environment: preferMainnet ? 'MAINNET' : 'TESTNET',
              };
            }
          }

          if (cred) {
            const execRes = await submitBybitSpotOrder({
              apiKey: cred.apiKey,
              secretKey: cred.secretKey,
              environment: cred.environment,
              symbol: intent.symbol,
              side: intent.side,
              orderType: 'MARKET',
              qty: intent.quantity,
              orderLinkId: intent.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 36),
              fetchImpl: opts.fetchImpl,
            });
            if (execRes.submitted) {
              cexExecutedCount += 1;
              cexOrderId = execRes.orderId;
            }
          }
        } catch {
          // Non-blocking: intent remains safely persisted in PostgreSQL SSOT
        }
      }

      const isTrailingStop =
        Boolean(intent.riskDecisionReason?.includes('TRAILING_STOP')) ||
        intent.idempotencyKey.includes('TRAILING_STOP');

      await notifyUserWebhookBestEffort({
        resolveWebhookUrl: async () => {
          const hook = await defaultProviderKeyVaultAdapter
            .resolveDecryptedKeyForDeploy({
              userIdentifier: opts.walletAddress,
              targetChain: 'all',
              provider: 'WEBHOOK',
            })
            .catch(() => null);
          return hook?.apiKey || null;
        },
        payload: {
          event: isTrailingStop ? 'TRAILING_STOP_TRIGGERED' : 'AUTOPILOT_ORDER_QUEUED',
          title: cexOrderId
            ? `${isTrailingStop ? 'Trailing Stop' : 'Auto-Pilot'} Executed ${intent.side} ${intent.symbol} (Bybit)`
            : `${isTrailingStop ? 'Trailing Stop' : 'Auto-Pilot'} Queued ${intent.side} ${intent.symbol}`,
          message: `${intent.riskDecisionReason || 'Auto-Pilot Signal'} · Stage: ${intent.stage} · Qty: ${intent.quantity}${cexOrderId ? ` · OrderId: ${cexOrderId}` : ''}`,
          metadata: {
            symbol: intent.symbol,
            side: intent.side,
            stage: intent.stage,
            idempotencyKey: intent.idempotencyKey,
            ...(cexOrderId ? { cexOrderId } : {}),
          },
        },
      });
    }
  }

  return {
    queuedCount: intents.length,
    cexExecutedCount,
    dryRun: Boolean(opts.dryRun),
    killSwitchActive,
    intentKeys,
  };
}

export async function runMultiTenantAutoPilotSweep(params?: {
  dryRun?: boolean;
  stage?: 'PAPER' | 'TESTNET' | 'LIVE';
  fetchImpl?: typeof fetch;
  openPositionsByWallet?: Record<string, AutoPilotOpenPosition[]>;
  marketSignals?: AutoPilotMarketSignal[];
}): Promise<{
  scannedWallets: number;
  executedWallets: number;
  deregisteredDowngraded: number;
  totalQueued: number;
  fastPathIdle: boolean;
}> {
  const wallets = await listActiveAutoPilotWallets();
  if (wallets.length === 0) {
    // Zero-DB Fast-Path: keep Neon PostgreSQL auto-suspended ($0 compute burn when idle)
    return {
      scannedWallets: 0,
      executedWallets: 0,
      deregisteredDowngraded: 0,
      totalQueued: 0,
      fastPathIdle: true,
    };
  }

  let executedWallets = 0;
  let deregisteredDowngraded = 0;
  let totalQueued = 0;

  for (const wallet of wallets) {
    const planId = await defaultBillingDbAdapter.getUserPlan(wallet).catch(() => 'FREE' as PlanId);
    const cap = SubscriptionsEngine.getPlanCapacities(planId);
    if (!cap.autoPilotEnabled) {
      await syncActiveAutoPilotRegistry(wallet, false).catch(() => {});
      deregisteredDowngraded += 1;
      continue;
    }

    const cfgKey = `agent:autopilot:cfg:${wallet.trim().toLowerCase()}`;
    const rawCfg = upstashRedis.isConfigured()
      ? await upstashRedis.get<string>(cfgKey).catch(() => null)
      : null;
    if (!rawCfg) continue;

    let config: AutoPilotConfig;
    try {
      config = typeof rawCfg === 'string' ? JSON.parse(rawCfg) : rawCfg;
    } catch {
      continue;
    }
    if (!config.enabled) continue;

    const rawPositions =
      params?.openPositionsByWallet?.[wallet] ??
      deriveOpenPositionsFromTradeIntents(
        await listUserRecentTradeIntents(wallet, 25).catch(() => [])
      );
    const symbolsToPrice = Array.from(
      new Set([...config.allowedSymbols, ...rawPositions.map((p) => p.symbol)])
    );
    const tickers24h = await fetchAutoPilot24hTickers(symbolsToPrice, params?.fetchImpl);
    const livePrices: Record<string, number> = {};
    for (const [sym, t] of Object.entries(tickers24h)) {
      livePrices[sym] = t.lastPrice;
    }
    if (Object.keys(livePrices).length === 0) {
      Object.assign(livePrices, await fetchAutoPilotSpotPrices(symbolsToPrice, params?.fetchImpl));
    }
    const hydratedPositions = await hydrateOpenPositionsWithPeakPrices(
      wallet,
      hydrateOpenPositionsWithLivePrices(rawPositions, livePrices)
    );

    const dynamicSignals: AutoPilotMarketSignal[] =
      params?.marketSignals && params.marketSignals.length > 0
        ? params.marketSignals.map((sig) => {
            const cleanSym = String(sig.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
            const t = tickers24h[cleanSym];
            return t
              ? {
                  ...sig,
                  confidenceScore: computeDynamicSignalConfidence({
                    priceChangePct24h: t.priceChangePct24h,
                    quoteVolumeUsd: t.quoteVolumeUsd,
                  }),
                }
              : sig;
          })
        : Object.values(tickers24h).map((t) => ({
            symbol: t.symbol,
            confidenceScore: computeDynamicSignalConfidence({
              priceChangePct24h: t.priceChangePct24h,
              quoteVolumeUsd: t.quoteVolumeUsd,
            }),
            suggestedOrderUsd: config.maxOrderUsd,
            source: 'BINANCE_24H_MOMENTUM',
          }));

    const tick = await runAutoPilotWorkerTick({
      userId: wallet,
      walletAddress: wallet,
      planId,
      stage: params?.stage || (params?.dryRun ? 'PAPER' : 'TESTNET'),
      config,
      marketSignals: dynamicSignals,
      openPositions: hydratedPositions,
      dryRun: params?.dryRun,
      fetchImpl: params?.fetchImpl,
    });

    executedWallets += 1;
    totalQueued += tick.queuedCount;
  }

  return {
    scannedWallets: wallets.length,
    executedWallets,
    deregisteredDowngraded,
    totalQueued,
    fastPathIdle: false,
  };
}
