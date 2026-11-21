import { describe, it, expect } from 'bun:test';
import {
  BYOK_LLM_MODELS,
  resolveByokLlmModel,
  generateMarketAdvisoryNote,
} from '../packages/intelligence/llm-advisory-client';
import { SubscriptionsEngine, annotateKeysWithQuotaStatus } from '../packages/billing/subscriptions-engine';
import { ProviderRegistry } from '../packages/providers/registry';

describe('Phase AA: BYOK LLM Exclusive Tier Gating (TRADER & AGENT) + Anthropic Claude & Model Selector', () => {
  it('[AA1.1] PlanCapacities restricts BYOK LLM exclusively to TRADER (3) and AGENT (5), locking FREE & CREATOR to 0', () => {
    expect(SubscriptionsEngine.getPlanCapacities('FREE').maxLlmKeys).toBe(0);
    expect(SubscriptionsEngine.getPlanCapacities('CREATOR').maxLlmKeys).toBe(0);
    expect(SubscriptionsEngine.getPlanCapacities('TRADER').maxLlmKeys).toBe(3);
    expect(SubscriptionsEngine.getPlanCapacities('AGENT').maxLlmKeys).toBe(5);
  });

  it('[AA1.2] Soft-Freeze preserves existing BYOK keys as FROZEN_OVER_QUOTA when user downgrades to FREE/CREATOR', () => {
    const existingKeys = [
      { id: 'k1', isDefault: true, createdAt: '2026-11-20T00:00:00Z' },
      { id: 'k2', isDefault: false, createdAt: '2026-11-21T00:00:00Z' },
    ];
    const annotatedFree = annotateKeysWithQuotaStatus(existingKeys, {
      maxActive: SubscriptionsEngine.getPlanCapacities('FREE').maxLlmKeys,
    });
    expect(annotatedFree.every((k) => k.quotaStatus === 'FROZEN_OVER_QUOTA')).toBe(true);

    const annotatedTrader = annotateKeysWithQuotaStatus(existingKeys, {
      maxActive: SubscriptionsEngine.getPlanCapacities('TRADER').maxLlmKeys,
    });
    expect(annotatedTrader.every((k) => k.quotaStatus === 'ACTIVE')).toBe(true);
  });

  it('[AA2.1] resolveByokLlmModel defaults to fast/balanced models and falls back safely on unknown model IDs', () => {
    expect(resolveByokLlmModel('GEMINI').id).toBe('gemini-2.5-flash');
    expect(resolveByokLlmModel('OPENAI').id).toBe('gpt-4o-mini');
    expect(resolveByokLlmModel('ANTHROPIC').id).toBe('claude-3-5-sonnet-latest');

    // Explicit whitelisted deep/fast options work
    expect(resolveByokLlmModel('ANTHROPIC', 'claude-opus-4-20250514').id).toBe('claude-opus-4-20250514');
    expect(resolveByokLlmModel('ANTHROPIC', 'claude-3-5-haiku-latest').id).toBe('claude-3-5-haiku-latest');
    expect(resolveByokLlmModel('GEMINI', 'gemini-2.5-pro').id).toBe('gemini-2.5-pro');
    expect(resolveByokLlmModel('OPENAI', 'gpt-4o').id).toBe('gpt-4o');

    // Unknown or injected model string falls back safely to recommended default
    expect(resolveByokLlmModel('ANTHROPIC', 'evil-unlisted-model').id).toBe('claude-3-5-sonnet-latest');
    expect(BYOK_LLM_MODELS.ANTHROPIC.length).toBe(3);
  });

  it('[AA2.2] ProviderRegistry lists ANTHROPIC as LIVE with TRADER & AGENT exclusive guard', () => {
    const anthropic = ProviderRegistry.getById('ANTHROPIC');
    expect(anthropic).not.toBeNull();
    expect(anthropic?.category).toBe('LLM');
    expect(anthropic?.status).toBe('LIVE');
    expect(anthropic?.supportsByok).toBe(true);
    expect(anthropic?.nonCustodialGuard).toContain('TRADER & AGENT');
  });

  it('[AA2.3] generateMarketAdvisoryNote calls Anthropic Messages API with x-api-key and whitelisted model', async () => {
    const origFetch = globalThis.fetch;
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                summary: 'BTCUSDT shows healthy momentum with low counterparty risk on current volume.',
                caution: 'Verify slippage cap and daily risk limit before manual execution.',
              }),
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      const note = await generateMarketAdvisoryNote(
        {
          symbol: 'BTCUSDT',
          computedConfidenceScore: 0.82,
          rationale: 'Strong breakout',
          riskFlags: [],
          inputs: {
            webSentiment: 'BULLISH',
            counterpartyRisk: 'LOW',
            marketVolatility: 'NORMAL',
            volumeAnomaly: false,
          },
          computedAt: new Date().toISOString(),
        },
        {
          symbol: 'BTCUSDT',
          action: 'BUY',
          suggestedQty: 0.25,
          byokLlm: {
            provider: 'ANTHROPIC',
            apiKey: 'sk-ant-test-1234567890abcdef',
            model: 'claude-3-5-sonnet-latest',
          },
        }
      );

      expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
      expect(capturedHeaders['x-api-key']).toBe('sk-ant-test-1234567890abcdef');
      expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
      expect(capturedBody?.model).toBe('claude-3-5-sonnet-latest');
      expect(note.provider).toBe('byok-anthropic');
      expect(note.model).toBe('claude-3-5-sonnet-latest');
      expect(note.summary).toContain('BTCUSDT');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
