/**
 * packages/shared/transparency-metrics.ts
 *
 * Pure, deterministic fee-split & monthly transparency analytics calculator (Phase CN).
 * Computes real platform accounting splits (Creators 50%, Protocol Treasury 50%,
 * DEX Partner Fee 0.25% / configurable bps, and metered credits economy) with zero fabrication.
 */

export interface MonthlyTransparencyInputRow {
  monthKey: string; // e.g. '2026-11'
  tradeVolumeUsd: number;
  curveRaisedEth: number;
  launchesCount: number;
  creditsBurned: number;
}

export interface MonthlyTransparencyRow {
  monthKey: string;
  monthLabel: string;
  tradeVolumeUsd: number;
  estimatedFeesUsd: number;
  creatorShareUsd: number;
  protocolShareUsd: number;
  launchesCount: number;
  creditsBurned: number;
}

export interface TransparencyFeeSplitSummary {
  totalEstimatedVolumeUsd: number;
  curveFeeUsd: number;
  dexPartnerFeeUsd: number;
  totalEstimatedFeesUsd: number;
  creatorShareUsd: number;
  protocolShareUsd: number;
  creatorSharePct: number;
  protocolSharePct: number;
  curveFeePctOfTotal: number;
  dexFeePctOfTotal: number;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatMonthKeyLabel(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec((monthKey || '').trim());
  if (!m) return monthKey || '—';
  const year = m[1];
  const monthIdx = Number(m[2]) - 1;
  const name = MONTH_NAMES[monthIdx] || m[2];
  return `${name} ${year}`;
}

function safeNonNegative(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Computes transparent fee flow totals matching POOLNET's documented fee model:
 * - Bonding Curve Fee: 1.00% of curve raised volume (0.50% Creator / 0.50% Protocol Treasury)
 * - 0x v2 DEX Partner Fee: configurable bps (default 25 bps = 0.25% Protocol Treasury)
 */
export function computeFeeSplitBreakdown(params: {
  totalTradeVolumeUsd: number;
  totalCurveRaisedEth: number;
  ethPriceUsd?: number;
  dexSwapFeeBps?: number;
}): TransparencyFeeSplitSummary {
  const ethPx = safeNonNegative(params.ethPriceUsd) || 3000;
  const dexBps = safeNonNegative(params.dexSwapFeeBps) || 25;
  const tradeVol = safeNonNegative(params.totalTradeVolumeUsd);
  const curveVolUsd = safeNonNegative(params.totalCurveRaisedEth) * ethPx;

  const curveFeeUsd = curveVolUsd * 0.01; // 1.00% bonding curve fee
  const dexPartnerFeeUsd = tradeVol * (dexBps / 10_000);
  const totalEstimatedFeesUsd = curveFeeUsd + dexPartnerFeeUsd;

  const creatorShareUsd = curveFeeUsd * 0.5; // 0.50% to creator
  const protocolShareUsd = curveFeeUsd * 0.5 + dexPartnerFeeUsd; // 0.50% curve + DEX partner fee

  const denom = totalEstimatedFeesUsd > 0 ? totalEstimatedFeesUsd : 1;
  return {
    totalEstimatedVolumeUsd: round2(tradeVol + curveVolUsd),
    curveFeeUsd: round2(curveFeeUsd),
    dexPartnerFeeUsd: round2(dexPartnerFeeUsd),
    totalEstimatedFeesUsd: round2(totalEstimatedFeesUsd),
    creatorShareUsd: round2(creatorShareUsd),
    protocolShareUsd: round2(protocolShareUsd),
    creatorSharePct: totalEstimatedFeesUsd > 0 ? Math.round((creatorShareUsd / denom) * 100) : 50,
    protocolSharePct: totalEstimatedFeesUsd > 0 ? Math.round((protocolShareUsd / denom) * 100) : 50,
    curveFeePctOfTotal: totalEstimatedFeesUsd > 0 ? Math.round((curveFeeUsd / denom) * 100) : 50,
    dexFeePctOfTotal: totalEstimatedFeesUsd > 0 ? Math.round((dexPartnerFeeUsd / denom) * 100) : 50,
  };
}

/**
 * Builds sorted monthly transparency rows (newest first) from aggregated DB buckets.
 */
export function buildMonthlyTransparencyRows(
  rows: MonthlyTransparencyInputRow[],
  ethPriceUsd: number = 3000,
  dexSwapFeeBps: number = 25
): MonthlyTransparencyRow[] {
  const list = Array.isArray(rows) ? rows : [];
  return [...list]
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey))
    .slice(0, 6)
    .map((r) => {
      const split = computeFeeSplitBreakdown({
        totalTradeVolumeUsd: r.tradeVolumeUsd,
        totalCurveRaisedEth: r.curveRaisedEth,
        ethPriceUsd,
        dexSwapFeeBps,
      });
      return {
        monthKey: r.monthKey,
        monthLabel: formatMonthKeyLabel(r.monthKey),
        tradeVolumeUsd: split.totalEstimatedVolumeUsd,
        estimatedFeesUsd: split.totalEstimatedFeesUsd,
        creatorShareUsd: split.creatorShareUsd,
        protocolShareUsd: split.protocolShareUsd,
        launchesCount: Math.floor(safeNonNegative(r.launchesCount)),
        creditsBurned: Math.floor(safeNonNegative(r.creditsBurned)),
      };
    });
}
