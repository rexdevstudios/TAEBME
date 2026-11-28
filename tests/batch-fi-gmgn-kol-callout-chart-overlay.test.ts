import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCandleChartMarkers,
  sanitizeSafeSocialUrl,
  validateKolCalloutInput,
} from '../packages/intelligence/kol-chart-overlay';

const ROOT = path.resolve(import.meta.dir, '..');

describe('Phase FI: GMGN-Style Verified KOL Tweet/Callout Chart Overlay & Hover Card', () => {
  test('sanitizeSafeSocialUrl & validateKolCalloutInput strictly allow X/Twitter/Warpcast HTTPS URLs and reject unsafe protocols', () => {
    expect(sanitizeSafeSocialUrl('https://x.com/hydra21/status/123456')).toBe('https://x.com/hydra21/status/123456');
    expect(sanitizeSafeSocialUrl('https://warpcast.com/alpha/0xabc')).toBe('https://warpcast.com/alpha/0xabc');
    expect(sanitizeSafeSocialUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeSafeSocialUrl('http://x.com/hydra21/status/1')).toBeUndefined();
    expect(sanitizeSafeSocialUrl('https://evil.example.com/phish')).toBeUndefined();

    const ok = validateKolCalloutInput({
      quoteText: 'Strong accumulation on Base bonding curve, liquidity climbing.',
      tweetUrl: 'https://x.com/hydra21/status/999',
      side: 'BUY',
      symbol: 'HSET',
      tokenAddress: '0x2c94879c2b482d1838ccce3cd00ffd96a82fbcb8',
      chain: 'robinhood',
      price: 0.0000937,
    });
    expect(ok.ok).toBe(true);
    expect(ok.sanitized?.tweetUrl).toBe('https://x.com/hydra21/status/999');
    expect(ok.sanitized?.side).toBe('BUY');

    const badShort = validateKolCalloutInput({ quoteText: 'hi', symbol: 'HSET' });
    expect(badShort.ok).toBe(false);
    expect(badShort.error).toContain('INVALID_QUOTE');

    const badUrl = validateKolCalloutInput({
      quoteText: 'Legit length quote here',
      tweetUrl: 'https://phishing.site/steal',
      symbol: 'HSET',
    });
    expect(badUrl.ok).toBe(false);
    expect(badUrl.error).toContain('INVALID_TWEET_URL');
  });

  test('buildCandleChartMarkers preserves kolHandle, quoteText, tweetUrl, and source on KOL markers', () => {
    const now = Date.now();
    const candles = [
      { timestamp: now - 3600_000, open: 0.001, high: 0.0012, low: 0.0009, close: 0.0011 },
      { timestamp: now, open: 0.0011, high: 0.0014, low: 0.001, close: 0.0013 },
    ];
    const markers = buildCandleChartMarkers({
      candles,
      kolEntries: [
        {
          walletAddress: '0x1111111111111111111111111111111111111111',
          handle: '@hydra21',
          trustScore: 90,
          hasSocialProof: true,
          source: 'SOCIAL_TWEET',
          side: 'BUY',
          price: 0.0011,
          timestampMs: now - 3600_000,
          quoteText: 'hoodset? more like hood rich set',
          tweetUrl: 'https://x.com/hydra21/status/123',
        },
      ],
      aiAction: 'BULLISH',
    });

    const kolPin = markers.find((m) => m.kind === 'KOL_BUY');
    expect(kolPin).toBeDefined();
    expect(kolPin!.kolHandle).toBe('@hydra21');
    expect(kolPin!.quoteText).toBe('hoodset? more like hood rich set');
    expect(kolPin!.tweetUrl).toBe('https://x.com/hydra21/status/123');
    expect(kolPin!.source).toBe('SOCIAL_TWEET');
  });

  test('wires 3-source SSOT loader, /api/kol/callout fail-closed gate, and dual-chart KolMarkerHoverCard', () => {
    const overlaySrc = fs.readFileSync(path.join(ROOT, 'packages/intelligence/kol-chart-overlay.ts'), 'utf8');
    const chartApiSrc = fs.readFileSync(path.join(ROOT, 'app/api/market/chart/route.ts'), 'utf8');
    const calloutApiSrc = fs.readFileSync(path.join(ROOT, 'app/api/kol/callout/route.ts'), 'utf8');
    const hoverCardSrc = fs.readFileSync(path.join(ROOT, 'app/components/KolMarkerHoverCard.tsx'), 'utf8');
    const tokenChartSrc = fs.readFileSync(path.join(ROOT, 'app/components/TokenMarketChartPanel.tsx'), 'utf8');
    const candleChartSrc = fs.readFileSync(path.join(ROOT, 'app/components/InteractiveCandlestickChart.tsx'), 'utf8');
    const tradingSrc = fs.readFileSync(path.join(ROOT, 'app/trading/page.tsx'), 'utf8');

    expect(overlaySrc).toContain('FROM bounty_claims bc');
    expect(overlaySrc).toContain("WHERE domain = 'kol_callout'");
    expect(chartApiSrc).toContain('tokenAddress || undefined');
    expect(calloutApiSrc).toContain('KOL_VERIFICATION_REQUIRED');
    expect(calloutApiSrc).toContain('CALLOUT_COOLDOWN_24H');
    expect(calloutApiSrc).toContain("VALUES ($1::uuid, $2, 'kol_callout'");
    expect(hoverCardSrc).toContain('View Tweet');
    expect(hoverCardSrc).toContain('KOL VERIFIED');
    expect(tokenChartSrc).toContain('Post KOL Callout');
    expect(tokenChartSrc).toContain('markers={chartMarkers}');
    expect(candleChartSrc).toContain('KolMarkerHoverCard');
    expect(tradingSrc).toContain('KolMarkerHoverCard');
  });
});
