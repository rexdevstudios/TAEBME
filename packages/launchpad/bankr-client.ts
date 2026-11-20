/**
 * packages/launchpad/bankr-client.ts
 *
 * Stateless, Vercel-Native Bankr Token Launch REST API Client.
 * Lifted cleanly from src/modules/evm/bankr-deployer.ts (zero src/ deps, zero fs, zero private keys).
 *
 * Endpoint: POST https://api.bankr.bot/token-launches/deploy
 * Safety invariant: NEVER blindly retries on timeout to prevent duplicate on-chain deployments.
 */

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
}

export interface BankrDeployResponse {
  status: 'deployed' | 'simulated' | 'unknown' | 'failed';
  tokenAddress?: string;
  poolId?: string;
  txHash?: string;
  chain: BankrSupportedChain;
  httpStatus?: number;
  message: string;
}

export async function deployTokenViaBankrApi(
  payload: BankrDeployRequest
): Promise<BankrDeployResponse> {
  const apiKey = process.env.BANKR_API_KEY?.trim();
  const chain: BankrSupportedChain = payload.chain || 'base';

  if (!apiKey || apiKey.startsWith('mock_')) {
    return {
      status: 'failed',
      chain,
      message: 'BANKR_API_KEY is not configured in Vercel environment variables.',
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
