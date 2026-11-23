/**
 * packages/intelligence/onchain-insider-guard.ts
 *
 * Free On-Chain Anti-Insider, Wallet Cluster Concentration & Honeypot Intelligence Engine (Phase BW).
 * - Powered by GoPlus Security Public API (100% free, zero API key required).
 * - Cached in Upstash Redis for 15 minutes (`intel:goplus:{chainId}:{addr}`) to guarantee $0 cost & <20ms repeat latency.
 * - 100% fault-isolated (4s timeout, returns null on upstream outage so trading flow never crashes).
 * - Purely defensive / fail-closed: only tightens risk (never loosens TradingRiskGate or KillSwitch).
 */

import { upstashRedis } from '../shared/redis-client';

export const SUPPORTED_GOPLUS_CHAIN_IDS = [1, 10, 56, 137, 8453, 42161] as const;
export type SupportedGoPlusChainId = (typeof SUPPORTED_GOPLUS_CHAIN_IDS)[number];

export const GOPLUS_CACHE_TTL_SECONDS = 900; // 15 minutes

export interface GoPlusHolderEntry {
  address?: string;
  tag?: string;
  is_contract?: number | string;
  balance?: string;
  percent?: string | number;
  is_locked?: number | string;
}

export interface GoPlusRawTokenSecurity {
  token_name?: string;
  token_symbol?: string;
  is_honeypot?: string | number;
  cannot_sell_all?: string | number;
  buy_tax?: string | number;
  sell_tax?: string | number;
  is_mintable?: string | number;
  hidden_owner?: string | number;
  is_blacklisted?: string | number;
  holder_count?: string | number;
  creator_percent?: string | number;
  owner_percent?: string | number;
  holders?: GoPlusHolderEntry[];
  lp_holders?: GoPlusHolderEntry[];
}

export type OnChainSecurityRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface OnChainTokenSecurityReport {
  address: string;
  chainId: number;
  tokenName?: string;
  tokenSymbol?: string;
  isHoneypot: boolean;
  cannotSellAll: boolean;
  buyTaxPct: number;
  sellTaxPct: number;
  isMintable: boolean;
  hiddenOwner: boolean;
  isBlacklisted: boolean;
  holderCount: number;
  top10HolderPct: number;
  creatorAndOwnerPct: number;
  lpLockedPct: number | null;
  suspectedClusterCount: number;
  riskLevel: OnChainSecurityRiskLevel;
  hardBlocked: boolean;
  scorePenalty: number; // 0 down to -0.40
  redFlags: string[];
  summary: string;
  source: 'GOPLUS_API' | 'GOPLUS_REDIS_CACHE';
  fetchedAt: string;
}

export function isValidEvmAddress(address: unknown): address is string {
  return typeof address === 'string' && /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

export function isSupportedGoPlusChainId(chainId: number): chainId is SupportedGoPlusChainId {
  return (SUPPORTED_GOPLUS_CHAIN_IDS as readonly number[]).includes(chainId);
}

export function resolveEvmChainIdFromNetwork(dexNetwork?: string, fallbackChainId?: number): number {
  if (typeof fallbackChainId === 'number' && isSupportedGoPlusChainId(fallbackChainId)) {
    return fallbackChainId;
  }
  const net = String(dexNetwork || '').trim().toLowerCase();
  if (net === 'ethereum' || net === 'mainnet' || net === 'eth') return 1;
  if (net === 'optimism' || net === 'op') return 10;
  if (net === 'bsc' || net === 'bnb') return 56;
  if (net === 'polygon' || net === 'matic') return 137;
  if (net === 'arbitrum' || net === 'arbitrum-one' || net === 'arb') return 42161;
  return 8453; // Default Base
}

function isFlagTruthy(val: unknown): boolean {
  return val === '1' || val === 1 || val === true || val === 'true';
}

/**
 * GoPlus returns ratios as decimal fractions (e.g. "0.05" = 5%, "0.25" = 25%).
 */
export function parseGoPlusFractionToPct(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const pct = n <= 1 ? n * 100 : n;
  return Math.min(100, Math.round(pct * 100) / 100);
}

/**
 * Detects suspected same-entity / bundled sniper wallet clusters:
 * finds the largest group of top non-contract, non-locked holders where each holds >= 1.0%
 * and the spread between them is <= 0.15%. Returns cluster size if >= 3, else 0.
 */
export function detectSuspectedInsiderCluster(holders: GoPlusHolderEntry[] | undefined): number {
  if (!Array.isArray(holders) || holders.length === 0) return 0;

  const candidatePcts = holders
    .filter((h) => !isFlagTruthy(h.is_contract) && !isFlagTruthy(h.is_locked))
    .map((h) => parseGoPlusFractionToPct(h.percent))
    .filter((pct) => pct >= 1.0)
    .slice(0, 15)
    .sort((a, b) => b - a);

  if (candidatePcts.length < 3) return 0;

  let maxCluster = 0;
  for (let i = 0; i < candidatePcts.length; i++) {
    let count = 1;
    for (let j = i + 1; j < candidatePcts.length; j++) {
      if (candidatePcts[i] - candidatePcts[j] <= 0.15) {
        count++;
      } else {
        break;
      }
    }
    if (count > maxCluster) {
      maxCluster = count;
    }
  }

  return maxCluster >= 3 ? maxCluster : 0;
}

export function analyzeGoPlusTokenSecurity(
  raw: GoPlusRawTokenSecurity,
  meta: { address: string; chainId: number; source?: 'GOPLUS_API' | 'GOPLUS_REDIS_CACHE' }
): OnChainTokenSecurityReport {
  const address = meta.address.trim().toLowerCase();
  const isHoneypot = isFlagTruthy(raw.is_honeypot);
  const cannotSellAll = isFlagTruthy(raw.cannot_sell_all);
  const buyTaxPct = parseGoPlusFractionToPct(raw.buy_tax);
  const sellTaxPct = parseGoPlusFractionToPct(raw.sell_tax);
  const isMintable = isFlagTruthy(raw.is_mintable);
  const hiddenOwner = isFlagTruthy(raw.hidden_owner);
  const isBlacklisted = isFlagTruthy(raw.is_blacklisted);
  const holderCount = Math.max(0, Math.floor(Number(raw.holder_count || 0) || 0));

  const nonContractHolders = Array.isArray(raw.holders)
    ? raw.holders.filter((h) => !isFlagTruthy(h.is_contract) && !isFlagTruthy(h.is_locked))
    : [];
  const top10RawSum = nonContractHolders
    .slice(0, 10)
    .reduce((acc, h) => acc + parseGoPlusFractionToPct(h.percent), 0);
  const top10HolderPct = Math.min(100, Math.round(top10RawSum * 100) / 100);

  const creatorAndOwnerPct = Math.min(
    100,
    Math.round(
      (parseGoPlusFractionToPct(raw.creator_percent) + parseGoPlusFractionToPct(raw.owner_percent)) * 100
    ) / 100
  );

  let lpLockedPct: number | null = null;
  if (Array.isArray(raw.lp_holders) && raw.lp_holders.length > 0) {
    const lockedSum = raw.lp_holders
      .filter((lp) => isFlagTruthy(lp.is_locked))
      .reduce((acc, lp) => acc + parseGoPlusFractionToPct(lp.percent), 0);
    lpLockedPct = Math.min(100, Math.round(lockedSum * 100) / 100);
  }

  const suspectedClusterCount = detectSuspectedInsiderCluster(raw.holders);

  const redFlags: string[] = [];
  let penalty = 0;

  if (isHoneypot) redFlags.push('HONEYPOT_DETECTED');
  if (cannotSellAll) redFlags.push('CANNOT_SELL_ALL');
  if (sellTaxPct > 20) redFlags.push('HIGH_SELL_TAX');
  if (buyTaxPct > 20) redFlags.push('HIGH_BUY_TAX');

  if (top10HolderPct >= 60) {
    redFlags.push('TOP10_CONCENTRATION_CRITICAL');
    penalty += 0.25;
  } else if (top10HolderPct >= 45) {
    redFlags.push('TOP10_CONCENTRATION_HIGH');
    penalty += 0.15;
  }

  if (suspectedClusterCount >= 3) {
    redFlags.push('INSIDER_CLUSTER_SUSPECTED');
    penalty += 0.2;
  }

  if (creatorAndOwnerPct >= 10) {
    redFlags.push('DEV_HOLDING_HIGH');
    penalty += 0.15;
  }

  if (isMintable) {
    redFlags.push('MINTABLE_SUPPLY');
    penalty += 0.1;
  }

  if (hiddenOwner) {
    redFlags.push('HIDDEN_OWNER');
    penalty += 0.15;
  }

  if (lpLockedPct !== null && lpLockedPct < 50) {
    redFlags.push('LP_UNLOCKED');
    penalty += 0.1;
  }

  const hardBlocked = isHoneypot || cannotSellAll || sellTaxPct > 20 || buyTaxPct > 20;
  const roundedPenalty = Math.min(0.4, Math.round(penalty * 100) / 100);
  const scorePenalty = hardBlocked ? -0.4 : roundedPenalty > 0 ? -roundedPenalty : 0;

  let riskLevel: OnChainSecurityRiskLevel = 'LOW';
  if (hardBlocked || top10HolderPct >= 60) {
    riskLevel = 'CRITICAL';
  } else if (scorePenalty <= -0.2 || suspectedClusterCount >= 3 || creatorAndOwnerPct >= 10) {
    riskLevel = 'HIGH';
  } else if (redFlags.length > 0) {
    riskLevel = 'MEDIUM';
  }

  const summaryParts: string[] = [];
  if (isHoneypot) summaryParts.push('Honeypot terdeteksi (tidak bisa dijual)');
  if (cannotSellAll) summaryParts.push('Kontrak membatasi jual penuh (cannot_sell_all)');
  if (sellTaxPct > 20) summaryParts.push(`Pajak jual ekstrem ${sellTaxPct}%`);
  if (buyTaxPct > 20) summaryParts.push(`Pajak beli ekstrem ${buyTaxPct}%`);
  if (suspectedClusterCount >= 3) {
    summaryParts.push(`Terdeteksi ${suspectedClusterCount} wallet kembar (indikasi cluster insider/sniper)`);
  }
  if (top10HolderPct >= 45) {
    summaryParts.push(`Top-10 holder menguasai ${top10HolderPct}% supply`);
  }
  if (creatorAndOwnerPct >= 10) {
    summaryParts.push(`Creator/Owner memegang ${creatorAndOwnerPct}% supply`);
  }
  if (isMintable) summaryParts.push('Supply dapat dicetak ulang (mintable)');
  if (hiddenOwner) summaryParts.push('Hidden owner terdeteksi');
  if (lpLockedPct !== null && lpLockedPct < 50) {
    summaryParts.push(`LP terkunci rendah (${lpLockedPct}%)`);
  }

  const summary =
    summaryParts.length > 0
      ? `${riskLevel} RISK: ${summaryParts.join(' · ')}.`
      : `LOW RISK: Kontrak bersih, Top-10 holder ${top10HolderPct}%, Buy/Sell tax ${buyTaxPct}%/${sellTaxPct}%, tidak ditemukan cluster insider.`;

  return {
    address,
    chainId: meta.chainId,
    tokenName: raw.token_name || undefined,
    tokenSymbol: raw.token_symbol || undefined,
    isHoneypot,
    cannotSellAll,
    buyTaxPct,
    sellTaxPct,
    isMintable,
    hiddenOwner,
    isBlacklisted,
    holderCount,
    top10HolderPct,
    creatorAndOwnerPct,
    lpLockedPct,
    suspectedClusterCount,
    riskLevel,
    hardBlocked,
    scorePenalty,
    redFlags,
    summary,
    source: meta.source || 'GOPLUS_API',
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchOnChainTokenSecurity(params: {
  address: string;
  chainId: number;
  fetchImpl?: typeof fetch;
  bypassCache?: boolean;
}): Promise<OnChainTokenSecurityReport | null> {
  if (!isValidEvmAddress(params.address) || !isSupportedGoPlusChainId(params.chainId)) {
    return null;
  }

  const normalizedAddr = params.address.trim().toLowerCase();
  const cacheKey = `intel:goplus:${params.chainId}:${normalizedAddr}`;

  if (!params.bypassCache && upstashRedis.isConfigured()) {
    const cachedRaw = await upstashRedis.get<string>(cacheKey).catch(() => null);
    if (cachedRaw) {
      try {
        const parsed = (typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw) as OnChainTokenSecurityReport;
        if (parsed && parsed.address === normalizedAddr && parsed.chainId === params.chainId) {
          return { ...parsed, source: 'GOPLUS_REDIS_CACHE' };
        }
      } catch {
        // Ignore corrupt cache and refetch
      }
    }
  }

  const fetcher = params.fetchImpl ?? fetch;
  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${params.chainId}?contract_addresses=${encodeURIComponent(
      normalizedAddr
    )}`;
    const res = await fetcher(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      code?: number;
      result?: Record<string, GoPlusRawTokenSecurity>;
    };
    const resultMap = json?.result;
    if (!resultMap || typeof resultMap !== 'object') return null;

    const rawToken =
      resultMap[normalizedAddr] ||
      Object.entries(resultMap).find(([k]) => k.toLowerCase() === normalizedAddr)?.[1];
    if (!rawToken) return null;

    const report = analyzeGoPlusTokenSecurity(rawToken, {
      address: normalizedAddr,
      chainId: params.chainId,
      source: 'GOPLUS_API',
    });

    if (upstashRedis.isConfigured()) {
      await upstashRedis.set(cacheKey, JSON.stringify(report), GOPLUS_CACHE_TTL_SECONDS).catch(() => false);
    }

    return report;
  } catch {
    return null;
  }
}
