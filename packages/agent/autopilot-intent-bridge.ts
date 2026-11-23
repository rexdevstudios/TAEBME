/**
 * packages/agent/autopilot-intent-bridge.ts
 *
 * Pure Deterministic Bridge from `AutoPilotCycleReport` -> `SaveTradeIntentParams[]` (Phase BM).
 * - Deduplicates repeated cycles via deterministic time-bucketed idempotency keys (`ap:...`).
 * - Fail-closed on ineligible tiers (`!report.eligible`).
 * - Blocks all BUY intents when `report.killSwitchActive` is true while still permitting
 *   capital-protective TP/SL SELL exits.
 */

import type { SaveTradeIntentParams } from '../shared/db-pool';
import type { AutoPilotCycleReport } from './autopilot-cycle-runner';

export function buildAutoPilotIdempotencyKey(params: {
  userId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  windowMinutes?: number;
  nowMs?: number;
}): string {
  const userPrefix = String(params.userId || 'usr')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .slice(0, 10) || 'usr';
  const cleanSym = String(params.symbol || 'UNKNOWN')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16) || 'SYM';
  const windowMin = Math.max(1, Math.min(1440, Math.floor(Number(params.windowMinutes ?? 15))));
  const nowMs = Number.isFinite(Number(params.nowMs)) ? Number(params.nowMs) : Date.now();
  const bucket = Math.floor(nowMs / (windowMin * 60 * 1000));
  return `ap:${userPrefix}:${cleanSym}:${params.side}:${bucket}`;
}

export function buildTradeIntentsFromAutoPilotReport(params: {
  userId: string;
  stage: 'PAPER' | 'TESTNET' | 'LIVE';
  report: AutoPilotCycleReport;
  windowMinutes?: number;
  nowMs?: number;
}): SaveTradeIntentParams[] {
  if (!params.report || !params.report.eligible) {
    return [];
  }

  const intents: SaveTradeIntentParams[] = [];

  // 1. Capital-protective TP/SL SELL exits (allowed even if Kill-Switch blocks new entries)
  for (const exit of params.report.exitActions || []) {
    if (exit.action !== 'TAKE_PROFIT_SELL' && exit.action !== 'STOP_LOSS_SELL') continue;
    if (!Number.isFinite(exit.quantity) || exit.quantity <= 0) continue;

    intents.push({
      userId: params.userId,
      stage: params.stage,
      symbol: exit.symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: exit.quantity,
      price: exit.currentPrice > 0 ? exit.currentPrice : undefined,
      idempotencyKey: buildAutoPilotIdempotencyKey({
        userId: params.userId,
        symbol: exit.symbol,
        side: 'SELL',
        windowMinutes: params.windowMinutes,
        nowMs: params.nowMs,
      }),
      status: 'APPROVED',
      riskDecisionReason: `AUTOPILOT_${exit.action} (PnL ${exit.pnlPct}%)`,
    });
  }

  // 2. New Auto-BUY entries (strictly blocked when Kill-Switch is active)
  if (!params.report.killSwitchActive) {
    for (const entry of params.report.entryActions || []) {
      if (!entry.approved || entry.decision !== 'AUTO_BUY_READY') continue;
      if (!Number.isFinite(entry.orderUsd) || entry.orderUsd <= 0) continue;

      intents.push({
        userId: params.userId,
        stage: params.stage,
        symbol: entry.symbol,
        side: 'BUY',
        type: 'MARKET',
        quantity: entry.orderUsd,
        idempotencyKey: buildAutoPilotIdempotencyKey({
          userId: params.userId,
          symbol: entry.symbol,
          side: 'BUY',
          windowMinutes: params.windowMinutes,
          nowMs: params.nowMs,
        }),
        status: 'APPROVED',
        riskDecisionReason: `AUTOPILOT_ENTRY (${entry.source}, conf=${entry.confidenceScore})`,
      });
    }
  }

  return intents;
}
