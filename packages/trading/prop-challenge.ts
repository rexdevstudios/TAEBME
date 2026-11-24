/**
 * packages/trading/prop-challenge.ts
 *
 * Pure, deterministic Web3 Proof-of-Skill Prop Challenge Engine (Phase DG).
 *  - 100% Non-Custodial: evaluates trader skill on virtual paper equity ($10,000) with live market feeds.
 *  - Deterministic Rules: +8% profit target, 5% max daily loss, 10% max total drawdown, min 3 trading days, 30d window.
 *  - Entry: 100 Credits or 0.005 ETH (Base L2 -> Treasury); Pass Reward: Verified Trader badge + 250 Credits.
 */

export const PROP_CHALLENGE_RULES = {
  startingEquityUsd: 10_000,
  profitTargetPct: 8,
  maxDailyLossPct: 5,
  maxTotalDrawdownPct: 10,
  minTradingDays: 3,
  maxDurationDays: 30,
  entryFeeCredits: 100,
  entryFeeEth: '0.005',
  passRewardCredits: 250,
} as const;

export type PropChallengeStatus = 'ACTIVE' | 'PASSED' | 'FAILED' | 'EXPIRED';

export interface PropChallengeRecord {
  id: string;
  walletAddress: string;
  status: PropChallengeStatus;
  paymentMode: 'CREDITS' | 'ETH';
  paymentRef: string;
  startingEquityUsd: number;
  currentEquityUsd: number;
  pnlPct: number;
  maxDrawdownPct: number;
  worstDailyLossPct: number;
  tradingDaysCount: number;
  startedAt: string;
  expiresAt: string;
  evaluatedAt?: string;
  verdictReason?: string;
}

export interface PropTradeSample {
  pnlUsd: number;
  executedAt: string; // ISO timestamp
}

export interface PropEvaluationOutcome {
  status: PropChallengeStatus;
  currentEquityUsd: number;
  pnlPct: number;
  maxDrawdownPct: number;
  worstDailyLossPct: number;
  tradingDaysCount: number;
  verdictReason: string;
}

/**
 * Pure deterministic evaluator for Proof-of-Skill Prop Challenge.
 */
export function evaluatePropChallengeMetrics(params: {
  startingEquityUsd?: number;
  trades: readonly PropTradeSample[];
  expiresAt: string;
  nowMs?: number;
}): PropEvaluationOutcome {
  const startEq =
    Number.isFinite(Number(params.startingEquityUsd)) && Number(params.startingEquityUsd) > 0
      ? Number(params.startingEquityUsd)
      : PROP_CHALLENGE_RULES.startingEquityUsd;
  const nowMs = params.nowMs ?? Date.now();
  const sorted = [...(params.trades || [])].sort(
    (a, b) => Date.parse(a.executedAt) - Date.parse(b.executedAt)
  );

  let equity = startEq;
  let peakEquity = startEq;
  let maxDrawdownPct = 0;
  const dailyPnl = new Map<string, number>();

  for (const t of sorted) {
    const delta = Number(t.pnlUsd);
    if (!Number.isFinite(delta)) continue;
    equity += delta;
    if (equity > peakEquity) peakEquity = equity;
    const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

    const dayKey = (t.executedAt || '').slice(0, 10) || 'unknown';
    dailyPnl.set(dayKey, (dailyPnl.get(dayKey) || 0) + delta);
  }

  let worstDailyLossPct = 0;
  for (const dayNet of dailyPnl.values()) {
    if (dayNet < 0) {
      const lossPct = (Math.abs(dayNet) / startEq) * 100;
      if (lossPct > worstDailyLossPct) worstDailyLossPct = lossPct;
    }
  }

  const tradingDaysCount = dailyPnl.size;
  const pnlPct = ((equity - startEq) / startEq) * 100;
  const r2 = (v: number) => Math.round(v * 100) / 100;

  if (worstDailyLossPct >= PROP_CHALLENGE_RULES.maxDailyLossPct) {
    return {
      status: 'FAILED',
      currentEquityUsd: r2(equity),
      pnlPct: r2(pnlPct),
      maxDrawdownPct: r2(maxDrawdownPct),
      worstDailyLossPct: r2(worstDailyLossPct),
      tradingDaysCount,
      verdictReason: `DAILY_LOSS_BREACHED: Daily loss ${r2(worstDailyLossPct)}% exceeded ${PROP_CHALLENGE_RULES.maxDailyLossPct}% cap.`,
    };
  }

  if (maxDrawdownPct >= PROP_CHALLENGE_RULES.maxTotalDrawdownPct) {
    return {
      status: 'FAILED',
      currentEquityUsd: r2(equity),
      pnlPct: r2(pnlPct),
      maxDrawdownPct: r2(maxDrawdownPct),
      worstDailyLossPct: r2(worstDailyLossPct),
      tradingDaysCount,
      verdictReason: `MAX_DRAWDOWN_BREACHED: Total drawdown ${r2(maxDrawdownPct)}% exceeded ${PROP_CHALLENGE_RULES.maxTotalDrawdownPct}% cap.`,
    };
  }

  if (
    pnlPct >= PROP_CHALLENGE_RULES.profitTargetPct &&
    tradingDaysCount >= PROP_CHALLENGE_RULES.minTradingDays
  ) {
    return {
      status: 'PASSED',
      currentEquityUsd: r2(equity),
      pnlPct: r2(pnlPct),
      maxDrawdownPct: r2(maxDrawdownPct),
      worstDailyLossPct: r2(worstDailyLossPct),
      tradingDaysCount,
      verdictReason: `CHALLENGE_PASSED: Reached +${r2(pnlPct)}% profit across ${tradingDaysCount} trading days within risk limits.`,
    };
  }

  const expMs = Date.parse(params.expiresAt);
  if (Number.isFinite(expMs) && nowMs >= expMs) {
    return {
      status: 'EXPIRED',
      currentEquityUsd: r2(equity),
      pnlPct: r2(pnlPct),
      maxDrawdownPct: r2(maxDrawdownPct),
      worstDailyLossPct: r2(worstDailyLossPct),
      tradingDaysCount,
      verdictReason: `CHALLENGE_EXPIRED: 30-day window ended at ${r2(pnlPct)}% PnL (${tradingDaysCount}/${PROP_CHALLENGE_RULES.minTradingDays} days).`,
    };
  }

  return {
    status: 'ACTIVE',
    currentEquityUsd: r2(equity),
    pnlPct: r2(pnlPct),
    maxDrawdownPct: r2(maxDrawdownPct),
    worstDailyLossPct: r2(worstDailyLossPct),
    tradingDaysCount,
    verdictReason: `IN_PROGRESS: ${r2(pnlPct)}% / +${PROP_CHALLENGE_RULES.profitTargetPct}% target (${tradingDaysCount}/${PROP_CHALLENGE_RULES.minTradingDays} days).`,
  };
}
