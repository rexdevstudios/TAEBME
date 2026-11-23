import { describe, expect, test } from 'bun:test';
import {
  buildAutoPilotPeakPriceKey,
  computeUpdatedPeakPrice,
  hydrateOpenPositionsWithPeakPrices,
} from '../packages/agent/autopilot-market-feed';
import { validateAndClampAutoPilotConfig } from '../packages/agent/autopilot-policy';
import { runAutonomousCycleEvaluation } from '../packages/agent/autopilot-cycle-runner';

describe('Phase BZ: High-Water Mark Peak-Price Tracking & Live 24/7 Trailing Stop-Loss', () => {
  test('BZ1.1 builds normalized Redis peak-price keys and tracks monotonic high-water marks', () => {
    expect(buildAutoPilotPeakPriceKey('0xAbC123', 'eth/usdt')).toBe('agent:autopilot:peak:0xabc123:ETHUSDT');

    // Initial rally above entry
    expect(computeUpdatedPeakPrice({ entryPrice: 100, currentPrice: 112, storedPeakPrice: null })).toBe(112);
    // Pullback retains peak 112
    expect(computeUpdatedPeakPrice({ entryPrice: 100, currentPrice: 107, storedPeakPrice: 112 })).toBe(112);
    // New high advances peak to 118
    expect(computeUpdatedPeakPrice({ entryPrice: 100, currentPrice: 118, storedPeakPrice: 112 })).toBe(118);
  });

  test('BZ1.2 hydrateOpenPositionsWithPeakPrices persists peak across pulses and triggers TRAILING_STOP_SELL on pullback', async () => {
    const uniqueWallet = `0xbztest${Date.now()}`;
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

    // Pulse 1: ETH rallies from 3000 -> 3360 (+12%), high-water mark stored as 3360
    const pulse1Positions = await hydrateOpenPositionsWithPeakPrices(uniqueWallet, [
      { symbol: 'ETHUSDT', entryPrice: 3000, currentPrice: 3360, quantity: 0.5 },
    ]);
    expect(pulse1Positions[0]?.peakPrice).toBe(3360);

    const pulse1Report = runAutonomousCycleEvaluation({
      planId: 'TRADER',
      config,
      killSwitchActive: false,
      openPositions: pulse1Positions,
      marketSignals: [],
    });
    expect(pulse1Report.exitActions[0]?.action).toBe('HOLD');

    // Pulse 2: ETH pulls back to 3200 (-4.76% from peak 3360 >= 4% trailing stop) -> TRAILING_STOP_SELL!
    const pulse2Positions = await hydrateOpenPositionsWithPeakPrices(uniqueWallet, [
      { symbol: 'ETHUSDT', entryPrice: 3000, currentPrice: 3200, quantity: 0.5 },
    ]);
    expect(pulse2Positions[0]?.peakPrice).toBe(3360);

    const pulse2Report = runAutonomousCycleEvaluation({
      planId: 'TRADER',
      config,
      killSwitchActive: false,
      openPositions: pulse2Positions,
      marketSignals: [],
    });
    expect(pulse2Report.exitActions[0]?.action).toBe('TRAILING_STOP_SELL');
    expect(pulse2Report.summary.trailingStopSellCount).toBe(1);
  });
});
