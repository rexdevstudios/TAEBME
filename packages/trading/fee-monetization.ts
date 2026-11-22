/**
 * packages/trading/fee-monetization.ts
 *
 * Non-Custodial Transaction Monetization & Env-Driven Broker Tagging Helpers (Phase AQ).
 * - Zero custody, zero secrets: uses public treasury address & public broker referer codes only.
 * - Supports:
 *   1. Env-driven CEX Broker tagging (`BYBIT_BROKER_REFERER`, `BINANCE_BROKER_PREFIX`).
 *   2. Transparent DEX Swap Partner Fee payload (`dexSwapFeeBps` -> `treasuryWallet`, 0x Swap v2 ready).
 *   3. Bankr platform-key default feeRecipient fallback to `treasuryWallet` when user omits custom recipient.
 */

export const DEFAULT_TREASURY_WALLET = '0x0c9f4a82b5ae258e8e65ca40ac4f1abc455c34b6';
export const DEFAULT_DEX_SWAP_FEE_BPS = 25; // 0.25%
export const MAX_DEX_SWAP_FEE_BPS = 100; // 1.00% hard cap

/**
 * Formats a CEX clientOrderId / orderLinkId with an optional env-configured broker prefix
 * (e.g. `BINANCE_BROKER_PREFIX=x-RTRADER`), strictly clamped to 36 characters.
 */
export function formatBrokerOrderId(baseId: string, prefixOverride?: string): string {
  const cleanBase = String(baseId || `ord-${Date.now()}`)
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 36);
  const rawPrefix =
    prefixOverride !== undefined ? prefixOverride : process.env.BINANCE_BROKER_PREFIX || '';
  const cleanPrefix = rawPrefix.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 14);
  if (!cleanPrefix) {
    return cleanBase;
  }
  const sep = cleanPrefix.endsWith('-') || cleanPrefix.endsWith('_') ? '' : '-';
  const combined = `${cleanPrefix}${sep}${cleanBase}`;
  return combined.slice(0, 36);
}

/**
 * Resolves the optional Bybit V5 Broker `X-BAPI-REFERER` header code from env (`BYBIT_BROKER_REFERER`).
 * Returns `undefined` when not configured so no empty header is transmitted.
 */
export function resolveBybitBrokerReferer(override?: string): string | undefined {
  const raw = override !== undefined ? override : process.env.BYBIT_BROKER_REFERER || '';
  const clean = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  return clean.length > 0 ? clean : undefined;
}

export interface DexPartnerFeePayload {
  feeBps: number;
  feePct: number;
  feeRecipient: string;
  chainId: number;
  zeroXSwapParams: {
    swapFeeBps: string;
    swapFeeRecipient: string;
  };
}

/**
 * Builds a transparent, non-custodial DEX partner fee contract (0x Swap API v2 compatible)
 * directed to the platform's public `treasuryWallet`.
 */
export function buildDexPartnerFeePayload(params: {
  dexSwapFeeBps?: number | null;
  treasuryWallet?: string | null;
  chainId?: number;
}): DexPartnerFeePayload {
  const rawBps = Number(params.dexSwapFeeBps ?? DEFAULT_DEX_SWAP_FEE_BPS);
  const feeBps = Number.isFinite(rawBps)
    ? Math.max(0, Math.min(MAX_DEX_SWAP_FEE_BPS, Math.round(rawBps)))
    : DEFAULT_DEX_SWAP_FEE_BPS;
  const candidateWallet = (params.treasuryWallet || '').trim();
  const feeRecipient = /^0x[a-fA-F0-9]{40}$/.test(candidateWallet)
    ? candidateWallet
    : DEFAULT_TREASURY_WALLET;

  return {
    feeBps,
    feePct: Number((feeBps / 100).toFixed(4)),
    feeRecipient,
    chainId: Number(params.chainId ?? 8453),
    zeroXSwapParams: {
      swapFeeBps: String(feeBps),
      swapFeeRecipient: feeRecipient,
    },
  };
}

/**
 * Resolves the effective Bankr `feeRecipient`:
 * - If the user explicitly supplied a `feeRecipient`, always respect it.
 * - If the user is deploying via `PLATFORM_DEFAULT` key and omitted `feeRecipient`,
 *   default to the platform's public `treasuryWallet`.
 */
export function resolveBankrEffectiveFeeRecipient(params: {
  requestedFeeRecipient?: unknown;
  usingPlatformDefaultKey: boolean;
  treasuryWallet?: string | null;
}): unknown {
  const hasExplicit =
    params.requestedFeeRecipient !== undefined &&
    params.requestedFeeRecipient !== null &&
    (typeof params.requestedFeeRecipient !== 'string' || params.requestedFeeRecipient.trim().length > 0);
  if (hasExplicit) {
    return params.requestedFeeRecipient;
  }
  if (!params.usingPlatformDefaultKey) {
    return undefined;
  }
  const candidate = (params.treasuryWallet || '').trim();
  const safeTreasury = /^0x[a-fA-F0-9]{40}$/.test(candidate) ? candidate : DEFAULT_TREASURY_WALLET;
  return { type: 'wallet', value: safeTreasury };
}
