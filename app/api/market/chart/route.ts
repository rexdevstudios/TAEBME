import { NextRequest, NextResponse } from 'next/server';
import { StrategyBacktester, BinanceKlineInterval, PriceCandle } from '@packages/agent/backtester';
import { intelligenceCache, OrderbookSnapshot } from '@packages/intelligence/market-data-cache';
import { FeatureEngine } from '@packages/intelligence/feature-engine';
import { fetchDefiLlamaMacroSignal } from '@packages/intelligence/defillama-client';
import { TradingSignalEngine } from '@packages/intelligence/trading-signal-engine';
import { fetchDexTokenSnapshot, DexTokenSnapshot } from '@packages/intelligence/dex-market-scanner';
import { ApiResponse } from '@packages/shared/contracts/api-contracts';
import { isValidChartInterval, isValidMarketSymbol } from '@packages/shared/market-pairs';

const INTERVAL_MS: Record<string, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

function deterministicHash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function buildTokenCandles(params: {
  seed: string;
  interval: string;
  currentPrice: number;
  change24hPct: number;
  baseVolume: number;
  count?: number;
}): PriceCandle[] {
  const count = params.count ?? 36;
  const stepMs = INTERVAL_MS[params.interval] || INTERVAL_MS['1h'];
  const now = Date.now();
  const safePrice = Math.max(params.currentPrice, 0.00000001);
  const clampedChange = Math.max(-65, Math.min(250, params.change24hPct));
  const startPrice = safePrice / (1 + clampedChange / 100);
  const candles: PriceCandle[] = [];
  let prevClose = startPrice;

  for (let i = 0; i < count; i++) {
    const progress = (i + 1) / count;
    const targetTrend = startPrice + (safePrice - startPrice) * progress;
    const r1 = deterministicHash(`${params.seed}-${i}-a`) - 0.5;
    const r2 = deterministicHash(`${params.seed}-${i}-b`);
    const r3 = deterministicHash(`${params.seed}-${i}-c`);
    const volatility = 0.032;
    const open = prevClose;
    const close = i === count - 1
      ? safePrice
      : Math.max(safePrice * 0.1, targetTrend * (1 + r1 * volatility * 2));
    const wickUp = Math.max(open, close) * (1 + r2 * volatility * 0.85);
    const wickDown = Math.min(open, close) * Math.max(0.1, 1 - r3 * volatility * 0.85);
    const volume = Math.max(10, Math.round((params.baseVolume / count) * (0.55 + r2 * 1.1)));

    candles.push({
      timestamp: now - (count - 1 - i) * stepMs,
      open,
      high: wickUp,
      low: wickDown,
      close,
      volume,
    });
    prevClose = close;
  }

  return candles;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const symbol = (searchParams.get('symbol') || 'BTCUSDT').trim().toUpperCase();
    const rawInterval = (searchParams.get('interval') || '1h').trim();
    const tokenAddress = (searchParams.get('address') || '').trim();

    if (!isValidMarketSymbol(symbol)) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_SYMBOL', message: 'Symbol must be a valid CEX ticker (e.g. BTCUSDT) or pair (e.g. MOON/ETH).' },
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }
    if (!isValidChartInterval(rawInterval)) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_INTERVAL', message: 'Supported intervals are 5m, 15m, 1h, 4h, 1d.' },
          timestamp: new Date().toISOString(),
        },
        { status: 400 }
      );
    }
    const interval = rawInterval as BinanceKlineInterval;
    const chain = (searchParams.get('chain') || 'base').trim().toLowerCase();
    const ticker = (searchParams.get('ticker') || symbol).toUpperCase();
    const raised = Number(searchParams.get('raised') || 0);
    const target = Math.max(1, Number(searchParams.get('target') || 69000));

    let candles: PriceCandle[] = [];
    let macroSignal: any = null;
    let dexSnapshot: DexTokenSnapshot | null = null;
    let chartSource: 'BINANCE_SPOT' | 'LIVE_DEX' | 'BONDING_CURVE' | 'FALLBACK' = 'BINANCE_SPOT';

    if (tokenAddress.length >= 16) {
      // Token-specific chart mode (Token Portal / Bonding Curve / External DEX)
      const [dexResult, macroResult] = await Promise.allSettled([
        fetchDexTokenSnapshot(tokenAddress, chain),
        fetchDefiLlamaMacroSignal(),
      ]);
      dexSnapshot = dexResult.status === 'fulfilled' ? dexResult.value : null;
      macroSignal = macroResult.status === 'fulfilled' ? macroResult.value : null;

      if (dexSnapshot && dexSnapshot.priceUsd > 0) {
        chartSource = 'LIVE_DEX';
        candles = buildTokenCandles({
          seed: `${tokenAddress}-${interval}-dex`,
          interval,
          currentPrice: dexSnapshot.priceUsd,
          change24hPct: dexSnapshot.priceChange24h || 4.2,
          baseVolume: Math.max(500, dexSnapshot.volume24hUsd || 12000),
          count: 36,
        });
      } else {
        // Pre-graduation / Bonding Curve deterministic price telemetry
        chartSource = 'BONDING_CURVE';
        const progressRatio = Math.min(1, Math.max(0, raised / target));
        const curvePriceUsd = Number((0.000012 + progressRatio * 0.000057).toFixed(8));
        const syntheticMomentumPct = Number((2.5 + progressRatio * 34).toFixed(2));
        candles = buildTokenCandles({
          seed: `${tokenAddress}-${chain}-${interval}-curve`,
          interval,
          currentPrice: curvePriceUsd,
          change24hPct: syntheticMomentumPct,
          baseVolume: Math.max(1200, raised * 1.45),
          count: 36,
        });
      }
    } else {
      // 1. Fetch Historical OHLCV & DefiLlama macro signal in parallel (non-blocking)
      const [candlesResult, macroResult] = await Promise.allSettled([
        StrategyBacktester.fetchHistoricalCandles(symbol, interval, 30),
        fetchDefiLlamaMacroSignal(),
      ]);

      candles = candlesResult.status === 'fulfilled' ? candlesResult.value : [];
      macroSignal = macroResult.status === 'fulfilled' ? macroResult.value : null;

      // Fallback mock candles if Binance REST is unreachable
      if (candles.length === 0) {
        chartSource = 'FALLBACK';
        const now = Date.now();
        const basePrice = symbol.includes('BTC') ? 64000 : symbol.includes('ETH') ? 3400 : 1.25;
        candles = Array.from({ length: 30 }, (_, i) => {
          const time = now - (30 - i) * 3600 * 1000;
          const variation = (Math.sin(i) * 0.02 + Math.cos(i * 0.5) * 0.01) * basePrice;
          const open = basePrice + variation;
          const close = open + (i % 2 === 0 ? 0.008 : -0.006) * basePrice;
          const high = Math.max(open, close) + 0.005 * basePrice;
          const low = Math.min(open, close) - 0.005 * basePrice;
          const volume = Math.round(1000 + Math.sin(i * 3) * 400);
          return { timestamp: time, open, high, low, close, volume };
        });
      }
    }

    const activeSymbol = tokenAddress ? ticker : symbol;

    // 2. Read Orderbook Snapshot from Cache (Fallback default if cold)
    let orderbook = intelligenceCache.getOrderbook(activeSymbol);
    if (!orderbook) {
      const lastClose = candles[candles.length - 1].close;
      const precision = lastClose < 0.01 ? 1e8 : 100;
      const bestBid = Math.round((lastClose * 0.9995) * precision) / precision;
      const bestAsk = Math.round((lastClose * 1.0005) * precision) / precision;
      orderbook = {
        symbol: activeSymbol,
        timestamp: Date.now(),
        bids: [
          [bestBid, 1.5],
          [bestBid * 0.998, 4.2],
          [bestBid * 0.995, 12.8],
        ],
        asks: [
          [bestAsk, 1.2],
          [bestAsk * 1.002, 3.8],
          [bestAsk * 1.005, 15.0],
        ],
        bestBid,
        bestAsk,
        spread: Math.round((bestAsk - bestBid) * precision) / precision,
        spreadPct: bestBid > 0 ? Math.round(((bestAsk - bestBid) / bestBid) * 10000) / 100 : 0.1,
      };
    }

    // 3. Compute Intelligence Signal (includes optional DefiLlama macro context)
    const signal = FeatureEngine.computeSignal(activeSymbol, intelligenceCache, null, null, macroSignal);

    // 4. Run Trading Signal Engine — generates alerts, regime, strategy signals (non-blocking)
    const tradingAnalysis = TradingSignalEngine.analyze(
      activeSymbol,
      candles as PriceCandle[],
      orderbook as OrderbookSnapshot,
      signal,
    );

    const data = {
      symbol: activeSymbol,
      interval,
      chartSource,
      dexSnapshot,
      candles,
      orderbook,
      signal,
      macroContext: signal.macroContext ?? null,
      tradingAnalysis,
    };

    const response: ApiResponse<typeof data> = {
      success: true,
      data,
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json(response, {
      status: 200,
      headers: {
        'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=20',
      },
    });

  } catch (err) {
    const response: ApiResponse<null> = {
      success: false,
      error: { code: 'CHART_DATA_ERROR', message: (err as Error).message },
      timestamp: new Date().toISOString(),
    };
    return NextResponse.json(response, { status: 500 });
  }
}
