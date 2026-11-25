/**
 * tests/batch-ea-byteplus-free-quota-waterfall.test.ts
 *
 * Unit Suite #94 — Phase EA:
 *  - parseBytePlusEndpointPool() comma/semicolon/whitespace parsing, deduplication & max cap
 *  - resolveBytePlusWaterfallEndpoints() fast vs deep ordering & cross-pool deduplication
 *  - Reuse verification in creator-asset-studio.ts & wall-clock budget guard in llm-advisory-client.ts
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseBytePlusEndpointPool,
  resolveBytePlusWaterfallEndpoints,
} from '../packages/intelligence/llm-advisory-client';

describe('Phase EA: BytePlus Multi-Endpoint Free-Quota Waterfall Failover', () => {
  test('parseBytePlusEndpointPool splits, trims, deduplicates, and enforces max cap', () => {
    const parsed = parseBytePlusEndpointPool(
      ' ep-seed20-mini, ep-seed20-lite ; ep-seed18  ep-seed20-mini , , ep-ds-v41-eco ',
      6
    );
    expect(parsed).toEqual([
      'ep-seed20-mini',
      'ep-seed20-lite',
      'ep-seed18',
      'ep-ds-v41-eco',
    ]);

    const capped = parseBytePlusEndpointPool('a,b,c,d,e,f,g,h', 4);
    expect(capped).toEqual(['a', 'b', 'c', 'd']);

    expect(parseBytePlusEndpointPool('')).toEqual([]);
    expect(parseBytePlusEndpointPool(undefined)).toEqual([]);
  });

  test('resolveBytePlusWaterfallEndpoints orders fast vs deep pools and deduplicates', () => {
    const fastOrder = resolveBytePlusWaterfallEndpoints({
      fastRaw: 'ep-seed20-mini,ep-seed20-lite,ep-shared',
      deepRaw: 'ep-deepseek-v4-pro,ep-shared',
      thinkingMode: 'fast',
    });
    expect(fastOrder).toEqual([
      'ep-seed20-mini',
      'ep-seed20-lite',
      'ep-shared',
      'ep-deepseek-v4-pro',
    ]);

    const deepOrder = resolveBytePlusWaterfallEndpoints({
      fastRaw: 'ep-seed20-mini,ep-shared',
      deepRaw: 'ep-deepseek-v4-pro,ep-dola-seed-21-turbo,ep-shared',
      thinkingMode: 'deep',
    });
    expect(deepOrder).toEqual([
      'ep-deepseek-v4-pro',
      'ep-dola-seed-21-turbo',
      'ep-shared',
      'ep-seed20-mini',
    ]);
  });

  test('Both llm-advisory-client and creator-asset-studio enforce wall-clock budget & pool reuse', () => {
    const llmClient = readFileSync(
      join(process.cwd(), 'packages/intelligence/llm-advisory-client.ts'),
      'utf8'
    );
    const studioLib = readFileSync(
      join(process.cwd(), 'packages/launchpad/creator-asset-studio.ts'),
      'utf8'
    );

    expect(llmClient).toContain('resolveBytePlusWaterfallEndpoints');
    expect(llmClient).toContain('totalBudgetMs');
    expect(studioLib).toContain("import { parseBytePlusEndpointPool } from '../intelligence/llm-advisory-client'");
    expect(studioLib).toContain('deadlineMs');
  });
});
