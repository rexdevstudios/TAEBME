import { describe, expect, it } from 'bun:test';
import {
  computeFeeSplitBreakdown,
  buildMonthlyTransparencyRows,
  formatMonthKeyLabel,
} from '../packages/shared/transparency-metrics';

describe('Phase CN: Public Platform Transparency & Fee Split Analytics', () => {
  it('CN1.1 computes exact 1% bonding curve split (50% Creator / 50% Protocol) + 25bps DEX partner fee', () => {
    const split = computeFeeSplitBreakdown({
      totalTradeVolumeUsd: 100_000, // 25 bps = $250 protocol DEX fee
      totalCurveRaisedEth: 10, // 10 * $3000 = $30,000 -> 1% = $300 ($150 creator / $150 protocol)
      ethPriceUsd: 3000,
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

  it('CN1.2 formats month keys and sorts monthly rows newest-first (capped at 6 months)', () => {
    expect(formatMonthKeyLabel('2026-11')).toBe('Nov 2026');
    const rows = buildMonthlyTransparencyRows([
      { monthKey: '2026-09', tradeVolumeUsd: 1000, curveRaisedEth: 1, launchesCount: 2, creditsBurned: 100 },
      { monthKey: '2026-11', tradeVolumeUsd: 5000, curveRaisedEth: 2, launchesCount: 4, creditsBurned: 250 },
      { monthKey: '2026-10', tradeVolumeUsd: 2000, curveRaisedEth: 0.5, launchesCount: 1, creditsBurned: 50 },
    ]);

    expect(rows.length).toBe(3);
    expect(rows[0].monthKey).toBe('2026-11');
    expect(rows[0].monthLabel).toBe('Nov 2026');
    expect(rows[1].monthKey).toBe('2026-10');
    expect(rows[2].monthKey).toBe('2026-09');
  });

  it('CN1.3 safely handles zero/NaN/negative inputs without producing NaN', () => {
    const split = computeFeeSplitBreakdown({
      totalTradeVolumeUsd: Number.NaN,
      totalCurveRaisedEth: -5,
    });
    expect(split.totalEstimatedVolumeUsd).toBe(0);
    expect(split.totalEstimatedFeesUsd).toBe(0);
    expect(split.creatorShareUsd).toBe(0);
    expect(split.protocolShareUsd).toBe(0);
  });
});
