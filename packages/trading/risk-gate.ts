import {
  TradeIntentInput,
  UserRiskLimits,
  KillSwitch,
  RiskDecision,
  evaluateTradeRisk,
} from '../shared/types/domain';

export type TradeIntentStatus =
  | 'PENDING_RISK'
  | 'RISK_APPROVED'
  | 'RISK_REJECTED'
  | 'EXECUTING'
  | 'EXECUTED'
  | 'CANCELLED'
  | 'FAILED';

export interface EntitlementCheck {
  planId: string;
  hasLiveTrading: boolean;
}

export class TradingRiskGate {
  /**
   * Pipeline Evaluasi Deterministik Risk Engine untuk Live & Testnet Order Intent
   */
  static evaluateIntent(
    intent: TradeIntentInput,
    userLimits: UserRiskLimits,
    userEntitlement: EntitlementCheck,
    activeKillSwitches: KillSwitch[]
  ): { status: TradeIntentStatus; decision: RiskDecision } {
    // 1. Entitlement Guard Check: Live Trading memuat ijin plan
    if (intent.stage === 'LIVE' && !userEntitlement.hasLiveTrading) {
      return {
        status: 'RISK_REJECTED',
        decision: {
          isApproved: false,
          score: 100,
          reason: `ENTITLEMENT_DENIED: Plan ${userEntitlement.planId} does not support live Binance trading`,
          riskFactors: ['NO_LIVE_TRADING_ENTITLEMENT'],
        },
      };
    }

    // 2. Evaluasi Deterministik Risk Engine (Kill Switch, Slippage, Max Order, Daily Loss)
    const decision = evaluateTradeRisk(intent, userLimits, activeKillSwitches);
    if (!decision.isApproved) {
      return {
        status: 'RISK_REJECTED',
        decision,
      };
    }

    // 3. Paper Trading Auto-Approval (setelah lolos kill switch & risk gate)
    if (intent.stage === 'PAPER') {
      return {
        status: 'RISK_APPROVED',
        decision: {
          isApproved: true,
          score: 0,
          riskFactors: [],
        },
      };
    }

    const status: TradeIntentStatus = decision.isApproved ? 'RISK_APPROVED' : 'RISK_REJECTED';

    return { status, decision };
  }
}

export interface DailyOrderFillSample {
  side: 'BUY' | 'SELL';
  quoteValueUsd: number;
  status: string;
}

/**
 * Pure deterministic 24h realized daily loss & open-position exposure calculator.
 * Computes realized daily deficit when closed/sold volume is below corresponding buy outlay,
 * and counts active open intents (`APPROVED` / `EXECUTING`).
 */
export function compute24hRiskExposure(params: {
  fills: DailyOrderFillSample[];
  openIntentCount: number;
}): { currentDailyLossUsd: number; currentOpenPositions: number } {
  let buyQuote = 0;
  let sellQuote = 0;
  for (const f of params.fills) {
    const st = String(f.status || '').toUpperCase();
    if (st !== 'FILLED' && st !== 'EXECUTED') continue;
    const val = Number.isFinite(Number(f.quoteValueUsd)) ? Math.max(0, Number(f.quoteValueUsd)) : 0;
    if (f.side === 'BUY') buyQuote += val;
    if (f.side === 'SELL') sellQuote += val;
  }

  const realizedLoss = sellQuote > 0 && buyQuote > sellQuote ? Math.round((buyQuote - sellQuote) * 100) / 100 : 0;
  return {
    currentDailyLossUsd: realizedLoss,
    currentOpenPositions: Math.max(0, Math.floor(Number(params.openIntentCount || 0))),
  };
}
