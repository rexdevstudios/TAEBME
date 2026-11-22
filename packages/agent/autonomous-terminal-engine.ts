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
  createdAt?: string;
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

export function buildAutonomousTerminalSnapshot(params: {
  planId?: string;
  intents: MinimalTradeIntent[];
  activeLaunches: ActiveLaunchLite[];
  hasActiveCexKey: boolean;
  hasZeroXApiKey: boolean;
  hasFirecrawlApiKey: boolean;
  firecrawlHints?: Array<{ symbol: string; note: string; tokenAddress?: string }>;
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
    return {
      id: intent.id,
      symbol: intent.symbol,
      side: intent.side === 'SELL' ? 'SELL' : 'BUY',
      stage: intent.stage,
      quantity: Number(intent.quantity || 0),
      status: intent.status,
      agent,
      rail,
      createdAt: intent.createdAt,
    };
  });

  const liveFeed: TerminalAgentFeedItem[] = [];

  // 1. Curve & Graduate signals from live platform launches (INTERNAL_LAUNCHPAD)
  for (const launch of launches.slice(0, 3)) {
    const ticker = String(launch.ticker || launch.symbol || 'TOKEN').replace(/^\$/, '').toUpperCase();
    const addrParam = launch.contractAddress ? `&token=${encodeURIComponent(launch.contractAddress)}` : '';
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
      href: `/trading?symbol=${encodeURIComponent(`${ticker}/WETH`)}&side=BUY&qty=0.05&mode=DEX_NON_CUSTODIAL${addrParam}`,
      symbol: `${ticker}/WETH`,
      side: 'BUY',
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

  for (const hint of hints.slice(0, 2)) {
    counts.SCOUT += 1;
    const addrParam = hint.tokenAddress ? `&token=${encodeURIComponent(hint.tokenAddress)}` : '';
    liveFeed.push({
      id: `scout-${hint.symbol}`,
      agent: 'SCOUT',
      color: AGENT_COLORS.SCOUT,
      rail: 'EXTERNAL_DEX_0X',
      railLabel: RAIL_LABELS.EXTERNAL_DEX_0X,
      headline: hint.note,
      href: `/trading?symbol=${encodeURIComponent(hint.symbol)}&side=BUY&qty=0.02&mode=DEX_NON_CUSTODIAL${addrParam}`,
      symbol: hint.symbol,
      side: 'BUY',
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
    href: `/trading?symbol=BTCUSDT&side=BUY&qty=0.02&mode=${params.hasActiveCexKey ? 'CEX_SINGLE_SHOT' : 'PAPER'}`,
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
    liveFeed: liveFeed.slice(0, 6),
  };
}
