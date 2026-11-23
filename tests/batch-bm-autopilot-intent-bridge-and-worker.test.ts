import { describe, it, expect } from 'vitest';
import { runAutonomousCycleEvaluation } from '../packages/agent/autopilot-cycle-runner';
import {
  buildAutoPilotIdempotencyKey,
  buildTradeIntentsFromAutoPilotReport,
} from '../packages/agent/autopilot-intent-bridge';
import { runAutoPilotWorkerTick } from '../apps/execution-plane/autopilot-worker';

describe('Phase BM — Auto-Pilot Intent Bridge, Idempotency Deduplication & Worker Tick', () => {
  it('[BM1.1] buildAutoPilotIdempotencyKey produces identical key within the same 15m window and rotates on next window', () => {
    const t0 = 1_700_000_000_000;
    const k1 = buildAutoPilotIdempotencyKey({ userId: 'user-abc-123', symbol: 'BTCUSDT', side: 'BUY', windowMinutes: 15, nowMs: t0 });
    const k2 = buildAutoPilotIdempotencyKey({ userId: 'user-abc-123', symbol: 'BTCUSDT', side: 'BUY', windowMinutes: 15, nowMs: t0 + 60_000 });
    const k3 = buildAutoPilotIdempotencyKey({ userId: 'user-abc-123', symbol: 'BTCUSDT', side: 'BUY', windowMinutes: 15, nowMs: t0 + 16 * 60_000 });

    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1.startsWith('ap:userabc123:BTCUSDT:BUY:')).toBe(true);
  });

  it('[BM1.2] buildTradeIntentsFromAutoPilotReport queues TP SELL + Auto BUY on normal cycle, blocks BUY on Kill-Switch, and blocks FREE tier', () => {
    const baseConfig = {
      enabled: true,
      rail: 'CEX_AUTO' as const,
      maxOrderUsd: 250,
      takeProfitPct: 10,
      stopLossPct: 5,
      minConfidenceScore: 75,
      allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
      updatedAt: new Date().toISOString(),
    };

    const normalReport = runAutonomousCycleEvaluation({
      planId: 'AGENT',
      config: baseConfig,
      killSwitchActive: false,
      openPositions: [{ symbol: 'ETHUSDT', entryPrice: 3000, currentPrice: 3360, quantity: 0.2 }],
      marketSignals: [{ symbol: 'BTCUSDT', confidenceScore: 88, suggestedOrderUsd: 150, source: '5_AGENT' }],
    });

    const normalIntents = buildTradeIntentsFromAutoPilotReport({
      userId: 'usr-agent-1',
      stage: 'TESTNET',
      report: normalReport,
      nowMs: 1_700_000_000_000,
    });
    expect(normalIntents).toHaveLength(2);
    expect(normalIntents[0].side).toBe('SELL');
    expect(normalIntents[0].riskDecisionReason).toContain('AUTOPILOT_TAKE_PROFIT_SELL');
    expect(normalIntents[1].side).toBe('BUY');
    expect(normalIntents[1].symbol).toBe('BTCUSDT');

    const ksReport = runAutonomousCycleEvaluation({
      planId: 'AGENT',
      config: baseConfig,
      killSwitchActive: true,
      openPositions: [{ symbol: 'ETHUSDT', entryPrice: 3000, currentPrice: 2800, quantity: 0.2 }],
      marketSignals: [{ symbol: 'BTCUSDT', confidenceScore: 95, suggestedOrderUsd: 150 }],
    });
    const ksIntents = buildTradeIntentsFromAutoPilotReport({
      userId: 'usr-agent-1',
      stage: 'TESTNET',
      report: ksReport,
    });
    expect(ksIntents).toHaveLength(1);
    expect(ksIntents[0].side).toBe('SELL');
    expect(ksIntents[0].riskDecisionReason).toContain('AUTOPILOT_STOP_LOSS_SELL');

    const freeReport = runAutonomousCycleEvaluation({
      planId: 'FREE',
      config: baseConfig,
      killSwitchActive: false,
      openPositions: [{ symbol: 'ETHUSDT', entryPrice: 3000, currentPrice: 3400, quantity: 0.2 }],
      marketSignals: [{ symbol: 'BTCUSDT', confidenceScore: 95, suggestedOrderUsd: 100 }],
    });
    expect(buildTradeIntentsFromAutoPilotReport({ userId: 'usr-free', stage: 'PAPER', report: freeReport })).toEqual([]);
  });

  it('[BM2.1] runAutoPilotWorkerTick runs cleanly in dryRun mode without writing live orders', async () => {
    const res = await runAutoPilotWorkerTick({
      userId: 'usr-dry-1',
      walletAddress: '0x0000000000000000000000000000000000000001',
      planId: 'TRADER',
      stage: 'PAPER',
      config: {
        enabled: true,
        rail: 'CEX_AUTO',
        maxOrderUsd: 200,
        takeProfitPct: 10,
        stopLossPct: 5,
        minConfidenceScore: 75,
        allowedSymbols: ['BTCUSDT'],
        updatedAt: new Date().toISOString(),
      },
      marketSignals: [{ symbol: 'BTCUSDT', confidenceScore: 84, suggestedOrderUsd: 100 }],
      openPositions: [],
      dryRun: true,
    });
    expect(res.dryRun).toBe(true);
    expect(res.queuedCount).toBe(1);
    expect(res.intentKeys[0]).toContain(':BTCUSDT:BUY:');
  });
});
