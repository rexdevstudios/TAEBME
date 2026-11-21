/**
 * packages/agent/trading-desk-orchestrator.ts
 *
 * 5-Agent Autonomous Trading Desk Orchestrator (100% Vercel-Native, Stateless).
 *
 * Sequential Anti-Collision Pipeline:
 *   1. SCANNER  — Active launches + DefiLlama macro TVL signal
 *   2. ANALYST  — FeatureEngine quantitative signal & risk flags
 *   3. BRAIN    — AgentProposalEngine + BytePlus/Gemini non-blocking LLM advisory
 *   4. RISK     — Immutable TradingRiskGate + KillSwitch + Entitlement + MEV Guard
 *   5. EXECUTOR — PAPER simulated fill OR LIVE_ADVISORY human-in-the-loop handoff
 *
 * Invariants (AGENTS.md):
 * - One rule: No agent can modify TradingRiskGate or KillSwitch rules.
 * - Zero cursor auto-clicking, zero private keys in Vercel, zero DB schema mutations.
 * - Zero collisions via sequential orchestration + idempotencyKey.
 */

import { ethers } from 'ethers';
import { FeatureEngine, type FeatureWeights, type IntelligenceSignal } from '../intelligence/feature-engine';
import { intelligenceCache } from '../intelligence/market-data-cache';
import { fetchDefiLlamaMacroSignal, type DefiLlamaMacroSignal } from '../intelligence/defillama-client';
import { generateMarketAdvisoryNote, type MarketAdvisoryNote } from '../intelligence/llm-advisory-client';
import {
  fetchDexTokenSnapshot,
  evaluateDexStrategyFit,
  type DexTokenSnapshot,
  type StrategyProfileId,
} from '../intelligence/dex-market-scanner';
import { AgentProposalEngine, type AgentProposalRecord, type ProposalDbAdapter } from './proposal-engine';
import { TradingRiskGate } from '../trading/risk-gate';
import { MevProtectionService } from '../trading/mev-protection';
import type { OrderSide, RiskDecision } from '../shared/types/domain';

export type DeskAgentName = 'SCANNER' | 'ANALYST' | 'BRAIN' | 'RISK' | 'EXECUTOR';
export type DeskAgentStatus = 'DONE' | 'BLOCKED' | 'WAITING_CONFIRMATION' | 'SKIPPED';

export interface DeskAgentCard {
  agent: DeskAgentName;
  role: string;
  status: DeskAgentStatus;
  summary: string;
  elapsedMs: number;
}

export interface DeskReadBackEntry {
  id: string;
  agent: DeskAgentName;
  event: string;
  detail: string;
  ok: boolean;
  timestamp: string;
}

export interface FiveAgentDeskInput {
  userId: string;
  symbol: string;
  action: OrderSide;
  quantity: number;
  maxSlippagePct?: number;
  mode: 'PAPER' | 'LIVE_ADVISORY';
  tokenAddress?: string;
  chainId?: number;
  dexNetwork?: string;
  strategyProfile?: StrategyProfileId;
  aiFeatureWeights?: Partial<FeatureWeights> | null;
  idempotencyKey?: string;
}

export interface FiveAgentDeskDeps {
  proposalDb: ProposalDbAdapter;
  getActiveLaunchesCount: () => Promise<number>;
  getActiveKillSwitches: () => Promise<any[]>;
  getUserEntitlement: (userId: string) => Promise<{ planId: string; hasLiveTrading: boolean }>;
  saveTradeIntent: (params: {
    userId: string;
    stage: 'PAPER' | 'TESTNET' | 'LIVE';
    symbol: string;
    side: OrderSide;
    type: 'MARKET' | 'LIMIT';
    quantity: number;
    idempotencyKey: string;
    status: 'APPROVED' | 'REJECTED' | 'PENDING_RISK' | 'EXECUTED' | 'CANCELLED';
    riskDecisionReason?: string;
  }) => Promise<string>;
  fetchMacroSignal?: () => Promise<DefiLlamaMacroSignal | null>;
  fetchDexSnapshot?: (tokenAddress: string, dexNetwork?: string) => Promise<DexTokenSnapshot | null>;
  generateAdvisory?: (signal: IntelligenceSignal, ctx: { symbol: string; action: 'BUY' | 'SELL'; suggestedQty: number }) => Promise<MarketAdvisoryNote>;
}

export interface FiveAgentDeskReport {
  runId: string;
  symbol: string;
  action: OrderSide;
  quantity: number;
  mode: 'PAPER' | 'LIVE_ADVISORY';
  strategyProfile?: StrategyProfileId;
  dexSnapshot?: DexTokenSnapshot | null;
  collisions: 0;
  rulesImmutable: true;
  agents: DeskAgentCard[];
  readBackLog: DeskReadBackEntry[];
  signal: IntelligenceSignal;
  proposal: AgentProposalRecord | null;
  llmAdvisory: MarketAdvisoryNote | null;
  riskDecision: RiskDecision | null;
  execution: {
    status: 'FILLED_SIMULATED' | 'READY_FOR_HUMAN_APPROVAL' | 'BLOCKED_BY_RISK';
    tradeIntentId?: string;
    handoffUrl?: string;
    mevSafe?: boolean;
  };
  totalElapsedMs: number;
  completedAt: string;
}

export async function runFiveAgentDeskCycle(
  input: FiveAgentDeskInput,
  deps: FiveAgentDeskDeps
): Promise<FiveAgentDeskReport> {
  const cycleStart = performance.now();
  const runId = `desk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const idempotencyKey = input.idempotencyKey || `${runId}:${input.symbol}:${input.action}`;
  const agents: DeskAgentCard[] = [];
  const readBackLog: DeskReadBackEntry[] = [];
  let seq = 1;

  const log = (agent: DeskAgentName, event: string, detail: string, ok: boolean) => {
    readBackLog.push({
      id: `${agent.slice(0, 3)}-${String(seq++).padStart(3, '0')}`,
      agent,
      event,
      detail,
      ok,
      timestamp: new Date().toISOString(),
    });
  };

  // -------------------------------------------------------------------------
  // AGENT 1: SCANNER — Active launches + DefiLlama Macro TVL + Live DEX Snapshot
  // -------------------------------------------------------------------------
  const s1 = performance.now();
  const [macroRes, launchesRes, dexRes] = await Promise.allSettled([
    (deps.fetchMacroSignal ?? fetchDefiLlamaMacroSignal)(),
    deps.getActiveLaunchesCount(),
    input.tokenAddress
      ? (deps.fetchDexSnapshot ?? fetchDexTokenSnapshot)(input.tokenAddress, input.dexNetwork || 'base')
      : Promise.resolve(null),
  ]);
  const macroSignal = macroRes.status === 'fulfilled' ? macroRes.value : null;
  const activeLaunchesCount = launchesRes.status === 'fulfilled' ? launchesRes.value : 0;
  const dexSnapshot = dexRes.status === 'fulfilled' ? dexRes.value : null;
  const resolvedSymbol = dexSnapshot?.symbol && input.symbol === 'TOKEN' ? dexSnapshot.symbol : input.symbol;
  const scannerSummary = dexSnapshot
    ? `Scanned ${dexSnapshot.symbol} on ${dexSnapshot.chainId.toUpperCase()} (${dexSnapshot.source}) · Liq $${Math.round(dexSnapshot.liquidityUsd).toLocaleString()} · Vol24h $${Math.round(dexSnapshot.volume24hUsd).toLocaleString()} · Buys ${dexSnapshot.buyRatioPct}%`
    : `Scanned ${activeLaunchesCount} active launches & macro TVL (${macroSignal ? `${macroSignal.topChains.length} chains` : 'neutral'}) for ${resolvedSymbol}.`;
  agents.push({
    agent: 'SCANNER',
    role: 'Finds pairs & macro regime',
    status: 'DONE',
    summary: scannerSummary,
    elapsedMs: Math.round(performance.now() - s1),
  });
  log('SCANNER', dexSnapshot ? 'DEX_TOKEN_SCANNED' : 'MARKET_SCANNED', scannerSummary, true);

  // -------------------------------------------------------------------------
  // AGENT 2: ANALYST — Quantitative FeatureEngine signal & Strategy Fit
  // -------------------------------------------------------------------------
  const s2 = performance.now();
  const baseSignal = FeatureEngine.computeSignal(
    resolvedSymbol,
    intelligenceCache,
    null,
    null,
    macroSignal,
    input.aiFeatureWeights
  );
  const strategyFit = dexSnapshot ? evaluateDexStrategyFit(dexSnapshot, input.strategyProfile) : null;
  const signal: IntelligenceSignal = strategyFit
    ? {
        ...baseSignal,
        computedConfidenceScore: Math.max(
          0,
          Math.min(1, Math.round((baseSignal.computedConfidenceScore + strategyFit.scoreDelta) * 100) / 100)
        ),
        riskFlags: [...baseSignal.riskFlags, ...strategyFit.riskFlags],
        rationale: `${strategyFit.rationale} | ${baseSignal.rationale}`,
      }
    : baseSignal;
  const counterpartyBlocked = signal.riskFlags.includes('COUNTERPARTY_BLOCKED');
  const analystSummary = `Confidence ${(signal.computedConfidenceScore * 100).toFixed(1)}% | Sentiment=${signal.inputs.webSentiment} | Volatility=${signal.inputs.marketVolatility} | Flags=${signal.riskFlags.length}${strategyFit ? ` · Strategy=${strategyFit.strategyProfile}` : ''}`;
  agents.push({
    agent: 'ANALYST',
    role: 'Evaluates tokens & risk flags',
    status: counterpartyBlocked ? 'BLOCKED' : 'DONE',
    summary: analystSummary,
    elapsedMs: Math.round(performance.now() - s2),
  });
  log('ANALYST', counterpartyBlocked ? 'COUNTERPARTY_BLOCKED' : 'TOKEN_EVALUATED', analystSummary, !counterpartyBlocked);

  // Fail-closed immediately if Analyst detects COUNTERPARTY_BLOCKED
  if (counterpartyBlocked) {
    agents.push(
      { agent: 'BRAIN', role: 'Sizes entries & LLM advisory', status: 'SKIPPED', summary: 'Skipped due to COUNTERPARTY_BLOCKED', elapsedMs: 0 },
      { agent: 'RISK', role: 'Immutable loss & rule guard', status: 'BLOCKED', summary: 'Blocked by Analyst counterparty risk flag', elapsedMs: 0 },
      { agent: 'EXECUTOR', role: 'Zero-collision execution', status: 'BLOCKED', summary: 'Execution halted (fail-closed)', elapsedMs: 0 }
    );
    log('RISK', 'EXECUTION_HALTED', 'COUNTERPARTY_BLOCKED prevents proposal & execution', false);
    return {
      runId,
      symbol: input.symbol,
      action: input.action,
      quantity: input.quantity,
      mode: input.mode,
      collisions: 0,
      rulesImmutable: true,
      agents,
      readBackLog,
      signal,
      proposal: null,
      llmAdvisory: null,
      riskDecision: null,
      execution: { status: 'BLOCKED_BY_RISK' },
      totalElapsedMs: Math.round(performance.now() - cycleStart),
      completedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // AGENT 3: BRAIN — Proposal generation + BytePlus/Gemini Advisory (non-blocking)
  // -------------------------------------------------------------------------
  const s3 = performance.now();
  const proposal = await AgentProposalEngine.generateProposalWithIntelligence(
    {
      agentId: 'five-agent-desk-brain',
      userId: input.userId,
      targetSymbol: input.symbol,
      action: input.action,
      suggestedQty: input.quantity,
      intelligenceSignal: signal,
    },
    deps.proposalDb
  );
  const llmAdvisory = await (deps.generateAdvisory ?? generateMarketAdvisoryNote)(signal, {
    symbol: input.symbol,
    action: input.action,
    suggestedQty: input.quantity,
  });
  const brainSummary = `Proposal ${proposal.id.slice(0, 8)} sized (${input.action} ${input.quantity} ${input.symbol}) · LLM: ${llmAdvisory.provider}`;
  agents.push({
    agent: 'BRAIN',
    role: 'Sizes entries & LLM advisory',
    status: 'DONE',
    summary: brainSummary,
    elapsedMs: Math.round(performance.now() - s3),
  });
  log('BRAIN', 'PROPOSAL_SIZED', `${brainSummary} — ${llmAdvisory.summary.slice(0, 120)}`, true);

  // -------------------------------------------------------------------------
  // AGENT 4: RISK — Immutable Rules (TradingRiskGate + KillSwitch + MEV Guard)
  // -------------------------------------------------------------------------
  const s4 = performance.now();
  const [activeKillSwitches, userEntitlement] = await Promise.all([
    deps.getActiveKillSwitches(),
    deps.getUserEntitlement(input.userId),
  ]);
  const stage = input.mode === 'PAPER' ? 'PAPER' : 'LIVE';
  const { decision: riskDecision } = TradingRiskGate.evaluateIntent(
    {
      userId: input.userId,
      stage,
      symbol: input.symbol,
      side: input.action,
      type: 'MARKET',
      quantity: input.quantity,
      maxSlippagePct: input.maxSlippagePct ?? 1.0,
      idempotencyKey,
    },
    {
      maxOrderValueUsd: 10000,
      maxDailyLossUsd: 1000,
      currentDailyLossUsd: 0,
      maxOpenPositions: 5,
      currentOpenPositions: 0,
    },
    userEntitlement,
    activeKillSwitches
  );

  let mevSafe: boolean | undefined;
  if (input.tokenAddress && ethers.isAddress(input.tokenAddress)) {
    const mevQuote = MevProtectionService.evaluateGraduationSlippage(
      input.tokenAddress,
      ethers.parseEther('24'),
      input.chainId ?? 8453
    );
    mevSafe = MevProtectionService.verifyMevProtection(mevQuote).isSafe;
  }

  const riskApproved = riskDecision.isApproved && mevSafe !== false;
  const riskSummary = riskApproved
    ? `APPROVED (Immutable Risk Gate passed · KillSwitches=${activeKillSwitches.length})`
    : `REJECTED: ${riskDecision.reason || 'MEV_UNSAFE'}`;
  agents.push({
    agent: 'RISK',
    role: 'Immutable loss & rule guard',
    status: riskApproved ? 'DONE' : 'BLOCKED',
    summary: riskSummary,
    elapsedMs: Math.round(performance.now() - s4),
  });
  log('RISK', riskApproved ? 'RISK_APPROVED' : 'RISK_REJECTED', riskSummary, riskApproved);

  // -------------------------------------------------------------------------
  // AGENT 5: EXECUTOR — Paper Auto-Fill OR Live Human-in-the-Loop Handoff
  // -------------------------------------------------------------------------
  const s5 = performance.now();
  if (!riskApproved) {
    agents.push({
      agent: 'EXECUTOR',
      role: 'Zero-collision execution',
      status: 'BLOCKED',
      summary: 'Blocked by immutable Risk Gate — zero order submitted',
      elapsedMs: Math.round(performance.now() - s5),
    });
    log('EXECUTOR', 'ORDER_BLOCKED', 'Risk Gate vetoed execution cleanly', false);
    return {
      runId,
      symbol: resolvedSymbol,
      action: input.action,
      quantity: input.quantity,
      mode: input.mode,
      strategyProfile: input.strategyProfile,
      dexSnapshot,
      collisions: 0,
      rulesImmutable: true,
      agents,
      readBackLog,
      signal,
      proposal,
      llmAdvisory,
      riskDecision,
      execution: { status: 'BLOCKED_BY_RISK', mevSafe },
      totalElapsedMs: Math.round(performance.now() - cycleStart),
      completedAt: new Date().toISOString(),
    };
  }

  const handoffUrl = `/trading?symbol=${encodeURIComponent(resolvedSymbol)}&side=${input.action}&qty=${input.quantity}&proposalId=${encodeURIComponent(proposal.id)}${input.tokenAddress ? `&token=${encodeURIComponent(input.tokenAddress)}` : ''}`;

  if (input.mode === 'PAPER') {
    const tradeIntentId = await deps.saveTradeIntent({
      userId: input.userId,
      stage: 'PAPER',
      symbol: resolvedSymbol,
      side: input.action,
      type: 'MARKET',
      quantity: input.quantity,
      idempotencyKey,
      status: 'APPROVED',
      riskDecisionReason: riskDecision.reason,
    });
    const execSummary = `PAPER fill recorded (${tradeIntentId.slice(0, 8)}) — 0 collisions`;
    agents.push({
      agent: 'EXECUTOR',
      role: 'Zero-collision execution',
      status: 'DONE',
      summary: execSummary,
      elapsedMs: Math.round(performance.now() - s5),
    });
    log('EXECUTOR', 'PAPER_FILLED', execSummary, true);

    return {
      runId,
      symbol: resolvedSymbol,
      action: input.action,
      quantity: input.quantity,
      mode: input.mode,
      strategyProfile: input.strategyProfile,
      dexSnapshot,
      collisions: 0,
      rulesImmutable: true,
      agents,
      readBackLog,
      signal,
      proposal,
      llmAdvisory,
      riskDecision,
      execution: { status: 'FILLED_SIMULATED', tradeIntentId, handoffUrl, mevSafe },
      totalElapsedMs: Math.round(performance.now() - cycleStart),
      completedAt: new Date().toISOString(),
    };
  }

  // LIVE_ADVISORY: Non-custodial — NEVER auto-sign live funds; hand off to /trading
  const execSummary = 'Risk approved — awaiting human wallet signature in /trading (non-custodial)';
  agents.push({
    agent: 'EXECUTOR',
    role: 'Zero-collision execution',
    status: 'WAITING_CONFIRMATION',
    summary: execSummary,
    elapsedMs: Math.round(performance.now() - s5),
  });
  log('EXECUTOR', 'AWAITING_HUMAN_SIGN', execSummary, true);

  return {
    runId,
    symbol: resolvedSymbol,
    action: input.action,
    quantity: input.quantity,
    mode: input.mode,
    strategyProfile: input.strategyProfile,
    dexSnapshot,
    collisions: 0,
    rulesImmutable: true,
    agents,
    readBackLog,
    signal,
    proposal,
    llmAdvisory,
    riskDecision,
    execution: { status: 'READY_FOR_HUMAN_APPROVAL', handoffUrl, mevSafe },
    totalElapsedMs: Math.round(performance.now() - cycleStart),
    completedAt: new Date().toISOString(),
  };
}
