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
  quoteText?: string;
  tweetUrl?: string;
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
  kolHandle?: string;
  quoteText?: string;
  tweetUrl?: string;
  source?: 'ONCHAIN_ENTRY' | 'SOCIAL_TWEET' | 'AI_SIGNAL';
}

const ALLOWED_CALLOUT_HOSTS = new Set([
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'warpcast.com',
  'www.warpcast.com',
]);

export function sanitizeSafeSocialUrl(raw?: string | null): string | undefined {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return undefined;
    if (!ALLOWED_CALLOUT_HOSTS.has(parsed.hostname.toLowerCase())) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export interface KolCalloutValidationResult {
  ok: boolean;
  error?: string;
  sanitized?: {
    quoteText: string;
    tweetUrl?: string;
    side: 'BUY' | 'SELL';
    symbol: string;
    tokenAddress?: string;
    chain: string;
    price?: number;
  };
}

/**
 * Pure, deterministic validator for Verified KOL Chart Callout submissions (Phase FI).
 */
export function validateKolCalloutInput(input: {
  quoteText?: unknown;
  tweetUrl?: unknown;
  side?: unknown;
  symbol?: unknown;
  tokenAddress?: unknown;
  chain?: unknown;
  price?: unknown;
}): KolCalloutValidationResult {
  const rawQuote = typeof input.quoteText === 'string' ? input.quoteText.replace(/[\r\n\t]+/g, ' ').trim() : '';
  if (rawQuote.length < 4 || rawQuote.length > 280) {
    return {
      ok: false,
      error: 'INVALID_QUOTE: Callout text must be between 4 and 280 characters.',
    };
  }

  const rawTweetUrl = typeof input.tweetUrl === 'string' ? input.tweetUrl.trim() : '';
  let tweetUrl: string | undefined;
  if (rawTweetUrl) {
    tweetUrl = sanitizeSafeSocialUrl(rawTweetUrl);
    if (!tweetUrl) {
      return {
        ok: false,
        error: 'INVALID_TWEET_URL: Only public https://x.com, twitter.com, or warpcast.com links are allowed.',
      };
    }
  }

  const side: 'BUY' | 'SELL' =
    typeof input.side === 'string' && input.side.trim().toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

  const rawSymbol = typeof input.symbol === 'string' ? input.symbol.trim().toUpperCase().replace(/[^A-Z0-9/_-]/g, '') : '';
  const rawAddress = typeof input.tokenAddress === 'string' ? input.tokenAddress.trim() : '';
  const isValidAddr =
    /^0x[a-fA-F0-9]{40}$/.test(rawAddress) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(rawAddress);

  if (!rawSymbol && !isValidAddr) {
    return {
      ok: false,
      error: 'MISSING_TARGET: Provide a valid token symbol or contract address.',
    };
  }

  const chain =
    typeof input.chain === 'string' && /^[a-z0-9_-]{2,24}$/i.test(input.chain.trim())
      ? input.chain.trim().toLowerCase()
      : 'base';

  const parsedPrice = Number(input.price);
  const price = Number.isFinite(parsedPrice) && parsedPrice > 0 ? parsedPrice : undefined;

  return {
    ok: true,
    sanitized: {
      quoteText: rawQuote,
      ...(tweetUrl ? { tweetUrl } : {}),
      side,
      symbol: rawSymbol || 'TOKEN',
      ...(isValidAddr ? { tokenAddress: rawAddress } : {}),
      chain,
      ...(price !== undefined ? { price } : {}),
    },
  };
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
      kolHandle: entry.handle,
      ...(entry.quoteText ? { quoteText: entry.quoteText } : {}),
      ...(entry.tweetUrl ? { tweetUrl: entry.tweetUrl } : {}),
      source: entry.source,
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
      source: 'AI_SIGNAL',
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
      source: 'AI_SIGNAL',
    });
  }

  return markers.sort((a, b) => a.candleIndex - b.candleIndex);
}

/**
 * Shared read-only SSOT loader for Verified KOL executed entries & social tweet callouts (Phase DV + Phase FI).
 * Reused by both /api/market/chart and /api/agent/proposals/intelligence (zero SQL duplication).
 * Merges 3 real Neon PostgreSQL sources:
 *   1. `trade_intents` (EXECUTED on-chain/CEX entries -> ONCHAIN_ENTRY)
 *   2. `bounty_claims` + `bounty_campaigns` + `token_launches` (verified tweet proofs -> SOCIAL_TWEET)
 *   3. `scraped_documents` (domain = 'kol_callout' -> SOCIAL_TWEET with quoteText & optional tweetUrl)
 */
export async function loadVerifiedKolSignalsForSymbol(
  pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> } | null,
  activeSymbol: string,
  tokenAddress?: string
): Promise<KolSignalInput[]> {
  if (!pool) return [];
  const kolEntries: KolSignalInput[] = [];
  const cleanBase = activeSymbol.replace(/\/.*$/, '').replace(/USDT$/, '');
  const normAddr = String(tokenAddress || '').trim().toLowerCase();

  // Source 1: Executed trade intents by verified KOLs (ONCHAIN_ENTRY)
  try {
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
          quoteText: `Verified ${String(row.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY'} execution on ${activeSymbol}`,
        });
      }
    }
  } catch {
    // Non-blocking fallback when no matching rows exist
  }

  // Source 2: Verified KOL Bounty Tweet Claims linked to this token launch (SOCIAL_TWEET)
  try {
    const claimRes = await pool.query(
      `SELECT bc.proof_url, bc.created_at, camp.title AS campaign_title, camp.required_hashtag,
              w.address AS wallet_address, kp.twitter_handle, kp.trust_score, kp.is_verified
       FROM bounty_claims bc
       JOIN bounty_campaigns camp ON camp.id = bc.campaign_id
       JOIN token_launches tl ON tl.id = camp.launch_id
       JOIN launch_drafts ld ON ld.id = tl.draft_id
       JOIN kol_profiles kp ON kp.id = bc.kol_id
       JOIN wallets w ON w.user_id = kp.user_id
       WHERE bc.verification_status IN ('VERIFIED', 'APPROVED', 'SETTLED')
         AND (
           ($1 <> '' AND LOWER(tl.contract_address) = $1)
           OR UPPER(ld.ticker) = UPPER($2)
         )
       ORDER BY bc.created_at DESC
       LIMIT 15`,
      [normAddr, cleanBase]
    );
    for (const row of claimRes.rows) {
      const v = isVerifiedKol({
        walletAddress: row.wallet_address,
        twitterHandle: row.twitter_handle,
        trustScore: Number(row.trust_score ?? 0),
        isVerified: row.is_verified === false ? false : undefined,
      });
      if (v.verified) {
        const safeTweet = sanitizeSafeSocialUrl(row.proof_url);
        const tag = row.required_hashtag ? ` (${String(row.required_hashtag)})` : '';
        kolEntries.push({
          walletAddress: String(row.wallet_address),
          handle: v.handle,
          trustScore: Number(row.trust_score ?? 0),
          hasSocialProof: true,
          source: 'SOCIAL_TWEET',
          side: 'BUY',
          timestampMs: new Date(row.created_at).getTime(),
          quoteText: `${String(row.campaign_title || 'Verified KOL Campaign Callout')}${tag}`,
          ...(safeTweet ? { tweetUrl: safeTweet } : {}),
        });
      }
    }
  } catch {
    // Non-blocking fallback
  }

  // Source 3: Direct Verified KOL Callouts stored in scraped_documents (domain = 'kol_callout')
  try {
    const calloutRes = await pool.query(
      `SELECT target_url, raw_content, extracted_metadata, scraped_at
       FROM scraped_documents
       WHERE domain = 'kol_callout'
         AND (
           ($1 <> '' AND LOWER(COALESCE(extracted_metadata->>'tokenAddress', '')) = $1)
           OR UPPER(COALESCE(extracted_metadata->>'symbol', '')) = UPPER($2)
           OR UPPER(COALESCE(extracted_metadata->>'symbol', '')) = UPPER($3)
         )
       ORDER BY scraped_at DESC
       LIMIT 20`,
      [normAddr, activeSymbol, cleanBase]
    );
    for (const row of calloutRes.rows) {
      const meta = (row.extracted_metadata && typeof row.extracted_metadata === 'object' ? row.extracted_metadata : {}) as Record<string, any>;
      const v = isVerifiedKol({
        walletAddress: String(meta.kolWallet || ''),
        twitterHandle: meta.kolHandle || null,
        trustScore: Number(meta.trustScore ?? 0),
        isVerified: meta.isVerified === false ? false : undefined,
      });
      if (v.verified && row.raw_content) {
        const safeTweet = sanitizeSafeSocialUrl(meta.tweetUrl || row.target_url);
        kolEntries.push({
          walletAddress: String(meta.kolWallet || ''),
          handle: v.handle,
          trustScore: Number(meta.trustScore ?? 0),
          hasSocialProof: true,
          source: 'SOCIAL_TWEET',
          side: String(meta.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          price: Number(meta.price || 0) || undefined,
          timestampMs: new Date(row.scraped_at).getTime(),
          quoteText: String(row.raw_content).trim().slice(0, 280),
          ...(safeTweet ? { tweetUrl: safeTweet } : {}),
        });
      }
    }
  } catch {
    // Non-blocking fallback
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

// ============================================================================
// PHASE DX: SCHEDULED ARCHIVE BACKTEST EVALUATOR & SPOT PRICE SNAPSHOT HELPER
// ============================================================================

export const KOL_CONSENSUS_ARCHIVE_DOMAIN = 'kol_consensus_archive';

export interface KolConsensusArchiveEntry {
  archivedAt: string;
  snapshot: CuratedKolDatasetSnapshot;
  spotPrices: Record<string, number>;
}

export interface KolBacktestSummary {
  totalArchives: number;
  evaluatedSignals: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgDirectionalReturnPct: number;
}

/**
 * Pure deterministic win-rate backtest evaluator comparing archived directional
 * KOL consensus verdicts against current live spot prices.
 */
export function evaluateKolConsensusBacktest(params: {
  archives: readonly KolConsensusArchiveEntry[];
  currentSpotPrices: Readonly<Record<string, number>>;
}): KolBacktestSummary {
  const archives = params.archives || [];
  let evaluatedSignals = 0;
  let wins = 0;
  let losses = 0;
  let returnSumPct = 0;

  for (const archive of archives) {
    const rows = archive?.snapshot?.rows || [];
    const entryPrices = archive?.spotPrices || {};

    for (const row of rows) {
      if (!row || Number(row.uniqueVerifiedKols || 0) <= 0) continue;
      const isBullish = row.verdict === 'STRONG_BULLISH' || row.verdict === 'BULLISH';
      const isBearish = row.verdict === 'BEARISH';
      if (!isBullish && !isBearish) continue;

      const sym = String(row.tokenSymbol || '').trim().toUpperCase();
      const entryPx = Number(entryPrices[sym]);
      const currentPx = Number(params.currentSpotPrices[sym]);
      if (!Number.isFinite(entryPx) || entryPx <= 0 || !Number.isFinite(currentPx) || currentPx <= 0) {
        continue;
      }

      const rawReturnPct = ((currentPx - entryPx) / entryPx) * 100;
      const directionalReturnPct = isBullish ? rawReturnPct : -rawReturnPct;

      evaluatedSignals += 1;
      returnSumPct += directionalReturnPct;
      if (directionalReturnPct > 0) {
        wins += 1;
      } else {
        losses += 1;
      }
    }
  }

  const winRatePct =
    evaluatedSignals > 0 ? Math.round((wins / evaluatedSignals) * 1000) / 10 : 0;
  const avgDirectionalReturnPct =
    evaluatedSignals > 0 ? Math.round((returnSumPct / evaluatedSignals) * 100) / 100 : 0;

  return {
    totalArchives: archives.length,
    evaluatedSignals,
    wins,
    losses,
    winRatePct,
    avgDirectionalReturnPct,
  };
}

/**
 * Best-effort public Binance Spot price fetcher (with data-api.binance.vision fallback)
 * for recording reference spot prices alongside archived KOL consensus snapshots.
 */
export async function fetchPublicSpotPricesForSymbols(
  symbols: readonly string[]
): Promise<Record<string, number>> {
  const wanted = new Set(symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean));
  const prices: Record<string, number> = {};
  if (wanted.size === 0) return prices;

  const endpoints = [
    'https://data-api.binance.vision/api/v3/ticker/price',
    'https://api.binance.com/api/v3/ticker/price',
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const rows = (await res.json()) as Array<{ symbol?: string; price?: string }>;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const sym = String(row?.symbol || '').trim().toUpperCase();
        if (!wanted.has(sym)) continue;
        const px = Number(row?.price);
        if (Number.isFinite(px) && px > 0) {
          prices[sym] = px;
        }
      }
      if (Object.keys(prices).length > 0) break;
    } catch {
      // Fallback to next endpoint
    }
  }

  return prices;
}

// ============================================================================
// PHASE EB: SHARED SNAPSHOT ARCHIVER & BYTEPLUS BATCH INFERENCE JSONL EXPORTER
// ============================================================================

export interface ArchiveKolSnapshotResult {
  dryRun: boolean;
  persisted: boolean;
  archiveId: string | null;
  targetUrl: string;
  snapshot: CuratedKolDatasetSnapshot;
  spotPricesCaptured: number;
}

/**
 * Shared SSOT archiver reused by both scheduled Cron (/api/cron/kol-consensus-archive)
 * and Admin 1-Click Archive (POST /api/admin/kol-dataset). Zero SQL duplication.
 */
export async function captureAndArchiveKolConsensusSnapshot(params: {
  pool: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }> } | null;
  symbols: readonly string[];
  dryRun?: boolean;
}): Promise<ArchiveKolSnapshotResult> {
  const dryRun = Boolean(params.dryRun);
  const symbols = (params.symbols || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);

  const [reports, spotPrices] = await Promise.all([
    Promise.all(
      symbols.map(async (symbol): Promise<KolConsensusReport> => {
        const signals = await loadVerifiedKolSignalsForSymbol(params.pool, symbol);
        return computeAntiManipulationKolConsensus({
          tokenSymbol: symbol,
          signals,
          isHoneypot: false,
        });
      })
    ),
    fetchPublicSpotPricesForSymbols(symbols),
  ]);

  const nowIso = new Date().toISOString();
  const snapshot = buildCuratedKolDatasetSnapshot({ reports, generatedAt: nowIso });
  const targetUrl = `kol-consensus://archive/${nowIso}`;

  let persisted = false;
  let archiveId: string | null = null;

  if (!dryRun && params.pool) {
    const insertRes = await params.pool.query(
      `INSERT INTO scraped_documents (target_url, domain, extracted_metadata, scraped_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       RETURNING id`,
      [targetUrl, KOL_CONSENSUS_ARCHIVE_DOMAIN, JSON.stringify({ snapshot, spotPrices })]
    );
    if (insertRes.rows.length > 0) {
      persisted = true;
      archiveId = String(insertRes.rows[0].id);
    }
  }

  return {
    dryRun,
    persisted,
    archiveId,
    targetUrl,
    snapshot,
    spotPricesCaptured: Object.keys(spotPrices).length,
  };
}

/**
 * Pure deterministic BytePlus ModelArk Batch Inference JSONL serializer
 * compatible with CreateBatchInferenceJob (OpenAI/ModelArk /api/v3/chat/completions schema).
 * Contains zero PII, zero wallet addresses, and zero private keys.
 */
export function serializeKolConsensusDatasetToBatchJsonl(
  snapshot: CuratedKolDatasetSnapshot,
  modelId?: string
): string {
  const resolvedModel = (modelId || 'dola-seed-2.0-mini').trim() || 'dola-seed-2.0-mini';
  const tsTag = String(snapshot.generatedAt || new Date().toISOString()).replace(/[^0-9A-Za-z]/g, '').slice(0, 14);

  return (snapshot.rows || [])
    .map((row, idx) => {
      const sym = String(row.tokenSymbol || 'UNKNOWN').replace(/[^A-Z0-9/_-]/g, '').slice(0, 20);
      const userPayload = JSON.stringify({
        tokenSymbol: sym,
        consensusScore: row.consensusScore,
        verdict: row.verdict,
        uniqueVerifiedKols: row.uniqueVerifiedKols,
        skinInTheGameCount: row.skinInTheGameCount,
        buySignals: row.buySignals,
        sellSignals: row.sellSignals,
        flags: row.flags,
        guardrailsVersion: row.guardrailsVersion,
      });

      return JSON.stringify({
        custom_id: `kol-eval-${sym}-${tsTag}-${idx + 1}`,
        method: 'POST',
        url: '/api/v3/chat/completions',
        body: {
          model: resolvedModel,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are an objective crypto signal evaluator. Given curated anti-manipulation KOL consensus metrics, return pure JSON with keys "bias" (BULLISH|BEARISH|NEUTRAL), "qualityScore" (0-100), and "riskNote" (max 160 chars). Advisory only.',
            },
            {
              role: 'user',
              content: `Evaluate this curated KOL consensus snapshot:\n${userPayload}`,
            },
          ],
        },
      });
    })
    .join('\n');
}
