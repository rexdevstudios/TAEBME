import { describe, expect, test } from 'bun:test';
import {
  AUTOPILOT_STRATEGY_PRESETS,
  evaluateAutoPilotPositionExit,
  explainAutoPilotDecision,
  validateAndClampAutoPilotConfig,
} from '../packages/agent/autopilot-policy';
import { runAutonomousCycleEvaluation } from '../packages/agent/autopilot-cycle-runner';
import { buildTradeIntentsFromAutoPilotReport } from '../packages/agent/autopilot-intent-bridge';

describe('Phase BX: Trailing Stop-Loss & Human-Readable AI Decision Log', () => {
  test('BX1.1 validates trailingStopPct (0=OFF or 0.5..30%) and exposes trailing presets', () => {
    const ok = validateAndClampAutoPilotConfig(
      { enabled: true, rail: 'CEX_AUTO', maxOrderUsd: 100, takeProfitPct: 15, stopLossPct: 5, trailingStopPct: 4 },
      'TRADER'
    );
    expect(ok.config.trailingStopPct).toBe(4);

    const off = validateAndClampAutoPilotConfig(
      { enabled: true, rail: 'CEX_AUTO', maxOrderUsd: 100, trailingStopPct: 0 },
      'TRADER'
    );
    expect(off.config.trailingStopPct).toBe(0);

    expect(() =>
      validateAndClampAutoPilotConfig(
        { enabled: true, rail: 'CEX_AUTO', maxOrderUsd: 100, trailingStopPct: 35 },
        'TRADER'
      )
    ).toThrow('INVALID_TRAILING_STOP_PCT');

    expect(AUTOPILOT_STRATEGY_PRESETS.every((p) => p.trailingStopPct >= 2 && p.trailingStopPct <= 10)).toBe(true);
  });

  test('BX1.2 evaluateAutoPilotPositionExit triggers TRAILING_STOP_SELL when drawdown from peak >= trailingStopPct', () => {
    // Entry 100, peaked at 112 (+12%), pulled back to 107 (-4.46% from peak >= 4% trailing stop) -> TRAILING_STOP_SELL
    const trailHit = evaluateAutoPilotPositionExit({
      entryPrice: 100,
      peakPrice: 112,
      currentPrice: 107,
      takeProfitPct: 15,
      stopLossPct: 5,
      trailingStopPct: 4,
    });
    expect(trailHit.action).toBe('TRAILING_STOP_SELL');
    expect(trailHit.pnlPct).toBe(7);

    // Small pullback (-1.79% from peak < 4%) -> HOLD
    const trailHold = evaluateAutoPilotPositionExit({
      entryPrice: 100,
      peakPrice: 112,
      currentPrice: 110,
      takeProfitPct: 15,
      stopLossPct: 5,
      trailingStopPct: 4,
    });
    expect(trailHold.action).toBe('HOLD');
  });

  test('BX1.3 explainAutoPilotDecision returns concise Indonesian human-readable explanations', () => {
    const buyReason = explainAutoPilotDecision('AUTO_BUY_READY', {
      symbol: 'BTCUSDT',
      confidenceScore: 86,
      minConfidenceScore: 75,
      orderUsd: 100,
    });
    expect(buyReason).toContain('BTCUSDT');
    expect(buyReason).toContain('86');

    const skipReason = explainAutoPilotDecision('CONFIDENCE_BELOW_THRESHOLD', {
      symbol: 'SOLUSDT',
      confidenceScore: 62,
      minConfidenceScore: 75,
    });
    expect(skipReason).toContain('SOLUSDT');
    expect(skipReason).toContain('di bawah ambang');

    const trailReason = explainAutoPilotDecision('TRAILING_STOP_SELL', {
      symbol: 'ETHUSDT',
      pnlPct: 7,
      trailingStopPct: 4,
    });
    expect(trailReason).toContain('Trailing Stop');
  });

  test('BX1.4 cycle runner & intent bridge emit TRAILING_STOP_SELL intents and human-readable reasons', () => {
    const { config } = validateAndClampAutoPilotConfig(
      {
        enabled: true,
        rail: 'CEX_AUTO',
        maxOrderUsd: 150,
        takeProfitPct: 15,
        stopLossPct: 5,
        trailingStopPct: 4,
        minConfidenceScore: 75,
        allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
      },
      'TRADER'
    );

    const report = runAutonomousCycleEvaluation({
      planId: 'TRADER',
      config,
      killSwitchActive: false,
      openPositions: [{ symbol: 'ETHUSDT', entryPrice: 3000, peakPrice: 3360, currentPrice: 3200, quantity: 0.25 }],
      marketSignals: [
        { symbol: 'BTCUSDT', confidenceScore: 84, suggestedOrderUsd: 100 },
        { symbol: 'ETHUSDT', confidenceScore: 60, suggestedOrderUsd: 100 },
      ],
    });

    expect(report.summary.trailingStopSellCount).toBe(1);
    expect(report.exitActions[0]?.action).toBe('TRAILING_STOP_SELL');
    expect(report.exitActions[0]?.reason).toContain('Trailing Stop');
    expect(report.entryActions[0]?.reason).toContain('lolos filter AI');
    expect(report.entryActions[1]?.reason).toContain('Kuota strategi aktif');

    const intents = buildTradeIntentsFromAutoPilotReport({
      userId: 'user-bx-test',
      stage: 'PAPER',
      report,
    });
    expect(intents.some((i) => i.side === 'SELL' && i.symbol === 'ETHUSDT' && i.riskDecisionReason?.includes('TRAILING_STOP_SELL'))).toBe(
      true
    );
  });
});
