import { describe, it, expect } from 'vitest';
import {
  computeDynamicSignalConfidence,
  deriveOpenPositionsFromTradeIntents,
  fetchAutoPilot24hTickers,
} from '../packages/agent/autopilot-market-feed';
import { AUTOPILOT_STRATEGY_PRESETS, validateAndClampAutoPilotConfig } from '../packages/agent/autopilot-policy';

describe('Phase BV — Dynamic AI Confidence Scoring, Auto-Hydrate Open Positions & 1-Click Presets', () => {
  it('[BV1.1] computeDynamicSignalConfidence rewards healthy momentum + deep liquidity and penalizes FOMO pumps/dumps', () => {
    const healthy = computeDynamicSignalConfidence({ priceChangePct24h: 5.5, quoteVolumeUsd: 80_000_000 });
    const fomoPump = computeDynamicSignalConfidence({ priceChangePct24h: 38.0, quoteVolumeUsd: 200_000 });
    const fallingKnife = computeDynamicSignalConfidence({ priceChangePct24h: -15.0, quoteVolumeUsd: 2_000_000 });

    expect(healthy).toBeGreaterThanOrEqual(82);
    expect(fomoPump).toBeLessThanOrEqual(55);
    expect(fallingKnife).toBeLessThanOrEqual(55);
  });

  it('[BV1.2] deriveOpenPositionsFromTradeIntents extracts active EXECUTED BUY positions and excludes closed SELL positions', () => {
    const positions = deriveOpenPositionsFromTradeIntents([
      // BTCUSDT: older BUY, newer SELL -> CLOSED
      { symbol: 'BTCUSDT', side: 'BUY', quantity: 0.01, price: 60000, status: 'EXECUTED', createdAt: '2026-11-20T00:00:00Z' },
      { symbol: 'BTCUSDT', side: 'SELL', quantity: 0.01, price: 66000, status: 'EXECUTED', createdAt: '2026-11-21T00:00:00Z' },
      // ETHUSDT: latest EXECUTED is BUY -> OPEN
      { symbol: 'ETHUSDT', side: 'BUY', quantity: 0.5, price: 3000, status: 'EXECUTED', createdAt: '2026-11-22T00:00:00Z' },
      // SOLUSDT: only REJECTED -> NOT OPEN
      { symbol: 'SOLUSDT', side: 'BUY', quantity: 2, price: 150, status: 'REJECTED', createdAt: '2026-11-22T01:00:00Z' },
    ]);

    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual({
      symbol: 'ETHUSDT',
      entryPrice: 3000,
      currentPrice: 3000,
      quantity: 0.5,
    });
  });

  it('[BV1.3] fetchAutoPilot24hTickers parses Binance 24hr ticker payload and all 3 strategy presets pass TRADER validation', async () => {
    const mockFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({ lastPrice: '3300.5', priceChangePercent: '6.2', quoteVolume: '95000000' }),
        { status: 200 }
      )) as typeof fetch;

    const tickers = await fetchAutoPilot24hTickers(['ETHUSDT'], mockFetch);
    expect(tickers.ETHUSDT?.lastPrice).toBe(3300.5);
    expect(tickers.ETHUSDT?.priceChangePct24h).toBe(6.2);

    expect(AUTOPILOT_STRATEGY_PRESETS).toHaveLength(3);
    for (const preset of AUTOPILOT_STRATEGY_PRESETS) {
      const validated = validateAndClampAutoPilotConfig(
        {
          enabled: true,
          rail: 'CEX_AUTO',
          maxOrderUsd: preset.maxOrderUsd,
          takeProfitPct: preset.takeProfitPct,
          stopLossPct: preset.stopLossPct,
          minConfidenceScore: preset.minConfidenceScore,
          allowedSymbols: preset.allowedSymbols,
        },
        'TRADER'
      );
      expect(validated.config.allowedSymbols.length).toBeGreaterThanOrEqual(2);
    }
  });
});
