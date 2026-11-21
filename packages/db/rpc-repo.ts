/**
 * packages/db/rpc-repo.ts
 *
 * Modular Domain Repository for Multi-Chain RPC Endpoint & Domain Routing SSOT.
 * Extracted from packages/shared/db-pool.ts (Phase AG2) with deduplicated fallback helpers
 * and zero breaking changes via barrel facade.
 */

import type { Pool } from 'pg';
import type {
  DatabaseAdapter as RpcDatabaseAdapter,
  RpcEndpointConfig,
  RpcDomainConfig,
  RpcHealthStatus,
  AuditLogEntry as RpcAuditLogEntry,
} from '../network-registry/rpc-manager';

export interface RpcRepoDeps {
  getDbPool: () => Pool | null;
}

let registeredDeps: RpcRepoDeps | null = null;

export function registerRpcRepoDeps(deps: RpcRepoDeps): void {
  registeredDeps = deps;
}

function getFallbackEndpoints(networkId: string): RpcEndpointConfig[] {
  if (networkId === 'base-mainnet') {
    return [
      {
        id: '11111111-1111-1111-1111-111111111111',
        networkId: 'base-mainnet',
        provider: 'DRPC_NODECLOUD',
        purpose: 'PRIMARY',
        httpUrl: 'https://lb.drpc.org/ogrpc?network=base&key=AswKP7vLrEsUmdIDLg6ZgrwzsKMjkiIR8YUJRoYgFhqK',
        priority: 1,
        weight: 100,
        rateLimitRps: 200,
        isActive: true,
        healthStatus: 'HEALTHY',
        latencyMs: 50,
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        networkId: 'base-mainnet',
        provider: 'DRPC_NODECORE',
        purpose: 'FALLBACK',
        httpUrl: 'https://lb.drpc.org/ogrpc?network=base&key=AswKP7vLrEsUmdIDLg6ZgrwzsKMjkiIR8YUJRoYgFhqK',
        priority: 2,
        weight: 80,
        rateLimitRps: 500,
        isActive: true,
        healthStatus: 'HEALTHY',
        latencyMs: 50,
      },
      {
        id: '55555555-5555-5555-5555-555555555555',
        networkId: 'base-mainnet',
        provider: 'CUSTOM',
        purpose: 'FALLBACK',
        httpUrl: 'https://mainnet.base.org',
        priority: 3,
        weight: 50,
        rateLimitRps: 50,
        isActive: true,
        healthStatus: 'HEALTHY',
        latencyMs: 100,
      },
    ];
  }
  if (networkId === 'base-sepolia') {
    const sepoliaUrl =
      process.env.RPC_URL_BASE_SEPOLIA?.trim() ||
      process.env.BASE_SEPOLIA_RPC_URL?.trim() ||
      'https://sepolia.base.org';
    return [
      {
        id: '33333333-3333-3333-3333-333333333333',
        networkId: 'base-sepolia',
        provider: 'CUSTOM',
        purpose: 'PRIMARY',
        httpUrl: sepoliaUrl,
        priority: 1,
        weight: 100,
        rateLimitRps: 100,
        isActive: true,
        healthStatus: 'HEALTHY',
        latencyMs: 60,
      },
    ];
  }
  if (networkId === 'robinhood-mainnet') {
    const robinhoodUrl =
      process.env.ROBINHOOD_RPC_URL?.trim() ||
      process.env.RPC_URL_ROBINHOOD?.trim() ||
      'https://rpc.mainnet.chain.robinhood.com';
    return [
      {
        id: '44444444-4444-4444-4444-444444444444',
        networkId: 'robinhood-mainnet',
        provider: 'CUSTOM',
        purpose: 'PRIMARY',
        httpUrl: robinhoodUrl,
        priority: 1,
        weight: 100,
        rateLimitRps: 100,
        isActive: true,
        healthStatus: 'HEALTHY',
        latencyMs: 80,
      },
    ];
  }
  if (networkId === 'arbitrum-mainnet') {
    const arbitrumUrl = process.env.ARBITRUM_RPC_URL?.trim() || 'https://arb1.arbitrum.io/rpc';
    return [
      {
        id: '66666666-6666-6666-6666-666666666666',
        networkId: 'arbitrum-mainnet',
        provider: 'CUSTOM',
        purpose: 'PRIMARY',
        httpUrl: arbitrumUrl,
        priority: 1,
        weight: 100,
        rateLimitRps: 50,
        isActive: true,
        healthStatus: 'HEALTHY',
        latencyMs: 100,
      },
    ];
  }
  // BSC, Polygon, Optimism, Arc: architecture-blocked — configure via rpc_endpoints in PostgreSQL SSOT.
  return [];
}

function getFallbackDomainConfig(domain: string, networkId: string): RpcDomainConfig | null {
  if (domain !== 'LAUNCHPAD') return null;
  if (networkId === 'base-mainnet') {
    return {
      domain: 'LAUNCHPAD',
      networkId: 'base-mainnet',
      primaryRpcId: '11111111-1111-1111-1111-111111111111',
      fallbackRpcId: '22222222-2222-2222-2222-222222222222',
    };
  }
  if (networkId === 'base-sepolia') {
    return {
      domain: 'LAUNCHPAD',
      networkId: 'base-sepolia',
      primaryRpcId: '33333333-3333-3333-3333-333333333333',
    };
  }
  if (networkId === 'robinhood-mainnet') {
    return {
      domain: 'LAUNCHPAD',
      networkId: 'robinhood-mainnet',
      primaryRpcId: '44444444-4444-4444-4444-444444444444',
    };
  }
  if (networkId === 'arbitrum-mainnet') {
    return {
      domain: 'LAUNCHPAD',
      networkId: 'arbitrum-mainnet',
      primaryRpcId: '66666666-6666-6666-6666-666666666666',
    };
  }
  return null;
}

export class PostgresRpcDbAdapter implements RpcDatabaseAdapter {
  private readonly deps?: RpcRepoDeps;

  constructor(deps?: RpcRepoDeps) {
    this.deps = deps;
  }

  private resolvePool(): Pool | null {
    return (this.deps || registeredDeps)?.getDbPool() || null;
  }

  async getEndpointsForNetwork(networkId: string): Promise<RpcEndpointConfig[]> {
    const pool = this.resolvePool();
    if (!pool) {
      return getFallbackEndpoints(networkId);
    }

    try {
      const res = await pool.query(
        `SELECT id, network_id, provider, purpose, http_url, ws_url, priority, weight, rate_limit_rps, is_active, health_status, latency_ms
         FROM rpc_endpoints
         WHERE network_id = $1
         ORDER BY priority ASC`,
        [networkId]
      );

      if (res && res.rows && res.rows.length > 0) {
        return res.rows.map((r: any) => ({
          id: r.id,
          networkId: r.network_id,
          provider: r.provider,
          purpose: r.purpose,
          httpUrl: r.http_url,
          wsUrl: r.ws_url || undefined,
          priority: Number(r.priority),
          weight: Number(r.weight),
          rateLimitRps: Number(r.rate_limit_rps),
          isActive: Boolean(r.is_active),
          healthStatus: r.health_status,
          latencyMs: Number(r.latency_ms || 0),
        }));
      }
    } catch {
      // In-memory fallback below
    }

    return getFallbackEndpoints(networkId);
  }

  async getDomainConfig(domain: string, networkId: string): Promise<RpcDomainConfig | null> {
    const pool = this.resolvePool();
    if (!pool) {
      return getFallbackDomainConfig(domain, networkId);
    }

    try {
      const res = await pool.query(
        `SELECT domain, network_id, primary_rpc_id, fallback_rpc_id, archive_rpc_id
         FROM rpc_domain_configs
         WHERE domain = $1 AND network_id = $2
         LIMIT 1`,
        [domain, networkId]
      );

      if (res && res.rows && res.rows.length > 0) {
        const r = res.rows[0];
        return {
          domain: r.domain,
          networkId: r.network_id,
          primaryRpcId: r.primary_rpc_id,
          fallbackRpcId: r.fallback_rpc_id || undefined,
          archiveRpcId: r.archive_rpc_id || undefined,
        };
      }
    } catch {
      // In-memory fallback below
    }

    return getFallbackDomainConfig(domain, networkId);
  }

  async updateEndpointHealth(endpointId: string, health: RpcHealthStatus, latencyMs: number): Promise<void> {
    const pool = this.resolvePool();
    if (!pool) return;
    await pool
      .query(
        `UPDATE rpc_endpoints
         SET health_status = $1, latency_ms = $2, updated_at = NOW()
         WHERE id = $3`,
        [health, latencyMs, endpointId]
      )
      .catch(() => {});
  }

  async createAuditLog(_entry: RpcAuditLogEntry): Promise<void> {
    // Non-blocking telemetry
  }
}
