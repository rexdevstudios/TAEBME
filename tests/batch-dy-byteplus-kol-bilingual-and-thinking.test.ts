/**
 * tests/batch-dy-byteplus-kol-bilingual-and-thinking.test.ts
 *
 * Unit Suite #92 — Phase DY:
 *  - Sanitized kolConsensus injection into LLM advisory prompt (zero PII/handles/wallets)
 *  - Bilingual Indonesian (ID) vs English (EN) system prompt directive
 *  - BytePlus ModelArk strict json_schema + thinking toggle isolation (never leaked to BYOK OpenAI)
 *  - API & UI wiring checks for proposals/intelligence, desk/run, and FiveAgentDeskPanel
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildBytePlusRequestPayload,
  buildSanitizedAdvisoryPrompt,
  resolveSystemPrompt,
} from '../packages/intelligence/llm-advisory-client';
import type { IntelligenceSignal } from '../packages/intelligence/feature-engine';

const SAMPLE_SIGNAL: IntelligenceSignal = {
  symbol: 'BTCUSDT',
  computedConfidenceScore: 0.78,
  inputs: {
    webSentiment: 'POSITIVE',
    counterpartyRisk: 'LOW',
    marketVolatility: 'MEDIUM',
    volumeAnomaly: false,
  },
  riskFlags: [],
  timestamp: new Date().toISOString(),
};

describe('Phase DY: BytePlus ModelArk KOL-Aware Bilingual Advisory & Deep Thinking', () => {
  test('buildSanitizedAdvisoryPrompt injects sanitized kolConsensus without PII', () => {
    const raw = buildSanitizedAdvisoryPrompt(SAMPLE_SIGNAL, {
      symbol: 'BTCUSDT',
      action: 'BUY',
      suggestedQty: 150,
      kolConsensus: {
        score: 84,
        verdict: 'STRONG_BULLISH; DROP TABLE',
        uniqueVerifiedKols: 3,
        skinInTheGameCount: 2,
        flags: ['COORDINATED_SHILL_DAMPENED', 'bad<script>'],
      },
    });
    const parsed = JSON.parse(raw);
    expect(parsed.kolConsensus).toBeDefined();
    expect(parsed.kolConsensus.score).toBe(84);
    expect(parsed.kolConsensus.uniqueVerifiedKols).toBe(3);
    expect(parsed.kolConsensus.skinInTheGameCount).toBe(2);
    // Unsafe characters stripped from verdict and flags
    expect(parsed.kolConsensus.verdict).toBe('STRONG_BULLISHDROPTABLE');
    expect(parsed.kolConsensus.flags).toContain('COORDINATED_SHILL_DAMPENED');
    expect(raw).not.toContain('<script>');
  });

  test('resolveSystemPrompt appends Indonesian directive only for locale=id', () => {
    const enPrompt = resolveSystemPrompt(undefined, 'en');
    const idPrompt = resolveSystemPrompt(undefined, 'id');
    expect(enPrompt).not.toContain('Bahasa Indonesia');
    expect(idPrompt).toContain('Bahasa Indonesia');
  });

  test('buildBytePlusRequestPayload isolates BytePlus thinking & json_schema from BYOK OpenAI', () => {
    const bpFast = buildBytePlusRequestPayload({
      endpoint: 'ep-seed-18-fast',
      systemPrompt: 'sys',
      sanitizedPayload: '{}',
      useBytePlusFeatures: true,
      thinkingMode: 'fast',
    });
    expect((bpFast.thinking as any)?.type).toBe('disabled');
    expect((bpFast.response_format as any)?.type).toBe('json_schema');

    const bpDeep = buildBytePlusRequestPayload({
      endpoint: 'ep-deepseek-r1',
      systemPrompt: 'sys',
      sanitizedPayload: '{}',
      useBytePlusFeatures: true,
      thinkingMode: 'deep',
    });
    expect((bpDeep.thinking as any)?.type).toBe('enabled');
    expect((bpDeep.response_format as any)?.type).toBe('json_schema');

    const openaiByok = buildBytePlusRequestPayload({
      endpoint: 'gpt-4o-mini',
      systemPrompt: 'sys',
      sanitizedPayload: '{}',
      useBytePlusFeatures: false,
      thinkingMode: 'deep',
    });
    expect(openaiByok.thinking).toBeUndefined();
    expect((openaiByok.response_format as any)?.type).toBe('json_object');
  });

  test('Proposals, Desk API, and FiveAgentDeskPanel wire kolConsensus, locale, and thinkingMode', () => {
    const propRoute = readFileSync(
      join(process.cwd(), 'app/api/agent/proposals/intelligence/route.ts'),
      'utf8'
    );
    const deskRoute = readFileSync(join(process.cwd(), 'app/api/agent/desk/run/route.ts'), 'utf8');
    const deskPanel = readFileSync(
      join(process.cwd(), 'app/components/FiveAgentDeskPanel.tsx'),
      'utf8'
    );

    expect(propRoute).toContain('kolConsensus');
    expect(propRoute).toContain('thinkingMode');
    expect(deskRoute).toContain('loadVerifiedKolSignalsForSymbol');
    expect(deskRoute).toContain('thinkingMode');
    expect(deskPanel).toContain('thinkingMode');
    expect(deskPanel).toContain('reasoningSummary');
  });
});
