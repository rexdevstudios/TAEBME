/**
 * packages/launchpad/bankr-client.ts
 *
 * Stateless, Vercel-Native Bankr Token Launch REST API Client.
 * Lifted cleanly from src/modules/evm/bankr-deployer.ts (zero src/ deps, zero fs, zero private keys).
 *
 * Endpoint: POST https://api.bankr.bot/token-launches/deploy
 * Safety invariant: NEVER blindly retries on timeout to prevent duplicate on-chain deployments.
 */

import { validateMultiChainFeeRecipient } from '../shared/credential-vault';

export const BANKR_DEPLOY_URL = 'https://api.bankr.bot/token-launches/deploy';

export type BankrSupportedChain = 'base' | 'robinhood' | 'arbitrum' | 'arc';

export interface BankrDeployRequest {
  tokenName: string;
  tokenSymbol: string;
  description?: string;
  image?: string;
  websiteUrl?: string;
  tweetUrl?: string;
  chain?: BankrSupportedChain;
  feeRecipient?: {
    type: 'wallet' | 'x' | 'farcaster' | 'ens';
    value: string;
  };
  degenMode?: boolean;
  simulateOnly?: boolean;
  apiKeyOverride?: string;
}

export interface BankrDeployResponse {
  status: 'deployed' | 'simulated' | 'unknown' | 'failed';
  tokenAddress?: string;
  poolId?: string;
  txHash?: string;
  chain: BankrSupportedChain;
  httpStatus?: number;
  message: string;
  keySource?: 'BYOK_VAULT' | 'PLATFORM_ENV';
}

export async function deployTokenViaBankrApi(
  payload: BankrDeployRequest
): Promise<BankrDeployResponse> {
  const overrideKey = payload.apiKeyOverride?.trim();
  const apiKey = overrideKey || process.env.BANKR_API_KEY?.trim();
  const keySource: 'BYOK_VAULT' | 'PLATFORM_ENV' = overrideKey ? 'BYOK_VAULT' : 'PLATFORM_ENV';
  const chain: BankrSupportedChain = payload.chain || 'base';

  validateMultiChainFeeRecipient(chain, payload.feeRecipient);

  if (!apiKey || apiKey.startsWith('mock_')) {
    return {
      status: 'failed',
      chain,
      keySource,
      message: 'BANKR_API_KEY belum tersedia. Tambahkan Bankr API Key Anda di Multi-Key BYOK Vault atau set di environment.',
    };
  }

  try {
    const res = await fetch(BANKR_DEPLOY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        tokenName: payload.tokenName.trim().slice(0, 30),
        tokenSymbol: payload.tokenSymbol.trim().toUpperCase().slice(0, 10),
        description: payload.description?.trim().slice(0, 280),
        image: payload.image,
        websiteUrl: payload.websiteUrl,
        tweetUrl: payload.tweetUrl,
        chain,
        feeRecipient: payload.feeRecipient,
        degenMode: payload.degenMode ?? true,
        simulateOnly: payload.simulateOnly ?? false,
      }),
      signal: AbortSignal.timeout(25000),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      return {
        status: 'failed',
        chain,
        httpStatus: res.status,
        message: String(data?.error || data?.message || `Bankr API returned HTTP ${res.status}`),
      };
    }

    return {
      status: payload.simulateOnly ? 'simulated' : 'deployed',
      tokenAddress: data?.tokenAddress || data?.address,
      poolId: data?.poolId,
      txHash: data?.txHash || data?.transactionHash,
      chain,
      httpStatus: res.status,
      message: payload.simulateOnly
        ? 'Bankr deployment simulation succeeded.'
        : 'Token deployed via Bankr Gas-Sponsored API.',
    };
  } catch (err: unknown) {
    // NEVER retry blindly on timeout/abort — return status 'unknown' to prevent duplicate launches
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: isTimeout ? 'unknown' : 'failed',
      chain,
      message: isTimeout
        ? 'BANKR_TIMEOUT_UNKNOWN: Request timed out. Check explorer/Bankr dashboard before retrying.'
        : 'BANKR_NETWORK_ERROR: Failed to contact Bankr API.',
    };
  }
}

export const MAX_BANKR_BATCH_ACCOUNTS = 5;

export interface BankrMultiAccountBatchValidation {
  valid: boolean;
  dedupedKeyIds: string[];
  requiredCredits: number;
  errorCode?: 'PLAN_MULTI_BANKR_REQUIRED' | 'BATCH_LIMIT_EXCEEDED' | 'INSUFFICIENT_CREDITS';
  errorMessage?: string;
}

/**
 * Pure deterministic validator for Sequential Multi-Account Bankr Fleet Deploy (Phase CD1).
 * - Exclusive to CREATOR (15 keys) & AGENT (25 keys) plans.
 * - Caps batch size at MAX_BANKR_BATCH_ACCOUNTS (5) to prevent serverless timeout & accidental spam.
 * - Pre-validates upfront credit balance (`launchCostCr * count`) when balance is provided.
 */
export function validateBankrMultiAccountBatch(params: {
  providerKeyIds: string[];
  planId: string;
  launchCostCr: number;
  userCreditBalance?: number | null;
  maxBatchSize?: number;
}): BankrMultiAccountBatchValidation {
  const dedupedKeyIds = Array.from(
    new Set(
      (Array.isArray(params.providerKeyIds) ? params.providerKeyIds : [])
        .map((id) => String(id || '').trim())
        .filter((id) => id.length > 0 && id !== 'PLATFORM_DEFAULT')
    )
  );
  const maxBatch = Math.max(1, Math.min(MAX_BANKR_BATCH_ACCOUNTS, Number(params.maxBatchSize ?? MAX_BANKR_BATCH_ACCOUNTS)));
  const perLaunchCost = Math.max(0, Number(params.launchCostCr ?? 50));
  const requiredCredits = perLaunchCost * dedupedKeyIds.length;
  const normPlan = String(params.planId || 'FREE').trim().toUpperCase();

  if (dedupedKeyIds.length > 1 && normPlan !== 'CREATOR' && normPlan !== 'AGENT') {
    return {
      valid: false,
      dedupedKeyIds,
      requiredCredits,
      errorCode: 'PLAN_MULTI_BANKR_REQUIRED',
      errorMessage:
        'PLAN_MULTI_BANKR_REQUIRED: Multi-Account Bankr Fleet Deploy eksklusif untuk paket Token Creator (CREATOR) dan AI Autonomous Desk (AGENT).',
    };
  }

  if (dedupedKeyIds.length > maxBatch) {
    return {
      valid: false,
      dedupedKeyIds,
      requiredCredits,
      errorCode: 'BATCH_LIMIT_EXCEEDED',
      errorMessage: `BATCH_LIMIT_EXCEEDED: Maksimal ${maxBatch} akun Bankr per batch deploy untuk keamanan & kestabilan eksekusi.`,
    };
  }

  if (
    typeof params.userCreditBalance === 'number' &&
    Number.isFinite(params.userCreditBalance) &&
    requiredCredits > 0 &&
    params.userCreditBalance < requiredCredits
  ) {
    return {
      valid: false,
      dedupedKeyIds,
      requiredCredits,
      errorCode: 'INSUFFICIENT_CREDITS',
      errorMessage: `INSUFFICIENT_CREDITS: Diperlukan ${requiredCredits} cr untuk ${dedupedKeyIds.length} akun Bankr (saldo Anda: ${params.userCreditBalance} cr).`,
    };
  }

  return {
    valid: true,
    dedupedKeyIds,
    requiredCredits,
  };
}

// ============================================================================
// BANKR AGENT API RAIL (Phase DK) — POST /agent/prompt & GET /agent/job/{id}
// ============================================================================
export const BANKR_AGENT_PROMPT_URL = 'https://api.bankr.bot/agent/prompt';
export const BANKR_AGENT_JOB_URL = 'https://api.bankr.bot/agent/job';
export const MAX_BANKR_AGENT_PROMPT_LEN = 1000;

export interface BankrAgentPromptValidation {
  valid: boolean;
  sanitizedPrompt: string;
  errorCode?: 'EMPTY_PROMPT' | 'PROMPT_TOO_LONG' | 'SENSITIVE_SECRET_DETECTED';
  errorMessage?: string;
}

export interface BankrAgentJobResponse {
  status: 'pending' | 'completed' | 'failed' | 'unknown';
  jobId?: string;
  response?: string;
  transactions?: unknown[];
  httpStatus?: number;
  message: string;
  keySource?: 'BYOK_VAULT' | 'PLATFORM_ENV';
}

/**
 * Pure deterministic validator for Bankr Agent API prompts (Phase DK).
 * Blocks empty/oversized prompts and prevents accidental private-key / seed-phrase exfiltration.
 */
export function validateBankrAgentPromptInput(rawPrompt: unknown): BankrAgentPromptValidation {
  const sanitizedPrompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : '';
  if (sanitizedPrompt.length < 3) {
    return {
      valid: false,
      sanitizedPrompt,
      errorCode: 'EMPTY_PROMPT',
      errorMessage: 'EMPTY_PROMPT: Prompt Bankr Agent minimal 3 karakter.',
    };
  }
  if (sanitizedPrompt.length > MAX_BANKR_AGENT_PROMPT_LEN) {
    return {
      valid: false,
      sanitizedPrompt,
      errorCode: 'PROMPT_TOO_LONG',
      errorMessage: `PROMPT_TOO_LONG: Maksimal ${MAX_BANKR_AGENT_PROMPT_LEN} karakter per perintah Bankr Agent.`,
    };
  }
  // Non-custodial guard: reject raw 64-hex private keys or mnemonic seed phrases
  if (/\b0x[a-fA-F0-9]{64}\b/.test(sanitizedPrompt) || /\b(seed phrase|mnemonic|private key)\b/i.test(sanitizedPrompt)) {
    return {
      valid: false,
      sanitizedPrompt: '',
      errorCode: 'SENSITIVE_SECRET_DETECTED',
      errorMessage: 'SENSITIVE_SECRET_DETECTED: Dilarang mengirim private key atau seed phrase ke prompt AI Agent.',
    };
  }
  return { valid: true, sanitizedPrompt };
}

export async function submitBankrAgentPrompt(params: {
  prompt: string;
  apiKeyOverride?: string;
}): Promise<BankrAgentJobResponse> {
  const check = validateBankrAgentPromptInput(params.prompt);
  if (!check.valid) {
    return {
      status: 'failed',
      message: check.errorMessage || 'INVALID_PROMPT',
    };
  }

  const overrideKey = params.apiKeyOverride?.trim();
  const apiKey = overrideKey || process.env.BANKR_API_KEY?.trim();
  const keySource: 'BYOK_VAULT' | 'PLATFORM_ENV' = overrideKey ? 'BYOK_VAULT' : 'PLATFORM_ENV';

  if (!apiKey || apiKey.startsWith('mock_')) {
    return {
      status: 'failed',
      keySource,
      message:
        'BANKR_API_KEY belum tersedia. Simpan Bankr API Key Anda di Multi-Key BYOK Vault terlebih dahulu.',
    };
  }

  try {
    const res = await fetch(BANKR_AGENT_PROMPT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({ prompt: check.sanitizedPrompt }),
      signal: AbortSignal.timeout(20000),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      return {
        status: 'failed',
        httpStatus: res.status,
        keySource,
        message: String(data?.error || data?.message || `Bankr Agent API returned HTTP ${res.status}`),
      };
    }

    const jobId = typeof data?.jobId === 'string' ? data.jobId : typeof data?.job_id === 'string' ? data.job_id : undefined;
    const rawStatus = String(data?.status || (jobId ? 'pending' : 'completed')).toLowerCase();
    const mappedStatus: BankrAgentJobResponse['status'] =
      rawStatus === 'completed' || rawStatus === 'done'
        ? 'completed'
        : rawStatus === 'failed' || rawStatus === 'error'
          ? 'failed'
          : 'pending';

    return {
      status: mappedStatus,
      jobId,
      response: typeof data?.response === 'string' ? data.response : undefined,
      transactions: Array.isArray(data?.transactions) ? data.transactions : undefined,
      httpStatus: res.status,
      keySource,
      message: jobId ? `Bankr Agent job submitted (${jobId}).` : 'Bankr Agent prompt accepted.',
    };
  } catch (err: unknown) {
    // NEVER blindly retry on timeout — return 'unknown' to prevent duplicate execution
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: isTimeout ? 'unknown' : 'failed',
      keySource,
      message: isTimeout
        ? 'BANKR_AGENT_TIMEOUT_UNKNOWN: Request timed out. Check Bankr job status before retrying.'
        : 'BANKR_AGENT_NETWORK_ERROR: Failed to contact Bankr Agent API.',
    };
  }
}

export async function getBankrAgentJobStatus(params: {
  jobId: string;
  apiKeyOverride?: string;
}): Promise<BankrAgentJobResponse> {
  const cleanJobId = String(params.jobId || '').trim();
  if (!cleanJobId || !/^[a-zA-Z0-9_-]{3,128}$/.test(cleanJobId)) {
    return {
      status: 'failed',
      message: 'INVALID_JOB_ID: jobId is required and must be alphanumeric.',
    };
  }

  const overrideKey = params.apiKeyOverride?.trim();
  const apiKey = overrideKey || process.env.BANKR_API_KEY?.trim();
  const keySource: 'BYOK_VAULT' | 'PLATFORM_ENV' = overrideKey ? 'BYOK_VAULT' : 'PLATFORM_ENV';

  if (!apiKey || apiKey.startsWith('mock_')) {
    return {
      status: 'failed',
      jobId: cleanJobId,
      keySource,
      message: 'BANKR_API_KEY belum tersedia di BYOK Vault atau environment.',
    };
  }

  try {
    const res = await fetch(`${BANKR_AGENT_JOB_URL}/${encodeURIComponent(cleanJobId)}`, {
      method: 'GET',
      headers: {
        'X-API-Key': apiKey,
      },
      signal: AbortSignal.timeout(15000),
    });

    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      return {
        status: 'failed',
        jobId: cleanJobId,
        httpStatus: res.status,
        keySource,
        message: String(data?.error || data?.message || `Bankr Job API returned HTTP ${res.status}`),
      };
    }

    const rawStatus = String(data?.status || 'pending').toLowerCase();
    const mappedStatus: BankrAgentJobResponse['status'] =
      rawStatus === 'completed' || rawStatus === 'done'
        ? 'completed'
        : rawStatus === 'failed' || rawStatus === 'error'
          ? 'failed'
          : 'pending';

    return {
      status: mappedStatus,
      jobId: cleanJobId,
      response: typeof data?.response === 'string' ? data.response : undefined,
      transactions: Array.isArray(data?.transactions) ? data.transactions : undefined,
      httpStatus: res.status,
      keySource,
      message: `Job ${cleanJobId} status: ${mappedStatus}`,
    };
  } catch (err: unknown) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      status: isTimeout ? 'unknown' : 'failed',
      jobId: cleanJobId,
      keySource,
      message: isTimeout
        ? 'BANKR_JOB_POLL_TIMEOUT: Timed out polling Bankr job status.'
        : 'BANKR_JOB_NETWORK_ERROR: Failed to poll Bankr job status.',
    };
  }
}
