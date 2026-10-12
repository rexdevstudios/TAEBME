// ============================================================================
// RTRADER ENVIRONMENT CONFIGURATION & ISOLATION MODULE
// ============================================================================
//
// Invariants:
// 1. Strict separation of testnet (Base Sepolia: 84532) and production (Base Mainnet: 8453).
// 2. Fail-closed: Never silently fall back from testnet to production or vice-versa.
// 3. Reject unallowlisted or mismatched Host headers (anti-host-header-injection).
// 4. Redis keys are strictly namespaced by environment (e.g., testnet:*, prod:*).
// ============================================================================

export type AppEnvironment = 'production' | 'testnet' | 'development' | 'test';

export interface EnvironmentConfig {
  env: AppEnvironment;
  domain: string;
  canonicalUrl: string;
  chainId: number;
  chainHex: string;
  chainName: string;
  redisPrefix: string;
}

const ALLOWED_DOMAINS: Record<string, AppEnvironment> = {
  'rbtrade.fun': 'production',
  'www.rbtrade.fun': 'production',
  'testnet.rbtrade.fun': 'testnet',
  'staging.rbtrade.fun': 'testnet',
  'rtrader-degen-platform.vercel.app': 'production',
  'localhost': 'development',
  '127.0.0.1': 'development',
};

/**
 * Resolves active application environment.
 * Priority: APP_ENV -> NEXT_PUBLIC_APP_ENV -> NODE_ENV mapping
 */
export function getAppEnvironment(): AppEnvironment {
  const custom = (process.env.APP_ENV || process.env.NEXT_PUBLIC_APP_ENV)?.toLowerCase()?.trim();
  if (custom === 'production' || custom === 'prod') return 'production';
  if (custom === 'testnet' || custom === 'staging') return 'testnet';
  if (custom === 'development' || custom === 'dev') return 'development';
  if (custom === 'test') return 'test';

  const nodeEnv = process.env.NODE_ENV?.toLowerCase()?.trim();
  if (nodeEnv === 'test') return 'test';
  if (nodeEnv === 'production') {
    // If NEXT_PUBLIC_DEFAULT_CHAIN_ID or NEXT_PUBLIC_APP_URL indicates testnet
    const defaultChain = process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID?.trim();
    if (defaultChain === '84532') return 'testnet';
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.toLowerCase()?.trim() || '';
    if (appUrl.includes('testnet')) return 'testnet';
    return 'production';
  }

  return 'development';
}

/**
 * Returns the environment configuration for the active environment.
 */
export function getEnvironmentConfig(envOverride?: AppEnvironment): EnvironmentConfig {
  const env = envOverride || getAppEnvironment();

  switch (env) {
    case 'production':
      return {
        env: 'production',
        domain: 'rbtrade.fun',
        canonicalUrl: 'https://rbtrade.fun',
        chainId: 8453,
        chainHex: '0x2105',
        chainName: 'Base Mainnet',
        redisPrefix: 'prod:',
      };
    case 'testnet':
      return {
        env: 'testnet',
        domain: 'testnet.rbtrade.fun',
        canonicalUrl: 'https://testnet.rbtrade.fun',
        chainId: 84532,
        chainHex: '0x14a34',
        chainName: 'Base Sepolia Testnet',
        redisPrefix: 'testnet:',
      };
    case 'test':
      return {
        env: 'test',
        domain: 'localhost:3000',
        canonicalUrl: 'http://localhost:3000',
        chainId: process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID === '8453' ? 8453 : 84532,
        chainHex: process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID === '8453' ? '0x2105' : '0x14a34',
        chainName: process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID === '8453' ? 'Base Mainnet' : 'Base Sepolia Testnet',
        redisPrefix: 'test:',
      };
    case 'development':
    default:
      return {
        env: 'development',
        domain: 'localhost:3000',
        canonicalUrl: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        chainId: process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID === '8453' ? 8453 : 84532,
        chainHex: process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID === '8453' ? '0x2105' : '0x14a34',
        chainName: process.env.NEXT_PUBLIC_DEFAULT_CHAIN_ID === '8453' ? 'Base Mainnet' : 'Base Sepolia Testnet',
        redisPrefix: 'dev:',
      };
  }
}

/**
 * Validates request Host against allowlist and current environment.
 * Throws an explicit error if Host is untrusted or mismatches the active environment (Fail-Closed).
 */
export function validateAndResolveHost(rawHost?: string | null): { domain: string; env: AppEnvironment } {
  const currentEnv = getAppEnvironment();
  const config = getEnvironmentConfig(currentEnv);

  if (!rawHost || typeof rawHost !== 'string') {
    return { domain: config.domain, env: currentEnv };
  }

  // Strip port if present (e.g., localhost:3000 -> localhost)
  const cleanHost = rawHost.split(':')[0].toLowerCase().trim();

  // Allow test/dev environments to accept localhost / 127.0.0.1
  if ((currentEnv === 'development' || currentEnv === 'test') && (cleanHost === 'localhost' || cleanHost === '127.0.0.1')) {
    return { domain: rawHost.toLowerCase().trim(), env: currentEnv };
  }

  const matchedEnv = ALLOWED_DOMAINS[cleanHost];
  if (!matchedEnv) {
    if (currentEnv === 'production' || currentEnv === 'testnet') {
      throw new Error(`SECURITY_ERROR: Untrusted Host header "${rawHost}". Host not allowlisted for ${currentEnv}.`);
    }
    return { domain: config.domain, env: currentEnv };
  }

  if ((currentEnv === 'production' && matchedEnv !== 'production') ||
      (currentEnv === 'testnet' && matchedEnv !== 'testnet')) {
    throw new Error(`ENVIRONMENT_MISMATCH: Host "${rawHost}" (${matchedEnv}) does not match active environment "${currentEnv}".`);
  }

  return { domain: cleanHost, env: matchedEnv };
}

/**
 * Authoritative SIWE configuration resolver for the active request.
 */
export function getSiweConfig(reqHost?: string | null): {
  domain: string;
  uri: string;
  chainId: number;
  statement: string;
} {
  const currentEnv = getAppEnvironment();
  const config = getEnvironmentConfig(currentEnv);
  const resolved = validateAndResolveHost(reqHost);

  const protocol = (currentEnv === 'development' || currentEnv === 'test') && resolved.domain.includes('localhost')
    ? 'http'
    : 'https';

  const uri = `${protocol}://${resolved.domain}/auth/login`;

  return {
    domain: resolved.domain,
    uri,
    chainId: config.chainId,
    statement: 'Sign in to Degen Launchpad & Trading Terminal Platform',
  };
}

/**
 * Prefixes a Redis key with the active environment namespace (e.g. `testnet:siwe:...`).
 */
export function formatRedisKey(rawKey: string): string {
  const config = getEnvironmentConfig();
  const prefix = config.redisPrefix;

  if (rawKey.startsWith('prod:') || rawKey.startsWith('testnet:') || rawKey.startsWith('dev:') || rawKey.startsWith('test:')) {
    return rawKey;
  }

  return `${prefix}${rawKey}`;
}

/**
 * Returns canonical app URL for links, OpenGraph, and redirects.
 */
export function getCanonicalAppUrl(): string {
  const config = getEnvironmentConfig();
  return config.canonicalUrl;
}

/**
 * Validates that smart contract configuration and chainId are strictly consistent with the environment.
 */
export function validateChainAndContractConsistency(targetChainId: number): void {
  const currentEnv = getAppEnvironment();

  if (currentEnv === 'production' && targetChainId !== 8453) {
    throw new Error(`SECURITY_MISCONFIGURATION: Production environment is locked to Base Mainnet (8453). Received chainId: ${targetChainId}`);
  }

  if (currentEnv === 'testnet' && targetChainId !== 84532) {
    throw new Error(`SECURITY_MISCONFIGURATION: Testnet environment is locked to Base Sepolia (84532). Received chainId: ${targetChainId}`);
  }
}
