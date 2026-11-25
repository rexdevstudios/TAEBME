/**
 * packages/intelligence/kol-chart-overlay.ts
 *
 * Pure, deterministic GMGN-Style Verified KOL Chart Overlay &
 * Manipulation-Resistant AI Consensus Dataset Engine (Phase DU).
 *
 * 5 Anti-Manipulation Guardrails:
 *  1. Strict KOL VERIFIED Gate (social proof + trustScore >= 65)
 *  2. 1-Vote-Per-KOL-Per-24h Deduplication (blocks tweet spam & wash-trading)
 *  3. Skin-in-the-Game 2x Weighting (real executed entry > tweet-only)
 *  4. Coordinated Shill Dampening (cuts weight 50% if >=3 low-tier tweet-only signals burst without positions)
 *  5. GoPlus Honeypot Hard-Veto (score forced to 0 regardless of KOL consensus)
 */

export type KolVerificationTier = 'GOLD' | 'SILVER' | 'UNVERIFIED';

export interface KolProfileSample {
  walletAddress: string;
  twitterHandle?: string | null;
  farcasterUsername?: string | null;
  lensHandle?: string | null;
  trustScore?: number | null;
  isVerified?: boolean | null;
}

export interface KolSignalInput {
  walletAddress: string;
  handle: string;
  trustScore: number;
  hasSocialProof: boolean;
  source: 'ONCHAIN_ENTRY' | 'SOCIAL_TWEET';
  side: 'BUY' | 'SELL';
  price?: number;
  timestampMs: number;
}

export interface KolConsensusReport {
  tokenSymbol: string;
  score: number; // 0..100
  uniqueVerifiedKols: number;
  skinInTheGameCount: number;
  buySignals: number;
  sellSignals: number;
  flags: string[];
  verdict: 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'VETOED_HONEYPOT';
}

export interface ChartCandleMarker {
  candleIndex: number;
  kind: 'KOL_BUY' | 'KOL_SELL' | 'AI_BUY' | 'AI_SELL';
  badge: 'KB' | 'KS' | 'AI';
  side: 'BUY' | 'SELL';
  price: number;
  label: string;
  tier?: KolVerificationTier;
  timestampMs: number;
}

export function isVerifiedKol(profile: KolProfileSample): {
  verified: boolean;
  tier: KolVerificationTier;
  handle: string;
} {
  const score = Number(profile.trustScore ?? 0);
  const handle =
    (profile.twitterHandle && `@${String(profile.twitterHandle).replace(/^@/, '').trim()}`) ||
    (profile.farcasterUsername && `fc:${String(profile.farcasterUsername).trim()}`) ||
    (profile.lensHandle && `lens:${String(profile.lensHandle).trim()}`) ||
    `${String(profile.walletAddress || '').slice(0, 6)}...${String(profile.walletAddress || '').slice(-4)}`;

  const hasSocialProof = Boolean(
    (profile.twitterHandle && String(profile.twitterHandle).trim().length > 0) ||
      (profile.farcasterUsername && String(profile.farcasterUsername).trim().length > 0) ||
      (profile.lensHandle && String(profile.lensHandle).trim().length > 0)
  );

  if (profile.isVerified === false || !hasSocialProof || score < 65) {
    return { verified: false, tier: 'UNVERIFIED', handle };
  }
  return {
    verified: true,
    tier: score >= 85 ? 'GOLD' : 'SILVER',
    handle,
  };
}

/**
 * Computes a deterministic, manipulation-resistant KOL consensus score (0..100)
 * suitable for both public chart display and AI Agent FeatureEngine input.
 */
export function computeAntiManipulationKolConsensus(params: {
  tokenSymbol: string;
  signals: readonly KolSignalInput[];
  isHoneypot?: boolean;
  nowMs?: number;
}): KolConsensusReport {
  const flags: string[] = [];

  // Guardrail 5: GoPlus Honeypot Hard-Veto (Social signal NEVER overrides on-chain safety)
  if (params.isHoneypot) {
    return {
      tokenSymbol: params.tokenSymbol,
      score: 0,
      uniqueVerifiedKols: 0,
      skinInTheGameCount: 0,
      buySignals: 0,
      sellSignals: 0,
      flags: ['GOPLUS_HONEYPOT_VETO'],
      verdict: 'VETOED_HONEYPOT',
    };
  }

  const now = params.nowMs ?? Date.now();
  const windowMs = 24 * 60 * 60 * 1000;

  // Guardrail 1 & 2: Strict KOL VERIFIED Gate + 1-Vote-Per-KOL-Per-24h Deduplication
  // If a KOL has both a tweet and an on-chain entry, keep the stronger ONCHAIN_ENTRY record.
  const dedupedByWallet = new Map<string, KolSignalInput>();
  for (const sig of params.signals || []) {
    if (!sig.hasSocialProof || Number(sig.trustScore || 0) < 65) continue;
    if (now - sig.timestampMs > windowMs) continue;
    const key = sig.walletAddress.trim().toLowerCase();
    const prev = dedupedByWallet.get(key);
    if (!prev || (prev.source === 'SOCIAL_TWEET' && sig.source === 'ONCHAIN_ENTRY')) {
      dedupedByWallet.set(key, sig);
    }
  }

  const uniqueSignals = Array.from(dedupedByWallet.values());
  if (uniqueSignals.length === 0) {
    return {
      tokenSymbol: params.tokenSymbol,
      score: 50,
      uniqueVerifiedKols: 0,
      skinInTheGameCount: 0,
      buySignals: 0,
      sellSignals: 0,
      flags: ['NO_VERIFIED_KOL_SIGNALS_24H'],
      verdict: 'NEUTRAL',
    };
  }

  let weightedBuy = 0;
  let weightedSell = 0;
  let buySignals = 0;
  let sellSignals = 0;
  let skinInTheGameCount = 0;
  let silverTweetOnlyCount = 0;

  for (const sig of uniqueSignals) {
    const tierWeight = sig.trustScore >= 85 ? 1.5 : 1.0; // GOLD vs SILVER
    // Guardrail 3: Skin-in-the-Game 2x Weighting
    const skinWeight = sig.source === 'ONCHAIN_ENTRY' ? 2.0 : 1.0;
    if (sig.source === 'ONCHAIN_ENTRY') skinInTheGameCount += 1;
    if (sig.source === 'SOCIAL_TWEET' && sig.trustScore < 85) silverTweetOnlyCount += 1;

    const totalW = tierWeight * skinWeight;
    if (sig.side === 'BUY') {
      weightedBuy += totalW;
      buySignals += 1;
    } else {
      weightedSell += totalW;
      sellSignals += 1;
    }
  }

  // Guardrail 4: Coordinated Shill Dampening
  let dampeningFactor = 1.0;
  if (silverTweetOnlyCount >= 3 && skinInTheGameCount === 0) {
    dampeningFactor = 0.5;
    flags.push('COORDINATED_SHILL_DAMPENED');
  }

  const netWeighted = (weightedBuy - weightedSell) * dampeningFactor;
  const rawScore = 50 + Math.max(-45, Math.min(48, Math.round(netWeighted * 10)));
  const score = Math.max(0, Math.min(100, rawScore));

  const verdict: KolConsensusReport['verdict'] =
    score >= 75
      ? 'STRONG_BULLISH'
      : score >= 60
        ? 'BULLISH'
        : score <= 35
          ? 'BEARISH'
          : 'NEUTRAL';

  return {
    tokenSymbol: params.tokenSymbol,
    score,
    uniqueVerifiedKols: uniqueSignals.length,
    skinInTheGameCount,
    buySignals,
    sellSignals,
    flags,
    verdict,
  };
}

/**
 * Maps Verified KOL entries (KB/KS) and deterministic AI Signal entries (AI)
 * onto exact candlestick indices for GMGN-style chart visualization.
 */
export function buildCandleChartMarkers(params: {
  candles: readonly { timestamp: number; open: number; high: number; low: number; close: number }[];
  kolEntries: readonly KolSignalInput[];
  aiAction?: string | null;
}): ChartCandleMarker[] {
  const { candles } = params;
  if (!candles || candles.length === 0) return [];

  const markers: ChartCandleMarker[] = [];

  // 1. Map Verified KOL entries to nearest candle by timestamp
  const usedKolCandles = new Set<string>();
  for (const entry of params.kolEntries || []) {
    if (!entry.hasSocialProof || entry.trustScore < 65) continue;
    let bestIdx = candles.length - 1;
    let bestDiff = Infinity;
    for (let i = 0; i < candles.length; i++) {
      const diff = Math.abs(candles[i].timestamp - entry.timestampMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    const dedupKey = `${bestIdx}-${entry.side}`;
    if (usedKolCandles.has(dedupKey)) continue;
    usedKolCandles.add(dedupKey);

    const tier: KolVerificationTier = entry.trustScore >= 85 ? 'GOLD' : 'SILVER';
    const px = Number.isFinite(Number(entry.price)) && Number(entry.price) > 0
      ? Number(entry.price)
      : entry.side === 'BUY'
        ? candles[bestIdx].low
        : candles[bestIdx].high;

    markers.push({
      candleIndex: bestIdx,
      kind: entry.side === 'BUY' ? 'KOL_BUY' : 'KOL_SELL',
      badge: entry.side === 'BUY' ? 'KB' : 'KS',
      side: entry.side,
      price: px,
      label: `${entry.handle} (KOL VERIFIED · ${tier})`,
      tier,
      timestampMs: entry.timestampMs,
    });
  }

  // 2. Deterministic AI Entry Signal Marker (based on local swing low / high + AI action)
  let minIdx = 0;
  let maxIdx = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].low < candles[minIdx].low) minIdx = i;
    if (candles[i].high > candles[maxIdx].high) maxIdx = i;
  }

  const aiUpper = String(params.aiAction || '').toUpperCase();
  if (aiUpper.includes('SELL') || aiUpper.includes('BEAR')) {
    markers.push({
      candleIndex: maxIdx,
      kind: 'AI_SELL',
      badge: 'AI',
      side: 'SELL',
      price: candles[maxIdx].high,
      label: 'AI Signal Resistance / Exit Zone',
      timestampMs: candles[maxIdx].timestamp,
    });
  } else {
    markers.push({
      candleIndex: minIdx,
      kind: 'AI_BUY',
      badge: 'AI',
      side: 'BUY',
      price: candles[minIdx].low,
      label: 'AI Signal Support / Dip Entry Zone',
      timestampMs: candles[minIdx].timestamp,
    });
  }

  return markers.sort((a, b) => a.candleIndex - b.candleIndex);
}

/**
 * Shared read-only SSOT loader for Verified KOL executed signals on a symbol (Phase DV).
 * Reused by both /api/market/chart and /api/agent/proposals/intelligence (zero SQL duplication).
 */
export async function loadVerifiedKolSignalsForSymbol(
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> } | null,
  activeSymbol: string
): Promise<KolSignalInput[]> {
  if (!pool) return [];
  const kolEntries: KolSignalInput[] = [];
  try {
    const cleanBase = activeSymbol.replace(/\/.*$/, '').replace(/USDT$/, '');
    const res = await pool.query(
      `SELECT ti.side, ti.estimated_price, ti.created_at, w.address AS wallet_address,
              kp.twitter_handle, kp.trust_score, kp.is_verified
       FROM trade_intents ti
       JOIN wallets w ON w.user_id = ti.user_id
       JOIN kol_profiles kp ON kp.user_id = ti.user_id
       WHERE ti.status = 'EXECUTED'
         AND (UPPER(ti.symbol) = UPPER($1) OR UPPER(ti.symbol) LIKE UPPER($2))
       ORDER BY ti.created_at DESC
       LIMIT 25`,
      [activeSymbol, `${cleanBase}%`]
    );
    for (const row of res.rows) {
      const v = isVerifiedKol({
        walletAddress: row.wallet_address,
        twitterHandle: row.twitter_handle,
        trustScore: Number(row.trust_score ?? 0),
        isVerified: row.is_verified === false ? false : undefined,
      });
      if (v.verified) {
        kolEntries.push({
          walletAddress: String(row.wallet_address),
          handle: v.handle,
          trustScore: Number(row.trust_score ?? 0),
          hasSocialProof: true,
          source: 'ONCHAIN_ENTRY',
          side: String(row.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          price: Number(row.estimated_price || 0) || undefined,
          timestampMs: new Date(row.created_at).getTime(),
        });
      }
    }
  } catch {
    // Non-blocking fallback when no matching rows exist
  }
  return kolEntries;
}

export interface KolEnrichedFields {
  kolVerified: boolean;
  kolTier: KolVerificationTier;
  kolHandle?: string;
}

/**
 * Pure deterministic enrichment attaching KOL VERIFIED status to Signal Marketplace presets (Phase DV).
 */
export function enrichMarketplacePresetsWithKolStatus<T extends { creatorWallet: string }>(
  presets: readonly T[],
  kolProfilesByWallet: ReadonlyMap<string, KolProfileSample>
): Array<T & KolEnrichedFields> {
  return (presets || []).map((preset) => {
    const key = String(preset.creatorWallet || '').trim().toLowerCase();
    const prof = kolProfilesByWallet.get(key);
    if (!prof) {
      return { ...preset, kolVerified: false, kolTier: 'UNVERIFIED' as const };
    }
    const v = isVerifiedKol(prof);
    return {
      ...preset,
      kolVerified: v.verified,
      kolTier: v.tier,
      kolHandle: v.verified ? v.handle : undefined,
    };
  });
}

// ============================================================================
// PHASE DW: ADMIN KOL VERIFICATION DECISION RESOLVER & CURATED AI DATASET EXPORT
// ============================================================================

export type KolVerificationDecision = 'APPROVE_GOLD' | 'APPROVE_SILVER' | 'REVOKE';

export interface ResolvedKolVerificationUpdate {
  decision: KolVerificationDecision;
  isVerified: boolean;
  trustScore: number;
  resultingTier: KolVerificationTier;
}

export function resolveKolVerificationDecision(
  raw: unknown
): ResolvedKolVerificationUpdate | null {
  const clean = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (clean === 'APPROVE_GOLD') {
    return { decision: 'APPROVE_GOLD', isVerified: true, trustScore: 90, resultingTier: 'GOLD' };
  }
  if (clean === 'APPROVE_SILVER') {
    return { decision: 'APPROVE_SILVER', isVerified: true, trustScore: 75, resultingTier: 'SILVER' };
  }
  if (clean === 'REVOKE') {
    return { decision: 'REVOKE', isVerified: false, trustScore: 40, resultingTier: 'UNVERIFIED' };
  }
  return null;
}

export interface CuratedKolDatasetRow {
  tokenSymbol: string;
  consensusScore: number;
  verdict: KolConsensusReport['verdict'];
  uniqueVerifiedKols: number;
  skinInTheGameCount: number;
  buySignals: number;
  sellSignals: number;
  flags: string[];
  guardrailsVersion: string;
}

export interface CuratedKolDatasetSnapshot {
  guardrailsVersion: string;
  generatedAt: string;
  totalSymbols: number;
  activeConsensusSymbols: number;
  rows: CuratedKolDatasetRow[];
}

export const KOL_DATASET_GUARDRAILS_VERSION = 'v1-5guardrails';

export function buildCuratedKolDatasetSnapshot(params: {
  reports: readonly KolConsensusReport[];
  generatedAt?: string;
}): CuratedKolDatasetSnapshot {
  const generatedAt = params.generatedAt || new Date().toISOString();
  const rows: CuratedKolDatasetRow[] = (params.reports || []).map((r) => ({
    tokenSymbol: String(r.tokenSymbol || '').trim().toUpperCase(),
    consensusScore: Number(r.score ?? 50),
    verdict: r.verdict,
    uniqueVerifiedKols: Number(r.uniqueVerifiedKols ?? 0),
    skinInTheGameCount: Number(r.skinInTheGameCount ?? 0),
    buySignals: Number(r.buySignals ?? 0),
    sellSignals: Number(r.sellSignals ?? 0),
    flags: Array.isArray(r.flags) ? [...r.flags] : [],
    guardrailsVersion: KOL_DATASET_GUARDRAILS_VERSION,
  }));

  const activeConsensusSymbols = rows.filter((r) => r.uniqueVerifiedKols > 0).length;

  return {
    guardrailsVersion: KOL_DATASET_GUARDRAILS_VERSION,
    generatedAt,
    totalSymbols: rows.length,
    activeConsensusSymbols,
    rows,
  };
}

function escapeDatasetCsvCell(raw: unknown): string {
  let str = String(raw ?? '');
  // OWASP CSV formula-injection neutralization
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function serializeKolConsensusDatasetToCsv(snapshot: CuratedKolDatasetSnapshot): string {
  const header = [
    'generated_at',
    'token_symbol',
    'consensus_score',
    'verdict',
    'unique_verified_kols',
    'skin_in_the_game_count',
    'buy_signals',
    'sell_signals',
    'flags',
    'guardrails_version',
  ].join(',');

  const lines = (snapshot.rows || []).map((row) =>
    [
      escapeDatasetCsvCell(snapshot.generatedAt),
      escapeDatasetCsvCell(row.tokenSymbol),
      escapeDatasetCsvCell(row.consensusScore),
      escapeDatasetCsvCell(row.verdict),
      escapeDatasetCsvCell(row.uniqueVerifiedKols),
      escapeDatasetCsvCell(row.skinInTheGameCount),
      escapeDatasetCsvCell(row.buySignals),
      escapeDatasetCsvCell(row.sellSignals),
      escapeDatasetCsvCell(row.flags.join('|')),
      escapeDatasetCsvCell(row.guardrailsVersion),
    ].join(',')
  );

  return [header, ...lines].join('\n');
}
