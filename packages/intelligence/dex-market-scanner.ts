/**
 * packages/intelligence/dex-market-scanner.ts
 *
 * Modular, stateless DEX Token Scanner (DexScreener + GeckoTerminal Public API)
 * and pluggable Strategy Profile evaluator for the 5-Agent Trading Desk.
 *
 * Invariants:
 * - Zero API keys required, zero private keys, strict 4s timeout, fail-safe null fallback.
 * - Purely advisory/enrichment: never modifies TradingRiskGate or KillSwitch rules.
 */

export type StrategyProfileId =
  | 'EARLY_SNIPER'
  | 'MOMENTUM_BREAKOUT'
  | 'DIP_ACCUMULATOR'
  | 'CONSERVATIVE_DCA';

export interface StrategyProfileConfig {
  id: StrategyProfileId;
  label: string;
  minLiquidityUsd: number;
  recommendedSlippagePct: number;
  description: string;
}

export const STRATEGY_PROFILES: Record<StrategyProfileId, StrategyProfileConfig> = {
  EARLY_SNIPER: {
    id: 'EARLY_SNIPER',
    label: 'Early Launch Sniper',
    minLiquidityUsd: 3000,
    recommendedSlippagePct: 2.5,
    description: 'Fokus token baru / Bonding Curve dengan toleransi slippage lebih longgar dan ukuran posisi kecil.',
  },
  MOMENTUM_BREAKOUT: {
    id: 'MOMENTUM_BREAKOUT',
    label: 'Momentum Breakout',
    minLiquidityUsd: 25000,
    recommendedSlippagePct: 1.5,
    description: 'Fokus volume 24j tinggi dengan dominasi beli (buy ratio >= 55%) dan likuiditas menengah.',
  },
  DIP_ACCUMULATOR: {
    id: 'DIP_ACCUMULATOR',
    label: 'Dip Accumulator',
    minLiquidityUsd: 20000,
    recommendedSlippagePct: 1.2,
    description: 'Fokus beli saat koreksi harga sehat (24h <= -5%) pada token dengan likuiditas stabil.',
  },
  CONSERVATIVE_DCA: {
    id: 'CONSERVATIVE_DCA',
    label: 'Conservative DCA',
    minLiquidityUsd: 100000,
    recommendedSlippagePct: 0.5,
    description: 'Fokus aset mapan berlikuiditas dalam (>= $100k) dengan slippage ketat & risiko minimal.',
  },
};

export interface DexTokenSnapshot {
  tokenAddress: string;
  symbol: string;
  name: string;
  chainId: string;
  dexId: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  fdvUsd: number;
  priceChange1h: number;
  priceChange24h: number;
  buys24h: number;
  sells24h: number;
  buyRatioPct: number;
  pairUrl: string;
  geckoTerminalUrl: string;
  source: 'DEXSCREENER' | 'GECKOTERMINAL';
  fetchedAt: string;
}

export interface StrategyFitEvaluation {
  strategyProfile: StrategyProfileId;
  scoreDelta: number;
  riskFlags: string[];
  rationale: string;
}

function mapToGeckoNetwork(net?: string): string {
  const n = (net || 'base').toLowerCase().trim();
  if (n === 'ethereum' || n === 'mainnet' || n === 'eth') return 'eth';
  if (n === 'arbitrum' || n === 'arbitrum-one' || n === 'arb') return 'arbitrum';
  if (n === 'solana' || n === 'sol') return 'solana';
  if (n === 'bsc' || n === 'bnb') return 'bsc';
  return 'base';
}

/**
 * Fetches live DEX telemetry for any EVM or Solana token address via DexScreener Public API,
 * falling back to GeckoTerminal Public API if needed. Never throws.
 */
export async function fetchDexTokenSnapshot(
  tokenAddress: string,
  dexNetwork: string = 'base'
): Promise<DexTokenSnapshot | null> {
  const cleanAddr = (tokenAddress || '').trim();
  if (!cleanAddr || cleanAddr.length < 16) return null;

  const geckoNet = mapToGeckoNetwork(dexNetwork);
  const defaultGeckoUrl = `https://www.geckoterminal.com/${geckoNet}/tokens/${cleanAddr}`;

  // 1. Primary: DexScreener Public API (covers Base, Arbitrum, Eth, Solana, BSC)
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(cleanAddr)}`,
      { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } }
    );
    if (res.ok) {
      const json: any = await res.json();
      const pairs: any[] = Array.isArray(json?.pairs) ? json.pairs : [];
      if (pairs.length > 0) {
        // Select highest-liquidity pool
        pairs.sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0));
        const top = pairs[0];
        const buys24h = Number(top?.txns?.h24?.buys || 0);
        const sells24h = Number(top?.txns?.h24?.sells || 0);
        const totalTx = buys24h + sells24h;
        const buyRatioPct = totalTx > 0 ? Math.round((buys24h / totalTx) * 100) : 50;

        return {
          tokenAddress: cleanAddr,
          symbol: String(top?.baseToken?.symbol || 'TOKEN').toUpperCase(),
          name: String(top?.baseToken?.name || 'DEX Token'),
          chainId: String(top?.chainId || dexNetwork),
          dexId: String(top?.dexId || 'dex'),
          priceUsd: Number(top?.priceUsd || 0),
          liquidityUsd: Number(top?.liquidity?.usd || 0),
          volume24hUsd: Number(top?.volume?.h24 || 0),
          fdvUsd: Number(top?.fdv || top?.marketCap || 0),
          priceChange1h: Number(top?.priceChange?.h1 || 0),
          priceChange24h: Number(top?.priceChange?.h24 || 0),
          buys24h,
          sells24h,
          buyRatioPct,
          pairUrl: String(top?.url || `https://dexscreener.com/${top?.chainId || dexNetwork}/${cleanAddr}`),
          geckoTerminalUrl: `https://www.geckoterminal.com/${mapToGeckoNetwork(top?.chainId || dexNetwork)}/tokens/${cleanAddr}`,
          source: 'DEXSCREENER',
          fetchedAt: new Date().toISOString(),
        };
      }
    }
  } catch {
    // Fall through to GeckoTerminal
  }

  // 2. Fallback: GeckoTerminal Public API
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(geckoNet)}/tokens/${encodeURIComponent(cleanAddr)}`,
      { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } }
    );
    if (res.ok) {
      const json: any = await res.json();
      const attr = json?.data?.attributes;
      if (attr) {
        return {
          tokenAddress: cleanAddr,
          symbol: String(attr.symbol || 'TOKEN').toUpperCase(),
          name: String(attr.name || 'GeckoTerminal Token'),
          chainId: geckoNet,
          dexId: 'geckoterminal',
          priceUsd: Number(attr.price_usd || 0),
          liquidityUsd: Number(attr.total_reserve_in_usd || 0),
          volume24hUsd: Number(attr.volume_usd?.h24 || 0),
          fdvUsd: Number(attr.fdv_usd || 0),
          priceChange1h: 0,
          priceChange24h: 0,
          buys24h: 0,
          sells24h: 0,
          buyRatioPct: 50,
          pairUrl: `https://dexscreener.com/${geckoNet}/${cleanAddr}`,
          geckoTerminalUrl: defaultGeckoUrl,
          source: 'GECKOTERMINAL',
          fetchedAt: new Date().toISOString(),
        };
      }
    }
  } catch {
    // Graceful null fallback
  }

  return null;
}

/**
 * Deterministically evaluates how well a live DEX token snapshot matches a chosen Strategy Profile.
 */
export function evaluateDexStrategyFit(
  snapshot: DexTokenSnapshot,
  strategyProfile: StrategyProfileId = 'MOMENTUM_BREAKOUT'
): StrategyFitEvaluation {
  const cfg = STRATEGY_PROFILES[strategyProfile] || STRATEGY_PROFILES.MOMENTUM_BREAKOUT;
  const riskFlags: string[] = [];
  const notes: string[] = [];
  let scoreDelta = 0;

  if (snapshot.liquidityUsd < cfg.minLiquidityUsd) {
    riskFlags.push('LOW_DEX_LIQUIDITY');
    scoreDelta -= 0.15;
    notes.push(`Liquidity $${Math.round(snapshot.liquidityUsd).toLocaleString()} below ${cfg.label} min ($${cfg.minLiquidityUsd.toLocaleString()})`);
  } else {
    scoreDelta += 0.08;
    notes.push(`Liquidity $${Math.round(snapshot.liquidityUsd).toLocaleString()} meets ${cfg.label}`);
  }

  if (snapshot.buyRatioPct < 42 && snapshot.buys24h + snapshot.sells24h >= 10) {
    riskFlags.push('SELL_PRESSURE_DOMINANT');
    scoreDelta -= 0.1;
    notes.push(`Sell pressure dominant (${snapshot.buyRatioPct}% buys)`);
  } else if (snapshot.buyRatioPct >= 55) {
    scoreDelta += 0.06;
    notes.push(`Healthy buy pressure (${snapshot.buyRatioPct}% buys)`);
  }

  if (snapshot.priceChange1h > 150) {
    riskFlags.push('EXTREME_PUMP_1H');
    scoreDelta -= 0.1;
    notes.push(`Extreme 1h pump (+${snapshot.priceChange1h.toFixed(1)}%) — pullback risk`);
  }

  if (strategyProfile === 'DIP_ACCUMULATOR' && snapshot.priceChange24h <= -5 && snapshot.liquidityUsd >= cfg.minLiquidityUsd) {
    scoreDelta += 0.07;
    notes.push(`Attractive dip entry (24h ${snapshot.priceChange24h.toFixed(1)}%)`);
  }

  return {
    strategyProfile: cfg.id,
    scoreDelta: Math.round(scoreDelta * 100) / 100,
    riskFlags,
    rationale: `[${cfg.label}] ${notes.join(' · ')}`,
  };
}
