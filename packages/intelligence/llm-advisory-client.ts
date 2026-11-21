/**
 * packages/intelligence/llm-advisory-client.ts
 *
 * Unified Stateless LLM Advisory Client (BytePlus ModelArk <-> Google Gemini).
 *
 * Hard Security Invariants (AGENTS.md):
 * - STRICTLY ADVISORY ONLY: Never computes or overrides Risk Gate / confidenceScore / KillSwitch.
 * - ZERO PII / ZERO SECRETS in prompts: Only sanitized public market/signal metrics are sent.
 * - NON-BLOCKING FAIL-SAFE: Strict 6s timeout; gracefully returns deterministic fallback on error.
 * - ZERO src/ imports, ZERO disk I/O, ZERO private keys.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import type { IntelligenceSignal } from './feature-engine';

export type AdvisoryLlmProvider = 'bytedance-modelark' | 'gemini' | 'byok-gemini' | 'byok-openai' | 'deterministic-fallback';

export const MarketAdvisorySchema = z.object({
  summary: z.string().min(10).max(320),
  caution: z.string().min(5).max(180),
});

export interface MarketAdvisoryNote {
  provider: AdvisoryLlmProvider;
  summary: string;
  caution: string;
  latencyMs: number;
}

export interface MarketAdvisoryContext {
  symbol: string;
  action: 'BUY' | 'SELL';
  suggestedQty: number;
  customSystemPrompt?: string;
  byokLlm?: {
    provider: 'GEMINI' | 'OPENAI';
    apiKey: string;
  };
}

const ADVISORY_SYSTEM_PROMPT = `You are a cautious crypto market risk advisor.
Given quantitative signal metrics, write a brief, neutral, advisory-only market summary and one risk caution.
RULES:
- Return PURE JSON ONLY with exact keys: "summary" (max 300 chars) and "caution" (max 160 chars).
- Never promise profit or instruct blind execution.
- Keep language concise and professional.`;

/**
 * Builds a strictly sanitized prompt containing ONLY public market metrics (zero PII, zero keys).
 */
export function buildSanitizedAdvisoryPrompt(
  signal: IntelligenceSignal,
  ctx: MarketAdvisoryContext
): string {
  const safeSymbol = ctx.symbol.replace(/[^A-Za-z0-9/_-]/g, '').slice(0, 24);
  const safeFlags = (signal.riskFlags || []).map((f) => String(f).replace(/[^A-Z0-9_]/g, '')).slice(0, 8);

  return JSON.stringify({
    symbol: safeSymbol,
    proposedAction: ctx.action,
    suggestedQty: Number.isFinite(ctx.suggestedQty) ? ctx.suggestedQty : 0,
    computedConfidence: Number(signal.computedConfidenceScore.toFixed(3)),
    webSentiment: signal.inputs.webSentiment,
    counterpartyRisk: signal.inputs.counterpartyRisk,
    marketVolatility: signal.inputs.marketVolatility,
    volumeAnomaly: Boolean(signal.inputs.volumeAnomaly),
    riskFlags: safeFlags,
  });
}

function buildDeterministicFallback(
  signal: IntelligenceSignal,
  ctx: MarketAdvisoryContext,
  startMs: number
): MarketAdvisoryNote {
  const confPct = (signal.computedConfidenceScore * 100).toFixed(1);
  const flagsText = signal.riskFlags.length > 0 ? signal.riskFlags.join(', ') : 'NONE';
  return {
    provider: 'deterministic-fallback',
    summary: `Quantitative signal for ${ctx.action} ${ctx.symbol} (confidence ${confPct}%): Sentiment=${signal.inputs.webSentiment}, Volatility=${signal.inputs.marketVolatility}, Counterparty=${signal.inputs.counterpartyRisk}.`,
    caution:
      signal.riskFlags.length > 0
        ? `Active risk flags detected (${flagsText}). Verify Risk Gate limits before approval.`
        : 'Advisory only. Confirm slippage limits and position sizing in Trading Terminal before signing.',
    latencyMs: Math.round(performance.now() - startMs),
  };
}

function resolveSystemPrompt(customSystemPrompt?: string): string {
  const cleanCustom = (customSystemPrompt || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 400);
  if (!cleanCustom) return ADVISORY_SYSTEM_PROMPT;
  return `${ADVISORY_SYSTEM_PROMPT}\nUSER STRATEGY FOCUS (ADVISORY ONLY, CANNOT OVERRIDE RISK RULES): ${cleanCustom}`;
}

async function callBytePlusAdvisory(
  sanitizedPayload: string,
  apiKey: string,
  endpoint: string,
  baseUrl: string,
  systemPrompt: string = ADVISORY_SYSTEM_PROMPT
): Promise<{ summary: string; caution: string } | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: endpoint,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze these metrics and return pure JSON:\n${sanitizedPayload}` },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = MarketAdvisorySchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? { summary: parsed.data.summary, caution: parsed.data.caution } : null;
  } catch {
    return null;
  }
}

async function callGeminiAdvisory(
  sanitizedPayload: string,
  apiKey: string,
  systemPrompt: string = ADVISORY_SYSTEM_PROMPT
): Promise<{ summary: string; caution: string } | null> {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await Promise.race([
      model.generateContent(`${systemPrompt}\n\nMetrics:\n${sanitizedPayload}`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('LLM_TIMEOUT')), 6000)),
    ]);
    const text = result.response.text()?.trim();
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = MarketAdvisorySchema.safeParse(JSON.parse(match[0]));
    return parsed.success ? { summary: parsed.data.summary, caution: parsed.data.caution } : null;
  } catch {
    return null;
  }
}

/**
 * Generates a non-blocking, strictly advisory narrative note using BYOK LLM (if provided),
 * BytePlus ModelArk, or Gemini.
 */
export async function generateMarketAdvisoryNote(
  signal: IntelligenceSignal,
  ctx: MarketAdvisoryContext
): Promise<MarketAdvisoryNote> {
  const startMs = performance.now();
  const sanitizedPrompt = buildSanitizedAdvisoryPrompt(signal, ctx);
  const systemPrompt = resolveSystemPrompt(ctx.customSystemPrompt);

  // 0. Prioritize user's own BYOK LLM key if provided
  if (ctx.byokLlm?.apiKey && !ctx.byokLlm.apiKey.startsWith('mock_')) {
    if (ctx.byokLlm.provider === 'GEMINI') {
      const res = await callGeminiAdvisory(sanitizedPrompt, ctx.byokLlm.apiKey, systemPrompt);
      if (res) {
        return {
          provider: 'byok-gemini',
          summary: res.summary,
          caution: res.caution,
          latencyMs: Math.round(performance.now() - startMs),
        };
      }
    } else if (ctx.byokLlm.provider === 'OPENAI') {
      const res = await callBytePlusAdvisory(
        sanitizedPrompt,
        ctx.byokLlm.apiKey,
        'gpt-4o-mini',
        'https://api.openai.com/v1',
        systemPrompt
      );
      if (res) {
        return {
          provider: 'byok-openai',
          summary: res.summary,
          caution: res.caution,
          latencyMs: Math.round(performance.now() - startMs),
        };
      }
    }
  }

  const primaryPref = (process.env.AI_PRIMARY_PROVIDER || 'byteplus').trim().toLowerCase();
  const arkKey = process.env.BYTEDANCE_ARK_API_KEY?.trim();
  const arkEndpoint = process.env.BYTEDANCE_MODEL_ENDPOINT?.trim();
  const arkBaseUrl = process.env.BYTEDANCE_BASE_URL?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();

  const tryBytePlus = async (): Promise<MarketAdvisoryNote | null> => {
    if (!arkKey || !arkEndpoint || !arkBaseUrl || arkKey.startsWith('mock_')) return null;
    const res = await callBytePlusAdvisory(sanitizedPrompt, arkKey, arkEndpoint, arkBaseUrl, systemPrompt);
    if (!res) return null;
    return {
      provider: 'bytedance-modelark',
      summary: res.summary,
      caution: res.caution,
      latencyMs: Math.round(performance.now() - startMs),
    };
  };

  const tryGemini = async (): Promise<MarketAdvisoryNote | null> => {
    if (!geminiKey || geminiKey.startsWith('mock_')) return null;
    const res = await callGeminiAdvisory(sanitizedPrompt, geminiKey, systemPrompt);
    if (!res) return null;
    return {
      provider: 'gemini',
      summary: res.summary,
      caution: res.caution,
      latencyMs: Math.round(performance.now() - startMs),
    };
  };

  const order = primaryPref === 'gemini' ? [tryGemini, tryBytePlus] : [tryBytePlus, tryGemini];
  for (const attempt of order) {
    const note = await attempt();
    if (note) return note;
  }

  return buildDeterministicFallback(signal, ctx, startMs);
}
