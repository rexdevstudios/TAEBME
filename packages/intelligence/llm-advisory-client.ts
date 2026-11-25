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

export type ByokLlmProvider = 'GEMINI' | 'OPENAI' | 'ANTHROPIC';

export type AdvisoryLlmProvider =
  | 'bytedance-modelark'
  | 'gemini'
  | 'byok-gemini'
  | 'byok-openai'
  | 'byok-anthropic'
  | 'deterministic-fallback';

export interface ByokModelOption {
  id: string;
  label: string;
  tier: 'fast' | 'balanced' | 'deep';
  recommended?: boolean;
  timeoutMs: number;
}

export const BYOK_LLM_MODELS: Record<ByokLlmProvider, readonly ByokModelOption[]> = {
  GEMINI: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Cepat · Rekomendasi)', tier: 'fast', recommended: true, timeoutMs: 6000 },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Deep Analysis)', tier: 'deep', timeoutMs: 9000 },
  ],
  OPENAI: [
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini (Cepat · Rekomendasi)', tier: 'fast', recommended: true, timeoutMs: 6000 },
    { id: 'gpt-4o', label: 'GPT-4o (Deep Analysis)', tier: 'deep', timeoutMs: 9000 },
  ],
  ANTHROPIC: [
    { id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet (Seimbang · Rekomendasi)', tier: 'balanced', recommended: true, timeoutMs: 7000 },
    { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku (Ultra-Cepat)', tier: 'fast', timeoutMs: 6000 },
    { id: 'claude-opus-4-20250514', label: 'Claude Opus 4 (Deep · Latensi & Biaya Tinggi)', tier: 'deep', timeoutMs: 9000 },
  ],
};

export function resolveByokLlmModel(provider: ByokLlmProvider, requestedModel?: string): ByokModelOption {
  const catalog = BYOK_LLM_MODELS[provider];
  const clean = (requestedModel || '').trim();
  if (clean) {
    const matched = catalog.find((m) => m.id === clean);
    if (matched) return matched;
  }
  return catalog.find((m) => m.recommended) || catalog[0];
}

export const MarketAdvisorySchema = z.object({
  summary: z.string().min(10).max(320),
  caution: z.string().min(5).max(180),
});

export type AdvisoryLocale = 'en' | 'id';
export type AdvisoryThinkingMode = 'fast' | 'deep';

export interface KolConsensusPromptSummary {
  score: number;
  verdict: string;
  uniqueVerifiedKols: number;
  skinInTheGameCount: number;
  flags?: string[];
}

export interface MarketAdvisoryNote {
  provider: AdvisoryLlmProvider;
  model?: string;
  summary: string;
  caution: string;
  reasoningSummary?: string;
  thinkingMode?: AdvisoryThinkingMode;
  latencyMs: number;
}

export interface MarketAdvisoryContext {
  symbol: string;
  action: 'BUY' | 'SELL';
  suggestedQty: number;
  customSystemPrompt?: string;
  locale?: AdvisoryLocale;
  thinkingMode?: AdvisoryThinkingMode;
  kolConsensus?: KolConsensusPromptSummary | null;
  byokLlm?: {
    provider: ByokLlmProvider;
    apiKey: string;
    model?: string;
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

  const payload: Record<string, unknown> = {
    symbol: safeSymbol,
    proposedAction: ctx.action,
    suggestedQty: Number.isFinite(ctx.suggestedQty) ? ctx.suggestedQty : 0,
    computedConfidence: Number(signal.computedConfidenceScore.toFixed(3)),
    webSentiment: signal.inputs.webSentiment,
    counterpartyRisk: signal.inputs.counterpartyRisk,
    marketVolatility: signal.inputs.marketVolatility,
    volumeAnomaly: Boolean(signal.inputs.volumeAnomaly),
    riskFlags: safeFlags,
  };

  if (ctx.kolConsensus) {
    const safeKolVerdict = String(ctx.kolConsensus.verdict || 'NEUTRAL')
      .replace(/[^A-Z0-9_]/g, '')
      .slice(0, 24);
    const safeKolFlags = (ctx.kolConsensus.flags || [])
      .map((f) => String(f).replace(/[^A-Z0-9_]/g, ''))
      .filter(Boolean)
      .slice(0, 6);
    payload.kolConsensus = {
      score: Math.max(0, Math.min(100, Math.round(Number(ctx.kolConsensus.score ?? 50)))),
      verdict: safeKolVerdict || 'NEUTRAL',
      uniqueVerifiedKols: Math.max(0, Math.floor(Number(ctx.kolConsensus.uniqueVerifiedKols ?? 0))),
      skinInTheGameCount: Math.max(0, Math.floor(Number(ctx.kolConsensus.skinInTheGameCount ?? 0))),
      flags: safeKolFlags,
    };
  }

  return JSON.stringify(payload);
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
    model: 'quantitative-rules-v1',
    summary: `Quantitative signal for ${ctx.action} ${ctx.symbol} (confidence ${confPct}%): Sentiment=${signal.inputs.webSentiment}, Volatility=${signal.inputs.marketVolatility}, Counterparty=${signal.inputs.counterpartyRisk}.`,
    caution:
      signal.riskFlags.length > 0
        ? `Active risk flags detected (${flagsText}). Verify Risk Gate limits before approval.`
        : 'Advisory only. Confirm slippage limits and position sizing in Trading Terminal before signing.',
    latencyMs: Math.round(performance.now() - startMs),
  };
}

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(all\s+|previous\s+|prior\s+)*instructions?/gi,
  /override\s+(the\s+)?risk\s*gate/gi,
  /bypass\s+(the\s+)?kill\s*switch/gi,
  /disregard\s+(all\s+)?safety\s+rules?/gi,
];

/**
 * Lean Context & Prompt-Injection Sanitizer (Phase AN):
 * - Strips ASCII control characters (`\x00-\x1F`, `\x7F`), normalizes whitespace.
 * - Neutralizes common risk-gate / instruction override phrases.
 * - Enforces a strict character budget (`50..1200`, default `400`) to prevent prompt bloat.
 */
export function sanitizeCustomSystemPrompt(raw?: string, maxChars: number = 400): string {
  const budget = Math.max(50, Math.min(1200, Math.floor(Number(maxChars) || 400)));
  let clean = (raw || '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    clean = clean.replace(pattern, '[REDACTED_POLICY_GUARD]');
  }
  return clean.replace(/\s+/g, ' ').trim().slice(0, budget);
}

export function resolveSystemPrompt(customSystemPrompt?: string, locale: AdvisoryLocale = 'en'): string {
  const langDirective =
    locale === 'id'
      ? '\nOUTPUT LANGUAGE: Write both "summary" and "caution" in concise, professional Indonesian (Bahasa Indonesia).'
      : '';
  const cleanCustom = sanitizeCustomSystemPrompt(customSystemPrompt, 400);
  if (!cleanCustom) return `${ADVISORY_SYSTEM_PROMPT}${langDirective}`;
  return `${ADVISORY_SYSTEM_PROMPT}${langDirective}\nUSER STRATEGY FOCUS (ADVISORY ONLY, CANNOT OVERRIDE RISK RULES): ${cleanCustom}`;
}

export const MARKET_ADVISORY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    caution: { type: 'string' },
  },
  required: ['summary', 'caution'],
} as const;

export function buildBytePlusRequestPayload(params: {
  endpoint: string;
  systemPrompt: string;
  sanitizedPayload: string;
  useBytePlusFeatures: boolean;
  thinkingMode?: AdvisoryThinkingMode;
  useStrictJsonSchema?: boolean;
}): Record<string, unknown> {
  const mode: AdvisoryThinkingMode = params.thinkingMode === 'deep' ? 'deep' : 'fast';
  const useStrict = params.useBytePlusFeatures && params.useStrictJsonSchema !== false;

  const body: Record<string, unknown> = {
    model: params.endpoint,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: `Analyze these metrics and return pure JSON:\n${params.sanitizedPayload}` },
    ],
    temperature: 0.3,
    response_format: useStrict
      ? {
          type: 'json_schema',
          json_schema: {
            name: 'market_advisory',
            strict: true,
            schema: MARKET_ADVISORY_JSON_SCHEMA,
          },
        }
      : { type: 'json_object' },
  };

  if (params.useBytePlusFeatures) {
    body.thinking = { type: mode === 'deep' ? 'enabled' : 'disabled' };
  }

  return body;
}

async function callBytePlusAdvisory(
  sanitizedPayload: string,
  apiKey: string,
  endpoint: string,
  baseUrl: string,
  systemPrompt: string = ADVISORY_SYSTEM_PROMPT,
  timeoutMs: number = 6000,
  options?: { useBytePlusFeatures?: boolean; thinkingMode?: AdvisoryThinkingMode }
): Promise<{ summary: string; caution: string; reasoningSummary?: string } | null> {
  const useBytePlusFeatures = Boolean(options?.useBytePlusFeatures);
  const thinkingMode: AdvisoryThinkingMode = options?.thinkingMode === 'deep' ? 'deep' : 'fast';
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const attemptCall = async (useStrictJsonSchema: boolean): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(
        buildBytePlusRequestPayload({
          endpoint,
          systemPrompt,
          sanitizedPayload,
          useBytePlusFeatures,
          thinkingMode,
          useStrictJsonSchema,
        })
      ),
      signal: AbortSignal.timeout(timeoutMs),
    });

  try {
    let res = await attemptCall(useBytePlusFeatures);
    // Automatic graceful fallback to json_object if a legacy endpoint rejects json_schema (HTTP 400)
    if (!res.ok && res.status === 400 && useBytePlusFeatures) {
      res = await attemptCall(false);
    }

    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const msg = data?.choices?.[0]?.message;
    const raw = msg?.content?.trim();
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = MarketAdvisorySchema.safeParse(JSON.parse(match[0]));
    if (!parsed.success) return null;

    const rawReasoning =
      thinkingMode === 'deep' && typeof msg?.reasoning_content === 'string'
        ? msg.reasoning_content.replace(/\s+/g, ' ').trim().slice(0, 280)
        : undefined;

    return {
      summary: parsed.data.summary,
      caution: parsed.data.caution,
      ...(rawReasoning ? { reasoningSummary: rawReasoning } : {}),
    };
  } catch {
    return null;
  }
}

async function callAnthropicAdvisory(
  sanitizedPayload: string,
  apiKey: string,
  modelId: string,
  systemPrompt: string = ADVISORY_SYSTEM_PROMPT,
  timeoutMs: number = 7000
): Promise<{ summary: string; caution: string } | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 300,
        temperature: 0.3,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Analyze these metrics and return pure JSON only:\n${sanitizedPayload}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    const raw = data?.content?.find((b) => b.type === 'text' && typeof b.text === 'string')?.text?.trim();
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
  systemPrompt: string = ADVISORY_SYSTEM_PROMPT,
  modelId: string = 'gemini-2.5-flash',
  timeoutMs: number = 6000
): Promise<{ summary: string; caution: string } | null> {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelId });
    const result = await Promise.race([
      model.generateContent(`${systemPrompt}\n\nMetrics:\n${sanitizedPayload}`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('LLM_TIMEOUT')), timeoutMs)),
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

export function parseBytePlusEndpointPool(raw?: string | null, maxEndpoints: number = 6): string[] {
  if (!raw || typeof raw !== 'string') return [];
  const cap = Math.max(1, Math.min(12, Math.floor(Number(maxEndpoints) || 6)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[,;\s]+/)) {
    const clean = token.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= cap) break;
  }
  return out;
}

export function resolveBytePlusWaterfallEndpoints(params: {
  fastRaw?: string | null;
  deepRaw?: string | null;
  thinkingMode?: AdvisoryThinkingMode;
  maxTotal?: number;
}): string[] {
  const fastList = parseBytePlusEndpointPool(params.fastRaw, 6);
  const deepList = parseBytePlusEndpointPool(params.deepRaw, 6);
  const ordered = params.thinkingMode === 'deep' ? [...deepList, ...fastList] : [...fastList, ...deepList];
  const maxTotal = Math.max(1, Math.min(12, Math.floor(Number(params.maxTotal) || 8)));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ep of ordered) {
    if (seen.has(ep)) continue;
    seen.add(ep);
    out.push(ep);
    if (out.length >= maxTotal) break;
  }
  return out;
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
  const locale: AdvisoryLocale = ctx.locale === 'id' ? 'id' : 'en';
  const thinkingMode: AdvisoryThinkingMode = ctx.thinkingMode === 'deep' ? 'deep' : 'fast';
  const sanitizedPrompt = buildSanitizedAdvisoryPrompt(signal, ctx);
  const systemPrompt = resolveSystemPrompt(ctx.customSystemPrompt, locale);

  // 0. Prioritize user's own BYOK LLM key if provided (TRADER & AGENT exclusive — gated at API layer)
  if (ctx.byokLlm?.apiKey && !ctx.byokLlm.apiKey.startsWith('mock_')) {
    const chosenModel = resolveByokLlmModel(ctx.byokLlm.provider, ctx.byokLlm.model);
    if (ctx.byokLlm.provider === 'GEMINI') {
      const res = await callGeminiAdvisory(
        sanitizedPrompt,
        ctx.byokLlm.apiKey,
        systemPrompt,
        chosenModel.id,
        chosenModel.timeoutMs
      );
      if (res) {
        return {
          provider: 'byok-gemini',
          model: chosenModel.id,
          summary: res.summary,
          caution: res.caution,
          latencyMs: Math.round(performance.now() - startMs),
        };
      }
    } else if (ctx.byokLlm.provider === 'OPENAI') {
      const res = await callBytePlusAdvisory(
        sanitizedPrompt,
        ctx.byokLlm.apiKey,
        chosenModel.id,
        'https://api.openai.com/v1',
        systemPrompt,
        chosenModel.timeoutMs
      );
      if (res) {
        return {
          provider: 'byok-openai',
          model: chosenModel.id,
          summary: res.summary,
          caution: res.caution,
          latencyMs: Math.round(performance.now() - startMs),
        };
      }
    } else if (ctx.byokLlm.provider === 'ANTHROPIC') {
      const res = await callAnthropicAdvisory(
        sanitizedPrompt,
        ctx.byokLlm.apiKey,
        chosenModel.id,
        systemPrompt,
        chosenModel.timeoutMs
      );
      if (res) {
        return {
          provider: 'byok-anthropic',
          model: chosenModel.id,
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
  const arkDeepEndpoint = process.env.BYTEDANCE_DEEP_ENDPOINT?.trim();
  const arkBaseUrl = process.env.BYTEDANCE_BASE_URL?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();

  const tryBytePlus = async (): Promise<MarketAdvisoryNote | null> => {
    if (!arkKey || !arkBaseUrl || arkKey.startsWith('mock_')) return null;
    const uniqueEndpoints = resolveBytePlusWaterfallEndpoints({
      fastRaw: arkEndpoint,
      deepRaw: arkDeepEndpoint,
      thinkingMode,
      maxTotal: 8,
    });
    if (uniqueEndpoints.length === 0) return null;

    const perCallTimeoutMs = thinkingMode === 'deep' ? 9000 : 6000;
    const totalBudgetMs = thinkingMode === 'deep' ? 12000 : 8500;
    const deadlineMs = performance.now() + totalBudgetMs;

    for (const ep of uniqueEndpoints) {
      const remainingMs = Math.floor(deadlineMs - performance.now());
      if (remainingMs < 1200) break;
      const res = await callBytePlusAdvisory(
        sanitizedPrompt,
        arkKey,
        ep,
        arkBaseUrl,
        systemPrompt,
        Math.min(perCallTimeoutMs, remainingMs),
        {
          useBytePlusFeatures: true,
          thinkingMode,
        }
      );
      if (res) {
        return {
          provider: 'bytedance-modelark',
          model: ep,
          summary: res.summary,
          caution: res.caution,
          ...(res.reasoningSummary ? { reasoningSummary: res.reasoningSummary } : {}),
          thinkingMode,
          latencyMs: Math.round(performance.now() - startMs),
        };
      }
    }
    return null;
  };

  const tryGemini = async (): Promise<MarketAdvisoryNote | null> => {
    if (!geminiKey || geminiKey.startsWith('mock_')) return null;
    const res = await callGeminiAdvisory(sanitizedPrompt, geminiKey, systemPrompt);
    if (!res) return null;
    return {
      provider: 'gemini',
      model: 'gemini-2.5-flash',
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

export interface ByokLlmVerifyResult {
  connected: boolean;
  provider: ByokLlmProvider;
  statusCode?: number;
  latencyMs: number;
  error?: string;
}

/**
 * Stateless, zero-token live connectivity verifier for BYOK LLM API keys (GEMINI, OPENAI, ANTHROPIC).
 * Uses read-only model listing endpoints so users incur $0 token cost during verification.
 * NEVER echoes raw API keys or query-string secrets in responses or errors.
 */
export async function verifyByokLlmKeyLive(params: {
  provider: ByokLlmProvider;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<ByokLlmVerifyResult> {
  const startMs = performance.now();
  const doFetch = params.fetchImpl || fetch;
  const cleanKey = (params.apiKey || '').trim();
  if (!cleanKey || cleanKey.startsWith('mock_')) {
    return {
      connected: false,
      provider: params.provider,
      latencyMs: Math.round(performance.now() - startMs),
      error: 'INVALID_OR_MOCK_API_KEY',
    };
  }

  let url = '';
  let headers: Record<string, string> = {};
  if (params.provider === 'GEMINI') {
    url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cleanKey)}&pageSize=1`;
  } else if (params.provider === 'OPENAI') {
    url = 'https://api.openai.com/v1/models';
    headers = { Authorization: `Bearer ${cleanKey}` };
  } else if (params.provider === 'ANTHROPIC') {
    url = 'https://api.anthropic.com/v1/models';
    headers = {
      'x-api-key': cleanKey,
      'anthropic-version': '2023-06-01',
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Math.round(performance.now() - startMs);
    if (res.ok) {
      return {
        connected: true,
        provider: params.provider,
        statusCode: res.status,
        latencyMs,
      };
    }

    const reason =
      res.status === 401 || res.status === 403
        ? `AUTH_REJECTED_HTTP_${res.status}`
        : `PROVIDER_HTTP_${res.status}`;
    return {
      connected: false,
      provider: params.provider,
      statusCode: res.status,
      latencyMs,
      error: reason,
    };
  } catch (err: any) {
    return {
      connected: false,
      provider: params.provider,
      latencyMs: Math.round(performance.now() - startMs),
      error: err?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
    };
  }
}
