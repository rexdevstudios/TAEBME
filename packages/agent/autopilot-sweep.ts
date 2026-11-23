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
  fetchAutoPilotSpotPrices,
  hydrateOpenPositionsWithLivePrices,
  listActiveAutoPilotWallets,
  syncActiveAutoPilotRegistry,
} from './autopilot-market-feed';
import { SubscriptionsEngine, type PlanId } from '../billing/subscriptions-engine';

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
}

export async function runAutoPilotWorkerTick(opts: AutoPilotWorkerTickOptions): Promise<{
  queuedCount: number;
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
  for (const intent of intents) {
    intentKeys.push(intent.idempotencyKey);
    if (!opts.dryRun) {
      await saveTradeIntent(intent);
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
          event: 'AUTOPILOT_ORDER_QUEUED',
          title: `Auto-Pilot Queued ${intent.side} ${intent.symbol}`,
          message: `${intent.riskDecisionReason || 'Auto-Pilot Signal'} · Stage: ${intent.stage} · Qty: ${intent.quantity}`,
          metadata: {
            symbol: intent.symbol,
            side: intent.side,
            stage: intent.stage,
            idempotencyKey: intent.idempotencyKey,
          },
        },
      });
    }
  }

  return {
    queuedCount: intents.length,
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
}> {
  const wallets = await listActiveAutoPilotWallets();
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

    const rawPositions = params?.openPositionsByWallet?.[wallet] || [];
    const symbolsToPrice = Array.from(
      new Set([...config.allowedSymbols, ...rawPositions.map((p) => p.symbol)])
    );
    const livePrices = await fetchAutoPilotSpotPrices(symbolsToPrice, params?.fetchImpl);
    const hydratedPositions = hydrateOpenPositionsWithLivePrices(rawPositions, livePrices);

    const tick = await runAutoPilotWorkerTick({
      userId: wallet,
      walletAddress: wallet,
      planId,
      stage: params?.stage || (params?.dryRun ? 'PAPER' : 'TESTNET'),
      config,
      marketSignals: params?.marketSignals || [],
      openPositions: hydratedPositions,
      dryRun: params?.dryRun,
    });

    executedWallets += 1;
    totalQueued += tick.queuedCount;
  }

  return {
    scannedWallets: wallets.length,
    executedWallets,
    deregisteredDowngraded,
    totalQueued,
  };
}
