/**
 * packages/agent/copilot-engine.ts
 *
 * Pure, deterministic Universal AI Trading & Launchpad Copilot Intent Engine (Phase ED).
 *
 * Complies strictly with AGENTS.md:
 * - Zero private keys / seed phrases (hard-rejects 64-hex keys and seed phrase keywords).
 * - Separates Read-Only Intelligence queries (Top Movers, Deployer Fees, Accounts, News/KOL)
 *   from Mutating Action Drafts (CEX LIMIT/MARKET orders, Bankr Agent prompts).
 * - Multi-Account Exposure Validator enforces Risk Gate caps across selected accounts.
 */

import { TOP_LIQUID_CEX_PAIRS } from '../shared/market-pairs';
import type { AutoPilot24hTicker } from './autopilot-market-feed';

export type CopilotIntentKind =
  | 'TOP_MOVERS'
  | 'DEPLOYER_FEES'
  | 'ACCOUNTS_STATUS'
  | 'NEWS_AND_KOL'
  | 'CEX_LIMIT_ORDER'
  | 'CEX_MARKET_ORDER'
  | 'BANKR_PROMPT'
  | 'GENERAL_MARKET';

export interface CopilotConnectedAccount {
  id: string;
  rail: 'BINANCE' | 'BYBIT' | 'BANKR';
  label: string;
  maskedKey: string;
  scope: string;
  isDefault: boolean;
}

export interface CopilotDeployerFeeSummary {
  contractAddress: string;
  chain: string;
  raisedAmount: number;
  estimatedCreatorFee: number;
  graduationThreshold: number;
  isGraduated: boolean;
}

export interface CopilotActionDraft {
  kind: 'CEX_LIMIT_ORDER' | 'CEX_MARKET_ORDER' | 'BANKR_PROMPT';
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'LIMIT' | 'MARKET';
  limitPrice?: number;
  amountUsd: number;
  bankrPrompt?: string;
  supportedRails: Array<'BINANCE' | 'BYBIT' | 'BANKR'>;
}

export interface ParsedCopilotIntent {
  valid: boolean;
  error?: string;
  kind: CopilotIntentKind;
  symbol: string;
  side: 'BUY' | 'SELL';
  minChangePct?: number;
  limitPrice?: number;
  amountUsd: number;
  sanitizedMessage: string;
  actionDraft?: CopilotActionDraft;
}

export interface MultiAccountExposureCheck {
  ok: boolean;
  selectedCount: number;
  amountUsdPerAccount: number;
  totalExposureUsd: number;
  maxOrderValueUsd: number;
  maxDailyLossUsd: number;
  reason?: string;
}

const KNOWN_BASE_TO_SYMBOL = new Map<string, string>(
  TOP_LIQUID_CEX_PAIRS.map((p) => [p.symbol.replace(/USDT$/, ''), p.symbol])
);

const PRIVATE_KEY_OR_SEED_REGEX =
  /\b(0x[a-fA-F0-9]{64}|[a-fA-F0-9]{64}|seed\s*phrase|private\s*key|mnemonic|recovery\s*phrase)\b/i;

function parseHumanNumber(raw: string): number {
  const clean = raw.replace(/[,$\s]/g, '').toLowerCase();
  if (clean.endsWith('k')) {
    const n = Number(clean.slice(0, -1));
    return Number.isFinite(n) ? n * 1000 : NaN;
  }
  return Number(clean);
}

/**
 * Parses a natural-language Indonesian or English Copilot command into a deterministic
 * read-only query or an actionable (confirmation-required) order/Bankr draft.
 */
export function parseCopilotUserMessage(rawMessage: unknown): ParsedCopilotIntent {
  const raw = typeof rawMessage === 'string' ? rawMessage.replace(/[\x00-\x1F\x7F]+/g, ' ').trim() : '';
  if (raw.length < 2 || raw.length > 600) {
    return {
      valid: false,
      error: 'INVALID_MESSAGE: Prompt must be 2–600 characters.',
      kind: 'GENERAL_MARKET',
      symbol: 'BTCUSDT',
      side: 'BUY',
      amountUsd: 100,
      sanitizedMessage: '',
    };
  }

  if (PRIVATE_KEY_OR_SEED_REGEX.test(raw)) {
    return {
      valid: false,
      error: 'SECURITY_BLOCK: Never paste private keys or seed phrases into AI Copilot.',
      kind: 'GENERAL_MARKET',
      symbol: 'BTCUSDT',
      side: 'BUY',
      amountUsd: 100,
      sanitizedMessage: '',
    };
  }

  const lower = raw.toLowerCase();
  const upper = raw.toUpperCase();

  // Detect target symbol (default BTCUSDT)
  let symbol = 'BTCUSDT';
  for (const [base, fullSym] of KNOWN_BASE_TO_SYMBOL.entries()) {
    const re = new RegExp(`\\b${base}(?:USDT)?\\b`, 'i');
    if (re.test(upper)) {
      symbol = fullSym;
      break;
    }
  }

  const side: 'BUY' | 'SELL' = /\b(sell|jual|short|tp|take\s*profit)\b/i.test(lower) ? 'SELL' : 'BUY';

  // Parse USD amount (e.g. "$100", "100 usd", "100 usdt", "sebesar 250")
  let amountUsd = 100;
  const usdMatch =
    raw.match(/\$\s*(\d+(?:[.,]\d+)?k?)\b/i) ||
    raw.match(/\b(\d+(?:[.,]\d+)?k?)\s*(?:usd|usdt|usdc|dollar|dolar)\b/i) ||
    raw.match(/\b(?:sebesar|senilai|amount|qty)\s*\$?\s*(\d+(?:[.,]\d+)?k?)\b/i);
  if (usdMatch?.[1]) {
    const parsed = parseHumanNumber(usdMatch[1]);
    if (Number.isFinite(parsed) && parsed >= 5 && parsed <= 50000) {
      amountUsd = Math.round(parsed * 100) / 100;
    }
  }

  // Parse limit price (e.g. "harga 88000", "di 88k", "at 88,000", "limit 3200")
  let limitPrice: number | undefined;
  const limitPriceMatch =
    raw.match(/\b(?:harga|price|di|at|@|ke|limit)\s*\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?k?)\b/i);
  if (limitPriceMatch?.[1]) {
    const parsed = parseHumanNumber(limitPriceMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      limitPrice = parsed;
    }
  }

  // 1. Bankr Agent natural-language command
  if (/\b(bankr|claim\s*fee\s*(?:di|via|lewat)?\s*bankr|swap\s+.*on\s+base)\b/i.test(lower)) {
    const actionDraft: CopilotActionDraft = {
      kind: 'BANKR_PROMPT',
      symbol,
      side,
      orderType: 'MARKET',
      amountUsd,
      bankrPrompt: raw,
      supportedRails: ['BANKR'],
    };
    return {
      valid: true,
      kind: 'BANKR_PROMPT',
      symbol,
      side,
      amountUsd,
      sanitizedMessage: raw,
      actionDraft,
    };
  }

  // 2. Deployer Fee / Launchpad status check
  if (/\b(deployer|fee|claim|klaim|bonding\s*curve|gradua|launchpad)\b/i.test(lower)) {
    return {
      valid: true,
      kind: 'DEPLOYER_FEES',
      symbol,
      side,
      amountUsd,
      sanitizedMessage: raw,
    };
  }

  // 3. Top Movers (> X% gainers / losers)
  if (/\b(naik|pump|gainer|mover|turun|dump|di\s*atas|above|over)\b/i.test(lower) && /%|persen|percent/i.test(lower)) {
    const pctMatch = raw.match(/(-?\d+(?:\.\d+)?)\s*(?:%|persen|percent)/i);
    const minChangePct = pctMatch?.[1] ? Number(pctMatch[1]) : 5;
    return {
      valid: true,
      kind: 'TOP_MOVERS',
      symbol,
      side,
      minChangePct: Number.isFinite(minChangePct) ? minChangePct : 5,
      amountUsd,
      sanitizedMessage: raw,
    };
  }

  // 4. Connected Vault Accounts status check
  if (/\b(akun|account|vault|terkonek|connected|terhubung)\b/i.test(lower) && !/\b(beli|buy|jual|sell|limit|order)\b/i.test(lower)) {
    return {
      valid: true,
      kind: 'ACCOUNTS_STATUS',
      symbol,
      side,
      amountUsd,
      sanitizedMessage: raw,
    };
  }

  // 5. Explicit CEX Trade intent (LIMIT or MARKET)
  const hasTradeVerb = /\b(beli|belikan|buy|jual|sell|order|entry|long|short)\b/i.test(lower);
  const isLimit = /\b(limit|ketika|kalau|jika|saat|when|if|target)\b/i.test(lower) && limitPrice !== undefined;

  if (hasTradeVerb && isLimit && limitPrice) {
    const actionDraft: CopilotActionDraft = {
      kind: 'CEX_LIMIT_ORDER',
      symbol,
      side,
      orderType: 'LIMIT',
      limitPrice,
      amountUsd,
      supportedRails: ['BINANCE', 'BYBIT'],
    };
    return {
      valid: true,
      kind: 'CEX_LIMIT_ORDER',
      symbol,
      side,
      limitPrice,
      amountUsd,
      sanitizedMessage: raw,
      actionDraft,
    };
  }

  if (hasTradeVerb) {
    const actionDraft: CopilotActionDraft = {
      kind: 'CEX_MARKET_ORDER',
      symbol,
      side,
      orderType: 'MARKET',
      amountUsd,
      supportedRails: ['BINANCE', 'BYBIT'],
    };
    return {
      valid: true,
      kind: 'CEX_MARKET_ORDER',
      symbol,
      side,
      amountUsd,
      sanitizedMessage: raw,
      actionDraft,
    };
  }

  // 6. News & Verified KOL consensus query
  if (/\b(berita|news|kol|konsensus|consensus|sentimen|sentiment|katalis|catalyst)\b/i.test(lower)) {
    return {
      valid: true,
      kind: 'NEWS_AND_KOL',
      symbol,
      side,
      amountUsd,
      sanitizedMessage: raw,
    };
  }

  return {
    valid: true,
    kind: 'GENERAL_MARKET',
    symbol,
    side,
    amountUsd,
    sanitizedMessage: raw,
  };
}

export function filterTopMoversByPercent(
  tickers: Readonly<Record<string, AutoPilot24hTicker>>,
  minChangePct: number = 5
): AutoPilot24hTicker[] {
  const threshold = Number.isFinite(minChangePct) ? minChangePct : 5;
  return Object.values(tickers || {})
    .filter((t) =>
      threshold >= 0 ? Number(t.priceChangePct24h) >= threshold : Number(t.priceChangePct24h) <= threshold
    )
    .sort((a, b) =>
      threshold >= 0
        ? Number(b.priceChangePct24h) - Number(a.priceChangePct24h)
        : Number(a.priceChangePct24h) - Number(b.priceChangePct24h)
    );
}

/**
 * Deterministic Multi-Account Exposure Risk Check (enforces Risk Gate limits across all selected accounts).
 */
export function computeMultiAccountExposureCheck(params: {
  amountUsdPerAccount: number;
  selectedCount: number;
  maxOrderValueUsd: number;
  maxDailyLossUsd: number;
}): MultiAccountExposureCheck {
  const count = Math.max(0, Math.floor(Number(params.selectedCount) || 0));
  const perAcct = Math.max(0, Number(params.amountUsdPerAccount) || 0);
  const totalExposureUsd = Math.round(count * perAcct * 100) / 100;
  const maxOrder = Math.max(10, Number(params.maxOrderValueUsd) || 1000);
  const maxDaily = Math.max(50, Number(params.maxDailyLossUsd) || 5000);

  if (count === 0) {
    return {
      ok: false,
      selectedCount: 0,
      amountUsdPerAccount: perAcct,
      totalExposureUsd: 0,
      maxOrderValueUsd: maxOrder,
      maxDailyLossUsd: maxDaily,
      reason: 'NO_ACCOUNT_SELECTED',
    };
  }

  if (perAcct > maxOrder) {
    return {
      ok: false,
      selectedCount: count,
      amountUsdPerAccount: perAcct,
      totalExposureUsd,
      maxOrderValueUsd: maxOrder,
      maxDailyLossUsd: maxDaily,
      reason: `ORDER_EXCEEDS_PER_ACCOUNT_CAP ($${perAcct} > $${maxOrder})`,
    };
  }

  if (totalExposureUsd > maxDaily) {
    return {
      ok: false,
      selectedCount: count,
      amountUsdPerAccount: perAcct,
      totalExposureUsd,
      maxOrderValueUsd: maxOrder,
      maxDailyLossUsd: maxDaily,
      reason: `TOTAL_MULTI_ACCOUNT_EXPOSURE_EXCEEDS_DAILY_CAP ($${totalExposureUsd} > $${maxDaily})`,
    };
  }

  return {
    ok: true,
    selectedCount: count,
    amountUsdPerAccount: perAcct,
    totalExposureUsd,
    maxOrderValueUsd: maxOrder,
    maxDailyLossUsd: maxDaily,
  };
}

/**
 * Builds a clean deterministic bilingual response grounded in real-time telemetry
 * (used as instant fallback or primary structured summary).
 */
export function buildDeterministicCopilotReply(params: {
  locale: 'en' | 'id';
  intent: ParsedCopilotIntent;
  tickers: Readonly<Record<string, AutoPilot24hTicker>>;
  topMovers: readonly AutoPilot24hTicker[];
  deployerTokens: readonly CopilotDeployerFeeSummary[];
  accounts: readonly CopilotConnectedAccount[];
  kolConsensus: { score: number; verdict: string; uniqueVerifiedKols: number };
  newsHint?: string | null;
}): string {
  const isId = params.locale === 'id';
  const symTicker = params.tickers[params.intent.symbol];
  const spotStr = symTicker ? `$${symTicker.lastPrice.toLocaleString()} (${symTicker.priceChangePct24h >= 0 ? '+' : ''}${symTicker.priceChangePct24h.toFixed(2)}%)` : 'N/A';

  if (params.intent.kind === 'TOP_MOVERS') {
    const pct = params.intent.minChangePct ?? 5;
    if (params.topMovers.length === 0) {
      return isId
        ? `Pemindaian live 12 pair likuid selesai: belum ada token dengan pergerakan >= ${pct}% dalam 24 jam terakhir.`
        : `Live scan of 12 liquid pairs complete: no tokens currently moving >= ${pct}% in the last 24h.`;
    }
    const list = params.topMovers
      .slice(0, 5)
      .map((t) => `${t.symbol} ($${t.lastPrice}, ${t.priceChangePct24h >= 0 ? '+' : ''}${t.priceChangePct24h.toFixed(2)}%)`)
      .join(' · ');
    return isId
      ? `Ditemukan ${params.topMovers.length} token bergerak >= ${pct}% (24j): ${list}.`
      : `Found ${params.topMovers.length} tokens moving >= ${pct}% (24h): ${list}.`;
  }

  if (params.intent.kind === 'DEPLOYER_FEES') {
    if (params.deployerTokens.length === 0) {
      return isId
        ? 'Belum ada token Launchpad yang tercatat di-deploy oleh wallet Anda pada Neon SSOT. Anda dapat membuat draft baru di /launchpad atau menjalankan claim via Bankr API.'
        : 'No Launchpad tokens deployed by your wallet were found in Neon SSOT. You can launch a new token at /launchpad or run a claim via Bankr API.';
    }
    const totalFee = params.deployerTokens.reduce((acc, t) => acc + t.estimatedCreatorFee, 0);
    return isId
      ? `Terdeteksi ${params.deployerTokens.length} token milik deployer Anda. Estimasi total creator fee (0.50% swap split): ${totalFee.toFixed(6)} ETH. Cek detail di /launchpad atau kirim perintah claim via Bankr.`
      : `Detected ${params.deployerTokens.length} tokens deployed by your wallet. Estimated creator fee (0.50% swap split): ${totalFee.toFixed(6)} ETH. Inspect details at /launchpad or claim via Bankr.`;
  }

  if (params.intent.kind === 'ACCOUNTS_STATUS') {
    const binanceCnt = params.accounts.filter((a) => a.rail === 'BINANCE').length;
    const bybitCnt = params.accounts.filter((a) => a.rail === 'BYBIT').length;
    const bankrCnt = params.accounts.filter((a) => a.rail === 'BANKR').length;
    return isId
      ? `Status Multi-Account Vault Anda: ${binanceCnt} Binance, ${bybitCnt} Bybit, dan ${bankrCnt} Bankr API key aktif. Anda dapat memilih sebagian atau semua akun pada kartu konfirmasi saat eksekusi.`
      : `Your Multi-Account Vault status: ${binanceCnt} Binance, ${bybitCnt} Bybit, and ${bankrCnt} active Bankr API keys. You can select individual or all accounts in the confirmation card before execution.`;
  }

  if (params.intent.actionDraft) {
    const d = params.intent.actionDraft;
    if (d.kind === 'BANKR_PROMPT') {
      return isId
        ? `Perintah Bankr Agent siap: "${d.bankrPrompt}". Pilih akun Bankr API yang ingin digunakan di kartu konfirmasi di bawah lalu klik Confirm.`
        : `Bankr Agent command ready: "${d.bankrPrompt}". Select the Bankr API account(s) in the confirmation card below and click Confirm.`;
    }
    const typeText = d.orderType === 'LIMIT' && d.limitPrice ? `LIMIT @ $${d.limitPrice.toLocaleString()}` : 'MARKET';
    return isId
      ? `Draft order ${d.side} ${d.symbol} (${typeText}, $${d.amountUsd}/akun) siap. Harga live: ${spotStr} · Konsensus KOL Verified: ${params.kolConsensus.verdict} (${params.kolConsensus.score}/100, ${params.kolConsensus.uniqueVerifiedKols} KOL). Silakan pilih akun Binance/Bybit di bawah lalu klik Confirm.`
      : `Order draft ${d.side} ${d.symbol} (${typeText}, $${d.amountUsd}/account) is ready. Live price: ${spotStr} · Verified KOL Consensus: ${params.kolConsensus.verdict} (${params.kolConsensus.score}/100, ${params.kolConsensus.uniqueVerifiedKols} KOLs). Select Binance/Bybit account(s) below and click Confirm.`;
  }

  const newsPart = params.newsHint
    ? isId
      ? ` Katalis berita live: ${params.newsHint}`
      : ` Live news catalyst: ${params.newsHint}`
    : '';
  return isId
    ? `Ringkasan live ${params.intent.symbol}: harga ${spotStr}, Konsensus KOL Verified ${params.kolConsensus.verdict} (${params.kolConsensus.score}/100, ${params.kolConsensus.uniqueVerifiedKols} KOL).${newsPart} Ketik perintah seperti "beli limit BTC di 88000 sebesar $100" untuk membuka kartu konfirmasi multi-akun.`
    : `Live ${params.intent.symbol} snapshot: price ${spotStr}, Verified KOL Consensus ${params.kolConsensus.verdict} (${params.kolConsensus.score}/100, ${params.kolConsensus.uniqueVerifiedKols} KOLs).${newsPart} Type a command like "buy limit BTC at 88000 for $100" to open the multi-account confirmation card.`;
}
