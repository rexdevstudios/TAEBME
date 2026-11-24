/**
 * Unit Suite #87 — Phase DT:
 * Hardened /api/market/chart (Strict Symbol/Interval Regex + 10s Edge Cache) + Top-12 Real Liquid Pairs.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import {
  TOP_LIQUID_CEX_PAIRS,
  isValidChartInterval,
  isValidMarketSymbol,
} from '../packages/shared/market-pairs';
import { GET as getMarketChart } from '../app/api/market/chart/route';

describe('Phase DT — Market Chart Security Hardening & Top-12 Liquid Pairs', () => {
  test('isValidMarketSymbol and isValidChartInterval strictly reject injection / pollution payloads', () => {
    expect(TOP_LIQUID_CEX_PAIRS.length).toBe(12);
    expect(TOP_LIQUID_CEX_PAIRS.some((p) => p.symbol === 'BASEUSDT')).toBe(false);
    expect(TOP_LIQUID_CEX_PAIRS.some((p) => p.symbol === 'BNBUSDT')).toBe(true);

    expect(isValidMarketSymbol('BTCUSDT')).toBe(true);
    expect(isValidMarketSymbol('WIFUSDT')).toBe(true);
    expect(isValidMarketSymbol('PUMPRUN/WETH')).toBe(true);

    expect(isValidMarketSymbol('BTCUSDT&limit=9999')).toBe(false);
    expect(isValidMarketSymbol('../etc/passwd')).toBe(false);
    expect(isValidMarketSymbol('<script>alert(1)</script>')).toBe(false);
    expect(isValidMarketSymbol('A')).toBe(false);

    expect(isValidChartInterval('1h')).toBe(true);
    expect(isValidChartInterval('1m;drop')).toBe(false);
  });

  test('GET /api/market/chart rejects invalid symbol and invalid interval with HTTP 400', async () => {
    const badSymReq = new NextRequest('https://pndigi.site/api/market/chart?symbol=BTCUSDT%26limit=9999&interval=1h');
    const badSymRes = await getMarketChart(badSymReq);
    expect(badSymRes.status).toBe(400);

    const badIntReq = new NextRequest('https://pndigi.site/api/market/chart?symbol=BTCUSDT&interval=99x');
    const badIntRes = await getMarketChart(badIntReq);
    expect(badIntRes.status).toBe(400);

    const root = join(import.meta.dir, '..');
    const routeSrc = readFileSync(join(root, 'app/api/market/chart/route.ts'), 'utf8');
    expect(routeSrc).toContain('s-maxage=10');
  });
});
