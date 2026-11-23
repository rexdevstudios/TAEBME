import { describe, expect, test } from 'bun:test';
import {
  clearAutoPilotPeakPrice,
  hydrateOpenPositionsWithPeakPrices,
} from '../packages/agent/autopilot-market-feed';
import { validateAndClampAutoPilotConfig } from '../packages/agent/autopilot-policy';
import { runAutonomousCycleEvaluation } from '../packages/agent/autopilot-cycle-runner';

describe('Phase CA: Peak-Price Reset on Exit & Re-Entry Lifecycle', () => {
  test('CA1.1 clearAutoPilotPeakPrice resets high-water mark so re-entry tracks fresh peak from new entry', async () => {
    const wallet = `0xcatest${Date.now()}`;
    const { config } = validateAndClampAutoPilotConfig(
      {
        enabled: true,
        rail: 'CEX_AUTO',
        maxOrderUsd: 100,
        takeProfitPct: 20,
        stopLossPct: 5,
        trailingStopPct: 4,
        allowedSymbols: ['ETHUSDT'],
      },
      'TRADER'
    );

    // Cycle 1: Rally to 3400 sets peak = 3400
    const p1 = await hydrateOpenPositionsWithPeakPrices(wallet, [
      { symbol: 'ETHUSDT', entryPrice: 3000, currentPrice: 3400, quantity: 0.5 },
    ]);
    expect(p1[0]?.peakPrice).toBe(3400);

    // Cycle 2: Pullback to 3220 triggers TRAILING_STOP_SELL
    const p2 = await hydrateOpenPositionsWithPeakPrices(wallet, [
      { symbol: 'ETHUSDT', entryPrice: 3000, currentPrice: 3220, quantity: 0.5 },
    ]);
    const exitReport = runAutonomousCycleEvaluation({
      planId: 'TRADER',
      config,
      killSwitchActive: false,
      openPositions: p2,
      marketSignals: [],
    });
    expect(exitReport.exitActions[0]?.action).toBe('TRAILING_STOP_SELL');

    // Reset peak on SELL execution
    await clearAutoPilotPeakPrice(wallet, 'ETHUSDT');

    // Cycle 3: Fresh re-entry at 2800 MUST start with fresh peak = 2800 (NOT stale 3400!)
    const p3 = await hydrateOpenPositionsWithPeakPrices(wallet, [
      { symbol: 'ETHUSDT', entryPrice: 2800, currentPrice: 2800, quantity: 0.5 },
    ]);
    expect(p3[0]?.peakPrice).toBe(2800);

    const reentryReport = runAutonomousCycleEvaluation({
      planId: 'TRADER',
      config,
      killSwitchActive: false,
      openPositions: p3,
      marketSignals: [],
    });
    expect(reentryReport.exitActions[0]?.action).toBe('HOLD');
  });
});
