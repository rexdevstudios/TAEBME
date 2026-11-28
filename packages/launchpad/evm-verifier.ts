// ============================================================================
// LAUNCHPAD EVM ON-CHAIN RECEIPT & DEPLOYMENT VERIFIER (NON-CUSTODIAL, VERCEL-SAFE)
// ============================================================================
// Pure read-only EVM verifier using viem public clients.
// Zero private keys, zero legacy src/ dependencies.
// ============================================================================

import {
  createPublicClient,
  fallback,
  http,
  defineChain,
  parseEther,
  type PublicClient,
  type Transport,
  type Chain,
  type TransactionReceipt,
  type Log,
  type Account,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';

type EvmLog = Log & { topics?: string[] };

export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

export const arbitrumChain = defineChain({
  id: 42161,
  name: 'Arbitrum One',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://arb1.arbitrum.io/rpc'] },
  },
  blockExplorers: {
    default: { name: 'Arbiscan', url: 'https://arbiscan.io' },
  },
});

export const arcChain = defineChain({
  id: 5042,
  name: 'Arc Network',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.arc.network'] },
  },
  blockExplorers: {
    default: { name: 'Arcscan', url: 'https://arcscan.io' },
  },
});

export interface EvmReceiptVerification {
  status: 'confirmed' | 'pending' | 'failed' | 'not_found' | 'unknown' | 'error';
  receipt?: TransactionReceipt;
  blockNumber?: bigint;
  contractAddress?: string;
  reason?: string;
}

export interface EvmDeploymentAttribution {
  status: 'confirmed' | 'pending' | 'failed' | 'unresolved' | 'mismatch' | 'unknown' | 'error' | 'not_found';
  attributedAddress?: string;
  attributionType?: 'direct_contract_creation' | 'factory_log_emitter' | 'factory_topic_reference' | 'none';
  reason?: string;
  receipt?: TransactionReceipt;
}

function sanitizeRpcText(input: string): string {
  return input.replace(/0x[0-9a-fA-F]{64}/g, (match) => `${match.slice(0, 10)}...${match.slice(-6)}`);
}

/**
 * Resolves ordered, deduplicated HTTP RPC endpoints (env primary -> env backup -> public fallbacks)
 * for Multi-RPC failover resilience (Phase FM).
 */
export function resolveEvmRpcUrls(chain = 'base-mainnet'): string[] {
  const normalized = chain.trim().toLowerCase();
  const candidates: Array<string | undefined> = [];

  if (normalized === 'base' || normalized === 'base-mainnet' || normalized === 'clanker' || normalized === '8453') {
    candidates.push(
      process.env.BASE_RPC_URL,
      process.env.BASE_RPC_FALLBACK_URL,
      'https://mainnet.base.org',
      'https://base.llamarpc.com',
      'https://base-rpc.publicnode.com'
    );
  } else if (normalized === 'base-sepolia' || normalized === 'base_sepolia' || normalized === '84532') {
    candidates.push(
      process.env.BASE_SEPOLIA_RPC_URL,
      'https://sepolia.base.org',
      'https://base-sepolia-rpc.publicnode.com'
    );
  } else if (normalized === 'robinhood' || normalized === 'robinhood-mainnet' || normalized === '4663') {
    candidates.push(process.env.ROBINHOOD_RPC_URL, 'https://rpc.mainnet.chain.robinhood.com');
  } else if (normalized === 'arbitrum' || normalized === 'arbitrum-mainnet' || normalized === '42161') {
    candidates.push(
      process.env.ARBITRUM_RPC_URL,
      process.env.ARBITRUM_RPC_FALLBACK_URL,
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum-one-rpc.publicnode.com'
    );
  } else if (normalized === 'arc' || normalized === 'arc-mainnet' || normalized === '5042') {
    candidates.push(process.env.ARC_RPC_URL, 'https://rpc.arc.network');
  } else if (normalized === 'ethereum' || normalized === 'eth' || normalized === '1') {
    candidates.push(process.env.ETH_RPC_URL, 'https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com');
  } else if (normalized === 'optimism' || normalized === '10') {
    candidates.push(process.env.OPTIMISM_RPC_URL, 'https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com');
  } else if (normalized === 'polygon' || normalized === '137') {
    candidates.push(process.env.POLYGON_RPC_URL, 'https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com');
  } else if (normalized === 'bsc' || normalized === 'bnb' || normalized === '56') {
    candidates.push(process.env.BSC_RPC_URL, 'https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com');
  }

  return Array.from(
    new Set(
      candidates
        .map((u) => (typeof u === 'string' ? u.trim() : ''))
        .filter((u) => u.startsWith('https://') || u.startsWith('http://'))
    )
  );
}

function buildResilientTransport(urls: string[], timeout: number): Transport {
  if (urls.length <= 1) {
    return http(urls[0], { timeout, retryCount: 1 });
  }
  return fallback(
    urls.map((u) => http(u, { timeout, retryCount: 1 })),
    { rank: false, retryCount: 1 }
  );
}

/**
 * Returns a configured read-only viem PublicClient with Multi-RPC fallback transport
 * for the specified EVM chain.
 */
export function getEvmPublicClient(
  chain = 'base-mainnet'
): PublicClient<Transport, Chain, Account | undefined> | null {
  const normalized = chain.trim().toLowerCase();
  const timeout = Number(process.env.RPC_TIMEOUT_MS) || 15_000;

  if (normalized === 'base' || normalized === 'base-mainnet' || normalized === 'clanker') {
    const urls = resolveEvmRpcUrls('base-mainnet');
    return createPublicClient({
      chain: base,
      transport: buildResilientTransport(urls, timeout),
    }) as PublicClient;
  }

  if (normalized === 'base-sepolia' || normalized === 'base_sepolia') {
    const urls = resolveEvmRpcUrls('base-sepolia');
    return createPublicClient({
      chain: baseSepolia,
      transport: buildResilientTransport(urls, timeout),
    }) as PublicClient;
  }

  if (normalized === 'robinhood' || normalized === 'robinhood-mainnet') {
    const urls = resolveEvmRpcUrls('robinhood-mainnet');
    return createPublicClient({
      chain: robinhoodChain,
      transport: buildResilientTransport(urls, timeout),
    }) as PublicClient;
  }

  if (normalized === 'arbitrum' || normalized === 'arbitrum-mainnet') {
    const urls = resolveEvmRpcUrls('arbitrum-mainnet');
    return createPublicClient({
      chain: arbitrumChain,
      transport: buildResilientTransport(urls, timeout),
    }) as PublicClient;
  }

  if (normalized === 'arc' || normalized === 'arc-mainnet') {
    const urls = resolveEvmRpcUrls('arc-mainnet');
    return createPublicClient({
      chain: arcChain,
      transport: buildResilientTransport(urls, timeout),
    }) as PublicClient;
  }

  return null;
}

/**
 * Verifies transaction status on-chain.
 * Invariant: RPC failure returns status: 'unknown', NEVER 'failed'.
 */
export async function verifyEvmTransactionReceipt(
  txHash: string,
  chain = 'base-mainnet',
  customClient?: PublicClient
): Promise<EvmReceiptVerification> {
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return {
      status: 'error',
      reason: `Malformed EVM transaction hash: '${sanitizeRpcText(txHash || '')}'`,
    };
  }

  try {
    const client = customClient ?? getEvmPublicClient(chain);
    if (!client) {
      return {
        status: 'error',
        reason: `UNSUPPORTED_EVM_CHAIN: Chain '${chain}' is not supported by EVM verifier`,
      };
    }

    const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    if (!receipt) {
      return {
        status: 'pending',
        reason: 'Transaction receipt not yet found on-chain',
      };
    }

    if (receipt.status === 'success') {
      return {
        status: 'confirmed',
        receipt,
        blockNumber: receipt.blockNumber,
        contractAddress: receipt.contractAddress ?? undefined,
      };
    }

    if (receipt.status === 'reverted') {
      return {
        status: 'failed',
        receipt,
        blockNumber: receipt.blockNumber,
        reason: 'Transaction reverted on-chain (execution failure)',
      };
    }

    return {
      status: 'unknown',
      reason: `Unrecognized receipt status: ${receipt.status}`,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const sanitizedErr = sanitizeRpcText(errMsg);

    if (sanitizedErr.includes('TransactionNotFoundError') || sanitizedErr.includes('could not be found')) {
      return {
        status: 'pending',
        reason: 'Transaction is not yet mined or propagated to this RPC node',
      };
    }

    return {
      status: 'unknown',
      reason: `RPC_FAILURE: ${sanitizedErr}`,
    };
  }
}

/**
 * Verifies deployment attribution: ensures transaction receipt and emitted logs
 * genuinely match the expected token contract address (direct or factory launch).
 */
export async function verifyEvmDeploymentAttribution(
  txHash: string,
  expectedTokenAddress?: string,
  chain = 'base-mainnet',
  customClient?: PublicClient
): Promise<EvmDeploymentAttribution> {
  const receiptResult = await verifyEvmTransactionReceipt(txHash, chain, customClient);

  if (receiptResult.status !== 'confirmed' || !receiptResult.receipt) {
    return {
      status: receiptResult.status,
      reason: receiptResult.reason,
    };
  }

  const receipt = receiptResult.receipt;

  if (receipt.contractAddress) {
    const directAddr = receipt.contractAddress;
    if (expectedTokenAddress) {
      if (directAddr.toLowerCase() === expectedTokenAddress.toLowerCase()) {
        return {
          status: 'confirmed',
          attributedAddress: directAddr,
          attributionType: 'direct_contract_creation',
          receipt,
        };
      }
      return {
        status: 'mismatch',
        reason: `Contract address in receipt '${directAddr}' does not match expected token address '${expectedTokenAddress}'`,
        receipt,
      };
    }
    return {
      status: 'confirmed',
      attributedAddress: directAddr,
      attributionType: 'direct_contract_creation',
      receipt,
    };
  }

  if (!expectedTokenAddress) {
    return {
      status: 'unresolved',
      reason: 'Transaction was successful but was executed via factory and no expectedTokenAddress was provided to attribute',
      receipt,
    };
  }

  const target = expectedTokenAddress.toLowerCase();
  const targetClean = target.replace(/^0x/, '');
  const logs: EvmLog[] = (receipt.logs || []) as EvmLog[];

  if (logs.length === 0) {
    return {
      status: 'unresolved',
      reason: 'No event logs emitted in transaction to attribute factory token deployment',
      receipt,
    };
  }

  if (logs.some((log) => log.address?.toLowerCase() === target)) {
    return {
      status: 'confirmed',
      attributedAddress: expectedTokenAddress,
      attributionType: 'factory_log_emitter',
      receipt,
    };
  }

  const topicOrDataMatch = logs.some((log) => {
    const inTopics = log.topics?.some((t) => t.toLowerCase().includes(targetClean));
    const inData = log.data?.toLowerCase().includes(targetClean);
    return Boolean(inTopics || inData);
  });

  if (topicOrDataMatch) {
    return {
      status: 'confirmed',
      attributedAddress: expectedTokenAddress,
      attributionType: 'factory_topic_reference',
      receipt,
    };
  }

  return {
    status: 'unresolved',
    reason: `Transaction succeeded on-chain, but no logs or event references match expected token address '${expectedTokenAddress}'`,
    receipt,
  };
}

// ============================================================================
// STRICT NATIVE PAYMENT VERIFIER (Phase DR — Anti-Spoofing Hardening)
// ============================================================================

export interface EvmNativePaymentCheckInput {
  from?: string | null;
  to?: string | null;
  valueWei: bigint;
  expectedFrom: string;
  expectedTo: string;
  minValueWei: bigint;
}

export interface EvmNativePaymentCheckResult {
  ok: boolean;
  code?: 'RECIPIENT_MISMATCH' | 'SENDER_MISMATCH' | 'INSUFFICIENT_PAYMENT_VALUE';
  reason?: string;
}

export interface EvmNativePaymentVerification {
  status: 'confirmed' | 'pending' | 'failed' | 'mismatch' | 'unknown' | 'error';
  code?: 'RECIPIENT_MISMATCH' | 'SENDER_MISMATCH' | 'INSUFFICIENT_PAYMENT_VALUE';
  from?: string;
  to?: string;
  valueWei?: bigint;
  blockNumber?: bigint;
  confirmations?: number;
  reason?: string;
}

export function ethStringToWei(ethAmount: string): bigint {
  try {
    return parseEther(String(ethAmount || '0').trim());
  } catch {
    return BigInt(0);
  }
}

/**
 * Pure deterministic invariant check for native ETH payments (Phase DR).
 * Strictly enforces: to === treasuryWallet, from === session.walletAddress, value >= minValueWei.
 */
export function validateEvmNativePaymentFields(
  input: EvmNativePaymentCheckInput
): EvmNativePaymentCheckResult {
  const actualTo = String(input.to || '').trim().toLowerCase();
  const expectedTo = String(input.expectedTo || '').trim().toLowerCase();
  if (!actualTo || actualTo !== expectedTo) {
    return {
      ok: false,
      code: 'RECIPIENT_MISMATCH',
      reason: `RECIPIENT_MISMATCH: Payment transaction recipient (${actualTo || 'none'}) does not match platform treasury (${expectedTo}).`,
    };
  }

  const actualFrom = String(input.from || '').trim().toLowerCase();
  const expectedFrom = String(input.expectedFrom || '').trim().toLowerCase();
  if (!actualFrom || actualFrom !== expectedFrom) {
    return {
      ok: false,
      code: 'SENDER_MISMATCH',
      reason: `SENDER_MISMATCH: Payment transaction sender (${actualFrom || 'none'}) does not match authenticated wallet (${expectedFrom}).`,
    };
  }

  if (input.valueWei < input.minValueWei) {
    return {
      ok: false,
      code: 'INSUFFICIENT_PAYMENT_VALUE',
      reason: `INSUFFICIENT_PAYMENT_VALUE: Sent ${input.valueWei.toString()} wei, but at least ${input.minValueWei.toString()} wei is required.`,
    };
  }

  return { ok: true };
}

/**
 * Strictly verifies an on-chain native ETH payment transaction on Base/EVM:
 *  1. Receipt exists and status === 'success'
 *  2. tx.to === expectedTo (Platform Treasury)
 *  3. tx.from === expectedFrom (Authenticated SIWE Wallet)
 *  4. tx.value >= minValueWei
 */
export async function verifyEvmNativePayment(params: {
  txHash: string;
  chain?: string;
  expectedFrom: string;
  expectedTo: string;
  minValueWei: bigint;
  minConfirmations?: number;
  customClient?: PublicClient;
}): Promise<EvmNativePaymentVerification> {
  const chain = params.chain || 'base-mainnet';
  if (!params.txHash || !/^0x[a-fA-F0-9]{64}$/.test(params.txHash)) {
    return {
      status: 'error',
      reason: `Malformed EVM transaction hash: '${sanitizeRpcText(params.txHash || '')}'`,
    };
  }

  try {
    const client = params.customClient ?? getEvmPublicClient(chain);
    if (!client) {
      return {
        status: 'error',
        reason: `UNSUPPORTED_EVM_CHAIN: Chain '${chain}' is not supported by EVM verifier`,
      };
    }

    const [receipt, tx] = await Promise.all([
      client.getTransactionReceipt({ hash: params.txHash as `0x${string}` }),
      client.getTransaction({ hash: params.txHash as `0x${string}` }),
    ]);

    if (!receipt || !tx) {
      return {
        status: 'pending',
        reason: 'Transaction receipt or payload not yet found on-chain',
      };
    }

    if (receipt.status === 'reverted') {
      return {
        status: 'failed',
        blockNumber: receipt.blockNumber,
        reason: 'Transaction reverted on-chain (execution failure)',
      };
    }

    if (receipt.status !== 'success') {
      return {
        status: 'unknown',
        blockNumber: receipt.blockNumber,
        reason: `Unexpected receipt status: ${String(receipt.status)}`,
      };
    }

    const fieldCheck = validateEvmNativePaymentFields({
      from: tx.from,
      to: tx.to,
      valueWei: tx.value,
      expectedFrom: params.expectedFrom,
      expectedTo: params.expectedTo,
      minValueWei: params.minValueWei,
    });

    if (!fieldCheck.ok) {
      return {
        status: 'mismatch',
        code: fieldCheck.code,
        from: tx.from,
        to: tx.to ?? undefined,
        valueWei: tx.value,
        blockNumber: receipt.blockNumber,
        reason: fieldCheck.reason,
      };
    }

    const minConfs = Math.max(1, Math.floor(Number(params.minConfirmations ?? 1)));
    let confirmations: number | undefined;
    if (typeof (client as any).getBlockNumber === 'function') {
      try {
        const latestBlock = await (client as any).getBlockNumber();
        if (typeof latestBlock === 'bigint' && typeof receipt.blockNumber === 'bigint') {
          confirmations = latestBlock >= receipt.blockNumber ? Number(latestBlock - receipt.blockNumber + 1n) : 0;
          if (confirmations < minConfs) {
            return {
              status: 'pending',
              from: tx.from,
              to: tx.to ?? undefined,
              valueWei: tx.value,
              blockNumber: receipt.blockNumber,
              confirmations,
              reason: `Awaiting minimum block confirmations (${confirmations}/${minConfs})`,
            };
          }
        }
      } catch {
        // Non-fatal if RPC node temporarily omits latest block lookup
      }
    }

    return {
      status: 'confirmed',
      from: tx.from,
      to: tx.to ?? undefined,
      valueWei: tx.value,
      blockNumber: receipt.blockNumber,
      ...(confirmations !== undefined ? { confirmations } : {}),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (lower.includes('not found') || lower.includes('could not be found')) {
      return {
        status: 'pending',
        reason: 'Transaction not yet indexed or not found on target chain',
      };
    }
    return {
      status: 'unknown',
      reason: `EVM RPC error: ${sanitizeRpcText(msg)}`,
    };
  }
}

// ============================================================================
// PHASE FM: STATELESS PRE-FLIGHT EVM SIMULATION (ETH_ESTIMATEGAS + REVERT GUARD)
// ============================================================================

export interface EvmPreflightSimulationResult {
  status: 'WILL_SUCCEED' | 'LIKELY_REVERT' | 'SKIPPED' | 'RPC_UNAVAILABLE';
  estimatedGas?: string;
  revertReason?: string;
  chainId: number;
  checkedAt: string;
}

export function decodeEvmRevertReason(rawError: string): string {
  const clean = sanitizeRpcText(String(rawError || ''));
  const lower = clean.toLowerCase();
  if (lower.includes('insufficient funds')) {
    return 'INSUFFICIENT_FUNDS: Wallet native ETH balance is insufficient for value + gas.';
  }
  if (lower.includes('allowance') || lower.includes('transferfrom')) {
    return 'ALLOWANCE_REQUIRED: Approve ERC-20 token allowance before signing swap.';
  }
  if (lower.includes('slippage') || lower.includes('too little received') || lower.includes('minreturn')) {
    return 'SLIPPAGE_EXCEEDED: Output moved beyond max slippage tolerance.';
  }
  if (lower.includes('revert') || lower.includes('execution reverted')) {
    return `EXECUTION_REVERTED: ${clean.slice(0, 140)}`;
  }
  return clean.slice(0, 140) || 'SIMULATION_FAILED';
}

/**
 * Read-only, non-custodial pre-flight EVM simulation (`eth_estimateGas`) before wallet sign.
 * Strictly bounded by a 4s timeout and never throws or blocks core quote delivery.
 */
export async function simulateEvmTransactionPreflight(params: {
  chainId: number;
  from: string;
  to: string;
  data?: string;
  value?: string;
  customEstimateGas?: (tx: { from: string; to: string; data?: string; value?: string }) => Promise<string | bigint>;
}): Promise<EvmPreflightSimulationResult> {
  const checkedAt = new Date().toISOString();
  const from = String(params.from || '').trim();
  const to = String(params.to || '').trim();

  if (!/^0x[a-fA-F0-9]{40}$/.test(from) || !/^0x[a-fA-F0-9]{40}$/.test(to)) {
    return { status: 'SKIPPED', chainId: params.chainId, checkedAt };
  }

  const hexValue = (() => {
    const raw = String(params.value || '0').trim();
    if (!raw || raw === '0' || raw === '0x0') return '0x0';
    if (raw.startsWith('0x')) return raw;
    try {
      return `0x${BigInt(raw).toString(16)}`;
    } catch {
      return '0x0';
    }
  })();

  if (params.customEstimateGas) {
    try {
      const est = await params.customEstimateGas({
        from,
        to,
        ...(params.data ? { data: params.data } : {}),
        value: hexValue,
      });
      const gasStr = typeof est === 'bigint' ? est.toString() : String(BigInt(est));
      return { status: 'WILL_SUCCEED', estimatedGas: gasStr, chainId: params.chainId, checkedAt };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'LIKELY_REVERT',
        revertReason: decodeEvmRevertReason(msg),
        chainId: params.chainId,
        checkedAt,
      };
    }
  }

  const urls = resolveEvmRpcUrls(String(params.chainId));
  if (urls.length === 0) {
    return { status: 'SKIPPED', chainId: params.chainId, checkedAt };
  }

  for (const rpcUrl of urls.slice(0, 2)) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_estimateGas',
          params: [
            {
              from,
              to,
              ...(params.data ? { data: params.data } : {}),
              value: hexValue,
            },
          ],
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const json: any = await res.json().catch(() => null);
      if (json?.result && typeof json.result === 'string' && json.result.startsWith('0x')) {
        return {
          status: 'WILL_SUCCEED',
          estimatedGas: BigInt(json.result).toString(),
          chainId: params.chainId,
          checkedAt,
        };
      }
      if (json?.error?.message) {
        return {
          status: 'LIKELY_REVERT',
          revertReason: decodeEvmRevertReason(json.error.message),
          chainId: params.chainId,
          checkedAt,
        };
      }
    } catch {
      // Try next fallback RPC
    }
  }

  return { status: 'RPC_UNAVAILABLE', chainId: params.chainId, checkedAt };
}
