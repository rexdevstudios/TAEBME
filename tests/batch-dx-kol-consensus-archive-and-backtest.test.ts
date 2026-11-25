/**
 * tests/batch-dx-kol-consensus-archive-and-backtest.test.ts
 *
 * Unit Suite #91 — Phase DX:
 *  - Deterministic KOL Consensus Win-Rate Backtest Evaluator (BULLISH win, BEARISH win, loss, neutral/zero-price ignored)
 *  - Cron route fail-closed CRON_SECRET auth & dryRun wiring
 *  - middleware.ts & vercel.json registration parity
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  KOL_CONSENSUS_ARCHIVE_DOMAIN,
  buildCuratedKolDatasetSnapshot,
  evaluateKolConsensusBacktest,
  type KolConsensusArchiveEntry,
  type KolConsensusReport,
} from '../packages/intelligence/kol-chart-overlay';

describe('Phase DX: Scheduled KOL Consensus Archive Cron & Win-Rate Backtest', () => {
  test('evaluateKolConsensusBacktest computes objective win-rate and directional return', () => {
    const reports: KolConsensusReport[] = [
      {
        tokenSymbol: 'BTCUSDT',
        score: 82,
        uniqueVerifiedKols: 2,
        skinInTheGameCount: 2,
        buySignals: 2,
        sellSignals: 0,
        flags: [],
        verdict: 'STRONG_BULLISH',
      },
      {
        tokenSymbol: 'ETHUSDT',
        score: 25,
        uniqueVerifiedKols: 1,
        skinInTheGameCount: 1,
        buySignals: 0,
        sellSignals: 1,
        flags: [],
        verdict: 'BEARISH',
      },
      {
        tokenSymbol: 'SOLUSDT',
        score: 70,
        uniqueVerifiedKols: 1,
        skinInTheGameCount: 1,
        buySignals: 1,
        sellSignals: 0,
        flags: [],
        verdict: 'BULLISH',
      },
      {
        tokenSymbol: 'BNBUSDT',
        score: 50,
        uniqueVerifiedKols: 0,
        skinInTheGameCount: 0,
        buySignals: 0,
        sellSignals: 0,
        flags: ['NO_VERIFIED_KOL_SIGNALS_24H'],
        verdict: 'NEUTRAL',
      },
    ];

    const archive: KolConsensusArchiveEntry = {
      archivedAt: '2026-11-24T00:00:00.000Z',
      snapshot: buildCuratedKolDatasetSnapshot({ reports, generatedAt: '2026-11-24T00:00:00.000Z' }),
      spotPrices: {
        BTCUSDT: 100000, // +10% -> WIN
        ETHUSDT: 4000,   // -5% (BEARISH) -> +5% directional -> WIN
        SOLUSDT: 200,    // -3% (BULLISH) -> -3% directional -> LOSS
        BNBUSDT: 600,    // NEUTRAL / 0 KOLs -> IGNORED
      },
    };

    const result = evaluateKolConsensusBacktest({
      archives: [archive],
      currentSpotPrices: {
        BTCUSDT: 110000,
        ETHUSDT: 3800,
        SOLUSDT: 194,
        BNBUSDT: 700,
      },
    });

    expect(result.totalArchives).toBe(1);
    expect(result.evaluatedSignals).toBe(3);
    expect(result.wins).toBe(2);
    expect(result.losses).toBe(1);
    expect(result.winRatePct).toBe(66.7);
    // (10 + 5 - 3) / 3 = +4.00%
    expect(result.avgDirectionalReturnPct).toBe(4);
  });

  test('evaluateKolConsensusBacktest ignores missing or non-positive prices safely', () => {
    const reports: KolConsensusReport[] = [
      {
        tokenSymbol: 'PEPEUSDT',
        score: 80,
        uniqueVerifiedKols: 2,
        skinInTheGameCount: 1,
        buySignals: 2,
        sellSignals: 0,
        flags: [],
        verdict: 'STRONG_BULLISH',
      },
    ];
    const archive: KolConsensusArchiveEntry = {
      archivedAt: '2026-11-24T00:00:00.000Z',
      snapshot: buildCuratedKolDatasetSnapshot({ reports }),
      spotPrices: { PEPEUSDT: 0 },
    };
    const res = evaluateKolConsensusBacktest({
      archives: [archive],
      currentSpotPrices: { PEPEUSDT: 0.00002 },
    });
    expect(res.evaluatedSignals).toBe(0);
    expect(res.winRatePct).toBe(0);
  });

  test('Cron route, middleware.ts, and vercel.json are consistently registered', () => {
    const cronRoute = readFileSync(
      join(process.cwd(), 'app/api/cron/kol-consensus-archive/route.ts'),
      'utf8'
    );
    const middleware = readFileSync(join(process.cwd(), 'middleware.ts'), 'utf8');
    const vercelJson = JSON.parse(readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'));

    expect(cronRoute).toContain('CRON_SECRET');
    expect(cronRoute).toContain('KOL_CONSENSUS_ARCHIVE_DOMAIN');
    expect(cronRoute).toContain('scraped_documents');
    expect(KOL_CONSENSUS_ARCHIVE_DOMAIN).toBe('kol_consensus_archive');

    expect(middleware).toContain("'/api/cron/kol-consensus-archive'");
    const cronEntry = (vercelJson.crons || []).find(
      (c: { path: string }) => c.path === '/api/cron/kol-consensus-archive'
    );
    expect(cronEntry).toBeDefined();
    expect(cronEntry.schedule).toBe('0 0 * * *');
  });
});
