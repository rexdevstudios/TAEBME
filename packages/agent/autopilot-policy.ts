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
  trailingStopPct?: number;
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
  trailingStopPct?: number;
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
  trailingStopPct: number;
  minConfidenceScore: number;
  allowedSymbols: string[];
}

export const AUTOPILOT_STRATEGY_PRESETS: AutoPilotStrategyPreset[] = [
  {
    id: 'CONSERVATIVE',
    label: 'Konservatif (Pemula)',
    description: 'Blue-chip BTC & ETH · TP 8% / SL 3% / Trail 2.5% · Filter AI ketat (82+)',
    maxOrderUsd: 50,
    takeProfitPct: 8,
    stopLossPct: 3,
    trailingStopPct: 2.5,
    minConfidenceScore: 82,
    allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
  },
  {
    id: 'BALANCED',
    label: 'Seimbang (Swing)',
    description: 'BTC, ETH, SOL · TP 15% / SL 5% / Trail 4% · Filter AI seimbang (75+)',
    maxOrderUsd: 150,
    takeProfitPct: 15,
    stopLossPct: 5,
    trailingStopPct: 4,
    minConfidenceScore: 75,
    allowedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  },
  {
    id: 'AGGRESSIVE',
    label: 'Agresif (Momentum)',
    description: 'Multi-pair momentum · TP 25% / SL 8% / Trail 6% · Filter AI responsif (68+)',
    maxOrderUsd: 250,
    takeProfitPct: 25,
    stopLossPct: 8,
    trailingStopPct: 6,
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
    trailingStopPct: 0,
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
  const rawTrailing = input.trailingStopPct === undefined || input.trailingStopPct === null ? 0 : Number(input.trailingStopPct);
  if (!Number.isFinite(rawTp) || rawTp < 1 || rawTp > 200) {
    throw new Error('INVALID_TAKE_PROFIT_PCT: takeProfitPct must be between 1% and 200%.');
  }
  if (!Number.isFinite(rawSl) || rawSl < 0.5 || rawSl > 50) {
    throw new Error('INVALID_STOP_LOSS_PCT: stopLossPct must be between 0.5% and 50%.');
  }
  if (!Number.isFinite(rawTrailing) || rawTrailing < 0 || (rawTrailing > 0 && rawTrailing < 0.5) || rawTrailing > 30) {
    throw new Error('INVALID_TRAILING_STOP_PCT: trailingStopPct must be 0 (OFF) or between 0.5% and 30%.');
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
      trailingStopPct: rawTrailing > 0 ? Math.round(rawTrailing * 100) / 100 : 0,
      minConfidenceScore,
      allowedSymbols,
      updatedAt: new Date().toISOString(),
    },
  };
}

export type AutoPilotExitAction = 'TAKE_PROFIT_SELL' | 'STOP_LOSS_SELL' | 'TRAILING_STOP_SELL' | 'HOLD';

export function evaluateAutoPilotPositionExit(params: {
  entryPrice: number;
  currentPrice: number;
  takeProfitPct: number;
  stopLossPct: number;
  peakPrice?: number;
  trailingStopPct?: number;
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

  const trailing = Number(params.trailingStopPct ?? 0);
  const peak = Number(params.peakPrice ?? 0);
  if (Number.isFinite(trailing) && trailing > 0 && Number.isFinite(peak) && peak > entry) {
    const drawdownFromPeakPct = Math.round(((peak - current) / peak) * 10000) / 100;
    if (drawdownFromPeakPct >= trailing) {
      return { action: 'TRAILING_STOP_SELL', pnlPct };
    }
  }

  if (pnlPct <= -Math.abs(Number(params.stopLossPct))) {
    return { action: 'STOP_LOSS_SELL', pnlPct };
  }
  return { action: 'HOLD', pnlPct };
}

export function explainAutoPilotDecision(
  code: AutoPilotEntryDecision | AutoPilotExitAction | 'STRATEGY_CAP_REACHED',
  ctx?: {
    symbol?: string;
    confidenceScore?: number;
    minConfidenceScore?: number;
    orderUsd?: number;
    maxOrderUsd?: number;
    pnlPct?: number;
    takeProfitPct?: number;
    stopLossPct?: number;
    trailingStopPct?: number;
  }
): string {
  const sym = ctx?.symbol || 'Token';
  switch (code) {
    case 'AUTO_BUY_READY':
      return `${sym} lolos filter AI (skor ${ctx?.confidenceScore ?? '-'} ≥ ${ctx?.minConfidenceScore ?? '-'}) & modal $${ctx?.orderUsd ?? '-'} dalam batas — siap beli.`;
    case 'BLOCKED_KILL_SWITCH':
      return `${sym} ditahan: Global Kill-Switch sedang AKTIF untuk keamanan darurat.`;
    case 'AUTOPILOT_DISABLED':
      return `${sym} dilewati: Status Auto-Pilot masih PAUSED (Advisory Only).`;
    case 'SYMBOL_NOT_ALLOWED':
      return `${sym} dilewati: Aset tidak termasuk dalam daftar Allowed Symbols Anda.`;
    case 'CONFIDENCE_BELOW_THRESHOLD':
      return `${sym} dilewati: Skor AI (${ctx?.confidenceScore ?? '-'}) masih di bawah ambang minimum (${ctx?.minConfidenceScore ?? '-'}).`;
    case 'ORDER_EXCEEDS_CAP':
      return `${sym} dilewati: Ukuran order ($${ctx?.orderUsd ?? '-'}) melebihi batas modal per order ($${ctx?.maxOrderUsd ?? '-'}).`;
    case 'STRATEGY_CAP_REACHED':
      return `${sym} dilewati: Kuota strategi aktif paket Anda sudah penuh.`;
    case 'TAKE_PROFIT_SELL':
      return `${sym} jual Take Profit: PnL ${ctx?.pnlPct ?? 0}% mencapai target TP ${ctx?.takeProfitPct ?? '-'}%.`;
    case 'TRAILING_STOP_SELL':
      return `${sym} jual Trailing Stop: Harga turun dari puncak melebihi batas ${ctx?.trailingStopPct ?? '-'}% (PnL ${ctx?.pnlPct ?? 0}%) — amankan profit.`;
    case 'STOP_LOSS_SELL':
      return `${sym} jual Stop Loss: PnL ${ctx?.pnlPct ?? 0}% menyentuh batas rugi -${ctx?.stopLossPct ?? '-'}%.`;
    case 'HOLD':
    default:
      return `${sym} tetap HOLD: PnL ${ctx?.pnlPct ?? 0}% masih di dalam rentang aman TP/SL.`;
  }
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
