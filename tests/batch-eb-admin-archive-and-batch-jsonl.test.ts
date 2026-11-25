/**
 * tests/batch-eb-admin-archive-and-batch-jsonl.test.ts
 *
 * Unit Suite #95 — Phase EB:
 *  - BytePlus ModelArk Batch Inference JSONL serializer (valid NDJSON, zero PII, /api/v3/chat/completions)
 *  - Shared captureAndArchiveKolConsensusSnapshot() reuse across Cron & Admin POST
 *  - Admin UI Archive Now & Batch JSONL controls
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildCuratedKolDatasetSnapshot,
  computeAntiManipulationKolConsensus,
  serializeKolConsensusDatasetToBatchJsonl,
} from '../packages/intelligence/kol-chart-overlay';

describe('Phase EB: Admin 1-Click Snapshot Archiver & BytePlus Batch Inference JSONL', () => {
  test('serializeKolConsensusDatasetToBatchJsonl emits valid BytePlus Batch NDJSON lines', () => {
    const now = Date.now();
    const btc = computeAntiManipulationKolConsensus({
      tokenSymbol: 'BTCUSDT',
      nowMs: now,
      signals: [
        {
          walletAddress: '0x1111111111111111111111111111111111111111',
          handle: '@secret_kol_handle',
          trustScore: 90,
          hasSocialProof: true,
          source: 'ONCHAIN_ENTRY',
          side: 'BUY',
          price: 95000,
          timestampMs: now - 30_000,
        },
      ],
    });
    const eth = computeAntiManipulationKolConsensus({
      tokenSymbol: 'ETHUSDT',
      nowMs: now,
      signals: [],
    });

    const snapshot = buildCuratedKolDatasetSnapshot({
      reports: [btc, eth],
      generatedAt: '2026-11-25T16:50:00.000Z',
    });

    const jsonl = serializeKolConsensusDatasetToBatchJsonl(snapshot, 'ep-dola-seed-20-mini');
    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]);
    expect(first.custom_id).toContain('kol-eval-BTCUSDT-');
    expect(first.method).toBe('POST');
    expect(first.url).toBe('/api/v3/chat/completions');
    expect(first.body.model).toBe('ep-dola-seed-20-mini');
    expect(first.body.response_format).toEqual({ type: 'json_object' });
    expect(Array.isArray(first.body.messages)).toBe(true);

    // Zero PII / zero wallet address / zero personal handle in batch eval JSONL
    expect(jsonl).not.toContain('0x1111111111111111111111111111111111111111');
    expect(jsonl).not.toContain('@secret_kol_handle');
  });

  test('Cron & Admin dataset routes share captureAndArchiveKolConsensusSnapshot and UI exposes Archive Now + Batch JSONL', () => {
    const cronRoute = readFileSync(
      join(process.cwd(), 'app/api/cron/kol-consensus-archive/route.ts'),
      'utf8'
    );
    const adminDatasetRoute = readFileSync(
      join(process.cwd(), 'app/api/admin/kol-dataset/route.ts'),
      'utf8'
    );
    const adminPanel = readFileSync(
      join(process.cwd(), 'app/components/AdminKolVerificationPanel.tsx'),
      'utf8'
    );

    expect(cronRoute).toContain('captureAndArchiveKolConsensusSnapshot');
    expect(adminDatasetRoute).toContain('captureAndArchiveKolConsensusSnapshot');
    expect(adminDatasetRoute).toContain('serializeKolConsensusDatasetToBatchJsonl');
    expect(adminDatasetRoute).toContain('ADMIN_KOL_DATASET_ARCHIVED');
    expect(adminPanel).toContain('handleArchiveNow');
    expect(adminPanel).toContain("handleDownloadDataset('jsonl')");
  });
});
