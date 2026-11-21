/**
 * packages/providers/registry.ts
 *
 * Unified Modular Provider Registry for CEX Execution, Multi-Chain Launchpads, and AI LLM Engines.
 * Enables plug-and-play onboarding of new providers (e.g. Bybit, OKX, Pump.fun, Clanker)
 * while automatically inheriting AES-256-GCM vaulting, Soft-Freeze quotas, and TradingRiskGate.
 */

export type ProviderCategory = 'CEX' | 'LAUNCHPAD' | 'LLM' | 'NOTIFICATION';
export type ProviderStatus = 'LIVE' | 'ADAPTER_READY' | 'ROADMAP';

export interface ProviderDescriptor {
  id: string;
  name: string;
  category: ProviderCategory;
  status: ProviderStatus;
  vaultKeyProvider: string;
  supportedChainsOrMarkets: string[];
  nonCustodialGuard: string;
  supportsByok: boolean;
}

export interface CexExecutionAdapterContract {
  providerId: string;
  verifyLivePermissions: (creds: { apiKey: string; secretKey: string; environment: 'TESTNET' | 'MAINNET' }) => Promise<{
    connected: boolean;
    canTrade: boolean;
    canWithdraw: boolean;
    latencyMs: number;
    error?: string;
  }>;
}

export interface LaunchpadAdapterContract {
  providerId: string;
  supportedChains: string[];
  supportsFeeRecipientTypes: Array<'wallet' | 'x' | 'farcaster' | 'ens'>;
}

const REGISTRY_ITEMS: ProviderDescriptor[] = [
  {
    id: 'BINANCE',
    name: 'Binance Spot CEX',
    category: 'CEX',
    status: 'LIVE',
    vaultKeyProvider: 'BINANCE',
    supportedChainsOrMarkets: ['SPOT_TESTNET', 'SPOT_MAINNET'],
    nonCustodialGuard: 'AES-256-GCM + No-Withdrawal Guard + Live Ping Verifier',
    supportsByok: true,
  },
  {
    id: 'BYBIT',
    name: 'Bybit Unified Spot/Perp',
    category: 'CEX',
    status: 'ADAPTER_READY',
    vaultKeyProvider: 'BYBIT',
    supportedChainsOrMarkets: ['SPOT_TESTNET', 'SPOT_MAINNET'],
    nonCustodialGuard: 'AES-256-GCM + No-Withdrawal Guard',
    supportsByok: true,
  },
  {
    id: 'BANKR',
    name: 'Bankr Gas-Sponsored Launchpad',
    category: 'LAUNCHPAD',
    status: 'LIVE',
    vaultKeyProvider: 'BANKR',
    supportedChainsOrMarkets: ['base', 'robinhood', 'arbitrum', 'arc'],
    nonCustodialGuard: 'AES-256-GCM + Multi-Chain Scope Isolation + Anti-PK Guard',
    supportsByok: true,
  },
  {
    id: 'PUMPFUN',
    name: 'Pump.fun Solana Bonding Curve',
    category: 'LAUNCHPAD',
    status: 'ADAPTER_READY',
    vaultKeyProvider: 'PUMPFUN',
    supportedChainsOrMarkets: ['solana'],
    nonCustodialGuard: 'Non-Custodial Browser Wallet Sign Only',
    supportsByok: false,
  },
  {
    id: 'BYTEPLUS',
    name: 'ByteDance / BytePlus ModelArk (Default)',
    category: 'LLM',
    status: 'LIVE',
    vaultKeyProvider: 'PLATFORM',
    supportedChainsOrMarkets: ['5-agent-desk', 'creator-asset-studio'],
    nonCustodialGuard: 'Advisory Only · Sanitized Prompt (Zero PII/Keys)',
    supportsByok: false,
  },
  {
    id: 'GEMINI',
    name: 'Google Gemini (2.5 Flash / 2.5 Pro — Failover & BYOK)',
    category: 'LLM',
    status: 'LIVE',
    vaultKeyProvider: 'GEMINI',
    supportedChainsOrMarkets: ['5-agent-desk', 'creator-asset-studio'],
    nonCustodialGuard: 'TRADER & AGENT Exclusive · AES-256-GCM BYOK Vault · 60% Credit Discount',
    supportsByok: true,
  },
  {
    id: 'OPENAI',
    name: 'OpenAI (GPT-4o-mini / GPT-4o — BYOK)',
    category: 'LLM',
    status: 'LIVE',
    vaultKeyProvider: 'OPENAI',
    supportedChainsOrMarkets: ['5-agent-desk'],
    nonCustodialGuard: 'TRADER & AGENT Exclusive · AES-256-GCM BYOK Vault · 60% Credit Discount',
    supportsByok: true,
  },
  {
    id: 'ANTHROPIC',
    name: 'Anthropic Claude (3.5 Sonnet / 3.5 Haiku / Opus 4 — BYOK)',
    category: 'LLM',
    status: 'LIVE',
    vaultKeyProvider: 'ANTHROPIC',
    supportedChainsOrMarkets: ['5-agent-desk'],
    nonCustodialGuard: 'TRADER & AGENT Exclusive · AES-256-GCM BYOK Vault · 60% Credit Discount',
    supportsByok: true,
  },
  {
    id: 'WEBHOOK',
    name: 'Outbound Alert Webhook (Discord / Telegram / Custom HTTPS)',
    category: 'NOTIFICATION',
    status: 'LIVE',
    vaultKeyProvider: 'WEBHOOK',
    supportedChainsOrMarkets: ['order-alerts', 'risk-alerts', 'launch-alerts'],
    nonCustodialGuard: 'SSRF-Safe HTTPS-Only Dispatcher (Blocks Private/Local IPs)',
    supportsByok: true,
  },
];

export class ProviderRegistry {
  static listAll(): ProviderDescriptor[] {
    return REGISTRY_ITEMS.map((item) => ({ ...item }));
  }

  static listByCategory(category: ProviderCategory): ProviderDescriptor[] {
    return REGISTRY_ITEMS.filter((item) => item.category === category).map((item) => ({ ...item }));
  }

  static getById(id: string): ProviderDescriptor | null {
    const norm = (id || '').trim().toUpperCase();
    return REGISTRY_ITEMS.find((item) => item.id === norm) || null;
  }

  static getDefaultLlmProvider(): { primary: string; failover: string; finalFallback: string } {
    const primaryPref = (process.env.AI_PRIMARY_PROVIDER || 'byteplus').trim().toLowerCase();
    return {
      primary: primaryPref === 'gemini' ? 'GEMINI' : 'BYTEPLUS',
      failover: primaryPref === 'gemini' ? 'BYTEPLUS' : 'GEMINI',
      finalFallback: 'DETERMINISTIC_FALLBACK',
    };
  }
}
