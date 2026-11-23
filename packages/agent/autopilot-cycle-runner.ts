/**
 * packages/agent/autopilot-cycle-runner.ts
 *
 * Pure Deterministic Autonomous AI Signal-to-Intent Cycle Runner & Auto-TP/SL Evaluator (Phase BL).
 * - Reuses `evaluateAutoPilotEntrySignal` & `evaluateAutoPilotPositionExit` from `autopilot-policy.ts`.
 * - Enforces billing tier `maxAutoPilotStrategies` cap (TRADER=2, AGENT=5) and global Kill-Switch.
 * - Zero network side-effects, zero private keys, 100% deterministic for both Vercel dry-run API
 *   and persistent 24/7 execution workers.
 */

import { SubscriptionsEngine, type PlanId } from '../billing/subscriptions-engine';
import {
  evaluateAutoPilotEntrySignal,
  evaluateAutoPilotPositionExit,
  type AutoPilotConfig,
  type AutoPilotEntryDecision,
  type AutoPilotExitAction,
} from './autopilot-policy';

export interface AutoPilotMarketSignal {
  symbol: string;
  confidenceScore: number;
  suggestedOrderUsd: number;
  source?: string;
}

export interface AutoPilotOpenPosition {
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
}

export interface AutoPilotExitEvaluation {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  pnlPct: number;
  action: AutoPilotExitAction;
}

export interface AutoPilotEntryEvaluation {
  symbol: string;
  confidenceScore: number;
  orderUsd: number;
  source: string;
  decision: AutoPilotEntryDecision | 'STRATEGY_CAP_REACHED';
  approved: boolean;
}

export interface AutoPilotCycleReport {
  planId: PlanId;
  eligible: boolean;
  rail: AutoPilotConfig['rail'];
  killSwitchActive: boolean;
  maxAutoPilotStrategies: number;
  exitActions: AutoPilotExitEvaluation[];
  entryActions: AutoPilotEntryEvaluation[];
  summary: {
    buyReadyCount: number;
    tpSellCount: number;
    slSellCount: number;
    holdCount: number;
    skippedCount: number;
  };
  evaluatedAt: string;
}

export function runAutonomousCycleEvaluation(params: {
  planId?: string | null;
  config: AutoPilotConfig;
  killSwitchActive: boolean;
  marketSignals: AutoPilotMarketSignal[];
  openPositions: AutoPilotOpenPosition[];
}): AutoPilotCycleReport {
  const cap = SubscriptionsEngine.getPlanCapacities(params.planId);
  const evaluatedAt = new Date().toISOString();

  if (!cap.autoPilotEnabled) {
    return {
      planId: cap.planId,
      eligible: false,
      rail: params.config.rail,
      killSwitchActive: Boolean(params.killSwitchActive),
      maxAutoPilotStrategies: 0,
      exitActions: [],
      entryActions: [],
      summary: {
        buyReadyCount: 0,
        tpSellCount: 0,
        slSellCount: 0,
        holdCount: 0,
        skippedCount: (params.marketSignals || []).length,
      },
      evaluatedAt,
    };
  }

  let tpSellCount = 0;
  let slSellCount = 0;
  let holdCount = 0;

  const exitActions: AutoPilotExitEvaluation[] = (params.openPositions || []).map((pos) => {
    const res = evaluateAutoPilotPositionExit({
      entryPrice: pos.entryPrice,
      currentPrice: pos.currentPrice,
      takeProfitPct: params.config.takeProfitPct,
      stopLossPct: params.config.stopLossPct,
    });
    if (res.action === 'TAKE_PROFIT_SELL') tpSellCount += 1;
    else if (res.action === 'STOP_LOSS_SELL') slSellCount += 1;
    else holdCount += 1;

    return {
      symbol: String(pos.symbol || '').trim().toUpperCase(),
      quantity: Number(pos.quantity || 0),
      entryPrice: Number(pos.entryPrice || 0),
      currentPrice: Number(pos.currentPrice || 0),
      pnlPct: res.pnlPct,
      action: res.action,
    };
  });

  let buyReadyCount = 0;
  let skippedCount = 0;
  const maxActive = Math.max(0, cap.maxAutoPilotStrategies);
  const currentOpenCount = (params.openPositions || []).length;

  const entryActions: AutoPilotEntryEvaluation[] = (params.marketSignals || []).map((sig) => {
    const symbol = String(sig.symbol || '').trim().toUpperCase();
    const orderUsd = Number(sig.suggestedOrderUsd || 0);
    const confidenceScore = Number(sig.confidenceScore || 0);
    const source = sig.source || 'SCOUT_SIGNAL';

    if (currentOpenCount + buyReadyCount >= maxActive) {
      skippedCount += 1;
      return {
        symbol,
        confidenceScore,
        orderUsd,
        source,
        decision: 'STRATEGY_CAP_REACHED',
        approved: false,
      };
    }

    const res = evaluateAutoPilotEntrySignal({
      symbol,
      confidenceScore,
      orderUsd,
      config: params.config,
      killSwitchActive: Boolean(params.killSwitchActive),
    });

    if (res.approved) {
      buyReadyCount += 1;
    } else {
      skippedCount += 1;
    }

    return {
      symbol,
      confidenceScore,
      orderUsd,
      source,
      decision: res.decision,
      approved: res.approved,
    };
  });

  return {
    planId: cap.planId,
    eligible: true,
    rail: params.config.rail,
    killSwitchActive: Boolean(params.killSwitchActive),
    maxAutoPilotStrategies: cap.maxAutoPilotStrategies,
    exitActions,
    entryActions,
    summary: {
      buyReadyCount,
      tpSellCount,
      slSellCount,
      holdCount,
      skippedCount,
    },
    evaluatedAt,
  };
}
