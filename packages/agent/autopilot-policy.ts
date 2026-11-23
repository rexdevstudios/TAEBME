/**
 * packages/agent/autopilot-policy.ts
 *
 * Pure Deterministic Autonomous AI Trading Auto-Pilot Policy & TP/SL Evaluator (Phase BK).
 * - Exclusive to Pro Terminal Trader (`TRADER`) and AI Autonomous Desk (`AGENT`) plans.
 * - 100% Non-Custodial: never accepts or stores private keys (`AGENTS.md` Rule 3).
 * - Strictly clamped against `SubscriptionsEngine.getPlanCapacities` and Kill-Switch.
 */

import {
  SubscriptionsEngine,
  type AutoPilotRail,
  type PlanId,
} from '../billing/subscriptions-engine';

export interface AutoPilotConfig {
  enabled: boolean;
  rail: AutoPilotRail;
  autoExecuteCex?: boolean;
  maxOrderUsd: number;
  takeProfitPct: number;
  stopLossPct: number;
  minConfidenceScore: number;
  allowedSymbols: string[];
  updatedAt: string;
}

export interface AutoPilotConfigInput {
  enabled?: boolean;
  rail?: string;
  autoExecuteCex?: boolean;
  maxOrderUsd?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  minConfidenceScore?: number;
  allowedSymbols?: string[] | string;
}

export interface AutoPilotStrategyPreset {
  id: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  label: string;
  description: string;
  maxOrderUsd: number;
  takeProfitPct: number;
  stopLossPct: number;
  minConfidenceScore: number;
  allowedSymbols: string[];
}

export const AUTOPILOT_STRATEGY_PRESETS: AutoPilotStrategyPreset[] = [
  {
    id: 'CONSERVATIVE',
    label: 'Konservatif (Pemula)',
    description: 'Blue-chip BTC & ETH · TP 8% / SL 3% · Filter AI ketat (82+)',
    maxOrderUsd: 50,
    takeProfitPct: 8,
    stopLossPct: 3,
    minConfidenceScore: 82,
    allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
  },
  {
    id: 'BALANCED',
    label: 'Seimbang (Swing)',
    description: 'BTC, ETH, SOL · TP 15% / SL 5% · Filter AI seimbang (75+)',
    maxOrderUsd: 150,
    takeProfitPct: 15,
    stopLossPct: 5,
    minConfidenceScore: 75,
    allowedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  },
  {
    id: 'AGGRESSIVE',
    label: 'Agresif (Momentum)',
    description: 'Multi-pair momentum · TP 25% / SL 8% · Filter AI responsif (68+)',
    maxOrderUsd: 250,
    takeProfitPct: 25,
    stopLossPct: 8,
    minConfidenceScore: 68,
    allowedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'],
  },
];

export function getDefaultAutoPilotConfig(planId?: string | null): AutoPilotConfig {
  const cap = SubscriptionsEngine.getPlanCapacities(planId);
  return {
    enabled: false,
    rail: 'CEX_AUTO',
    autoExecuteCex: false,
    maxOrderUsd: cap.autoPilotEnabled ? Math.min(100, cap.maxAutoPilotOrderUsd) : 0,
    takeProfitPct: 12,
    stopLossPct: 5,
    minConfidenceScore: 75,
    allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
    updatedAt: new Date().toISOString(),
  };
}

export function validateAndClampAutoPilotConfig(
  input: AutoPilotConfigInput,
  planId?: string | null
): { planId: PlanId; config: AutoPilotConfig } {
  const cap = SubscriptionsEngine.getPlanCapacities(planId);
  if (!cap.autoPilotEnabled) {
    throw new Error(
      'PLAN_AUTOPILOT_REQUIRED: Autonomous AI Trading Auto-Pilot is exclusive to Pro Terminal Trader (TRADER) and AI Autonomous Desk (AGENT) plans.'
    );
  }

  const rawRail = String(input.rail || 'CEX_AUTO').trim().toUpperCase() as AutoPilotRail;
  if (rawRail !== 'CEX_AUTO' && rawRail !== 'DEX_SESSION') {
    throw new Error('INVALID_AUTOPILOT_RAIL: Supported rails are CEX_AUTO and DEX_SESSION.');
  }
  if (!cap.autoPilotRails.includes(rawRail)) {
    throw new Error(
      `AUTOPILOT_RAIL_UPGRADE_REQUIRED: Rail ${rawRail} requires AI Autonomous Desk (AGENT) plan.`
    );
  }

  const rawMaxOrder = Number(input.maxOrderUsd ?? 100);
  if (!Number.isFinite(rawMaxOrder) || rawMaxOrder <= 0) {
    throw new Error('INVALID_AUTOPILOT_ORDER_USD: maxOrderUsd must be a positive number.');
  }
  const maxOrderUsd = Math.round(Math.max(10, Math.min(rawMaxOrder, cap.maxAutoPilotOrderUsd)) * 100) / 100;

  const rawTp = Number(input.takeProfitPct ?? 12);
  const rawSl = Number(input.stopLossPct ?? 5);
  if (!Number.isFinite(rawTp) || rawTp < 1 || rawTp > 200) {
    throw new Error('INVALID_TAKE_PROFIT_PCT: takeProfitPct must be between 1% and 200%.');
  }
  if (!Number.isFinite(rawSl) || rawSl < 0.5 || rawSl > 50) {
    throw new Error('INVALID_STOP_LOSS_PCT: stopLossPct must be between 0.5% and 50%.');
  }

  const rawConf = Number(input.minConfidenceScore ?? 75);
  const minConfidenceScore = Number.isFinite(rawConf)
    ? Math.max(55, Math.min(95, Math.round(rawConf)))
    : 75;

  const rawSymbols = Array.isArray(input.allowedSymbols)
    ? input.allowedSymbols
    : typeof input.allowedSymbols === 'string'
    ? input.allowedSymbols.split(',')
    : ['BTCUSDT', 'ETHUSDT'];

  const allowedSymbols = Array.from(
    new Set(
      rawSymbols
        .map((s) => String(s || '').trim().toUpperCase())
        .filter((s) => /^[A-Z0-9/_-]{2,24}$/.test(s))
    )
  ).slice(0, 12);

  if (allowedSymbols.length === 0) {
    throw new Error('INVALID_ALLOWED_SYMBOLS: Provide at least one valid trading symbol (e.g. BTCUSDT).');
  }

  return {
    planId: cap.planId,
    config: {
      enabled: Boolean(input.enabled),
      rail: rawRail,
      autoExecuteCex: rawRail === 'CEX_AUTO' ? Boolean(input.autoExecuteCex) : false,
      maxOrderUsd,
      takeProfitPct: Math.round(rawTp * 100) / 100,
      stopLossPct: Math.round(rawSl * 100) / 100,
      minConfidenceScore,
      allowedSymbols,
      updatedAt: new Date().toISOString(),
    },
  };
}

export type AutoPilotExitAction = 'TAKE_PROFIT_SELL' | 'STOP_LOSS_SELL' | 'HOLD';

export function evaluateAutoPilotPositionExit(params: {
  entryPrice: number;
  currentPrice: number;
  takeProfitPct: number;
  stopLossPct: number;
}): { action: AutoPilotExitAction; pnlPct: number } {
  const entry = Number(params.entryPrice);
  const current = Number(params.currentPrice);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(current) || current <= 0) {
    return { action: 'HOLD', pnlPct: 0 };
  }
  const pnlPct = Math.round(((current - entry) / entry) * 10000) / 100;
  if (pnlPct >= Number(params.takeProfitPct)) {
    return { action: 'TAKE_PROFIT_SELL', pnlPct };
  }
  if (pnlPct <= -Math.abs(Number(params.stopLossPct))) {
    return { action: 'STOP_LOSS_SELL', pnlPct };
  }
  return { action: 'HOLD', pnlPct };
}

export type AutoPilotEntryDecision =
  | 'AUTO_BUY_READY'
  | 'BLOCKED_KILL_SWITCH'
  | 'AUTOPILOT_DISABLED'
  | 'SYMBOL_NOT_ALLOWED'
  | 'CONFIDENCE_BELOW_THRESHOLD'
  | 'ORDER_EXCEEDS_CAP';

export function evaluateAutoPilotEntrySignal(params: {
  symbol: string;
  confidenceScore: number;
  orderUsd: number;
  config: AutoPilotConfig;
  killSwitchActive: boolean;
}): { decision: AutoPilotEntryDecision; approved: boolean } {
  if (params.killSwitchActive) {
    return { decision: 'BLOCKED_KILL_SWITCH', approved: false };
  }
  if (!params.config.enabled) {
    return { decision: 'AUTOPILOT_DISABLED', approved: false };
  }
  const normSym = String(params.symbol || '').trim().toUpperCase();
  if (!params.config.allowedSymbols.includes(normSym)) {
    return { decision: 'SYMBOL_NOT_ALLOWED', approved: false };
  }
  if (Number(params.confidenceScore) < params.config.minConfidenceScore) {
    return { decision: 'CONFIDENCE_BELOW_THRESHOLD', approved: false };
  }
  if (Number(params.orderUsd) <= 0 || Number(params.orderUsd) > params.config.maxOrderUsd) {
    return { decision: 'ORDER_EXCEEDS_CAP', approved: false };
  }
  return { decision: 'AUTO_BUY_READY', approved: true };
}
