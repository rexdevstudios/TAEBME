/**
 * packages/agent/autonomous-terminal-engine.ts
 *
 * Pure Deterministic 4-Sub-Agent Dual-Rail Terminal Aggregator (Phase AR).
 * - Maps real PostgreSQL SSOT records (`trade_intents`, `token_launches`, Firecrawl hints)
 *   into 4 specialized sub-agents:
 *     1. SCOUT    (Orange) — Firecrawl web/social buzz & external DEX discovery
 *     2. SNIPER   (Blue)   — Early launch / block-0 & CEX breakout entries
 *     3. CURVE    (Green)  — Bonding curve momentum rider
 *     4. GRADUATE (Purple) — Pre-graduation & DEX liquidity migration
 * - Explicitly tags every actionable signal with 1 of 3 user-friendly Execution Rails:
 *     - `INTERNAL_LAUNCHPAD` (Platform Bonding Curve / Bankr token)
 *     - `EXTERNAL_DEX_0X`    (External Base/EVM token via 0x Swap API v2 + Auto-ETH Fee)
 *     - `EXTERNAL_CEX_AUTO`  (Liquid CEX pair via Venue Auto-Router: Binance / Bybit V5)
 * - ZERO fake PnL claims: strictly computes deterministic counts, approval rate, and transparent status.
 */

export interface MinimalTradeIntent {
  id: string;
  userId?: string;
  stage: string;
  symbol: string;
  side: string;
  type?: string;
  quantity: number;
  status: string;
  createdAt?: string;
}

export type SubAgentId = 'SCOUT' | 'SNIPER' | 'CURVE' | 'GRADUATE';
export type ExecutionRailId = 'INTERNAL_LAUNCHPAD' | 'EXTERNAL_DEX_0X' | 'EXTERNAL_CEX_AUTO';

export interface SubAgentAttribution {
  id: SubAgentId;
  label: string;
  color: string;
  signalCount: number;
  sharePct: number;
  summary: string;
}

export interface TerminalTradeCard {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  stage: string;
  quantity: number;
  status: string;
  agent: SubAgentId;
  rail: ExecutionRailId;
  href?: string;
  createdAt?: string;
}

export type TradingExecutionModeParam = 'PAPER' | 'DEX_NON_CUSTODIAL' | 'CEX_SINGLE_SHOT';

export interface ParsedTradingHandoffParams {
  symbol: string | null;
  side: 'BUY' | 'SELL' | null;
  qty: number | null;
  mode: TradingExecutionModeParam | null;
  tokenAddress: string | null;
  chainId: number | null;
  rail: ExecutionRailId | null;
  agent: SubAgentId | null;
  proposalId: string | null;
}

const SUPPORTED_HANDOFF_CHAIN_IDS = new Set<number>([1, 10, 56, 137, 8453, 42161]);
const SUPPORTED_SUB_AGENTS = new Set<SubAgentId>(['SCOUT', 'SNIPER', 'CURVE', 'GRADUATE']);
const SUPPORTED_EXECUTION_RAILS = new Set<ExecutionRailId>([
  'INTERNAL_LAUNCHPAD',
  'EXTERNAL_DEX_0X',
  'EXTERNAL_CEX_AUTO',
]);

export function buildTerminalTradeHandoffUrl(params: {
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  mode: TradingExecutionModeParam;
  rail: ExecutionRailId;
  agent: SubAgentId;
  tokenAddress?: string | null;
  chainId?: number | null;
}): string {
  const qs = new URLSearchParams();
  qs.set('symbol', String(params.symbol || 'BTCUSDT').trim());
  qs.set('side', params.side === 'SELL' ? 'SELL' : 'BUY');
  const safeQty = Number.isFinite(params.qty) && params.qty > 0 ? params.qty : 0.02;
  qs.set('qty', String(safeQty));
  qs.set('mode', params.mode);
  qs.set('rail', params.rail);
  qs.set('agent', params.agent);
  if (params.chainId && SUPPORTED_HANDOFF_CHAIN_IDS.has(Number(params.chainId))) {
    qs.set('chainId', String(Number(params.chainId)));
  } else if (params.mode === 'DEX_NON_CUSTODIAL') {
    qs.set('chainId', '8453');
  }
  if (params.tokenAddress && /^0x[a-fA-F0-9]{40}$/.test(params.tokenAddress.trim())) {
    qs.set('token', params.tokenAddress.trim());
  }
  return `/trading?${qs.toString()}`;
}

export function parseTradingHandoffSearchParams(
  search: string | URLSearchParams
): ParsedTradingHandoffParams {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const rawSymbol = params.get('symbol')?.trim() || null;
  const rawSide = params.get('side')?.trim().toUpperCase() || null;
  const side: 'BUY' | 'SELL' | null = rawSide === 'BUY' || rawSide === 'SELL' ? rawSide : null;

  const rawQty = params.get('qty');
  const parsedQty = rawQty !== null && rawQty.trim() !== '' ? Number(rawQty) : NaN;
  const qty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : null;

  const rawMode = params.get('mode')?.trim().toUpperCase() || null;
  const mode: TradingExecutionModeParam | null =
    rawMode === 'PAPER' || rawMode === 'DEX_NON_CUSTODIAL' || rawMode === 'CEX_SINGLE_SHOT'
      ? rawMode
      : null;

  const rawToken = params.get('token')?.trim() || null;
  const tokenAddress = rawToken && /^0x[a-fA-F0-9]{40}$/.test(rawToken) ? rawToken : null;

  const rawChain = params.get('chainId');
  const parsedChain = rawChain !== null && rawChain.trim() !== '' ? Number(rawChain) : NaN;
  const chainId =
    Number.isInteger(parsedChain) && SUPPORTED_HANDOFF_CHAIN_IDS.has(parsedChain)
      ? parsedChain
      : null;

  const rawRail = params.get('rail')?.trim().toUpperCase() as ExecutionRailId | undefined;
  const rail: ExecutionRailId | null =
    rawRail && SUPPORTED_EXECUTION_RAILS.has(rawRail) ? rawRail : null;

  const rawAgent = params.get('agent')?.trim().toUpperCase() as SubAgentId | undefined;
  const agent: SubAgentId | null = rawAgent && SUPPORTED_SUB_AGENTS.has(rawAgent) ? rawAgent : null;

  const proposalId = params.get('proposalId')?.trim() || null;

  return {
    symbol: rawSymbol,
    side,
    qty,
    mode,
    tokenAddress,
    chainId,
    rail,
    agent,
    proposalId,
  };
}

export interface TerminalAgentFeedItem {
  id: string;
  agent: SubAgentId;
  color: string;
  rail: ExecutionRailId;
  railLabel: string;
  headline: string;
  href: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  chainId?: number;
}

export type TerminalFeedFilter = 'ALL' | ExecutionRailId | number;

export function shouldTriggerOnDemandScoutSync(params: {
  refreshRequested: boolean;
  lastSyncedAtIso: string | null | undefined;
  nowMs?: number;
  cooldownSec?: number;
}): boolean {
  if (!params.refreshRequested) return false;
  const nowMs = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  const cooldownMs = Math.max(5, Math.floor(Number(params.cooldownSec ?? 60))) * 1000;
  if (!params.lastSyncedAtIso || typeof params.lastSyncedAtIso !== 'string') return true;
  const lastMs = Date.parse(params.lastSyncedAtIso);
  if (!Number.isFinite(lastMs)) return true;
  return nowMs - lastMs >= cooldownMs;
}

export function filterTerminalLiveFeed(
  feed: TerminalAgentFeedItem[],
  filter: TerminalFeedFilter
): TerminalAgentFeedItem[] {
  const list = Array.isArray(feed) ? feed : [];
  if (filter === 'ALL') return list;
  if (typeof filter === 'number') {
    return list.filter((item) => item.chainId === filter);
  }
  return list.filter((item) => item.rail === filter);
}

export interface AutonomousTerminalSnapshot {
  mode: 'LIVE_NON_CUSTODIAL' | 'PAPER_SIM';
  planId: string;
  totalTrades: number;
  approvedTrades: number;
  approvalRatePct: number;
  goalTradesTarget: number;
  goalProgressPct: number;
  dualRailReadiness: {
    internalLaunchpadCount: number;
    externalDexZeroXReady: boolean;
    externalCexAutoReady: boolean;
    firecrawlReady: boolean;
    scoutDatasetSyncedAt?: string | null;
    scoutDatasetHintCount?: number;
  };
  agentBreakdown: SubAgentAttribution[];
  recentTradeCards: TerminalTradeCard[];
  liveFeed: TerminalAgentFeedItem[];
}

export interface ActiveLaunchLite {
  ticker?: string;
  symbol?: string;
  name?: string;
  contractAddress?: string;
  chain?: string;
  isGraduated?: boolean;
  bondingProgressPct?: number;
}

const AGENT_COLORS: Record<SubAgentId, string> = {
  SCOUT: '#F97316',    // Orange
  SNIPER: '#3B82F6',   // Blue
  CURVE: '#10B981',    // Green
  GRADUATE: '#A855F7', // Purple
};

const RAIL_LABELS: Record<ExecutionRailId, string> = {
  INTERNAL_LAUNCHPAD: 'INTERNAL · LAUNCHPAD',
  EXTERNAL_DEX_0X: 'EXTERNAL · DEX 0x',
  EXTERNAL_CEX_AUTO: 'EXTERNAL · CEX AUTO',
};

function classifyIntentAgent(intent: MinimalTradeIntent): { agent: SubAgentId; rail: ExecutionRailId } {
  const sym = String(intent.symbol || '').toUpperCase();
  if (sym.includes('/')) {
    return intent.side === 'SELL'
      ? { agent: 'GRADUATE', rail: 'INTERNAL_LAUNCHPAD' }
      : { agent: 'CURVE', rail: 'INTERNAL_LAUNCHPAD' };
  }
  if (intent.stage === 'LIVE' || intent.stage === 'TESTNET') {
    return { agent: 'SNIPER', rail: 'EXTERNAL_CEX_AUTO' };
  }
  return { agent: 'SCOUT', rail: 'EXTERNAL_CEX_AUTO' };
}

export function formatScoutCacheAgeLabel(
  syncedAtIso: string | null | undefined,
  nowMs: number = Date.now()
): string {
  if (!syncedAtIso || typeof syncedAtIso !== 'string') return 'Awaiting Cron Sync';
  const parsedMs = Date.parse(syncedAtIso);
  if (!Number.isFinite(parsedMs)) return 'Awaiting Cron Sync';
  const diffSec = Math.max(0, Math.floor((nowMs - parsedMs) / 1000));
  if (diffSec < 60) return 'Synced <1m ago';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Synced ${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `Synced ${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `Synced ${diffDays}d ago`;
}

export const DEXSCREENER_EVM_CHAIN_MAP: Record<
  string,
  { chainId: number; label: string; prefix: string }
> = {
  base: { chainId: 8453, label: 'Base', prefix: 'BASE' },
  arbitrum: { chainId: 42161, label: 'Arbitrum', prefix: 'ARB' },
  ethereum: { chainId: 1, label: 'Ethereum', prefix: 'ETH' },
  optimism: { chainId: 10, label: 'Optimism', prefix: 'OP' },
  polygon: { chainId: 137, label: 'Polygon', prefix: 'POLY' },
  bsc: { chainId: 56, label: 'BNB Chain', prefix: 'BSC' },
};

export interface MappedScoutDatasetHint {
  symbol: string;
  note: string;
  tokenAddress: string;
  chainId: number;
  updatedAt: string;
}

export function mapDexScreenerBoostRowsToScoutHints(
  rows: unknown[],
  nowIso: string = new Date().toISOString(),
  maxHints: number = 6
): MappedScoutDatasetHint[] {
  if (!Array.isArray(rows)) return [];
  const cap = Math.max(1, Math.min(20, Math.floor(Number(maxHints) || 6)));
  const results: MappedScoutDatasetHint[] = [];

  for (const raw of rows) {
    if (results.length >= cap) break;
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') continue;

    const rawChainKey = String(item.chainId || '').trim().toLowerCase();
    const chainMeta = DEXSCREENER_EVM_CHAIN_MAP[rawChainKey];
    if (!chainMeta) continue;

    const addr = typeof item.tokenAddress === 'string' ? item.tokenAddress.trim() : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) continue;

    const desc =
      typeof item.description === 'string' ? item.description.trim().slice(0, 80) : '';
    const rawSym = typeof item.symbol === 'string' ? item.symbol.trim() : '';
    const sym = rawSym
      ? rawSym.toUpperCase().slice(0, 12)
      : `${chainMeta.prefix}_${addr.slice(2, 6).toUpperCase()}`;

    results.push({
      symbol: sym,
      tokenAddress: addr,
      chainId: chainMeta.chainId,
      note: desc
        ? `Scout boosted on ${chainMeta.label}: ${desc} → 0x Swap v2 ready`
        : `Scout trending ${chainMeta.label} token ($${sym}) → MEV-guarded 0x Swap v2 ready`,
      updatedAt: nowIso,
    });
  }

  return results;
}

export function buildAutonomousTerminalSnapshot(params: {
  planId?: string;
  intents: MinimalTradeIntent[];
  activeLaunches: ActiveLaunchLite[];
  hasActiveCexKey: boolean;
  hasZeroXApiKey: boolean;
  hasFirecrawlApiKey: boolean;
  firecrawlHints?: Array<{
    symbol: string;
    note: string;
    tokenAddress?: string;
    chainId?: number;
  }>;
  scoutDatasetSyncedAt?: string | null;
  goalTradesTarget?: number;
}): AutonomousTerminalSnapshot {
  const planId = String(params.planId || 'FREE').toUpperCase();
  const goalTradesTarget = Math.max(5, Math.round(Number(params.goalTradesTarget ?? 20)));
  const intents = Array.isArray(params.intents) ? params.intents : [];
  const launches = Array.isArray(params.activeLaunches) ? params.activeLaunches : [];

  const totalTrades = intents.length;
  const approvedTrades = intents.filter((i) => i.status === 'APPROVED' || i.status === 'EXECUTED').length;
  const approvalRatePct = totalTrades > 0 ? Math.round((approvedTrades / totalTrades) * 100) : 100;
  const goalProgressPct = Math.min(100, Math.round((totalTrades / goalTradesTarget) * 100));

  const counts: Record<SubAgentId, number> = {
    SCOUT: 0,
    SNIPER: 0,
    CURVE: 0,
    GRADUATE: 0,
  };

  const recentTradeCards: TerminalTradeCard[] = intents.slice(0, 9).map((intent) => {
    const { agent, rail } = classifyIntentAgent(intent);
    counts[agent] += 1;
    const normalizedSide: 'BUY' | 'SELL' = intent.side === 'SELL' ? 'SELL' : 'BUY';
    const normalizedQty = Number(intent.quantity || 0) > 0 ? Number(intent.quantity) : 0.02;
    const cardMode: TradingExecutionModeParam =
      rail === 'INTERNAL_LAUNCHPAD' || rail === 'EXTERNAL_DEX_0X'
        ? 'DEX_NON_CUSTODIAL'
        : intent.stage === 'LIVE' || intent.stage === 'TESTNET'
        ? 'CEX_SINGLE_SHOT'
        : 'PAPER';
    return {
      id: intent.id,
      symbol: intent.symbol,
      side: normalizedSide,
      stage: intent.stage,
      quantity: Number(intent.quantity || 0),
      status: intent.status,
      agent,
      rail,
      href: buildTerminalTradeHandoffUrl({
        symbol: intent.symbol,
        side: normalizedSide,
        qty: normalizedQty,
        mode: cardMode,
        rail,
        agent,
        chainId: cardMode === 'DEX_NON_CUSTODIAL' ? 8453 : null,
      }),
      createdAt: intent.createdAt,
    };
  });

  const liveFeed: TerminalAgentFeedItem[] = [];

  // 1. Curve & Graduate signals from live platform launches (INTERNAL_LAUNCHPAD)
  for (const launch of launches.slice(0, 3)) {
    const ticker = String(launch.ticker || launch.symbol || 'TOKEN').replace(/^\$/, '').toUpperCase();
    const isNearGrad = Boolean(launch.isGraduated) || Number(launch.bondingProgressPct ?? 0) >= 75;
    const agent: SubAgentId = isNearGrad ? 'GRADUATE' : 'CURVE';
    counts[agent] += 1;
    liveFeed.push({
      id: `launch-${ticker}-${agent}`,
      agent,
      color: AGENT_COLORS[agent],
      rail: 'INTERNAL_LAUNCHPAD',
      railLabel: RAIL_LABELS.INTERNAL_LAUNCHPAD,
      headline: isNearGrad
        ? `$${ticker} approaching DEX graduation → MEV-protected entry ready`
        : `$${ticker} active on Bonding Curve → momentum monitoring`,
      href: buildTerminalTradeHandoffUrl({
        symbol: `${ticker}/WETH`,
        side: 'BUY',
        qty: 0.05,
        mode: 'DEX_NON_CUSTODIAL',
        rail: 'INTERNAL_LAUNCHPAD',
        agent,
        tokenAddress: launch.contractAddress || null,
        chainId: 8453,
      }),
      symbol: `${ticker}/WETH`,
      side: 'BUY',
      chainId: 8453,
    });
  }

  // 2. Scout signals from Firecrawl web/social dataset (EXTERNAL_DEX_0X)
  const hints =
    params.firecrawlHints && params.firecrawlHints.length > 0
      ? params.firecrawlHints
      : [
          {
            symbol: 'WETH',
            note: params.hasFirecrawlApiKey
              ? 'Firecrawl Scout active → Base ecosystem velocity scan ready'
              : 'Scout quantitative baseline → Base DEX 0x v2 swap ready',
            tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
          },
        ];

  for (const hint of hints.slice(0, 4)) {
    counts.SCOUT += 1;
    const resolvedChainId =
      hint.chainId && SUPPORTED_HANDOFF_CHAIN_IDS.has(Number(hint.chainId))
        ? Number(hint.chainId)
        : 8453;
    liveFeed.push({
      id: `scout-${hint.symbol}-${resolvedChainId}`,
      agent: 'SCOUT',
      color: AGENT_COLORS.SCOUT,
      rail: 'EXTERNAL_DEX_0X',
      railLabel: RAIL_LABELS.EXTERNAL_DEX_0X,
      headline: hint.note,
      href: buildTerminalTradeHandoffUrl({
        symbol: hint.symbol,
        side: 'BUY',
        qty: 0.02,
        mode: 'DEX_NON_CUSTODIAL',
        rail: 'EXTERNAL_DEX_0X',
        agent: 'SCOUT',
        tokenAddress: hint.tokenAddress || null,
        chainId: resolvedChainId,
      }),
      symbol: hint.symbol,
      side: 'BUY',
      chainId: resolvedChainId,
    });
  }

  // 3. Sniper CEX Auto-Router signal (EXTERNAL_CEX_AUTO)
  counts.SNIPER += 1;
  liveFeed.push({
    id: 'sniper-cex-btcusdt',
    agent: 'SNIPER',
    color: AGENT_COLORS.SNIPER,
    rail: 'EXTERNAL_CEX_AUTO',
    railLabel: RAIL_LABELS.EXTERNAL_CEX_AUTO,
    headline: params.hasActiveCexKey
      ? 'BTCUSDT breakout watch → Auto-Router armed (Binance / Bybit V5)'
      : 'BTCUSDT breakout watch → Paper Sim / connect CEX vault to arm',
    href: buildTerminalTradeHandoffUrl({
      symbol: 'BTCUSDT',
      side: 'BUY',
      qty: 0.02,
      mode: params.hasActiveCexKey ? 'CEX_SINGLE_SHOT' : 'PAPER',
      rail: 'EXTERNAL_CEX_AUTO',
      agent: 'SNIPER',
    }),
    symbol: 'BTCUSDT',
    side: 'BUY',
  });

  const totalSignals = Math.max(1, counts.SCOUT + counts.SNIPER + counts.CURVE + counts.GRADUATE);
  const agentBreakdown: SubAgentAttribution[] = [
    {
      id: 'SCOUT',
      label: 'Scout (Firecrawl)',
      color: AGENT_COLORS.SCOUT,
      signalCount: counts.SCOUT,
      sharePct: Math.round((counts.SCOUT / totalSignals) * 100),
      summary: 'Social & web velocity intel',
    },
    {
      id: 'SNIPER',
      label: 'Sniper (CEX/Early)',
      color: AGENT_COLORS.SNIPER,
      signalCount: counts.SNIPER,
      sharePct: Math.round((counts.SNIPER / totalSignals) * 100),
      summary: 'Early entry & CEX Auto-Router',
    },
    {
      id: 'CURVE',
      label: 'Curve (Launchpad)',
      color: AGENT_COLORS.CURVE,
      signalCount: counts.CURVE,
      sharePct: Math.round((counts.CURVE / totalSignals) * 100),
      summary: 'Bonding curve momentum',
    },
    {
      id: 'GRADUATE',
      label: 'Graduate (DEX)',
      color: AGENT_COLORS.GRADUATE,
      signalCount: counts.GRADUATE,
      sharePct: Math.max(
        0,
        100 -
          Math.round((counts.SCOUT / totalSignals) * 100) -
          Math.round((counts.SNIPER / totalSignals) * 100) -
          Math.round((counts.CURVE / totalSignals) * 100)
      ),
      summary: 'Pre-graduation & 0x v2 DEX',
    },
  ];

  const isLiveReady = (planId === 'TRADER' || planId === 'AGENT') && (params.hasActiveCexKey || params.hasZeroXApiKey);

  return {
    mode: isLiveReady ? 'LIVE_NON_CUSTODIAL' : 'PAPER_SIM',
    planId,
    totalTrades,
    approvedTrades,
    approvalRatePct,
    goalTradesTarget,
    goalProgressPct,
    dualRailReadiness: {
      internalLaunchpadCount: launches.length,
      externalDexZeroXReady: params.hasZeroXApiKey,
      externalCexAutoReady: params.hasActiveCexKey,
      firecrawlReady: params.hasFirecrawlApiKey,
      scoutDatasetSyncedAt:
        typeof params.scoutDatasetSyncedAt === 'string' && params.scoutDatasetSyncedAt.trim()
          ? params.scoutDatasetSyncedAt.trim()
          : null,
      scoutDatasetHintCount: Array.isArray(params.firecrawlHints) ? params.firecrawlHints.length : 0,
    },
    agentBreakdown,
    recentTradeCards,
    liveFeed: liveFeed.slice(0, 8),
  };
}
