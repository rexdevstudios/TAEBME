/**
 * packages/shared/transparency-metrics.ts
 *
 * Pure, deterministic fee-split & monthly transparency analytics calculator (Phase CN/CP).
 * Computes real platform accounting splits (Creators 50%, Protocol Treasury 50%,
 * DEX Partner Fee 0.25% / configurable bps, and 18-decimal wei token normalization) with zero fabrication.
 */

export interface MonthlyTransparencyInputRow {
  monthKey: string; // e.g. '2026-11'
  tradeVolumeUsd: number;
  curveRaisedUsd: number;
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
 * Normalizes on-chain 18-decimal wei token amounts (e.g. 4.46e24 wei -> 4,460,000 tokens)
 * while preserving already human-denominated values (< 1e15).
 */
export function normalizeWeiOrHumanTokens(raw: unknown): number {
  const v = safeNonNegative(raw);
  if (v >= 1e15) {
    return round2(v / 1e18);
  }
  return round2(v);
}

/**
 * Formats large token counts compactly (e.g. 4,460,000 -> "4.46M", 12,500 -> "12.50K").
 */
export function formatCompactNumber(raw: unknown): string {
  const v = safeNonNegative(raw);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Computes transparent fee flow totals matching POOLNET's documented fee model:
 * - Bonding Curve Fee: 1.00% of curve raised volume in USD (0.50% Creator / 0.50% Protocol Treasury)
 * - 0x v2 DEX Partner Fee: configurable bps (default 25 bps = 0.25% Protocol Treasury)
 */
export function computeFeeSplitBreakdown(params: {
  totalTradeVolumeUsd: number;
  totalCurveRaisedUsd: number;
  dexSwapFeeBps?: number;
}): TransparencyFeeSplitSummary {
  const dexBps = safeNonNegative(params.dexSwapFeeBps) || 25;
  const tradeVol = safeNonNegative(params.totalTradeVolumeUsd);
  const curveVolUsd = safeNonNegative(params.totalCurveRaisedUsd);

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
  dexSwapFeeBps: number = 25
): MonthlyTransparencyRow[] {
  const list = Array.isArray(rows) ? rows : [];
  return [...list]
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey))
    .slice(0, 6)
    .map((r) => {
      const split = computeFeeSplitBreakdown({
        totalTradeVolumeUsd: r.tradeVolumeUsd,
        totalCurveRaisedUsd: r.curveRaisedUsd,
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

/**
 * Resolves the canonical public block explorer address URL for any supported launch chain (Phase CQ).
 */
export function resolveChainAddressExplorerUrl(chain: string, address: string): string {
  const cleanAddr = (address || '').trim();
  const c = (chain || 'base-mainnet').trim().toLowerCase();
  if (c.includes('sepolia')) return `https://sepolia.basescan.org/address/${cleanAddr}`;
  if (c.includes('robinhood')) return `https://robinhoodchain.blockscout.com/address/${cleanAddr}`;
  if (c.includes('arbitrum')) return `https://arbiscan.io/address/${cleanAddr}`;
  if (c.includes('arc')) return `https://arcscan.io/address/${cleanAddr}`;
  if (c.includes('solana')) return `https://solscan.io/token/${cleanAddr}`;
  return `https://basescan.org/address/${cleanAddr}`;
}

export interface TransparencyAuditExportPayload {
  network: string;
  generatedAt?: string;
  fees: TransparencyFeeSplitSummary;
  monthly: MonthlyTransparencyRow[];
  recentLaunches?: Array<{
    name: string;
    ticker: string;
    chain: string;
    contractAddress: string;
    raisedUsd: number;
    status: string;
    explorerUrl: string;
  }>;
}

function escapeAuditCsvCell(raw: unknown): string {
  const s = String(raw ?? '').replace(/\r?\n/g, ' ').trim();
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Serializes Platform Transparency monthly fees & on-chain explorer proofs to formula-safe CSV (Phase CY).
 */
export function serializeTransparencyReportToCsv(report: TransparencyAuditExportPayload): string {
  const lines: string[] = [];
  lines.push(
    ['Section', 'PeriodOrTicker', 'NetworkOrChain', 'VolumeOrRaisedUsd', 'EstimatedFeesUsd', 'CreatorShareUsd', 'ProtocolShareUsd', 'StatusOrLaunches', 'ExplorerUrl']
      .map(escapeAuditCsvCell)
      .join(',')
  );

  for (const m of report.monthly || []) {
    lines.push(
      [
        'MONTHLY_FEES',
        m.monthLabel,
        report.network,
        m.tradeVolumeUsd.toFixed(2),
        m.estimatedFeesUsd.toFixed(2),
        m.creatorShareUsd.toFixed(2),
        m.protocolShareUsd.toFixed(2),
        String(m.launchesCount),
        '',
      ]
        .map(escapeAuditCsvCell)
        .join(',')
    );
  }

  for (const l of report.recentLaunches || []) {
    lines.push(
      [
        'ONCHAIN_LAUNCH',
        `${l.name} ($${l.ticker})`,
        l.chain,
        Number(l.raisedUsd || 0).toFixed(2),
        '',
        '',
        '',
        l.status,
        l.explorerUrl || resolveChainAddressExplorerUrl(l.chain, l.contractAddress),
      ]
        .map(escapeAuditCsvCell)
        .join(',')
    );
  }

  return lines.join('\n');
}

/**
 * Serializes Platform Transparency data into a canonical JSON audit bundle (Phase CY).
 */
export function serializeTransparencyReportToJson(report: TransparencyAuditExportPayload): string {
  return JSON.stringify(
    {
      schemaVersion: 'poolnet.audit.transparency.v1',
      exportedAt: new Date().toISOString(),
      network: report.network,
      generatedAt: report.generatedAt || new Date().toISOString(),
      fees: report.fees,
      monthly: report.monthly,
      recentLaunches: report.recentLaunches || [],
    },
    null,
    2
  );
}
