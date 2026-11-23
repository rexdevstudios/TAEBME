import { describe, expect, test } from 'bun:test';
import { StrategyBacktester } from '../packages/agent/backtester';
import {
  fetchAutoPilot24hTickers,
  fetchAutoPilotSpotPrices,
} from '../packages/agent/autopilot-market-feed';

describe('Phase CC: Geo-Block Resilient Binance Vision Mirror Fallback', () => {
  test('CC1.1 StrategyBacktester.fetchHistoricalCandles uses data-api.binance.vision first and falls back to api.binance.com on non-200', async () => {
    const calledUrls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calledUrls.push(url);
      if (url.includes('data-api.binance.vision')) {
        return new Response(
          JSON.stringify([[1700000000000, '60000', '61000', '59500', '60500', '123.4']]),
          { status: 200 }
        );
      }
      return new Response('geo-blocked', { status: 451 });
    }) as typeof fetch;

    const candles = await StrategyBacktester.fetchHistoricalCandles('BTCUSDT', '1h', 10, false, mockFetch);
    expect(candles.length).toBe(1);
    expect(candles[0]?.close).toBe(60500);
    expect(calledUrls[0]).toContain('data-api.binance.vision');
  });

  test('CC1.2 Auto-Pilot spot price & 24h ticker fetchers recover automatically if primary host returns 451', async () => {
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('data-api.binance.vision')) {
        return new Response('temporary 503', { status: 503 });
      }
      if (url.includes('/ticker/price')) {
        return new Response(JSON.stringify({ symbol: 'BTCUSDT', price: '95000.50' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ symbol: 'BTCUSDT', lastPrice: '95000.50', priceChangePercent: '4.2', quoteVolume: '120000000' }),
        { status: 200 }
      );
    }) as typeof fetch;

    const prices = await fetchAutoPilotSpotPrices(['BTCUSDT'], mockFetch);
    expect(prices.BTCUSDT).toBe(95000.5);

    const tickers = await fetchAutoPilot24hTickers(['BTCUSDT'], mockFetch);
    expect(tickers.BTCUSDT?.lastPrice).toBe(95000.5);
    expect(tickers.BTCUSDT?.priceChangePct24h).toBe(4.2);
  });
});
