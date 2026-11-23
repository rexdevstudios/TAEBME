/**
 * packages/intelligence/free-wallet-intelligence.ts
 *
 * Free Multi-Source On-Chain Wallet Intelligence Engine ($0/month — Phase BY).
 * Replaces paid Arkham Enterprise API with a 3-layer zero-cost stack:
 *   1. GoPlus Address Security Public API (free, no API key): real-time OFAC sanctions,
 *      cybercrime, phishing, stealing_attack, honeypot_related_address, mixer detection.
 *   2. Public EVM RPC Wallet Maturity (free): eth_getTransactionCount + eth_getBalance
 *      to distinguish fresh burner/sybil wallets from active veterans and whales.
 *   3. Curated Public Entity Registry (in-memory, 0ms): canonical Exchange & DeFi routers.
 *   4. Upstash Redis 24h Cache (`intel:wallet:{chainId}:{addr}`): <15ms repeat lookups.
 */

import { upstashRedis } from '../shared/redis-client';
import { isSupportedGoPlusChainId, isValidEvmAddress } from './onchain-insider-guard';
import type { ArkhamEntityProfile } from './arkham-enrichment';

export const WALLET_INTEL_CACHE_TTL_SECONDS = 86400; // 24 hours

export interface PublicWalletEntityMeta {
  name: string;
  entityType: ArkhamEntityProfile['arkhamEntityType'];
  baseScore: number;
  tags: string[];
}

export const KNOWN_PUBLIC_WALLET_ENTITIES: Record<string, PublicWalletEntityMeta> = {
  // 0x Protocol AllowanceHolder (Canonical v2 across EVM chains)
  '0x0000000000001ff3684f28c67538d4d072c22734': {
    name: '0x Protocol AllowanceHolder',
    entityType: 'DEVELOPER',
    baseScore: 95,
    tags: ['KNOWN_PUBLIC_ENTITY', 'DEX_ROUTER', 'VERIFIED_PROTOCOL'],
  },
  // Binance Hot Wallet 14
  '0x28c6c06298d514db089934071355e5743bf21d60': {
    name: 'Binance Hot Wallet',
    entityType: 'EXCHANGE',
    baseScore: 95,
    tags: ['KNOWN_PUBLIC_ENTITY', 'CEX_EXCHANGE'],
  },
  // Coinbase Commerce / Hot Wallet
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': {
    name: 'Coinbase Hot Wallet',
    entityType: 'EXCHANGE',
    baseScore: 95,
    tags: ['KNOWN_PUBLIC_ENTITY', 'CEX_EXCHANGE'],
  },
  // Bybit Hot Wallet
  '0xf89d7b9c864f589bbf53a82105107622b35eaa40': {
    name: 'Bybit Hot Wallet',
    entityType: 'EXCHANGE',
    baseScore: 94,
    tags: ['KNOWN_PUBLIC_ENTITY', 'CEX_EXCHANGE'],
  },
  // Uniswap Universal Router (Base)
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': {
    name: 'Uniswap Universal Router',
    entityType: 'DEVELOPER',
    baseScore: 95,
    tags: ['KNOWN_PUBLIC_ENTITY', 'DEX_ROUTER', 'VERIFIED_PROTOCOL'],
  },
  // Aerodrome Router (Base)
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': {
    name: 'Aerodrome Finance Router',
    entityType: 'DEVELOPER',
    baseScore: 94,
    tags: ['KNOWN_PUBLIC_ENTITY', 'DEX_ROUTER', 'VERIFIED_PROTOCOL'],
  },
  // Canonical Burn / Dead Address
  '0x000000000000000000000000000000000000dead': {
    name: 'Burn Address (0xdead)',
    entityType: 'DEVELOPER',
    baseScore: 90,
    tags: ['KNOWN_PUBLIC_ENTITY', 'BURN_ADDRESS'],
  },
};

const FREE_PUBLIC_RPC_BY_CHAIN: Record<number, string> = {
  1: 'https://eth.llamarpc.com',
  10: 'https://mainnet.optimism.io',
  56: 'https://bsc-dataseed.binance.org',
  137: 'https://polygon-rpc.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
};

export interface GoPlusAddressSecurityRaw {
  sanctioned?: string | number;
  cybercrime?: string | number;
  money_laundering?: string | number;
  financial_crime?: string | number;
  stealing_attack?: string | number;
  phishing_activities?: string | number;
  blackmail_activities?: string | number;
  darkweb_transactions?: string | number;
  honeypot_related_address?: string | number;
  fake_kyc?: string | number;
  malicious_mining_activities?: string | number;
  mixer?: string | number;
  contract_address?: string | number;
  number_of_malicious_contracts_created?: string | number;
}

export interface RpcWalletMaturity {
  txCount: number;
  balanceEth: number;
  rpcReachable: boolean;
}

function isTruthy(val: unknown): boolean {
  return val === '1' || val === 1 || val === true || val === 'true';
}

export function analyzeFreeWalletIntelligence(params: {
  address: string;
  chainId: number;
  goPlus?: GoPlusAddressSecurityRaw | null;
  rpcMaturity?: RpcWalletMaturity | null;
  source?: string;
}): ArkhamEntityProfile {
  const normalizedAddr = params.address.trim().toLowerCase();
  const knownEntity = KNOWN_PUBLIC_WALLET_ENTITIES[normalizedAddr];
  const gp = params.goPlus || {};
  const rpc = params.rpcMaturity;

  const criticalFlags: string[] = [];
  if (isTruthy(gp.sanctioned)) criticalFlags.push('SANCTIONED_OFAC');
  // Canonical audited DEX routers & CEX hot wallets frequently receive dust/swaps from phishers,
  // so only OFAC sanctions hard-block known verified entities; unknown wallets enforce all flags.
  if (!knownEntity) {
    if (isTruthy(gp.cybercrime)) criticalFlags.push('CYBERCRIME');
    if (isTruthy(gp.money_laundering)) criticalFlags.push('MONEY_LAUNDERING');
    if (isTruthy(gp.financial_crime)) criticalFlags.push('FINANCIAL_CRIME');
    if (isTruthy(gp.stealing_attack)) criticalFlags.push('STEALING_ATTACK');
    if (isTruthy(gp.phishing_activities)) criticalFlags.push('PHISHING_ACTIVITIES');
    if (isTruthy(gp.blackmail_activities)) criticalFlags.push('BLACKMAIL_ACTIVITIES');
    if (isTruthy(gp.darkweb_transactions)) criticalFlags.push('DARKWEB_TRANSACTIONS');
    if (isTruthy(gp.honeypot_related_address)) criticalFlags.push('HONEYPOT_RELATED');
  }

  const tags: string[] = [];
  let entityType: ArkhamEntityProfile['arkhamEntityType'] = knownEntity?.entityType || 'UNKNOWN';
  let entityName = knownEntity?.name || 'On-Chain Wallet';
  let score = knownEntity?.baseScore ?? 75;
  let isCounterpartyBlocked = false;

  if (knownEntity) {
    tags.push(...knownEntity.tags);
  }

  if (criticalFlags.length > 0) {
    entityType = 'SANCTIONED';
    entityName = `Blocked Malicious Wallet (${criticalFlags[0]})`;
    score = 0;
    isCounterpartyBlocked = true;
    tags.push(...criticalFlags);
  } else {
    if (isTruthy(gp.mixer)) {
      score -= 35;
      tags.push('MIXER_EXPOSURE');
    }
    if (isTruthy(gp.fake_kyc)) {
      score -= 25;
      tags.push('FAKE_KYC');
    }
    if (isTruthy(gp.malicious_mining_activities)) {
      score -= 25;
      tags.push('MALICIOUS_MINING');
    }
    const maliciousContracts = Number(gp.number_of_malicious_contracts_created || 0);
    if (Number.isFinite(maliciousContracts) && maliciousContracts > 0) {
      score -= 40;
      tags.push('MALICIOUS_CONTRACT_DEPLOYER');
    }
    if (isTruthy(gp.contract_address) && entityType === 'UNKNOWN') {
      entityType = 'DEVELOPER';
      entityName = 'Smart Contract Address';
      tags.push('SMART_CONTRACT');
    }

    if (rpc?.rpcReachable && !knownEntity) {
      if (rpc.txCount === 0 && rpc.balanceEth < 0.001) {
        score -= 15;
        tags.push('FRESH_BURNER_WALLET');
      } else if (rpc.txCount >= 50) {
        score += 10;
        tags.push('VETERAN_WALLET');
      }
      if (rpc.balanceEth >= 10) {
        if (entityType === 'UNKNOWN') {
          entityType = 'WHALE';
          entityName = 'High-Balance On-Chain Whale';
        }
        score += 5;
        tags.push('HIGH_BALANCE_WHALE');
      }
    }

    if (tags.length === 0) {
      tags.push(params.goPlus ? 'GOPLUS_VERIFIED_CLEAN' : 'FALLBACK_NEUTRAL');
    }
  }

  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));

  return {
    walletAddress: params.address.trim(),
    arkhamEntityName: entityName,
    arkhamEntityType: entityType,
    riskPassportScore: clampedScore,
    isCounterpartyBlocked,
    tags: Array.from(new Set(tags)),
    rawIntelligence: {
      provider: params.source || 'FREE_ONCHAIN_GUARD_GOPLUS_RPC',
      chainId: params.chainId,
      goPlusChecked: Boolean(params.goPlus),
      rpcChecked: Boolean(rpc?.rpcReachable),
      txCount: rpc?.txCount ?? null,
      balanceEth: rpc?.balanceEth ?? null,
      criticalFlags,
    },
  };
}

async function fetchRpcWalletMaturity(
  address: string,
  chainId: number,
  fetchImpl: typeof fetch
): Promise<RpcWalletMaturity | null> {
  const rpcUrl = FREE_PUBLIC_RPC_BY_CHAIN[chainId];
  if (!rpcUrl) return null;

  try {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [address, 'latest'] },
        { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [address, 'latest'] },
      ]),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Array<{ id?: number; result?: string }>;
    if (!Array.isArray(json)) return null;

    const txHex = json.find((item) => item?.id === 1)?.result;
    const balHex = json.find((item) => item?.id === 2)?.result;
    if (!txHex || !balHex) return null;

    const txCount = Number.parseInt(txHex, 16);
    const balanceWei = BigInt(balHex);
    const balanceEth = Number(balanceWei / BigInt(1e12)) / 1e6;

    return {
      txCount: Number.isFinite(txCount) ? txCount : 0,
      balanceEth: Number.isFinite(balanceEth) ? Math.round(balanceEth * 10000) / 10000 : 0,
      rpcReachable: true,
    };
  } catch {
    return null;
  }
}

export async function fetchFreeWalletProfile(params: {
  address: string;
  chainId?: number;
  fetchImpl?: typeof fetch;
  bypassCache?: boolean;
}): Promise<ArkhamEntityProfile> {
  const chainId = typeof params.chainId === 'number' && isSupportedGoPlusChainId(params.chainId) ? params.chainId : 8453;
  const rawAddr = String(params.address || '').trim();

  if (!isValidEvmAddress(rawAddr)) {
    return analyzeFreeWalletIntelligence({
      address: rawAddr,
      chainId,
      goPlus: null,
      rpcMaturity: null,
      source: 'INVALID_ADDRESS_FALLBACK',
    });
  }

  const normalizedAddr = rawAddr.toLowerCase();
  const cacheKey = `intel:wallet:${chainId}:${normalizedAddr}`;

  if (!params.bypassCache && upstashRedis.isConfigured()) {
    const cachedRaw = await upstashRedis.get<string>(cacheKey).catch(() => null);
    if (cachedRaw) {
      try {
        const parsed = (typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw) as ArkhamEntityProfile;
        if (parsed && typeof parsed.riskPassportScore === 'number') {
          return {
            ...parsed,
            rawIntelligence: {
              ...(parsed.rawIntelligence || {}),
              provider: 'FREE_ONCHAIN_GUARD_REDIS_24H',
            },
          };
        }
      } catch {
        // Ignore corrupt cache
      }
    }
  }

  const fetcher = params.fetchImpl ?? fetch;

  const [goPlusRes, rpcRes] = await Promise.allSettled([
    fetcher(
      `https://api.gopluslabs.io/api/v1/address_security/${encodeURIComponent(normalizedAddr)}?chain_id=${chainId}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      }
    ).then(async (r) => {
      if (!r.ok) return null;
      const json = (await r.json()) as { result?: GoPlusAddressSecurityRaw };
      return json?.result ?? null;
    }),
    fetchRpcWalletMaturity(normalizedAddr, chainId, fetcher),
  ]);

  const goPlus = goPlusRes.status === 'fulfilled' ? goPlusRes.value : null;
  const rpcMaturity = rpcRes.status === 'fulfilled' ? rpcRes.value : null;

  const profile = analyzeFreeWalletIntelligence({
    address: rawAddr,
    chainId,
    goPlus,
    rpcMaturity,
    source: 'FREE_ONCHAIN_GUARD_GOPLUS_RPC',
  });

  if (upstashRedis.isConfigured()) {
    await upstashRedis.set(cacheKey, JSON.stringify(profile), WALLET_INTEL_CACHE_TTL_SECONDS).catch(() => false);
  }

  return profile;
}
