/**
 * Unit Suite #88 — Phase DU:
 * GMGN-Style Verified KOL Chart Overlay (KB/KS & AI Markers) + Anti-Manipulation AI Consensus Engine.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCandleChartMarkers,
  computeAntiManipulationKolConsensus,
  isVerifiedKol,
  type KolSignalInput,
} from '../packages/intelligence/kol-chart-overlay';

describe('Phase DU — GMGN Verified KOL Chart Overlay & Anti-Manipulation Consensus', () => {
  test('isVerifiedKol enforces social proof and trustScore >= 65', () => {
    expect(isVerifiedKol({ walletAddress: '0x1111111111111111111111111111111111111111', trustScore: 90 }).verified).toBe(false);
    expect(isVerifiedKol({ walletAddress: '0x1111111111111111111111111111111111111111', twitterHandle: 'whale', trustScore: 50 }).verified).toBe(false);

    const gold = isVerifiedKol({ walletAddress: '0x1111111111111111111111111111111111111111', twitterHandle: '@alpha_kol', trustScore: 88 });
    expect(gold.verified).toBe(true);
    expect(gold.tier).toBe('GOLD');
    expect(gold.handle).toBe('@alpha_kol');
  });

  test('computeAntiManipulationKolConsensus enforces 1-vote dedup, skin-in-the-game 2x, shill dampening, and GoPlus honeypot veto', () => {
    const now = Date.now();
    // 1. GoPlus Honeypot Hard-Veto overrides even strong KOL consensus
    const veto = computeAntiManipulationKolConsensus({
      tokenSymbol: 'SCAM',
      isHoneypot: true,
      signals: [
        { walletAddress: '0x1', handle: '@kol1', trustScore: 95, hasSocialProof: true, source: 'ONCHAIN_ENTRY', side: 'BUY', timestampMs: now },
      ],
      nowMs: now,
    });
    expect(veto.score).toBe(0);
    expect(veto.verdict).toBe('VETOED_HONEYPOT');
    expect(veto.flags).toContain('GOPLUS_HONEYPOT_VETO');

    // 2. 1-Vote-Per-KOL Dedup (same wallet spamming 3 tweets + 1 entry counts as 1 unique KOL)
    const dedup = computeAntiManipulationKolConsensus({
      tokenSymbol: 'BTCUSDT',
      signals: [
        { walletAddress: '0xAAA', handle: '@spammer', trustScore: 90, hasSocialProof: true, source: 'SOCIAL_TWEET', side: 'BUY', timestampMs: now },
        { walletAddress: '0xaaa', handle: '@spammer', trustScore: 90, hasSocialProof: true, source: 'ONCHAIN_ENTRY', side: 'BUY', timestampMs: now },
        { walletAddress: '0xAAA', handle: '@spammer', trustScore: 90, hasSocialProof: true, source: 'SOCIAL_TWEET', side: 'BUY', timestampMs: now },
      ],
      nowMs: now,
    });
    expect(dedup.uniqueVerifiedKols).toBe(1);
    expect(dedup.skinInTheGameCount).toBe(1);
    expect(dedup.score).toBe(80); // 50 + (1.5 * 2.0 * 10)

    // 3. Coordinated Shill Dampening (3 silver tweet-only without skin-in-the-game)
    const shillSignals: KolSignalInput[] = [
      { walletAddress: '0x1', handle: '@s1', trustScore: 70, hasSocialProof: true, source: 'SOCIAL_TWEET', side: 'BUY', timestampMs: now },
      { walletAddress: '0x2', handle: '@s2', trustScore: 70, hasSocialProof: true, source: 'SOCIAL_TWEET', side: 'BUY', timestampMs: now },
      { walletAddress: '0x3', handle: '@s3', trustScore: 70, hasSocialProof: true, source: 'SOCIAL_TWEET', side: 'BUY', timestampMs: now },
    ];
    const dampened = computeAntiManipulationKolConsensus({ tokenSymbol: 'SHILL', signals: shillSignals, nowMs: now });
    expect(dampened.flags).toContain('COORDINATED_SHILL_DAMPENED');
    expect(dampened.score).toBe(65); // 50 + (3 * 0.5 * 10) instead of 80
  });

  test('buildCandleChartMarkers maps KOL KB/KS and AI pins onto exact candles and wires into /trading & /api/market/chart', () => {
    const now = Date.now();
    const candles = [
      { timestamp: now - 7200_000, open: 100, high: 105, low: 98, close: 102 },
      { timestamp: now - 3600_000, open: 102, high: 104, low: 95, close: 96 },
      { timestamp: now, open: 96, high: 110, low: 96, close: 108 },
    ];
    const markers = buildCandleChartMarkers({
      candles,
      kolEntries: [
        { walletAddress: '0x1', handle: '@alpha', trustScore: 90, hasSocialProof: true, source: 'ONCHAIN_ENTRY', side: 'BUY', price: 96, timestampMs: now - 3600_000 },
      ],
      aiAction: 'BULLISH',
    });
    expect(markers.some((m) => m.kind === 'KOL_BUY' && m.badge === 'KB' && m.candleIndex === 1)).toBe(true);
    expect(markers.some((m) => m.kind === 'AI_BUY' && m.badge === 'AI')).toBe(true);

    const root = join(import.meta.dir, '..');
    const chartRoute = readFileSync(join(root, 'app/api/market/chart/route.ts'), 'utf8');
    expect(chartRoute).toContain('buildCandleChartMarkers');
    expect(chartRoute).toContain('computeAntiManipulationKolConsensus');

    const tradingPage = readFileSync(join(root, 'app/trading/page.tsx'), 'utf8');
    expect(tradingPage).toContain('KOL Verified (KB/KS)');
  });
});
