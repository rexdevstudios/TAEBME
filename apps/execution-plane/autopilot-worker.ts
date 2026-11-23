/**
 * apps/execution-plane/autopilot-worker.ts
 *
 * Standalone 24/7 Execution-Plane Auto-Pilot Worker CLI (Phase BM + BN + BO).
 * - Thin CLI wrapper around `@packages/agent/autopilot-sweep` (zero duplication).
 * - Strictly runs outside Vercel/Next.js (`AGENTS.md` Rule 1: Control Plane Isolation).
 * - Zero Auto-Start on Import: safe to import in unit tests.
 */

import {
  runAutoPilotWorkerTick,
  runMultiTenantAutoPilotSweep,
  type AutoPilotWorkerTickOptions,
} from '../../packages/agent/autopilot-sweep';
import type { PlanId } from '../../packages/billing/subscriptions-engine';

export { runAutoPilotWorkerTick, runMultiTenantAutoPilotSweep, type AutoPilotWorkerTickOptions };

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
