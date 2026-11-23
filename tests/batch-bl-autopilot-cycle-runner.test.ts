import { describe, it, expect } from 'vitest';
import { validateAndClampAutoPilotConfig } from '../packages/agent/autopilot-policy';
import { runAutonomousCycleEvaluation } from '../packages/agent/autopilot-cycle-runner';

describe('Phase BL — Autonomous Signal-to-Intent Cycle Runner & Auto-TP/SL Simulator', () => {
  it('[BL1.1] runAutonomousCycleEvaluation enforces TRADER maxAutoPilotStrategies=2 cap and evaluates TP/SL exits', () => {
    const { config } = validateAndClampAutoPilotConfig(
      {
        enabled: true,
        rail: 'CEX_AUTO',
        maxOrderUsd: 250,
        takeProfitPct: 10,
        stopLossPct: 5,
        minConfidenceScore: 75,
        allowedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      },
      'TRADER'
    );

    const report = runAutonomousCycleEvaluation({
      planId: 'TRADER',
      config,
      killSwitchActive: false,
      openPositions: [
        { symbol: 'BTCUSDT', entryPrice: 100, currentPrice: 112, quantity: 1 }, // TP +12%
      ],
      marketSignals: [
        { symbol: 'ETHUSDT', confidenceScore: 85, suggestedOrderUsd: 200, source: '5_AGENT' }, // slot 2 -> APPROVED
        { symbol: 'SOLUSDT', confidenceScore: 90, suggestedOrderUsd: 200, source: 'SCOUT' }, // slot 3 -> STRATEGY_CAP_REACHED
      ],
    });

    expect(report.eligible).toBe(true);
    expect(report.summary.tpSellCount).toBe(1);
    expect(report.summary.buyReadyCount).toBe(1);
    expect(report.summary.skippedCount).toBe(1);
    expect(report.entryActions[0].decision).toBe('AUTO_BUY_READY');
    expect(report.entryActions[1].decision).toBe('STRATEGY_CAP_REACHED');
  });

  it('[BL1.2] runAutonomousCycleEvaluation blocks all entries when killSwitchActive is true and returns eligible=false on FREE', () => {
    const { config } = validateAndClampAutoPilotConfig(
      { enabled: true, rail: 'DEX_SESSION', maxOrderUsd: 1000, allowedSymbols: ['BTCUSDT'] },
      'AGENT'
    );

    const ksReport = runAutonomousCycleEvaluation({
      planId: 'AGENT',
      config,
      killSwitchActive: true,
      openPositions: [{ symbol: 'BTCUSDT', entryPrice: 100, currentPrice: 92, quantity: 1 }], // SL -8%
      marketSignals: [{ symbol: 'BTCUSDT', confidenceScore: 95, suggestedOrderUsd: 500 }],
    });
    expect(ksReport.summary.slSellCount).toBe(1);
    expect(ksReport.summary.buyReadyCount).toBe(0);
    expect(ksReport.entryActions[0].decision).toBe('BLOCKED_KILL_SWITCH');

    const freeReport = runAutonomousCycleEvaluation({
      planId: 'FREE',
      config,
      killSwitchActive: false,
      openPositions: [],
      marketSignals: [{ symbol: 'BTCUSDT', confidenceScore: 95, suggestedOrderUsd: 100 }],
    });
    expect(freeReport.eligible).toBe(false);
    expect(freeReport.summary.buyReadyCount).toBe(0);
  });
});
