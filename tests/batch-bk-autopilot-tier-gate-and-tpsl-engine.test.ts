import { describe, it, expect } from 'vitest';
import { SubscriptionsEngine } from '../packages/billing/subscriptions-engine';
import {
  evaluateAutoPilotEntrySignal,
  evaluateAutoPilotPositionExit,
  validateAndClampAutoPilotConfig,
} from '../packages/agent/autopilot-policy';

describe('Phase BK — Autonomous AI Trading Auto-Pilot Tier Gate & TP/SL Engine', () => {
  it('[BK1.1] PlanCapacities locks Auto-Pilot on FREE & CREATOR and unlocks TRADER (2 CEX) & AGENT (5 CEX+DEX)', () => {
    const free = SubscriptionsEngine.getPlanCapacities('FREE');
    const creator = SubscriptionsEngine.getPlanCapacities('CREATOR');
    const trader = SubscriptionsEngine.getPlanCapacities('TRADER');
    const agent = SubscriptionsEngine.getPlanCapacities('AGENT');

    expect(free.autoPilotEnabled).toBe(false);
    expect(creator.autoPilotEnabled).toBe(false);
    expect(trader.autoPilotEnabled).toBe(true);
    expect(trader.maxAutoPilotStrategies).toBe(2);
    expect(trader.autoPilotRails).toEqual(['CEX_AUTO']);
    expect(agent.autoPilotEnabled).toBe(true);
    expect(agent.maxAutoPilotStrategies).toBe(5);
    expect(agent.autoPilotRails).toEqual(['CEX_AUTO', 'DEX_SESSION']);
  });

  it('[BK1.2] validateAndClampAutoPilotConfig fails closed on FREE/CREATOR and clamps TRADER/AGENT limits', () => {
    expect(() => validateAndClampAutoPilotConfig({ enabled: true }, 'FREE')).toThrow('PLAN_AUTOPILOT_REQUIRED');
    expect(() => validateAndClampAutoPilotConfig({ enabled: true }, 'CREATOR')).toThrow('PLAN_AUTOPILOT_REQUIRED');
    expect(() =>
      validateAndClampAutoPilotConfig({ enabled: true, rail: 'DEX_SESSION' }, 'TRADER')
    ).toThrow('AUTOPILOT_RAIL_UPGRADE_REQUIRED');

    const traderRes = validateAndClampAutoPilotConfig(
      { enabled: true, rail: 'CEX_AUTO', maxOrderUsd: 9999, takeProfitPct: 15, stopLossPct: 4, allowedSymbols: 'btcusdt, ethusdt' },
      'TRADER'
    );
    expect(traderRes.config.maxOrderUsd).toBe(500);
    expect(traderRes.config.allowedSymbols).toEqual(['BTCUSDT', 'ETHUSDT']);

    const agentRes = validateAndClampAutoPilotConfig(
      { enabled: true, rail: 'DEX_SESSION', maxOrderUsd: 5000, takeProfitPct: 20, stopLossPct: 6 },
      'AGENT'
    );
    expect(agentRes.config.rail).toBe('DEX_SESSION');
    expect(agentRes.config.maxOrderUsd).toBe(2500);
  });

  it('[BK1.3] evaluateAutoPilotPositionExit and evaluateAutoPilotEntrySignal enforce TP, SL, confidence, and kill-switch', () => {
    expect(
      evaluateAutoPilotPositionExit({ entryPrice: 100, currentPrice: 115, takeProfitPct: 12, stopLossPct: 5 })
    ).toEqual({ action: 'TAKE_PROFIT_SELL', pnlPct: 15 });

    expect(
      evaluateAutoPilotPositionExit({ entryPrice: 100, currentPrice: 94, takeProfitPct: 12, stopLossPct: 5 })
    ).toEqual({ action: 'STOP_LOSS_SELL', pnlPct: -6 });

    expect(
      evaluateAutoPilotPositionExit({ entryPrice: 100, currentPrice: 104, takeProfitPct: 12, stopLossPct: 5 })
    ).toEqual({ action: 'HOLD', pnlPct: 4 });

    const { config } = validateAndClampAutoPilotConfig(
      { enabled: true, rail: 'CEX_AUTO', maxOrderUsd: 200, minConfidenceScore: 80, allowedSymbols: ['BTCUSDT'] },
      'TRADER'
    );

    expect(
      evaluateAutoPilotEntrySignal({ symbol: 'BTCUSDT', confidenceScore: 85, orderUsd: 150, config, killSwitchActive: true })
    ).toEqual({ decision: 'BLOCKED_KILL_SWITCH', approved: false });

    expect(
      evaluateAutoPilotEntrySignal({ symbol: 'BTCUSDT', confidenceScore: 85, orderUsd: 150, config, killSwitchActive: false })
    ).toEqual({ decision: 'AUTO_BUY_READY', approved: true });
  });
});
