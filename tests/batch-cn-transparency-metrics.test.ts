import { describe, expect, it } from 'bun:test';
import {
  computeFeeSplitBreakdown,
  buildMonthlyTransparencyRows,
  formatMonthKeyLabel,
  normalizeWeiOrHumanTokens,
  formatCompactNumber,
} from '../packages/shared/transparency-metrics';

describe('Phase CN/CP: Public Platform Transparency & Fee Split Analytics', () => {
  it('CN1.1 computes exact 1% bonding curve USD split (50% Creator / 50% Protocol) + 25bps DEX partner fee', () => {
    const split = computeFeeSplitBreakdown({
      totalTradeVolumeUsd: 100_000, // 25 bps = $250 protocol DEX fee
      totalCurveRaisedUsd: 30_000, // 1% = $300 ($150 creator / $150 protocol)
      dexSwapFeeBps: 25,
    });

    expect(split.totalEstimatedVolumeUsd).toBe(130_000);
    expect(split.curveFeeUsd).toBe(300);
    expect(split.dexPartnerFeeUsd).toBe(250);
    expect(split.totalEstimatedFeesUsd).toBe(550);
    expect(split.creatorShareUsd).toBe(150);
    expect(split.protocolShareUsd).toBe(400);
    expect(split.creatorSharePct + split.protocolSharePct).toBe(100);
  });

  it('CN1.2 normalizes 18-decimal wei bounty allocations & formats compact numbers cleanly', () => {
    expect(normalizeWeiOrHumanTokens(4.46e24)).toBe(4_460_000);
    expect(normalizeWeiOrHumanTokens(12500)).toBe(12500);
    expect(formatCompactNumber(4_460_000)).toBe('4.46M');
    expect(formatCompactNumber(12_500)).toBe('12.50K');
  });

  it('CN1.3 formats month keys and sorts monthly rows newest-first', () => {
    expect(formatMonthKeyLabel('2026-11')).toBe('Nov 2026');
    const rows = buildMonthlyTransparencyRows([
      { monthKey: '2026-09', tradeVolumeUsd: 1000, curveRaisedUsd: 27501, launchesCount: 2, creditsBurned: 100 },
      { monthKey: '2026-11', tradeVolumeUsd: 5000, curveRaisedUsd: 10000, launchesCount: 4, creditsBurned: 250 },
      { monthKey: '2026-10', tradeVolumeUsd: 2000, curveRaisedUsd: 5000, launchesCount: 1, creditsBurned: 50 },
    ]);

    expect(rows.length).toBe(3);
    expect(rows[0].monthKey).toBe('2026-11');
    expect(rows[0].monthLabel).toBe('Nov 2026');
    expect(rows[2].estimatedFeesUsd).toBe(277.51); // 275.01 curve + 2.50 DEX
  });

  it('CN1.4 safely handles zero/NaN/negative inputs without producing NaN', () => {
    const split = computeFeeSplitBreakdown({
      totalTradeVolumeUsd: Number.NaN,
      totalCurveRaisedUsd: -5,
    });
    expect(split.totalEstimatedVolumeUsd).toBe(0);
    expect(split.totalEstimatedFeesUsd).toBe(0);
    expect(split.creatorShareUsd).toBe(0);
    expect(split.protocolShareUsd).toBe(0);
  });
});
