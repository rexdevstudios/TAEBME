import { EventEmitter } from 'events';

export type RpcProviderType = 'DRPC' | 'DRPC_NODECLOUD' | 'DRPC_NODECORE' | 'ALCHEMY' | 'ANKR' | 'QUIKNODE' | 'CUSTOM';
export type RpcPurpose = 'PRIMARY' | 'FALLBACK' | 'ARCHIVE' | 'INDEXER' | 'TRANSACT';
export type RpcHealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';

export interface NetworkDefinition {
  networkId: string;
  chainId: number;
  name: string;
  aliases: string[];
}

export const KNOWN_NETWORKS: Record<string, NetworkDefinition> = {
  'base-mainnet': {
    networkId: 'base-mainnet',
    chainId: 8453,
    name: 'Base Mainnet',
    aliases: ['base-mainnet', '8453', '0x2105', 'base'],
  },
  'base-sepolia': {
    networkId: 'base-sepolia',
    chainId: 84532,
    name: 'Base Sepolia Testnet',
    aliases: ['base-sepolia', '84532', '0x14a34', 'sepolia'],
  },
  'robinhood-mainnet': {
    networkId: 'robinhood-mainnet',
    chainId: 4663,
    name: 'Robinhood Chain L2',
    aliases: ['robinhood-mainnet', '4663', '0x1237', 'robinhood'],
  },
  'bsc-mainnet': {
    networkId: 'bsc-mainnet',
    chainId: 56,
    name: 'BNB Smart Chain Mainnet',
    aliases: ['bsc-mainnet', '56', '0x38', 'bsc'],
  },
  'bsc-testnet': {
    networkId: 'bsc-testnet',
    chainId: 97,
    name: 'BNB Smart Chain Testnet',
    aliases: ['bsc-testnet', '97', '0x61'],
  },
  'arbitrum-mainnet': {
    networkId: 'arbitrum-mainnet',
    chainId: 42161,
    name: 'Arbitrum One',
    aliases: ['arbitrum-mainnet', 'arbitrum', '42161', '0xa4b1'],
  },
  'polygon-mainnet': {
    networkId: 'polygon-mainnet',
    chainId: 137,
    name: 'Polygon Mainnet',
    aliases: ['polygon-mainnet', 'polygon', '137', '0x89'],
  },
  'optimism-mainnet': {
    networkId: 'optimism-mainnet',
    chainId: 10,
    name: 'Optimism Mainnet',
    aliases: ['optimism-mainnet', 'optimism', '10', '0xa'],
  },
  'arc-mainnet': {
    networkId: 'arc-mainnet',
    chainId: 5042,
    name: 'Arc Mainnet',
    aliases: ['arc-mainnet', 'arc', '5042', '0x13b2'],
  },
};

export function resolveNetworkDefinition(rawChainOrAlias?: string | null): NetworkDefinition | null {
  if (!rawChainOrAlias || typeof rawChainOrAlias !== 'string') return null;
  const clean = rawChainOrAlias.toLowerCase().trim();
  for (const def of Object.values(KNOWN_NETWORKS)) {
    if (def.networkId === clean || def.aliases.includes(clean)) {
      return def;
    }
  }
  return null;
}

export function isCompatibleChainAlias(chainA: string, chainB: string): boolean {
  if (chainA === chainB) return true;
  const defA = resolveNetworkDefinition(chainA);
  const defB = resolveNetworkDefinition(chainB);
  if (defA && defB && defA.networkId === defB.networkId) return true;
  return false;
}

export interface RpcEndpointConfig {
  id: string;
  networkId: string;
  provider: RpcProviderType;
  purpose: RpcPurpose;
  httpUrl: string;
  wsUrl?: string;
  priority: number;
  weight: number;
  rateLimitRps: number;
  isActive: boolean;
  healthStatus: RpcHealthStatus;
  latencyMs: number;
}

export interface RpcDomainConfig {
  domain: 'LAUNCHPAD' | 'INTELLIGENCE' | 'TRADING' | 'AGENT' | 'BILLING';
  networkId: string;
  primaryRpcId: string;
  fallbackRpcId?: string;
  archiveRpcId?: string;
}

export interface AuditLogEntry {
  actorId: string;
  action: string;
  entityId?: string;
  payloadBefore?: unknown;
  payloadAfter?: unknown;
  reason?: string;
}

export interface DatabaseAdapter {
  getEndpointsForNetwork(networkId: string): Promise<RpcEndpointConfig[]>;
  getDomainConfig(domain: string, networkId: string): Promise<RpcDomainConfig | null>;
  updateEndpointHealth(endpointId: string, health: RpcHealthStatus, latencyMs: number): Promise<void>;
  createAuditLog(entry: AuditLogEntry): Promise<void>;
}

export interface PubSubAdapter {
  subscribe(channel: string, callback: (message: string) => void): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
}

export class ModularRpcManager extends EventEmitter {
  private cache: Map<string, RpcEndpointConfig[]> = new Map();
  private domainConfigs: Map<string, RpcDomainConfig> = new Map();
  private consecutiveFailures: Map<string, number> = new Map();
  private readonly RPC_PUBSUB_CHANNEL = 'rpc_config_updated_pubsub';

  constructor(
    private db: DatabaseAdapter,
    private pubsub?: PubSubAdapter
  ) {
    super();
  }

  /**
   * Inisialisasi RPC Manager: Connect ke PubSub untuk hot-reload tanpa redeploy.
   */
  async initialize(): Promise<void> {
    if (this.pubsub) {
      await this.pubsub.subscribe(this.RPC_PUBSUB_CHANNEL, async (message: string) => {
        console.log(`[RPC Manager] Received hot-reload pubsub event: ${message}`);
        await this.reloadConfig();
        this.emit('hot_reloaded', message);
      });
    }
  }

  /**
   * Mengambil URL RPC aktif berdasarkan network dan domain (misal: LAUNCHPAD, TRADING).
   * Mendukung otomatisasi fallback dari Primary (dRPC) ke Fallback (Ankr/Alchemy).
   */
  async getActiveHttpRpc(networkId: string, domain: 'LAUNCHPAD' | 'INTELLIGENCE' | 'TRADING' | 'AGENT' | 'BILLING'): Promise<string> {
    const domainKey = `${domain}:${networkId}`;
    let domainCfg = this.domainConfigs.get(domainKey);

    if (!domainCfg) {
      const fetched = await this.db.getDomainConfig(domain, networkId);
      if (fetched) {
        domainCfg = fetched;
        this.domainConfigs.set(domainKey, fetched);
      }
    }

    let endpoints = this.cache.get(networkId);
    if (!endpoints) {
      endpoints = await this.db.getEndpointsForNetwork(networkId);
      this.cache.set(networkId, endpoints);
    }

    // Filter endpoints aktif & healthy
    const healthyEndpoints = endpoints.filter(e => e.isActive && e.healthStatus !== 'UNHEALTHY');

    if (healthyEndpoints.length === 0) {
      throw new Error(`[RPC Error] No healthy RPC endpoints available for network: ${networkId}`);
    }

    // Cek apakah ada primary RPC khusus domain
    if (domainCfg?.primaryRpcId) {
      const primary = healthyEndpoints.find(e => e.id === domainCfg!.primaryRpcId);
      if (primary && (this.consecutiveFailures.get(primary.id) || 0) < 3) {
        return primary.httpUrl;
      }
    }

    // Fallback ke Secondary RPC jika Primary gagal
    if (domainCfg?.fallbackRpcId) {
      const fallback = healthyEndpoints.find(e => e.id === domainCfg!.fallbackRpcId);
      if (fallback) {
        console.warn(`[RPC Fallback] Routing traffic for domain ${domain} to fallback provider: ${fallback.provider}`);
        return fallback.httpUrl;
      }
    }

    // Fallback default: ambil endpoint priority terkecil
    const sorted = [...healthyEndpoints].sort((a, b) => a.priority - b.priority);
    return sorted[0].httpUrl;
  }

  /**
   * Menandai kegagalan request pada RPC tertentu untuk memicu Circuit Breaker.
   */
  async reportRpcFailure(endpointId: string, errorMsg: string): Promise<void> {
    const current = (this.consecutiveFailures.get(endpointId) || 0) + 1;
    this.consecutiveFailures.set(endpointId, current);

    console.warn(`[RPC Circuit Breaker] Endpoint ${endpointId} failed (${current}/3): ${errorMsg}`);

    if (current >= 3) {
      console.error(`[RPC Circuit Breaker] Marking endpoint ${endpointId} as UNHEALTHY`);
      await this.db.updateEndpointHealth(endpointId, 'UNHEALTHY', 9999);
      await this.reloadConfig();
    }
  }

  /**
   * Menandai sukses request pada RPC untuk mereset counter failure.
   */
  async reportRpcSuccess(endpointId: string, latencyMs: number): Promise<void> {
    this.consecutiveFailures.set(endpointId, 0);
    const healthStatus: RpcHealthStatus = latencyMs > 1500 ? 'DEGRADED' : 'HEALTHY';
    await this.db.updateEndpointHealth(endpointId, healthStatus, latencyMs);
  }

  /**
   * Update konfigurasi RPC dari Admin Console + broadcast via PubSub + Audit Log.
   */
  async updateRpcEndpoint(
    actorId: string,
    endpoint: RpcEndpointConfig,
    reason: string
  ): Promise<void> {
    // 1. Audit Log Mandatori
    await this.db.createAuditLog({
      actorId,
      action: 'UPDATE_RPC_ENDPOINT',
      entityId: endpoint.id,
      payloadAfter: endpoint,
      reason,
    });

    // 2. Clear local cache
    this.cache.delete(endpoint.networkId);

    // 3. Publish PubSub Event untuk Hot-Reload
    if (this.pubsub) {
      await this.pubsub.publish(this.RPC_PUBSUB_CHANNEL, JSON.stringify({
        action: 'UPDATE_RPC_ENDPOINT',
        networkId: endpoint.networkId,
        updatedBy: actorId,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  /**
   * Reload seluruh cache RPC dari DB SSOT.
   */
  async reloadConfig(): Promise<void> {
    this.cache.clear();
    this.domainConfigs.clear();
  }
}
