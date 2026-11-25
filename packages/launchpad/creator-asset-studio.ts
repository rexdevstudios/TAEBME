/**
 * packages/launchpad/creator-asset-studio.ts
 *
 * Stateless, Vercel-compatible Creator Asset Studio lifted from legacy src/ modules
 * (gemini-brain, pollinations-gen, pinata-uploader).
 *
 * Invariants (AGENTS.md):
 * - Zero src/ imports, zero disk I/O (fs), zero private keys.
 * - Pure request-response execution suitable for Vercel Serverless Functions.
 * - Graceful deterministic fallbacks when optional AI/IPFS env vars are absent.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

export const TokenIdentitySchema = z.object({
  name: z
    .string()
    .min(2)
    .max(30)
    .regex(/^[a-zA-Z0-9 ]+$/, 'Name must contain only letters, numbers, and spaces'),
  ticker: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z0-9]+$/, 'Ticker must contain only uppercase letters and numbers'),
  description: z.string().min(10).max(280),
  viralScore: z.number().int().min(1).max(100),
  imagePrompt: z.string().min(10).max(500),
  website: z.string().url(),
  twitter: z.string().url(),
  telegram: z.string().url(),
});

export type TokenIdentity = z.infer<typeof TokenIdentitySchema>;

export interface GenerateIdentityResult {
  identity: TokenIdentity;
  provider: 'gemini' | 'bytedance-modelark' | 'deterministic-fallback';
}

export type LogoImageProvider = 'bytedance-seedream' | 'pollinations' | 'deterministic-fallback';

export interface IpfsUploadResult {
  imageUrl: string;
  metadataUrl: string | null;
  uploadedToIpfs: boolean;
}

const POLLINATIONS_BASE_URL = 'https://image.pollinations.ai/prompt';
const PINATA_BASE = 'https://api.pinata.cloud';

// Valid 64x64 PNG buffer fallback when external image provider is unavailable
export const FALLBACK_LOGO_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAPUlEQVR42u3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOwa8AABb0qZ2wAAAABJRU5ErkJggg==',
  'base64'
);

const SYSTEM_PROMPT = `You are a crypto trend analyst and token launch identity designer.
Analyze the supplied narrative or trend prompt and formulate a concise, high-clarity token identity.

CRITICAL RULES:
- All fields MUST be in English.
- ticker: uppercase alphanumeric only, 2-10 chars, no spaces.
- name: alphanumeric + spaces only, 2-30 chars.
- description: concise, witty summary, 10-280 chars.
- viralScore: integer 1-100.
- imagePrompt: vivid logo prompt, 10-500 chars.
- website, twitter, telegram: valid complete HTTPS URLs (never use personal handles).
- Return PURE JSON ONLY with keys: name, ticker, description, viralScore, imagePrompt, website, twitter, telegram.`;

export function sanitizeIdentityRaw(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {};
  const raw = { ...(obj as Record<string, unknown>) };
  if (typeof raw.name === 'string') {
    raw.name = raw.name.replace(/[^a-zA-Z0-9 ]/g, '').trim().slice(0, 30);
  }
  if (typeof raw.ticker === 'string') {
    raw.ticker = raw.ticker.replace(/[^a-zA-Z0-9]/g, '').trim().toUpperCase().slice(0, 10);
  }
  if (typeof raw.description === 'string') {
    raw.description = raw.description.trim().slice(0, 280);
  }
  if (typeof raw.imagePrompt === 'string') {
    raw.imagePrompt = raw.imagePrompt.trim().slice(0, 500);
  }
  return raw;
}

export function applyIdentityPrivacyShield(identity: TokenIdentity): TokenIdentity {
  const cleanTicker = identity.ticker.replace(/[^A-Z0-9]/g, '').toUpperCase() || 'TOKEN';
  const slug =
    identity.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || cleanTicker.toLowerCase();

  const overridden = { ...identity };
  const isPersonalOrPlaceholder = (url: string) => /abdul|rochim|personal|myaccount/i.test(url);

  if (!overridden.website || overridden.website.includes('test') || isPersonalOrPlaceholder(overridden.website)) {
    overridden.website = `https://pndigi.site/launchpad?token=${slug}`;
  }
  if (!overridden.twitter || overridden.twitter.includes('random') || isPersonalOrPlaceholder(overridden.twitter)) {
    overridden.twitter = `https://x.com/${`${cleanTicker}_coin`.slice(0, 15)}`;
  }
  if (!overridden.telegram || overridden.telegram.includes('random') || isPersonalOrPlaceholder(overridden.telegram)) {
    overridden.telegram = `https://t.me/${cleanTicker.toLowerCase()}_portal`;
  }
  return overridden;
}

export function buildDeterministicFallbackIdentity(trendPrompt: string): TokenIdentity {
  const words = trendPrompt
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 3);

  const rawName = (words.length > 0 ? words.join(' ') : 'Base Alpha').slice(0, 30);
  const name = rawName.length >= 2 ? rawName : 'Base Alpha';
  const rawTicker = words
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  const ticker = (rawTicker.length >= 2 ? rawTicker : name.replace(/\s+/g, '').slice(0, 5).toUpperCase()).slice(0, 10);

  return applyIdentityPrivacyShield({
    name,
    ticker,
    description: `${name} ($${ticker}) — Community-aligned launchpad token engineered for Base L2 bonding curve liquidity and SocialFi KOL bounties.`,
    viralScore: 72,
    imagePrompt: `minimalist futuristic crypto token emblem for ${name}, vibrant neon cyan and emerald vector badge on dark background`,
    website: `https://pndigi.site/launchpad`,
    twitter: `https://x.com/${`${ticker}_coin`.slice(0, 15)}`,
    telegram: `https://t.me/${ticker.toLowerCase()}_portal`,
  });
}

async function callGeminiIdentity(trendPrompt: string, apiKey: string): Promise<TokenIdentity | null> {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `${SYSTEM_PROMPT}\n\nTrend/Narrative Prompt:\n${trendPrompt.slice(0, 3000)}`;
    const result = await model.generateContent(prompt);
    const text = result.response.text()?.trim();
    if (!text) return null;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = sanitizeIdentityRaw(JSON.parse(jsonMatch[0]));
    const validated = TokenIdentitySchema.safeParse(parsed);
    if (!validated.success) return null;
    return applyIdentityPrivacyShield(validated.data);
  } catch {
    return null;
  }
}

async function callByteDanceIdentity(
  trendPrompt: string,
  apiKey: string,
  endpoint: string,
  baseUrl: string
): Promise<TokenIdentity | null> {
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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: trendPrompt.slice(0, 3000) },
        ],
        temperature: 0.7,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const rawContent = data?.choices?.[0]?.message?.content?.trim();
    if (!rawContent) return null;

    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = sanitizeIdentityRaw(JSON.parse(jsonMatch[0]));
    const validated = TokenIdentitySchema.safeParse(parsed);
    if (!validated.success) return null;
    return applyIdentityPrivacyShield(validated.data);
  } catch {
    return null;
  }
}

/**
 * Generates a validated TokenIdentity from a trend/narrative prompt.
 * Respects AI_PRIMARY_PROVIDER (default 'byteplus': BytePlus ModelArk -> Gemini -> deterministic fallback).
 */
export async function generateTokenIdentityFromTrend(
  trendPrompt: string
): Promise<GenerateIdentityResult> {
  const primaryPref = (process.env.AI_PRIMARY_PROVIDER || 'byteplus').trim().toLowerCase();
  const arkKey = process.env.BYTEDANCE_ARK_API_KEY?.trim();
  const arkEndpoint = process.env.BYTEDANCE_MODEL_ENDPOINT?.trim();
  const arkBaseUrl = process.env.BYTEDANCE_BASE_URL?.trim();
  const geminiKey = process.env.GEMINI_API_KEY?.trim();

  const tryBytePlus = async (): Promise<GenerateIdentityResult | null> => {
    if (!arkKey || !arkEndpoint || !arkBaseUrl || arkKey.startsWith('mock_')) return null;
    const arkIdentity = await callByteDanceIdentity(trendPrompt, arkKey, arkEndpoint, arkBaseUrl);
    return arkIdentity ? { identity: arkIdentity, provider: 'bytedance-modelark' } : null;
  };

  const tryGemini = async (): Promise<GenerateIdentityResult | null> => {
    if (!geminiKey || geminiKey.startsWith('mock_')) return null;
    const geminiIdentity = await callGeminiIdentity(trendPrompt, geminiKey);
    return geminiIdentity ? { identity: geminiIdentity, provider: 'gemini' } : null;
  };

  const order = primaryPref === 'gemini' ? [tryGemini, tryBytePlus] : [tryBytePlus, tryGemini];
  for (const attempt of order) {
    const res = await attempt();
    if (res) return res;
  }

  return {
    identity: buildDeterministicFallbackIdentity(trendPrompt),
    provider: 'deterministic-fallback',
  };
}

/**
 * Pure deterministic request builder for BytePlus ModelArk Seedream Image Generation API
 * (POST /api/v3/images/generations). Uses b64_json to eliminate secondary URL fetches / SSRF.
 */
export function buildSeedreamImageRequestPayload(params: {
  endpoint: string;
  imagePrompt: string;
}): Record<string, unknown> {
  const cleanPrompt = String(params.imagePrompt || '')
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 380);
  return {
    model: params.endpoint.trim(),
    prompt: `${cleanPrompt || 'minimalist futuristic crypto token emblem'}, crypto token logo, minimalist, high quality, centered, clean vector style`,
    size: '1024x1024',
    response_format: 'b64_json',
    watermark: false,
  };
}

async function callBytePlusSeedreamLogo(
  imagePrompt: string,
  apiKey: string,
  endpoint: string,
  baseUrl: string
): Promise<Buffer | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(buildSeedreamImageRequestPayload({ endpoint, imagePrompt })),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = json?.data?.[0]?.b64_json?.trim();
    if (!b64) return null;
    const buf = Buffer.from(b64, 'base64');
    return buf.length >= 64 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Generates a token logo PNG buffer (memory-only, zero fs).
 * Priority: BytePlus Seedream (BYTEDANCE_IMAGE_ENDPOINT) -> Pollinations.ai -> deterministic fallback.
 */
export async function generateTokenLogoBuffer(
  imagePrompt: string,
  _tokenName: string
): Promise<{ buffer: Buffer; isFallback: boolean; provider: LogoImageProvider }> {
  const arkKey = process.env.BYTEDANCE_ARK_API_KEY?.trim();
  const imageEndpoint = process.env.BYTEDANCE_IMAGE_ENDPOINT?.trim();
  const arkBaseUrl = process.env.BYTEDANCE_BASE_URL?.trim();

  if (arkKey && imageEndpoint && arkBaseUrl && !arkKey.startsWith('mock_')) {
    const seedreamBuf = await callBytePlusSeedreamLogo(imagePrompt, arkKey, imageEndpoint, arkBaseUrl);
    if (seedreamBuf) {
      return { buffer: seedreamBuf, isFallback: false, provider: 'bytedance-seedream' };
    }
  }

  const fullPrompt = `${imagePrompt.slice(0, 400)}, crypto token logo, minimalist, high quality, centered`;
  const url = `${POLLINATIONS_BASE_URL}/${encodeURIComponent(fullPrompt)}?width=512&height=512&seed=${Date.now()}&nologo=true`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
    if (!res.ok) {
      return { buffer: FALLBACK_LOGO_PNG_BUFFER, isFallback: true, provider: 'deterministic-fallback' };
    }
    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    if (buf.length < 64) {
      return { buffer: FALLBACK_LOGO_PNG_BUFFER, isFallback: true, provider: 'deterministic-fallback' };
    }
    return { buffer: buf, isFallback: false, provider: 'pollinations' };
  } catch {
    return { buffer: FALLBACK_LOGO_PNG_BUFFER, isFallback: true, provider: 'deterministic-fallback' };
  }
}

/**
 * Uploads logo PNG buffer and standard ERC-20 metadata JSON to Pinata IPFS
 * using native Web FormData + fetch (zero fs, zero form-data dependency).
 */
export async function uploadLogoAndMetadataToIpfs(
  logoBuffer: Buffer,
  identity: Pick<TokenIdentity, 'name' | 'ticker' | 'description' | 'website' | 'twitter' | 'telegram'>
): Promise<IpfsUploadResult> {
  const jwt = process.env.PINATA_JWT?.trim();
  const fallbackDataUri = `data:image/png;base64,${logoBuffer.toString('base64')}`;

  if (!jwt || jwt.startsWith('mock_')) {
    return {
      imageUrl: fallbackDataUri,
      metadataUrl: null,
      uploadedToIpfs: false,
    };
  }

  try {
    const filename = `${identity.ticker.toLowerCase()}-logo.png`;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(logoBuffer)], { type: 'image/png' }), filename);
    form.append('pinataMetadata', JSON.stringify({ name: filename }));

    const fileRes = await fetch(`${PINATA_BASE}/pinning/pinFileToIPFS`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
      signal: AbortSignal.timeout(25000),
    });

    if (!fileRes.ok) {
      return { imageUrl: fallbackDataUri, metadataUrl: null, uploadedToIpfs: false };
    }
    const fileJson = (await fileRes.json()) as { IpfsHash?: string };
    if (!fileJson.IpfsHash) {
      return { imageUrl: fallbackDataUri, metadataUrl: null, uploadedToIpfs: false };
    }

    const imageUrl = `https://gateway.pinata.cloud/ipfs/${fileJson.IpfsHash}`;
    const metadata = {
      name: identity.name,
      symbol: identity.ticker,
      description: identity.description,
      image: imageUrl,
      external_url: identity.website,
      twitter: identity.twitter,
      telegram: identity.telegram,
    };

    const metaRes = await fetch(`${PINATA_BASE}/pinning/pinJSONToIPFS`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pinataContent: metadata,
        pinataMetadata: { name: `${identity.ticker.toLowerCase()}-metadata.json` },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!metaRes.ok) {
      return { imageUrl, metadataUrl: null, uploadedToIpfs: true };
    }
    const metaJson = (await metaRes.json()) as { IpfsHash?: string };
    const metadataUrl = metaJson.IpfsHash
      ? `https://gateway.pinata.cloud/ipfs/${metaJson.IpfsHash}`
      : null;

    return { imageUrl, metadataUrl, uploadedToIpfs: true };
  } catch {
    return { imageUrl: fallbackDataUri, metadataUrl: null, uploadedToIpfs: false };
  }
}
