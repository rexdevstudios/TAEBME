/**
 * packages/agent/binance-agentic-bridge.ts
 *
 * Pure, deterministic Non-Custodial Guardrail & Skill Command Bridge
 * for Binance Agentic Wallet (MPC keyless wallet rail — Phase DL).
 *
 * Complies strictly with AGENTS.md Rule 3 (Non-Custodial) & Rule 5 (Deterministic Risk Gate):
 * - Zero private keys or seed phrases stored or transmitted.
 * - Enforces single-tx & daily spending caps aligned with TradingRiskGate.
 * - Produces copy-ready non-custodial `baw` / Binance Agentic Wallet skill commands.
 */

export const BINANCE_AGENTIC_SUPPORTED_CHAINS = ['bsc', 'base', 'ethereum', 'solana'] as const;
export type BinanceAgenticChain = (typeof BINANCE_AGENTIC_SUPPORTED_CHAINS)[number];

export interface BinanceAgenticGuardrailConfig {
  enabled: boolean;
  allowedChains: BinanceAgenticChain[];
  maxSingleTxUsd: number;
  dailySpendCapUsd: number;
  requireGoPlusPreCheck: boolean;
  updatedAt: string;
}

export interface BinanceAgenticGuardrailValidation {
  ok: boolean;
  sanitized?: BinanceAgenticGuardrailConfig;
  error?: string;
}

const VALID_CHAIN_SET = new Set<string>(BINANCE_AGENTIC_SUPPORTED_CHAINS);

export function validateBinanceAgenticGuardrail(
  raw: Record<string, unknown>
): BinanceAgenticGuardrailValidation {
  const rawChains = Array.isArray(raw?.allowedChains) ? raw.allowedChains : ['bsc', 'base'];
  const allowedChains: BinanceAgenticChain[] = [];
  for (const item of rawChains) {
    const norm = String(item || '').trim().toLowerCase();
    if (VALID_CHAIN_SET.has(norm) && !allowedChains.includes(norm as BinanceAgenticChain)) {
      allowedChains.push(norm as BinanceAgenticChain);
    }
  }
  if (allowedChains.length === 0) {
    return {
      ok: false,
      error: 'INVALID_CHAINS: Select at least one supported chain (bsc, base, ethereum, solana).',
    };
  }

  const rawSingle = Number(raw?.maxSingleTxUsd ?? 100);
  const rawDaily = Number(raw?.dailySpendCapUsd ?? 500);
  if (!Number.isFinite(rawSingle) || !Number.isFinite(rawDaily)) {
    return {
      ok: false,
      error: 'INVALID_SPEND_CAP: Spending limits must be valid finite numbers.',
    };
  }

  const maxSingleTxUsd = Math.max(10, Math.min(5000, Math.round(rawSingle)));
  const dailySpendCapUsd = Math.max(maxSingleTxUsd, Math.min(25000, Math.round(rawDaily)));

  return {
    ok: true,
    sanitized: {
      enabled: raw?.enabled !== false,
      allowedChains,
      maxSingleTxUsd,
      dailySpendCapUsd,
      requireGoPlusPreCheck: raw?.requireGoPlusPreCheck !== false,
      updatedAt: new Date().toISOString(),
    },
  };
}

export interface BinanceAgenticCommandParams {
  chain: BinanceAgenticChain;
  action: 'swap' | 'balance' | 'transfer_check';
  tokenSymbol?: string;
  amountUsd?: number;
  guardrail: BinanceAgenticGuardrailConfig;
}

/**
 * Generates a deterministic, non-custodial Binance Agentic Wallet CLI/Skill handoff command
 * bounded by the user's configured spending guardrail.
 */
export function buildBinanceAgenticSkillCommand(params: BinanceAgenticCommandParams): string {
  const chain = VALID_CHAIN_SET.has(params.chain) ? params.chain : 'bsc';
  const cleanSymbol = String(params.tokenSymbol || 'USDC')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12) || 'USDC';

  const clampedAmount = Math.max(
    1,
    Math.min(
      params.guardrail.maxSingleTxUsd,
      Number.isFinite(Number(params.amountUsd)) ? Number(params.amountUsd) : 25
    )
  );

  if (params.action === 'balance') {
    return `baw wallet balance --chain ${chain} --format json`;
  }

  const goplusFlag = params.guardrail.requireGoPlusPreCheck ? ' --precheck-goplus' : '';
  if (params.action === 'transfer_check') {
    return `baw policy inspect --chain ${chain} --max-tx-usd ${params.guardrail.maxSingleTxUsd} --daily-cap-usd ${params.guardrail.dailySpendCapUsd}`;
  }

  return `baw swap quote --chain ${chain} --token ${cleanSymbol} --amount-usd ${clampedAmount} --daily-cap-usd ${params.guardrail.dailySpendCapUsd}${goplusFlag}`;
}
