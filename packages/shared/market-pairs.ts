/**
 * packages/shared/market-pairs.ts
 *
 * Single Source of Truth (SSOT) for verified liquid CEX trading pairs &
 * strict symbol/interval validation guards (Phase DT).
 * Prevents query-parameter pollution, injection, and silent mock fallbacks.
 */

export interface MarketPairOption {
  symbol: string;
  label: string;
  venue: 'BINANCE_LIVE' | 'LAUNCHPAD';
}

export const TOP_LIQUID_CEX_PAIRS: readonly MarketPairOption[] = [
  { symbol: 'BTCUSDT', label: 'BTC / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'ETHUSDT', label: 'ETH / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'SOLUSDT', label: 'SOL / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'BNBUSDT', label: 'BNB / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'XRPUSDT', label: 'XRP / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'DOGEUSDT', label: 'DOGE / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'PEPEUSDT', label: 'PEPE / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'ARBUSDT', label: 'ARB / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'AVAXUSDT', label: 'AVAX / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'SUIUSDT', label: 'SUI / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'LINKUSDT', label: 'LINK / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
  { symbol: 'OPUSDT', label: 'OP / USDT (Binance Live)', venue: 'BINANCE_LIVE' },
] as const;

export const LAUNCHPAD_CURVE_PAIRS: readonly MarketPairOption[] = [
  { symbol: 'PUMPRUN/WETH', label: 'PUMPRUN / WETH (Base Doppler v4)', venue: 'LAUNCHPAD' },
  { symbol: 'MOON/ETH', label: 'MOON / ETH (Bonding Curve)', venue: 'LAUNCHPAD' },
  { symbol: 'PEOPLE/ETH', label: 'PEOPLE / ETH (Fair Launch)', venue: 'LAUNCHPAD' },
  { symbol: 'CDAO/ETH', label: 'CDAO / ETH (Community Prelaunch)', venue: 'LAUNCHPAD' },
] as const;

export const VALID_CHART_INTERVALS = new Set(['5m', '15m', '1h', '4h', '1d']);

/**
 * Strict allowlist for CEX symbols (e.g. BTCUSDT, 1000PEPEUSDT) and Launchpad slash pairs (e.g. MOON/ETH).
 * Rejects spaces, query delimiters, path traversal, and oversized payloads.
 */
export function isValidMarketSymbol(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const clean = raw.trim().toUpperCase();
  if (clean.length < 3 || clean.length > 22) return false;
  return /^[A-Z0-9]{4,18}$/.test(clean) || /^[A-Z0-9]{2,12}\/[A-Z0-9]{2,8}$/.test(clean);
}

export function isValidChartInterval(raw: unknown): boolean {
  return typeof raw === 'string' && VALID_CHART_INTERVALS.has(raw.trim());
}
