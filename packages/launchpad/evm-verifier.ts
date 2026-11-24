// ============================================================================
// LAUNCHPAD EVM ON-CHAIN RECEIPT & DEPLOYMENT VERIFIER (NON-CUSTODIAL, VERCEL-SAFE)
// ============================================================================
// Pure read-only EVM verifier using viem public clients.
// Zero private keys, zero legacy src/ dependencies.
// ============================================================================

import {
  createPublicClient,
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
 * Returns a configured read-only viem PublicClient for the specified EVM chain.
 */
export function getEvmPublicClient(
  chain = 'base-mainnet'
): PublicClient<Transport, Chain, Account | undefined> | null {
  const normalized = chain.trim().toLowerCase();
  const timeout = Number(process.env.RPC_TIMEOUT_MS) || 15_000;

  if (normalized === 'base' || normalized === 'base-mainnet' || normalized === 'clanker') {
    const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    return createPublicClient({
      chain: base,
      transport: http(rpcUrl, { timeout }),
    }) as PublicClient;
  }

  if (normalized === 'base-sepolia' || normalized === 'base_sepolia') {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
    return createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl, { timeout }),
    }) as PublicClient;
  }

  if (normalized === 'robinhood' || normalized === 'robinhood-mainnet') {
    const rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
    return createPublicClient({
      chain: robinhoodChain,
      transport: http(rpcUrl, { timeout }),
    }) as PublicClient;
  }

  if (normalized === 'arbitrum' || normalized === 'arbitrum-mainnet') {
    const rpcUrl = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
    return createPublicClient({
      chain: arbitrumChain,
      transport: http(rpcUrl, { timeout }),
    }) as PublicClient;
  }

  if (normalized === 'arc' || normalized === 'arc-mainnet') {
    const rpcUrl = process.env.ARC_RPC_URL || 'https://rpc.arc.network';
    return createPublicClient({
      chain: arcChain,
      transport: http(rpcUrl, { timeout }),
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

    return {
      status: 'confirmed',
      from: tx.from,
      to: tx.to ?? undefined,
      valueWei: tx.value,
      blockNumber: receipt.blockNumber,
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
