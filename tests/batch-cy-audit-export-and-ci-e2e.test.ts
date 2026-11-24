/**
 * tests/batch-cy-audit-export-and-ci-e2e.test.ts
 *
 * Phase CX & CY Verification Suite:
 *  - Verifies formula-injection-safe CSV audit export for Platform Transparency
 *  - Verifies structured JSON audit bundle schema for Platform Transparency
 *  - Verifies GitHub Actions daily workflow runs both verify:live:all and verify:testnet:e2e
 */

import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import {
  serializeTransparencyReportToCsv,
  serializeTransparencyReportToJson,
  type TransparencyAuditExportPayload,
} from '../packages/shared/transparency-metrics';

const SAMPLE_REPORT: TransparencyAuditExportPayload = {
  network: 'Base Mainnet',
  generatedAt: '2026-11-24T10:00:00.000Z',
  fees: {
    totalEstimatedVolumeUsd: 39501,
    curveFeeUsd: 395.01,
    dexPartnerFeeUsd: 12.5,
    totalEstimatedFeesUsd: 407.51,
    creatorShareUsd: 197.51,
    protocolShareUsd: 210,
    creatorSharePct: 48.5,
    protocolSharePct: 51.5,
    curveFeePctOfTotal: 96.9,
    dexFeePctOfTotal: 3.1,
  },
  monthly: [
    {
      monthKey: '2026-11',
      monthLabel: 'Nov 2026',
      tradeVolumeUsd: 39501,
      estimatedFeesUsd: 407.51,
      creatorShareUsd: 197.51,
      protocolShareUsd: 210,
      launchesCount: 4,
      creditsBurned: 240,
    },
  ],
  recentLaunches: [
    {
      name: '=CMD|calc',
      ticker: 'EVIL',
      chain: 'base-mainnet',
      contractAddress: '0x1111111111111111111111111111111111111111',
      raisedUsd: 12500,
      status: 'ACTIVE',
      explorerUrl: 'https://basescan.org/address/0x1111111111111111111111111111111111111111',
    },
  ],
};

describe('Phase CX & CY: Audit Export Serializers & Daily Testnet E2E CI Wiring', () => {
  test('[CY1.1] serializeTransparencyReportToCsv neutralizes CSV formula injection and includes explorer proofs', () => {
    const csv = serializeTransparencyReportToCsv(SAMPLE_REPORT);
    expect(csv).toContain('"MONTHLY_FEES","Nov 2026","Base Mainnet","39501.00","407.51"');
    expect(csv).toContain(`"'=CMD|calc ($EVIL)"`);
    expect(csv).toContain('https://basescan.org/address/0x1111111111111111111111111111111111111111');
  });

  test('[CY1.2] serializeTransparencyReportToJson emits valid poolnet.audit.transparency.v1 bundle', () => {
    const raw = serializeTransparencyReportToJson(SAMPLE_REPORT);
    const parsed = JSON.parse(raw);
    expect(parsed.schemaVersion).toBe('poolnet.audit.transparency.v1');
    expect(parsed.network).toBe('Base Mainnet');
    expect(parsed.monthly.length).toBe(1);
    expect(parsed.recentLaunches.length).toBe(1);
  });

  test('[CX1.1] daily-dual-blackbox.yml schedules both verify:live:all and verify:testnet:e2e', () => {
    const wf = fs.readFileSync(
      path.resolve(process.cwd(), '.github/workflows/daily-dual-blackbox.yml'),
      'utf8'
    );
    expect(wf).toContain('bun run verify:live:all');
    expect(wf).toContain('bun run verify:testnet:e2e');
  });
});
