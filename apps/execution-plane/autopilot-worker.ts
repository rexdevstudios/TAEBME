/**
 * apps/execution-plane/autopilot-worker.ts
 *
 * Standalone 24/7 Execution-Plane Auto-Pilot Worker CLI (Phase BM).
 * - Strictly runs outside Vercel/Next.js (`AGENTS.md` Rule 1: Control Plane Isolation).
 * - Zero Auto-Start on Import: safe to import in unit tests.
 * - Supports `--dry-run` and `--once` flags for safe preflight and VPS/Docker/Railway deployment.
 */

import {
  defaultKillSwitchDbAdapter,
  defaultProviderKeyVaultAdapter,
  saveTradeIntent,
} from '../../packages/shared/db-pool';
import { notifyUserWebhookBestEffort } from '../../packages/notifications/webhook-dispatcher';
import {
  runAutonomousCycleEvaluation,
  type AutoPilotMarketSignal,
  type AutoPilotOpenPosition,
} from '../../packages/agent/autopilot-cycle-runner';
import { buildTradeIntentsFromAutoPilotReport } from '../../packages/agent/autopilot-intent-bridge';
import type { AutoPilotConfig } from '../../packages/agent/autopilot-policy';
import type { PlanId } from '../../packages/billing/subscriptions-engine';

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

// CLI Entrypoint (only executes when invoked directly)
const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('apps/execution-plane/autopilot-worker.ts');

if (isMainModule) {
  const dryRun = process.argv.includes('--dry-run');
  const once = process.argv.includes('--once') || dryRun;

  const run = async () => {
    const res = await runAutoPilotWorkerTick({
      userId: process.env.AUTOPILOT_USER_ID || 'autopilot-dryrun-user',
      walletAddress: process.env.AUTOPILOT_WALLET_ADDRESS || '0x0000000000000000000000000000000000000001',
      planId: (process.env.AUTOPILOT_PLAN_ID as PlanId) || 'AGENT',
      stage: dryRun ? 'PAPER' : 'TESTNET',
      config: {
        enabled: true,
        rail: 'CEX_AUTO',
        maxOrderUsd: 250,
        takeProfitPct: 12,
        stopLossPct: 5,
        minConfidenceScore: 75,
        allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
        updatedAt: new Date().toISOString(),
      },
      marketSignals: [
        { symbol: 'BTCUSDT', confidenceScore: 86, suggestedOrderUsd: 150, source: '5_AGENT_DESK' },
      ],
      openPositions: [
        { symbol: 'ETHUSDT', entryPrice: 3000, currentPrice: 3420, quantity: 0.1 },
      ],
      dryRun,
    });
    console.log(
      `[AutoPilot Worker] Tick complete (dryRun=${res.dryRun}, killSwitch=${res.killSwitchActive}, queued=${res.queuedCount}, keys=${res.intentKeys.join(', ')})`
    );
  };

  run()
    .then(() => {
      if (once) process.exit(0);
    })
    .catch((err) => {
      console.error('[AutoPilot Worker] Fatal error:', err?.message || err);
      process.exit(1);
    });
}
