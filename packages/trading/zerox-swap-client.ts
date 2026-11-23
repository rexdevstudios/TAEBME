/**
 * packages/trading/zerox-swap-client.ts
 *
 * Stateless Non-Custodial 0x Swap API v2 (AllowanceHolder) Quote Client (Phase AR).
 * - Complies strictly with AGENTS.md Rule 1 (Stateless Vercel) & Rule 3 (Non-Custodial).
 * - Injects automatic ETH partner fee (`swapFeeBps`, `swapFeeRecipient = treasuryWallet`,
 *   `swapFeeToken = ZEROX_NATIVE_ETH`) so the platform treasury receives native ETH directly on-chain.
 * - NEVER logs or echoes `ZEROX_API_KEY`.
 * - Fail-safe 6s timeout: returns `{ available: false, reason }` without blocking callers.
 */

import { ethers } from 'ethers';
import type { DexPartnerFeePayload } from './fee-monetization';

export const ZEROX_API_BASE = 'https://api.0x.org/swap/allowance-holder/quote';
export const ZEROX_NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const ZEROX_ALLOWANCE_HOLDER_ADDRESS = '0x0000000000001fF3684f28c67538d4D072C22734';
export const ZEROX_SUPPORTED_CHAIN_IDS = new Set<number>([1, 10, 56, 137, 8453, 42161]);

const ERC20_APPROVE_IFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export function buildErc20ApproveTransaction(params: {
  tokenAddress: string;
  spender?: string | null;
  amountWei: string | bigint;
}): { to: string; spender: string; data: string; value: '0' } {
  if (!params.tokenAddress || !ethers.isAddress(params.tokenAddress)) {
    throw new Error('INVALID_ERC20_TOKEN_ADDRESS');
  }
  const rawSpender = (params.spender || ZEROX_ALLOWANCE_HOLDER_ADDRESS).trim();
  if (!ethers.isAddress(rawSpender)) {
    throw new Error('INVALID_ERC20_SPENDER_ADDRESS');
  }
  const parsedAmount = BigInt(params.amountWei);
  if (parsedAmount <= 0n) {
    throw new Error('INVALID_ERC20_APPROVE_AMOUNT');
  }
  const to = ethers.getAddress(params.tokenAddress);
  const spender = ethers.getAddress(rawSpender);
  const data = ERC20_APPROVE_IFACE.encodeFunctionData('approve', [spender, parsedAmount]);
  return {
    to,
    spender,
    data,
    value: '0',
  };
}

export interface ZeroXQuoteParams {
  chainId: number;
  side: 'BUY' | 'SELL';
  tokenAddress: string;
  sellAmountWei: string;
  takerAddress: string;
  slippageBps: number;
  partnerFee: DexPartnerFeePayload;
  apiKeyOverride?: string;
  fetchImpl?: typeof fetch;
}

export interface ZeroXSwapQuoteResult {
  available: boolean;
  chainId: number;
  sellToken?: string;
  buyToken?: string;
  sellAmount?: string;
  buyAmount?: string;
  minBuyAmount?: string;
  allowanceTarget?: string | null;
  transaction?: {
    to: string;
    data: string;
    value: string;
    gas?: string;
    gasPrice?: string;
  };
  feeBps?: number;
  feeRecipient?: string;
  feeToken?: string;
  routeSources?: string[];
  latencyMs: number;
  reason?: string;
}

export function extractZeroXRouteSources(data: unknown): string[] {
  const fills = (data as any)?.route?.fills;
  if (!Array.isArray(fills) || fills.length === 0) {
    return ['0x_Settler_v2'];
  }
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const f of fills) {
    const src = typeof f?.source === 'string' ? f.source.trim() : '';
    if (src && !seen.has(src)) {
      seen.add(src);
      sources.push(src);
    }
  }
  return sources.length > 0 ? sources : ['0x_Settler_v2'];
}

export function buildZeroXQuoteUrl(params: {
  chainId: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  taker: string;
  slippageBps: number;
  feeBps: number;
  feeRecipient: string;
}): string {
  const qs = new URLSearchParams({
    chainId: String(params.chainId),
    sellToken: params.sellToken,
    buyToken: params.buyToken,
    sellAmount: params.sellAmount,
    taker: params.taker,
    slippageBps: String(Math.max(10, Math.min(500, Math.round(params.slippageBps)))),
  });

  if (params.feeBps > 0 && ethers.isAddress(params.feeRecipient)) {
    qs.set('swapFeeRecipient', params.feeRecipient);
    qs.set('swapFeeBps', String(Math.min(100, Math.round(params.feeBps))));
    // Always collect partner fee in native ETH when ETH is either sellToken or buyToken
    const feeToken =
      params.sellToken.toLowerCase() === ZEROX_NATIVE_ETH.toLowerCase() ||
      params.buyToken.toLowerCase() === ZEROX_NATIVE_ETH.toLowerCase()
        ? ZEROX_NATIVE_ETH
        : params.buyToken;
    qs.set('swapFeeToken', feeToken);
  }

  return `${ZEROX_API_BASE}?${qs.toString()}`;
}

export async function fetchZeroXSwapQuote(params: ZeroXQuoteParams): Promise<ZeroXSwapQuoteResult> {
  const start = Date.now();
  const apiKey = (
    params.apiKeyOverride !== undefined ? params.apiKeyOverride : process.env.ZEROX_API_KEY || ''
  ).trim();

  if (!apiKey || apiKey.startsWith('mock_')) {
    return {
      available: false,
      chainId: params.chainId,
      latencyMs: Math.max(1, Date.now() - start),
      reason: 'ZEROX_API_KEY_NOT_CONFIGURED',
    };
  }

  if (!ZEROX_SUPPORTED_CHAIN_IDS.has(params.chainId)) {
    return {
      available: false,
      chainId: params.chainId,
      latencyMs: Math.max(1, Date.now() - start),
      reason: `ZEROX_UNSUPPORTED_CHAIN_${params.chainId}`,
    };
  }

  if (!ethers.isAddress(params.tokenAddress) || !ethers.isAddress(params.takerAddress)) {
    return {
      available: false,
      chainId: params.chainId,
      latencyMs: Math.max(1, Date.now() - start),
      reason: 'INVALID_EVM_ADDRESS',
    };
  }

  const sellToken = params.side === 'BUY' ? ZEROX_NATIVE_ETH : ethers.getAddress(params.tokenAddress);
  const buyToken = params.side === 'BUY' ? ethers.getAddress(params.tokenAddress) : ZEROX_NATIVE_ETH;

  if (sellToken.toLowerCase() === buyToken.toLowerCase()) {
    return {
      available: false,
      chainId: params.chainId,
      latencyMs: Math.max(1, Date.now() - start),
      reason: 'IDENTICAL_SELL_AND_BUY_TOKEN',
    };
  }

  const url = buildZeroXQuoteUrl({
    chainId: params.chainId,
    sellToken,
    buyToken,
    sellAmount: params.sellAmountWei,
    taker: ethers.getAddress(params.takerAddress),
    slippageBps: params.slippageBps,
    feeBps: params.partnerFee.feeBps,
    feeRecipient: params.partnerFee.feeRecipient,
  });

  const doFetch = params.fetchImpl || fetch;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers: {
          '0x-api-key': apiKey,
          '0x-version': 'v2',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Math.max(1, Date.now() - start);
    const data: any = await res.json().catch(() => ({}));
    const resolvedAllowanceTarget =
      params.side === 'SELL'
        ? String(
            data?.issues?.allowance?.spender ||
              data?.allowanceTarget ||
              ZEROX_ALLOWANCE_HOLDER_ADDRESS
          )
        : null;

    if (!res.ok || !data?.transaction?.to || !data?.transaction?.data) {
      return {
        available: false,
        chainId: params.chainId,
        sellToken,
        buyToken,
        sellAmount: String(data?.sellAmount || params.sellAmountWei),
        allowanceTarget: resolvedAllowanceTarget,
        latencyMs,
        reason: data?.name || data?.message || `ZEROX_HTTP_${res.status}`,
      };
    }

    return {
      available: true,
      chainId: params.chainId,
      sellToken,
      buyToken,
      sellAmount: String(data.sellAmount || params.sellAmountWei),
      buyAmount: String(data.buyAmount || '0'),
      minBuyAmount: String(data.minBuyAmount || data.buyAmount || '0'),
      allowanceTarget: resolvedAllowanceTarget,
      transaction: {
        to: String(data.transaction.to),
        data: String(data.transaction.data),
        value: String(data.transaction.value || '0'),
        ...(data.transaction.gas ? { gas: String(data.transaction.gas) } : {}),
        ...(data.transaction.gasPrice ? { gasPrice: String(data.transaction.gasPrice) } : {}),
      },
      feeBps: params.partnerFee.feeBps,
      feeRecipient: params.partnerFee.feeRecipient,
      feeToken: ZEROX_NATIVE_ETH,
      routeSources: extractZeroXRouteSources(data),
      latencyMs,
    };
  } catch (err: any) {
    return {
      available: false,
      chainId: params.chainId,
      latencyMs: Math.max(1, Date.now() - start),
      reason: err?.name === 'AbortError' ? 'ZEROX_TIMEOUT' : 'ZEROX_NETWORK_ERROR',
    };
  }
}
