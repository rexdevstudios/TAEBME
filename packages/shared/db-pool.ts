// ============================================================================
// SERVERLESS-SAFE POSTGRESQL POOL & SSOT ADAPTERS (RTRADER PLATFORM)
// ============================================================================

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { LaunchDraftDbAdapter } from '../launchpad/launch-draft-service';
import { KolDbAdapter } from '../social/kol-service';
import { BountyDbAdapter, BountyClaimItem } from '../launchpad/bounty-escrow';
import { KolProfile, BountyCampaign, BountyClaim, UserGameFiProfile, QuestDefinition, QuestCompletion, NftItemRecord, NftCollectionRecord } from './types/domain';
import { normalizeTokenIdentifier } from './token-identifier';
import { DexPairFactoryService } from '../launchpad/dex-pair-factory';
import { encodeDexSettlementIdempotencyKey } from '../launchpad/web3-provider';
import { TrustEvidenceService } from '../social/trust-evidence-service';
import { KillSwitchDbAdapter, KillSwitchRecord } from '../admin/kill-switch-manager';
import {
  ModularRpcManager,
  DatabaseAdapter as RpcDatabaseAdapter,
  RpcEndpointConfig,
  RpcDomainConfig,
  RpcHealthStatus,
  AuditLogEntry as RpcAuditLogEntry,
} from '../network-registry/rpc-manager';
import { BinanceExecutionDbAdapter, BinanceCredentialMeta, TradeIntentRecord } from '../trading/execution-types';
import { BinanceCredentialVault } from '../trading/binance-vault';
import { compute24hRiskExposure } from '../trading/risk-gate';
import { validateBinancePermissions, BinanceKeyPermissions } from './types/domain';
import { ProposalDbAdapter, AgentProposalRecord } from '../agent/proposal-engine';
import { DualControlDbAdapter, DualControlRequestRecord } from '../admin/dual-control';
import {
  PlanId,
  BillingDbAdapter,
  UserRiskPolicy,
  UserAddonSlots,
  CapacityAddonType,
  CAPACITY_ADDON_CATALOG,
  SubscriptionsEngine,
} from '../billing/subscriptions-engine';

import { getAppEnvironment } from './env-config';

declare global {
  // eslint-disable-next-line no-var
  var _rtraderPgPool: Pool | undefined;
  // eslint-disable-next-line no-var
  var _rtraderPgPoolUrl: string | undefined;
  // eslint-disable-next-line no-var
  var _rtraderPgPoolKey: string | undefined;
  // eslint-disable-next-line no-var
  var _rtraderPgDrainingPools: Set<Pool> | undefined;
  // eslint-disable-next-line no-var
  var _rtraderPgPoolEndPromises: Map<Pool, Promise<void>> | undefined;
}

/**
 * Returns authoritative PostgreSQL connection string for active environment.
 * - APP_ENV=testnet -> requires DATABASE_URL_TESTNET. Fails closed if missing.
 * - APP_ENV=production -> uses DATABASE_URL. Fails closed if missing or in non-production runtime.
 * - APP_ENV=development -> uses DATABASE_URL_DEV || DATABASE_URL_TESTNET || null. NEVER DATABASE_URL.
 * - APP_ENV=test -> uses DATABASE_URL_TEST || DATABASE_URL_TESTNET || null. NEVER DATABASE_URL.
 */
export function getDatabaseConnectionString(): string | null {
  const env = getAppEnvironment();
  const rawNodeEnv = process.env.NODE_ENV;
  const nodeEnv = typeof rawNodeEnv === 'string' ? rawNodeEnv.trim().toLowerCase() : undefined;

  // 1. Production Environment: Only permitted when NODE_ENV=production AND APP_ENV=production
  if (env === 'production') {
    if (nodeEnv !== 'production') {
      throw new Error(
        `SECURITY_MISCONFIGURATION: Production database connection is forbidden in non-production runtime (NODE_ENV=${rawNodeEnv || 'development'}).`
      );
    }
    const prodUrl = process.env.DATABASE_URL?.trim();
    if (!prodUrl || prodUrl.includes('placeholder')) {
      throw new Error(
        'CRITICAL_CONFIG_ERROR: DATABASE_URL is not configured in production environment. Refusing to operate unbacked state.'
      );
    }
    return prodUrl;
  }

  // 2. Testnet Environment: Requires DATABASE_URL_TESTNET unconditionally
  if (env === 'testnet') {
    const testnetUrl = process.env.DATABASE_URL_TESTNET?.trim();
    if (!testnetUrl || testnetUrl.includes('placeholder')) {
      throw new Error(
        'TESTNET_DATABASE_NOT_CONFIGURED: APP_ENV is set to "testnet", but DATABASE_URL_TESTNET environment variable is missing or unconfigured. Refusing to fall back to production database.'
      );
    }
    return testnetUrl;
  }

  // 3. Defense-in-depth: If NODE_ENV is production, non-production environments are strictly forbidden
  if (nodeEnv === 'production') {
    throw new Error(
      `SECURITY_MISCONFIGURATION: Database connection resolution for non-production environment "${env}" is forbidden in production runtime.`
    );
  }

  // 4. Development Environment (APP_ENV=development)
  if (env === 'development') {
    const devUrl =
      process.env.DATABASE_URL_DEV?.trim() ||
      process.env.DATABASE_URL_TESTNET?.trim();
    if (devUrl && !devUrl.includes('placeholder')) {
      return devUrl;
    }
    // NEVER fall back to DATABASE_URL in development!
    return null;
  }

  // 5. Test Environment (APP_ENV=test or NODE_ENV=test)
  if (env === 'test') {
    const testUrl =
      process.env.DATABASE_URL_TEST?.trim() ||
      process.env.DATABASE_URL_TESTNET?.trim();
    if (testUrl && !testUrl.includes('placeholder')) {
      return testUrl;
    }
    // NEVER fall back to DATABASE_URL in test!
    return null;
  }

  return null;
}

function getDrainingPoolsRegistry(): Set<Pool> {
  if (!global._rtraderPgDrainingPools) {
    global._rtraderPgDrainingPools = new Set<Pool>();
  }
  return global._rtraderPgDrainingPools;
}

function getPoolEndPromisesMap(): Map<Pool, Promise<void>> {
  if (!global._rtraderPgPoolEndPromises) {
    global._rtraderPgPoolEndPromises = new Map<Pool, Promise<void>>();
  }
  return global._rtraderPgPoolEndPromises;
}

/**
 * Safe error code allowlist for database pool lifecycle logging.
 * NEVER prints raw error messages, URLs, hostnames, usernames, or parameters.
 */
const SAFE_POOL_ERROR_CODES = new Set([
  'CONNECTION_TIMEOUT',
  'SOCKET_HANGUP',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_SOCKET_CLOSED',
]);

/**
 * Sanitizes an error into an allowlisted categorical error tag.
 * Guaranteed to never expose hostnames, IPs, usernames, passwords, or query strings.
 */
export function sanitizePoolErrorTag(err: unknown): string {
  if (!err) return 'POOL_DRAIN_ERROR';

  const code = (err as Record<string, unknown>)?.code;
  if (typeof code === 'string') {
    const normalized = code.trim().toUpperCase();
    if (SAFE_POOL_ERROR_CODES.has(normalized)) {
      return normalized;
    }
  }

  const name = (err as Record<string, unknown>)?.name;
  if (typeof name === 'string') {
    const normalizedName = name.trim();
    if (normalizedName === 'TimeoutError') return 'CONNECTION_TIMEOUT';
    if (normalizedName === 'AbortError') return 'ABORT_ERROR';
  }

  return 'POOL_DRAIN_ERROR';
}

/**
 * Emits a strictly sanitized warning for detached pool teardown.
 * Suppresses expected "Called end on pool more than once" double-end errors.
 */
function logSanitizedPoolTeardownWarning(err: unknown): void {
  const errMsg = (err instanceof Error) ? err.message : String(err);
  if (errMsg.includes('Called end on pool more than once')) {
    return; // harmless double-end call
  }
  if (process.env.NODE_ENV !== 'test') {
    const errorTag = sanitizePoolErrorTag(err);
    console.warn(`[Postgres SSOT Pool Teardown Warning]: ${errorTag}`);
  }
}

/**
 * Initiates graceful background shutdown of a retired pool instance.
 * - Deduplicates pool.end() execution per Pool instance.
 * - Preserves the UNTOUCHED underlying Promise in _rtraderPgPoolEndPromises for awaited callers.
 * - Attaches a detached rejection handler immediately to prevent unhandled promise rejections.
 * - Removes pool from registry and promise map when settled.
 */
function drainRetiredPool(pool: Pool): Promise<void> {
  const registry = getDrainingPoolsRegistry();
  const promiseMap = getPoolEndPromisesMap();
  registry.add(pool);

  if (promiseMap.has(pool)) {
    return promiseMap.get(pool)!;
  }

  let rawEndPromise: Promise<void>;
  try {
    const result = pool.end();
    if (result && typeof (result as Promise<void>).then === 'function') {
      rawEndPromise = result as Promise<void>;
    } else {
      rawEndPromise = Promise.resolve();
    }
  } catch (syncErr: unknown) {
    rawEndPromise = Promise.reject(syncErr);
  }

  // Deduplicate using the raw, unadulterated promise
  promiseMap.set(pool, rawEndPromise);

  // Attach detached rejection handler immediately so detached callers never trigger UnhandledPromiseRejection.
  // This does NOT mutate rawEndPromise for awaited callers.
  rawEndPromise
    .catch((err: unknown) => {
      logSanitizedPoolTeardownWarning(err);
    })
    .finally(() => {
      registry.delete(pool);
      promiseMap.delete(pool);
    });

  return rawEndPromise;
}

/**
 * Reset singleton connection pool synchronously (useful for test fixture isolation).
 * Initiates safe background draining of the active pool without blocking synchronous callers.
 */
export function resetDbPool(): void {
  if (global._rtraderPgPool) {
    const poolToRetire = global._rtraderPgPool;
    global._rtraderPgPool = undefined;
    global._rtraderPgPoolUrl = undefined;
    global._rtraderPgPoolKey = undefined;
    drainRetiredPool(poolToRetire);
  }
}

export interface PoolCloseResult {
  pool: Pool;
  status: 'fulfilled' | 'rejected';
  errorTag?: string;
}

export interface PoolTeardownSummary {
  total: number;
  closed: number;
  failed: number;
  results: PoolCloseResult[];
}

/**
 * Deterministically closes the active pool and awaits completion of all in-flight draining pools
 * captured at snapshot invocation time.
 *
 * Snapshot Teardown Semantics:
 * 1. Snapshot Boundary: Captures active pool (if present) and all currently draining pools in registry.
 * 2. Active Pool Unset: Atomically unsets global active singleton references immediately.
 * 3. Outcome Preservation: Awaits the raw underlying pool.end() promises via Promise.allSettled().
 *    Failures are NEVER converted into silent successes.
 * 4. Structured Return Contract: Returns a PoolTeardownSummary containing total, closed, failed counts,
 *    and sanitized categorical error tags per pool.
 * 5. Concurrent / Future Invocations: Pools retired AFTER this snapshot is captured are tracked in subsequent
 *    registry snapshots and not awaited by this call. A replacement pool created concurrently remains active.
 */
export async function closeDbPoolAsync(): Promise<PoolTeardownSummary> {
  const registry = getDrainingPoolsRegistry();
  const poolsToClose: Pool[] = Array.from(registry);

  if (global._rtraderPgPool) {
    const active = global._rtraderPgPool;
    global._rtraderPgPool = undefined;
    global._rtraderPgPoolUrl = undefined;
    global._rtraderPgPoolKey = undefined;
    if (!poolsToClose.includes(active)) {
      poolsToClose.push(active);
    }
  }

  const settledResults = await Promise.allSettled(poolsToClose.map((p) => drainRetiredPool(p)));

  const results: PoolCloseResult[] = [];
  let closed = 0;
  let failed = 0;

  for (let i = 0; i < poolsToClose.length; i++) {
    const pool = poolsToClose[i];
    const settled = settledResults[i];

    if (settled.status === 'fulfilled') {
      closed++;
      results.push({ pool, status: 'fulfilled' });
    } else {
      failed++;
      results.push({
        pool,
        status: 'rejected',
        errorTag: sanitizePoolErrorTag(settled.reason),
      });
    }
  }

  return {
    total: poolsToClose.length,
    closed,
    failed,
    results,
  };
}

/**
 * Returns true if a valid UUID v4 format.
 */
export function isUuid(str?: string): boolean {
  if (!str || typeof str !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

/**
 * Returns true if a valid database connection string is provided for the active environment.
 */
export function isDatabaseConfigured(): boolean {
  try {
    const url = getDatabaseConnectionString();
    return Boolean(url);
  } catch {
    return false;
  }
}

/**
 * Resolves the TLS/SSL configuration for the PostgreSQL connection pool.
 *
 * Security model:
 * - production/testnet: TLS is MANDATORY. rejectUnauthorized is always true.
 *   DATABASE_SSL=false is forbidden in production/testnet and throws a hard error.
 * - development/test: DATABASE_SSL=false disables TLS (for local non-TLS PostgreSQL).
 *   If not explicitly disabled, TLS is still enabled with rejectUnauthorized: true.
 *
 * Why we strip ?sslmode from connectionString before Pool construction:
 *   pg-connection-string's parse() runs on connectionString *after* merging explicit ssl
 *   config (pg/lib/connection-parameters.js:60 — Object.assign({}, config, parse(cs))).
 *   When ?sslmode=require is present, parse() produces { ssl: {} } which overwrites our
 *   { rejectUnauthorized: true } with an empty object {}. Stripping sslmode from the URL
 *   ensures our explicit ssl config is authoritative and never overwritten by the URL parser.
 *   The original raw connectionString is preserved separately for the pool cache key.
 *
 * @returns [poolConnectionString, sslConfig]
 */
export function resolvePoolSslConfig(
  rawConnectionString: string
): [string, false | { rejectUnauthorized: boolean }] {
  const env = getAppEnvironment();
  const dbSslEnv = process.env.DATABASE_SSL?.toLowerCase()?.trim();

  // In production/testnet: TLS is mandatory. Refuse to start if explicitly disabled.
  if (env === 'production' || env === 'testnet') {
    if (dbSslEnv === 'false') {
      throw new Error(
        `SECURITY_MISCONFIGURATION: DATABASE_SSL=false is forbidden in ${env} environment. ` +
        `TLS certificate validation cannot be disabled in production or testnet. ` +
        `Remove DATABASE_SSL=false from your environment configuration.`
      );
    }
  }

  // Strip SSL query params from the connection string so pg-connection-string's parse()
  // does not overwrite our explicit ssl config object (see JSDoc above for full rationale).
  let poolConnectionString = rawConnectionString;
  try {
    const parsed = new URL(rawConnectionString);
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('sslrootcert');
    parsed.searchParams.delete('sslcert');
    parsed.searchParams.delete('sslkey');
    poolConnectionString = parsed.toString();
  } catch {
    // URL parse failed (e.g. non-standard connection string format); use as-is
  }

  // Development/test: allow disabling TLS for local PostgreSQL without TLS support
  if ((env === 'development' || env === 'test') && dbSslEnv === 'false') {
    return [poolConnectionString, false];
  }

  return [poolConnectionString, { rejectUnauthorized: true }];
}

/**
 * Returns singleton Pool instance for serverless environments.
 * - Enforces max: 5 connections to prevent exhausting Postgres serverless connection limits.
 * - Enforces TLS certificate validation (rejectUnauthorized: true) in production and testnet.
 * - Throws in production if DATABASE_URL is missing.
 * - Throws in testnet if DATABASE_URL_TESTNET is missing (FAIL CLOSED).
 * - Returns null in dev/test when DB URL is omitted to allow graceful local mock fallback.
 */
export function getDbPool(): Pool | null {
  const connectionString = getDatabaseConnectionString();

  if (connectionString) {
    const env = getAppEnvironment();
    const [poolConnectionString, sslConfig] = resolvePoolSslConfig(connectionString);
    const poolKey = `${env}:${connectionString}:${JSON.stringify(sslConfig)}`;

    if (!global._rtraderPgPool || global._rtraderPgPoolKey !== poolKey) {
      if (global._rtraderPgPool) {
        const poolToRetire = global._rtraderPgPool;
        global._rtraderPgPool = undefined;
        global._rtraderPgPoolUrl = undefined;
        global._rtraderPgPoolKey = undefined;
        drainRetiredPool(poolToRetire);
      }

      try {
        const newPool = new Pool({
          connectionString: poolConnectionString,
          max: 5,
          idleTimeoutMillis: 10000,
          connectionTimeoutMillis: 15000,
          ssl: sslConfig,
        });

        newPool.on('error', (err) => {
          console.error('[Postgres SSOT Pool Error]:', err.message);
        });

        // Cache key uses environment, raw connectionString, and TLS config
        // so environment isolation, SSL transitions, and singleton reset continue to work correctly.
        global._rtraderPgPool = newPool;
        global._rtraderPgPoolUrl = connectionString;
        global._rtraderPgPoolKey = poolKey;
      } catch (err) {
        // Failed initialization does not leave an invalid cached pool
        global._rtraderPgPool = undefined;
        global._rtraderPgPoolUrl = undefined;
        global._rtraderPgPoolKey = undefined;
        throw err;
      }
    }
    return global._rtraderPgPool;
  }

  return null;
}

export interface WorkerDbPoolOptions {
  connectionString?: string;
  max?: number;
  statementTimeoutMs?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/**
 * Creates an isolated, dedicated PostgreSQL connection pool for Execution Plane workers.
 *
 * Technical Rationale for Worker Pool Sizing & Isolation:
 * - Control Plane vs Execution Plane: Vercel serverless functions use getDbPool() (max: 5, fast recycle).
 *   In contrast, execution-plane workers are long-running persistent services with continuous polling
 *   and multi-step transaction lifecycles (dispatch, atomic claim, order fill recording, stale sweep).
 * - Sizing (Default max: 6): Sized specifically for:
 *   1. Dispatcher queue poller (1 connection)
 *   2. Active execution transaction (1 connection during atomic write)
 *   3. Periodic stale intent reconciler sweep (1 connection)
 *   4. Kill switch & audit log synchronization (1 connection)
 *   5. Headroom for concurrent sweep/reconciliation queries (2 connections)
 *   Staying at max: 6 ensures sufficient throughput while preventing Neon compute connection exhaustion
 *   or starving concurrent Vercel serverless lambdas.
 * - Statement Timeout: Injects statement_timeout (default 10,000 ms) so hung locks or slow DB operations
 *   fail closed instead of hanging the worker thread indefinitely.
 * - Transaction Safety: Transactions (BEGIN ... COMMIT/ROLLBACK) release the client immediately in finally.
 *   Transactions are NEVER held across external Binance HTTP requests.
 */
export function createWorkerDbPool(options?: WorkerDbPoolOptions): Pool {
  const rawConnectionString = options?.connectionString || getDatabaseConnectionString();
  if (!rawConnectionString) {
    throw new Error('DATABASE_UNAVAILABLE: Connection string is missing for worker database pool.');
  }

  const [poolConnectionString, sslConfig] = resolvePoolSslConfig(rawConnectionString);

  const rawMax = options?.max ?? (process.env.WORKER_DB_POOL_MAX ? parseInt(process.env.WORKER_DB_POOL_MAX, 10) : 6);
  if (typeof rawMax !== 'number' || Number.isNaN(rawMax) || !Number.isInteger(rawMax) || rawMax <= 0 || rawMax > 50) {
    throw new Error(
      `INVALID_WORKER_POOL_CONFIG: Pool size 'max' must be an integer between 1 and 50, but received ${rawMax}.`
    );
  }
  const max = rawMax;

  const rawStatementTimeout = options?.statementTimeoutMs ?? (process.env.WORKER_STATEMENT_TIMEOUT_MS ? parseInt(process.env.WORKER_STATEMENT_TIMEOUT_MS, 10) : 10000);
  if (
    typeof rawStatementTimeout !== 'number' ||
    Number.isNaN(rawStatementTimeout) ||
    !Number.isInteger(rawStatementTimeout) ||
    rawStatementTimeout < 100 ||
    rawStatementTimeout > 60000
  ) {
    throw new Error(
      `INVALID_WORKER_POOL_CONFIG: 'statementTimeoutMs' must be an integer between 100 and 60000 ms, but received ${rawStatementTimeout}.`
    );
  }
  const statementTimeoutMs = rawStatementTimeout;

  const rawConnectionTimeout = options?.connectionTimeoutMs ?? 15000;
  if (
    typeof rawConnectionTimeout !== 'number' ||
    Number.isNaN(rawConnectionTimeout) ||
    !Number.isInteger(rawConnectionTimeout) ||
    rawConnectionTimeout < 100 ||
    rawConnectionTimeout > 60000
  ) {
    throw new Error(
      `INVALID_WORKER_POOL_CONFIG: 'connectionTimeoutMs' must be an integer between 100 and 60000 ms, but received ${rawConnectionTimeout}.`
    );
  }
  const connectionTimeoutMs = rawConnectionTimeout;

  const rawIdleTimeout = options?.idleTimeoutMs ?? 30000;
  if (
    typeof rawIdleTimeout !== 'number' ||
    Number.isNaN(rawIdleTimeout) ||
    !Number.isInteger(rawIdleTimeout) ||
    rawIdleTimeout < 1000 ||
    rawIdleTimeout > 300000
  ) {
    throw new Error(
      `INVALID_WORKER_POOL_CONFIG: 'idleTimeoutMs' must be an integer between 1000 and 300000 ms, but received ${rawIdleTimeout}.`
    );
  }
  const idleTimeoutMs = rawIdleTimeout;

  const pool = new Pool({
    connectionString: poolConnectionString,
    max,
    idleTimeoutMillis: idleTimeoutMs,
    connectionTimeoutMillis: connectionTimeoutMs,
    ssl: sslConfig,
    statement_timeout: statementTimeoutMs,
  });

  // Make pool.end() idempotent to protect against pg's 'Called end on pool more than once' exception
  let isEndingOrEnded = false;
  let endPromise: Promise<void> | null = null;
  const originalEnd = pool.end.bind(pool);
  pool.end = ((cb?: any) => {
    if (isEndingOrEnded && endPromise) {
      if (typeof cb === 'function') {
        endPromise.then(() => cb(), (err) => cb(err));
      }
      return endPromise;
    }
    isEndingOrEnded = true;
    endPromise = originalEnd(cb);
    return endPromise;
  }) as any;

  pool.on('error', (err) => {
    console.error('[Postgres Worker Dedicated Pool Error]:', err.message);
  });

  return pool;
}

/**
 * Generic query helper executing safely against PostgreSQL connection pool.
 */
export async function query<R extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<R> | null> {
  const pool = getDbPool();
  if (!pool) return null;
  return pool.query<R>(text, params);
}

/**
 * Ensures an actor or wallet address has an associated user and entity record.
 * Returns the valid UUID user_id.
 */
export async function ensureUserEntity(pool: Pool | PoolClient | any, actorOrWallet: string): Promise<string> {
  if (isUuid(actorOrWallet)) {
    const existing = await pool.query('SELECT id FROM users WHERE id = $1', [actorOrWallet]);
    if (existing.rows.length > 0) return actorOrWallet;
    await pool.query("INSERT INTO entities (id, type) VALUES ($1, 'USER') ON CONFLICT (id) DO NOTHING", [actorOrWallet]);
    await pool.query("INSERT INTO users (id, status) VALUES ($1, 'ACTIVE') ON CONFLICT (id) DO NOTHING", [actorOrWallet]);
    return actorOrWallet;
  }

  const isUsrPrefix = actorOrWallet.startsWith('usr-');
  const cleanAddress = isUsrPrefix
    ? actorOrWallet.slice(4).toLowerCase()
    : actorOrWallet.toLowerCase();

  const existingWallet = await pool.query(
    'SELECT user_id FROM wallets WHERE LOWER(address) = LOWER($1) LIMIT 1',
    [cleanAddress]
  );
  if (existingWallet.rows.length > 0) {
    return existingWallet.rows[0].user_id;
  }

  if (isUsrPrefix && /^[a-f0-9]{6,16}$/i.test(cleanAddress)) {
    const prefixMatch = await pool.query(
      'SELECT user_id FROM wallets WHERE LOWER(address) LIKE $1 ORDER BY is_primary DESC, created_at ASC LIMIT 1',
      [`0x${cleanAddress}%`]
    );
    if (prefixMatch.rows.length > 0) {
      return prefixMatch.rows[0].user_id;
    }
  }

  const newUserId = crypto.randomUUID();
  await pool.query("INSERT INTO entities (id, type) VALUES ($1, 'USER')", [newUserId]);
  await pool.query("INSERT INTO users (id, status) VALUES ($1, 'ACTIVE')", [newUserId]);
  await pool.query(
    "INSERT INTO wallets (user_id, address, chain_type, is_primary) VALUES ($1, $2, 'EVM', true) ON CONFLICT (address, chain_type) DO NOTHING",
    [newUserId, cleanAddress]
  );

  return newUserId;
}

/**
 * Ensures a network ID exists in the PostgreSQL networks table to satisfy foreign key constraints.
 */
export async function ensureNetworkInPool(pool: Pool, chainInput: string): Promise<string> {
  const lower = (chainInput || 'base-mainnet').toLowerCase();
  let networkId = lower.includes('robinhood')
    ? 'robinhood-mainnet'
    : lower.includes('solana')
    ? 'solana-mainnet'
    : lower.includes('arbitrum')
    ? 'arbitrum-mainnet'
    : lower.includes('arc')
    ? 'arc-mainnet'
    : lower.includes('ethereum')
    ? 'ethereum-mainnet'
    : 'base-mainnet';

  let chainId: number | null = 8453;
  let name = 'Base Mainnet';
  let family = 'EVM';
  let symbol = 'ETH';
  let decimals = 18;
  let explorer = 'https://basescan.org';

  if (networkId === 'robinhood-mainnet') {
    chainId = 4663;
    name = 'Robinhood Chain L2';
    explorer = 'https://robinhoodchain.blockscout.com';
  } else if (networkId === 'arbitrum-mainnet') {
    chainId = 42161;
    name = 'Arbitrum One';
    explorer = 'https://arbiscan.io';
  } else if (networkId === 'arc-mainnet') {
    chainId = 5042;
    name = 'Arc Mainnet';
    explorer = 'https://arcscan.io';
  } else if (networkId === 'ethereum-mainnet') {
    chainId = 1;
    name = 'Ethereum Mainnet';
    explorer = 'https://etherscan.io';
  } else if (networkId === 'solana-mainnet') {
    chainId = null;
    name = 'Solana Mainnet';
    family = 'SOLANA';
    symbol = 'SOL';
    decimals = 9;
    explorer = 'https://solscan.io';
  }

  try {
    await pool.query(
      `INSERT INTO networks (id, chain_id, name, network_family, native_currency_symbol, native_currency_decimals, explorer_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [networkId, chainId, name, family, symbol, decimals, explorer]
    );
  } catch {
    // Non-blocking fallback
  }
  return networkId;
}

// IN-MEMORY FALLBACK STORES -> Moved into domain repositories in packages/db/* (Phases AF–AH)
// POSTGRES DRAFT DB ADAPTER -> Extracted to packages/db/launch-draft-repo.ts (Phase AG2)
// POSTGRES KOL DB ADAPTER & HandleConflictError -> Extracted to packages/db/kol-repo.ts (Phase AF1)
// POSTGRES BOUNTY DB ADAPTER -> Extracted to packages/db/bounty-repo.ts (Phase AH1)
// POSTGRES RPC DB ADAPTER -> Extracted to packages/db/rpc-repo.ts (Phase AG2)

/**
 * Returns a singleton TrustEvidenceService backed by the shared DB pool.
 * Returns null when DATABASE_URL is not configured (dev/test without DB).
 *
 * CANONICAL USAGE:
 *   Pass as 3rd arg to BountyEscrowService in all production route handlers.
 *   When non-null, World ID anti-replay uses DB-persisted verified_nullifiers
 *   (restart-safe). When null, falls back to in-memory (test/dev only).
 */
export function getTrustEvidenceService(): TrustEvidenceService | null {
  const pool = getDbPool();
  if (!pool) return null;
  return new TrustEvidenceService(pool);
}

export interface SaveTradeIntentParams {
  userId: string;
  stage: 'PAPER' | 'TESTNET' | 'LIVE';
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET' | 'STOP_LOSS' | 'TAKE_PROFIT';
  quantity: number;
  price?: number;
  idempotencyKey: string;
  status: 'PENDING_RISK' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'CANCELLED';
  riskDecisionReason?: string;
}

export async function saveTradeIntent(params: SaveTradeIntentParams): Promise<string> {
  const pool = getDbPool();
  const intentId = crypto.randomUUID();

  // Always seed defaultBinanceExecutionDbAdapter memory store for unit testing & offline dev
  defaultBinanceExecutionDbAdapter.seedIntent({
    id: intentId,
    userId: params.userId,
    stage: params.stage,
    symbol: params.symbol,
    side: params.side,
    type: params.type,
    quantity: params.quantity,
    price: params.price,
    maxSlippagePct: 1.0,
    idempotencyKey: params.idempotencyKey,
    status: params.status,
    riskDecisionReason: params.riskDecisionReason,
  });

  if (pool) {
    try {
      const validUserId = await ensureUserEntity(pool, params.userId);
      await pool.query("INSERT INTO entities (id, type) VALUES ($1, 'ORDER') ON CONFLICT (id) DO NOTHING", [intentId]);

      const res = await pool.query(
        `INSERT INTO trade_intents (
          id, user_id, stage, symbol, side, type,
          quantity, price, idempotency_key, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (idempotency_key) DO UPDATE SET
          status = EXCLUDED.status
        RETURNING id`,
        [
          intentId,
          validUserId,
          params.stage,
          params.symbol,
          params.side,
          params.type,
          params.quantity,
          params.price ?? null,
          params.idempotencyKey,
          params.status,
        ]
      );

      const savedId = res.rows[0]?.id || intentId;

      if (params.status === 'APPROVED' || params.status === 'REJECTED') {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [
            validUserId,
            `TRADE_INTENT_${params.status}`,
            savedId,
            params.riskDecisionReason || `Stage: ${params.stage}, Symbol: ${params.symbol}`,
          ]
        );
      }

      return savedId;
    } catch (err: any) {
      console.error('[DB] saveTradeIntent error:', err?.message || err);
    }
  }

  return intentId;
}

export async function getTradeIntentByIdempotencyKey(idempotencyKey: string): Promise<TradeIntentRecord | null> {
  for (const intent of defaultBinanceExecutionDbAdapter.getInMemoryIntents()) {
    if (intent.idempotencyKey === idempotencyKey) {
      return intent;
    }
  }

  const pool = getDbPool();
  if (pool) {
    try {
      const res = await pool.query(
        `SELECT id, user_id as "userId", stage, symbol, side, type,
                quantity, price, idempotency_key as "idempotencyKey", status,
                created_at as "createdAt"
         FROM trade_intents
         WHERE idempotency_key = $1`,
        [idempotencyKey]
      );
      if (res.rows.length > 0) {
        return res.rows[0];
      }
    } catch (err: any) {
      console.warn('[DB] getTradeIntentByIdempotencyKey error:', err?.message || err);
    }
  }

  return null;
}

/**
 * Lists recent trade intents strictly scoped to a single authenticated user (Phase AP).
 * - Clamps `limit` to `1..50` (default `10`).
 * - Falls back cleanly to in-memory seeded intents in offline/test environments.
 */
export async function listUserRecentTradeIntents(
  userIdentifier: string,
  limit: number = 10
): Promise<TradeIntentRecord[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 10)));
  const pool = getDbPool();
  if (pool) {
    try {
      const validUserId = await ensureUserEntity(pool, userIdentifier);
      const res = await pool.query(
        `SELECT id, user_id AS "userId", stage, symbol, side, type,
                quantity::float AS quantity, price::float AS price,
                idempotency_key AS "idempotencyKey", status,
                risk_decision_id AS "riskDecisionId", created_at AS "createdAt"
         FROM trade_intents
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [validUserId, safeLimit]
      );
      return res.rows.map((r: any) => ({
        id: String(r.id),
        userId: String(r.userId),
        stage: r.stage,
        symbol: String(r.symbol),
        side: r.side,
        type: r.type,
        quantity: Number(r.quantity),
        price: r.price !== null && r.price !== undefined ? Number(r.price) : undefined,
        maxSlippagePct: 1.0,
        idempotencyKey: String(r.idempotencyKey),
        status: r.status,
        riskDecisionId: r.riskDecisionId ? String(r.riskDecisionId) : undefined,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      }));
    } catch (err: any) {
      console.warn('[DB] listUserRecentTradeIntents fallback to memory:', err?.message || err);
    }
  }

  const norm = (userIdentifier || '').trim().toLowerCase();
  return defaultBinanceExecutionDbAdapter
    .getInMemoryIntents()
    .filter((i) => (i.userId || '').trim().toLowerCase() === norm)
    .sort((a, b) => Date.parse(b.createdAt || '0') - Date.parse(a.createdAt || '0'))
    .slice(0, safeLimit);
}

/**
 * Confirms an on-chain DEX swap settlement strictly scoped to the authenticated user (Phase BF).
 * - Transitions `status` from `APPROVED` -> `EXECUTED`.
 * - Encodes `dex:${chainId}:${txHash}:${intentPrefix}` into `idempotency_key` (0 DDL migration).
 * - Appends an audit log record (`DEX_SWAP_TX_CONFIRMED`).
 */
export async function confirmUserDexTradeIntentSettlement(params: {
  userIdentifier: string;
  tradeIntentId: string;
  txHash: string;
  chainId: number;
}): Promise<{ tradeIntentId: string; status: 'EXECUTED'; idempotencyKey: string }> {
  const intentId = String(params.tradeIntentId || '').trim();
  if (!intentId) {
    throw new Error('INVALID_TRADE_INTENT_ID');
  }
  const encodedKey = encodeDexSettlementIdempotencyKey({
    chainId: params.chainId,
    txHash: params.txHash,
    intentId,
  });

  const pool = getDbPool();
  if (pool) {
    const validUserId = await ensureUserEntity(pool, params.userIdentifier);
    const res = await pool.query(
      `UPDATE trade_intents
       SET status = 'EXECUTED',
           idempotency_key = $3
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [intentId, validUserId, encodedKey]
    );
    if (res.rowCount === 0) {
      throw new Error('TRADE_INTENT_NOT_FOUND_OR_FORBIDDEN');
    }
    await pool
      .query(
        `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
         VALUES ($1, 'DEX_SWAP_TX_CONFIRMED', $2, $3, NOW())`,
        [
          validUserId,
          isUuid(intentId) ? intentId : null,
          `On-chain 0x Swap v2 tx confirmed on chain ${params.chainId}: ${params.txHash}`,
        ]
      )
      .catch(() => {});
  } else {
    const normUser = (params.userIdentifier || '').trim().toLowerCase();
    const memMatch = defaultBinanceExecutionDbAdapter
      .getInMemoryIntents()
      .find((i) => i.id === intentId && (i.userId || '').trim().toLowerCase() === normUser);
    if (!memMatch) {
      throw new Error('TRADE_INTENT_NOT_FOUND_OR_FORBIDDEN');
    }
    memMatch.status = 'EXECUTED';
    memMatch.idempotencyKey = encodedKey;
  }

  // Keep in-memory mirror in sync if present
  const memMirror = defaultBinanceExecutionDbAdapter
    .getInMemoryIntents()
    .find((i) => i.id === intentId);
  if (memMirror) {
    memMirror.status = 'EXECUTED';
    memMirror.idempotencyKey = encodedKey;
  }

  return {
    tradeIntentId: intentId,
    status: 'EXECUTED',
    idempotencyKey: encodedKey,
  };
}

/**
 * Cancels a pending/approved trade intent strictly scoped to the authenticated user (Phase EF).
 * - Anti-IDOR: only cancels intents owned by `userIdentifier` with status `APPROVED` or `PENDING_RISK`.
 * - Appends an immutable `audit_logs` record (`TRADE_INTENT_CANCELLED`).
 */
export async function cancelUserPendingTradeIntent(params: {
  userIdentifier: string;
  tradeIntentId: string;
}): Promise<{ tradeIntentId: string; status: 'CANCELLED' }> {
  const intentId = String(params.tradeIntentId || '').trim();
  if (!intentId) {
    throw new Error('INVALID_TRADE_INTENT_ID');
  }

  const pool = getDbPool();
  if (pool) {
    const validUserId = await ensureUserEntity(pool, params.userIdentifier);
    const res = await pool.query(
      `UPDATE trade_intents
       SET status = 'CANCELLED'
       WHERE id = $1
         AND user_id = $2
         AND status IN ('APPROVED', 'PENDING_RISK')
       RETURNING id`,
      [intentId, validUserId]
    );
    if (res.rowCount === 0) {
      throw new Error('TRADE_INTENT_NOT_FOUND_OR_NOT_CANCELLABLE');
    }
    await pool
      .query(
        `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
         VALUES ($1, 'TRADE_INTENT_CANCELLED', $2, $3, NOW())`,
        [validUserId, isUuid(intentId) ? intentId : null, `User cancelled pending trade intent ${intentId}`]
      )
      .catch(() => {});
  } else {
    const normUser = (params.userIdentifier || '').trim().toLowerCase();
    const memMatch = defaultBinanceExecutionDbAdapter
      .getInMemoryIntents()
      .find(
        (i) =>
          i.id === intentId &&
          (i.userId || '').trim().toLowerCase() === normUser &&
          (i.status === 'APPROVED' || i.status === 'PENDING_RISK')
      );
    if (!memMatch) {
      throw new Error('TRADE_INTENT_NOT_FOUND_OR_NOT_CANCELLABLE');
    }
    memMatch.status = 'CANCELLED';
  }

  const memMirror = defaultBinanceExecutionDbAdapter
    .getInMemoryIntents()
    .find((i) => i.id === intentId);
  if (memMirror && (memMirror.status === 'APPROVED' || memMirror.status === 'PENDING_RISK')) {
    memMirror.status = 'CANCELLED';
  }

  return {
    tradeIntentId: intentId,
    status: 'CANCELLED',
  };
}

// ----------------------------------------------------------------------------
// MULTI-OWNED SUB-WALLET ALLOWLIST (SSOT `public.wallets`, Phase EG, Zero-Migration)
// ----------------------------------------------------------------------------
export interface OwnedWalletRecord {
  id: string;
  address: string;
  chainType: string;
  isPrimary: boolean;
  createdAt: string;
}

const MAX_OWNED_SUBWALLETS_PER_USER = 10;
const inMemoryOwnedSubWallets = new Map<string, OwnedWalletRecord[]>();

/**
 * Lists all verified owned wallets (primary SIWE wallet + cryptographically linked sub-wallets)
 * for the authenticated user. Always includes `userIdentifier` when it is a valid EVM address.
 */
export async function listUserOwnedWallets(userIdentifier: string): Promise<OwnedWalletRecord[]> {
  const normPrimary = String(userIdentifier || '').trim().toLowerCase();
  const pool = getDbPool();
  if (pool) {
    try {
      const validUserId = await ensureUserEntity(pool, userIdentifier);
      const res = await pool.query(
        `SELECT id, address, chain_type, is_primary, created_at
         FROM wallets
         WHERE user_id = $1
         ORDER BY is_primary DESC, created_at ASC
         LIMIT 25`,
        [validUserId]
      );
      const rows: OwnedWalletRecord[] = res.rows.map((r: any) => ({
        id: String(r.id),
        address: String(r.address || '').toLowerCase(),
        chainType: String(r.chain_type || 'EVM').toUpperCase(),
        isPrimary: Boolean(r.is_primary),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      }));
      if (/^0x[a-f0-9]{40}$/.test(normPrimary) && !rows.some((r) => r.address === normPrimary)) {
        rows.unshift({
          id: `primary-${normPrimary.slice(2, 10)}`,
          address: normPrimary,
          chainType: 'EVM',
          isPrimary: true,
          createdAt: new Date().toISOString(),
        });
      }
      return rows;
    } catch (err: any) {
      console.warn('[DB] listUserOwnedWallets fallback to memory:', err?.message || err);
    }
  }

  const memList = inMemoryOwnedSubWallets.get(normPrimary) || [];
  const base: OwnedWalletRecord[] = /^0x[a-f0-9]{40}$/.test(normPrimary)
    ? [
        {
          id: `primary-${normPrimary.slice(2, 10)}`,
          address: normPrimary,
          chainType: 'EVM',
          isPrimary: true,
          createdAt: new Date().toISOString(),
        },
      ]
    : [];
  return [...base, ...memList.filter((w) => w.address !== normPrimary)];
}

/**
 * Links a cryptographically verified sub-wallet (`is_primary = false`) into `public.wallets`.
 * Enforces max 10 sub-wallets per user and DB-level UNIQUE(address, chain_type) anti-hijack guard.
 */
export async function linkVerifiedOwnedSubWallet(params: {
  userIdentifier: string;
  subWalletAddress: string;
}): Promise<OwnedWalletRecord> {
  const normPrimary = String(params.userIdentifier || '').trim().toLowerCase();
  const normSub = String(params.subWalletAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normSub)) {
    throw new Error('INVALID_SUBWALLET_ADDRESS');
  }

  const pool = getDbPool();
  if (pool) {
    const validUserId = await ensureUserEntity(pool, params.userIdentifier);

    const existing = await pool.query(
      `SELECT id, user_id, address, chain_type, is_primary, created_at
       FROM wallets
       WHERE LOWER(address) = LOWER($1) AND UPPER(chain_type) = 'EVM'
       LIMIT 1`,
      [normSub]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (String(row.user_id) !== String(validUserId)) {
        throw new Error('WALLET_ALREADY_CLAIMED_BY_ANOTHER_ACCOUNT');
      }
      return {
        id: String(row.id),
        address: String(row.address).toLowerCase(),
        chainType: String(row.chain_type || 'EVM').toUpperCase(),
        isPrimary: Boolean(row.is_primary),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
      };
    }

    const cntRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM wallets WHERE user_id = $1 AND is_primary = false`,
      [validUserId]
    );
    if (Number(cntRes.rows[0]?.cnt || 0) >= MAX_OWNED_SUBWALLETS_PER_USER) {
      throw new Error(`MAX_SUBWALLETS_REACHED: Maximum ${MAX_OWNED_SUBWALLETS_PER_USER} verified sub-wallets allowed.`);
    }

    const ins = await pool.query(
      `INSERT INTO wallets (user_id, address, chain_type, is_primary)
       VALUES ($1, $2, 'EVM', false)
       RETURNING id, address, chain_type, is_primary, created_at`,
      [validUserId, normSub]
    );
    const created = ins.rows[0];
    await pool
      .query(
        `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
         VALUES ($1, 'OWNED_SUBWALLET_LINKED', $2, $3, NOW())`,
        [validUserId, isUuid(created.id) ? created.id : null, `Linked verified owned sub-wallet ${normSub}`]
      )
      .catch(() => {});

    return {
      id: String(created.id),
      address: String(created.address).toLowerCase(),
      chainType: String(created.chain_type || 'EVM').toUpperCase(),
      isPrimary: Boolean(created.is_primary),
      createdAt: created.created_at ? new Date(created.created_at).toISOString() : new Date().toISOString(),
    };
  }

  const list = inMemoryOwnedSubWallets.get(normPrimary) || [];
  const dup = list.find((w) => w.address === normSub);
  if (dup) return dup;
  if (list.length >= MAX_OWNED_SUBWALLETS_PER_USER) {
    throw new Error(`MAX_SUBWALLETS_REACHED: Maximum ${MAX_OWNED_SUBWALLETS_PER_USER} verified sub-wallets allowed.`);
  }
  const rec: OwnedWalletRecord = {
    id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    address: normSub,
    chainType: 'EVM',
    isPrimary: false,
    createdAt: new Date().toISOString(),
  };
  inMemoryOwnedSubWallets.set(normPrimary, [...list, rec]);
  return rec;
}

/**
 * Unlinks a non-primary sub-wallet from `public.wallets` strictly scoped to the authenticated user.
 */
export async function unlinkOwnedSubWallet(params: {
  userIdentifier: string;
  subWalletAddress: string;
}): Promise<{ address: string; removed: boolean }> {
  const normPrimary = String(params.userIdentifier || '').trim().toLowerCase();
  const normSub = String(params.subWalletAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normSub)) {
    throw new Error('INVALID_SUBWALLET_ADDRESS');
  }

  const pool = getDbPool();
  if (pool) {
    const validUserId = await ensureUserEntity(pool, params.userIdentifier);
    const del = await pool.query(
      `DELETE FROM wallets
       WHERE user_id = $1 AND LOWER(address) = LOWER($2) AND is_primary = false
       RETURNING id`,
      [validUserId, normSub]
    );
    if (del.rowCount === 0) {
      throw new Error('SUBWALLET_NOT_FOUND_OR_PRIMARY_PROTECTED');
    }
    await pool
      .query(
        `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
         VALUES ($1, 'OWNED_SUBWALLET_UNLINKED', NULL, $2, NOW())`,
        [validUserId, `Unlinked owned sub-wallet ${normSub}`]
      )
      .catch(() => {});
    return { address: normSub, removed: true };
  }

  const list = inMemoryOwnedSubWallets.get(normPrimary) || [];
  const next = list.filter((w) => w.address !== normSub);
  if (next.length === list.length) {
    throw new Error('SUBWALLET_NOT_FOUND_OR_PRIMARY_PROTECTED');
  }
  inMemoryOwnedSubWallets.set(normPrimary, next);
  return { address: normSub, removed: true };
}

/**
 * Reads cumulative 24h `TRANSFER_OWNED` USD volume from `public.audit_logs`
 * using index `idx_audit_actor_date (actor_id, created_at DESC)` (Phase EH, Zero-Migration).
 */
export async function getUser24hOwnedTransferUsd(userIdentifier: string): Promise<number> {
  const pool = getDbPool();
  if (!pool) return 0;
  try {
    const validUserId = await ensureUserEntity(pool, userIdentifier);
    const res = await pool.query(
      `SELECT reason
       FROM audit_logs
       WHERE actor_id = $1
         AND action = 'COPILOT_MULTI_ACCOUNT_CONFIRMED'
         AND reason LIKE 'kind=TRANSFER_OWNED%'
         AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 200`,
      [validUserId]
    );
    let total = 0;
    for (const row of res.rows) {
      const m = String(row.reason || '').match(/\btotalUsd=(\d+(?:\.\d+)?)\b/);
      if (m?.[1]) {
        const val = Number(m[1]);
        if (Number.isFinite(val) && val > 0) total += val;
      }
    }
    return Math.round(total * 100) / 100;
  } catch {
    return 0;
  }
}

export function resetDbStateForTesting(): void {
  defaultBinanceExecutionDbAdapter.clearInMemoryState();
  defaultKillSwitchDbAdapter.clearKillSwitches();
  defaultBillingDbAdapter.clearSubscriptions();
  defaultDualControlDbAdapter.clearRequests();
  defaultDraftDbAdapter.clearDrafts();

  // Seed default test traders so existing test suites retain live trading entitlement
  defaultBillingDbAdapter.seedSubscription('usr-trader-killswitch-alpha', {
    planId: 'TRADER',
    status: 'ACTIVE',
    currentPeriodEnd: new Date(Date.now() + 86400000),
  });
  defaultBillingDbAdapter.seedSubscription('usr-trader-killswitch-beta', {
    planId: 'TRADER',
    status: 'ACTIVE',
    currentPeriodEnd: new Date(Date.now() + 86400000),
  });
}

// POSTGRES KILL SWITCH ADAPTER -> Extracted to packages/db/kill-switch-repo.ts (Phase AE1)

// ORDER SNAPSHOT STATE MACHINE & POSTGRES BINANCE EXECUTION ADAPTER -> Extracted to packages/db/binance-execution-repo.ts (Phase AJ2)
// POSTGRES BOUNTY MERKLE SNAPSHOT ADAPTER -> Extracted to packages/db/merkle-snapshot-repo.ts (Phase AJ2)
// ----------------------------------------------------------------------------
// GOVERNANCE AUDIT LOGS READER (SSOT `audit_logs`)
// ----------------------------------------------------------------------------
export interface AuditLogRecord {
  id: string;
  actorId: string;
  action: string;
  entityId: string | null;
  reason: string | null;
  createdAt: string;
}

export async function listRecentAuditLogs(
  limit: number = 20,
  actionFilter?: string
): Promise<AuditLogRecord[]> {
  const safeLimit = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)));
  const pool = getDbPool();
  if (!pool) return [];

  try {
    const cleanFilter = typeof actionFilter === 'string' ? actionFilter.trim().toUpperCase() : '';
    const hasFilter = cleanFilter.length > 0 && cleanFilter !== 'ALL';
    const sql = hasFilter
      ? `SELECT id, actor_id, action, entity_id, reason, created_at
         FROM audit_logs
         WHERE UPPER(action) LIKE $1
         ORDER BY created_at DESC
         LIMIT $2`
      : `SELECT id, actor_id, action, entity_id, reason, created_at
         FROM audit_logs
         ORDER BY created_at DESC
         LIMIT $1`;
    const params = hasFilter ? [`%${cleanFilter}%`, safeLimit] : [safeLimit];
    const res = await pool.query(sql, params);
    return res.rows.map((r: any) => ({
      id: String(r.id),
      actorId: String(r.actor_id || 'system'),
      action: String(r.action || 'UNKNOWN'),
      entityId: r.entity_id ? String(r.entity_id) : null,
      reason: r.reason ? String(r.reason) : null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    }));
  } catch (err: any) {
    console.warn('[listRecentAuditLogs] Non-blocking read warning:', err?.message);
    return [];
  }
}

// ----------------------------------------------------------------------------
// MODULAR DOMAIN REPOSITORY BARREL FACADE (packages/db/*)
// ----------------------------------------------------------------------------
import { maskApiKey, assertNotPrivateKeyOrMnemonic } from './credential-vault';
import {
  PostgresProviderKeyVaultAdapter,
  registerProviderVaultRepoDeps,
  type UserProviderKeyMeta,
} from '../db/provider-vault-repo';
import {
  PostgresCustomAgentAdapter,
  registerCustomAgentRepoDeps,
} from '../db/custom-agent-repo';
import {
  PostgresGameFiDbAdapter,
  registerGameFiRepoDeps,
} from '../db/gamefi-repo';
import {
  PostgresKillSwitchDbAdapter,
  registerKillSwitchRepoDeps,
} from '../db/kill-switch-repo';
import {
  PostgresProposalDbAdapter,
  registerProposalRepoDeps,
} from '../db/proposal-repo';
import {
  HandleConflictError,
  PostgresKolDbAdapter,
  inMemoryKolProfiles,
  registerKolRepoDeps,
} from '../db/kol-repo';
import {
  PostgresDualControlDbAdapter,
  registerDualControlRepoDeps,
} from '../db/dual-control-repo';
import {
  PostgresRpcDbAdapter,
  registerRpcRepoDeps,
} from '../db/rpc-repo';
import {
  PostgresDraftDbAdapter,
  registerLaunchDraftRepoDeps,
} from '../db/launch-draft-repo';
import {
  PostgresBountyDbAdapter,
  registerBountyRepoDeps,
} from '../db/bounty-repo';
import {
  PostgresBillingDbAdapter,
  DEFAULT_AI_FEATURE_WEIGHTS,
  registerBillingRepoDeps,
  type SubscriptionRecord,
  type AiFeatureWeights,
  type PlatformFeeAndRiskConfig,
} from '../db/billing-repo';
import {
  OrderSnapshotStateMachine,
  PostgresBinanceExecutionDbAdapter,
  registerBinanceExecutionRepoDeps,
  type SnapshotTransitionAction,
} from '../db/binance-execution-repo';
import {
  PostgresBountyMerkleSnapshotDbAdapter,
  registerMerkleSnapshotRepoDeps,
} from '../db/merkle-snapshot-repo';

registerProviderVaultRepoDeps({
  getDbPool,
  ensureUserEntity,
  isUuid,
  createAuditLog: (actorId, action, entityId, reason) =>
    defaultBillingDbAdapter.createAuditLog(actorId, action, entityId, reason),
});

registerCustomAgentRepoDeps({
  getDbPool,
  ensureUserEntity,
});

registerGameFiRepoDeps({
  getDbPool,
  ensureUserEntity,
  isUuid,
});

registerKillSwitchRepoDeps({
  getDbPool,
  ensureUserEntity,
  isUuid,
});

registerProposalRepoDeps({
  getDbPool,
  ensureUserEntity,
  isUuid,
});

registerKolRepoDeps({
  getDbPool,
  ensureUserEntity,
  isUuid,
});

registerDualControlRepoDeps({
  getDbPool,
  ensureUserEntity,
  isUuid,
});

registerRpcRepoDeps({
  getDbPool,
});

registerLaunchDraftRepoDeps({
  getDbPool,
  ensureUserEntity,
  ensureNetworkInPool,
  isUuid,
});

registerBountyRepoDeps({
  getDbPool,
  ensureUserEntity,
  isUuid,
});

registerBillingRepoDeps({
  getDbPool,
  ensureUserEntity,
});

registerBinanceExecutionRepoDeps({
  getDbPool,
  ensureUserEntity,
  isUuid,
  getActiveKillSwitches: () => defaultKillSwitchDbAdapter.getActiveKillSwitches(),
});

registerMerkleSnapshotRepoDeps({
  getDbPool,
});

export {
  HandleConflictError,
  DEFAULT_AI_FEATURE_WEIGHTS,
  OrderSnapshotStateMachine,
  PostgresProviderKeyVaultAdapter,
  PostgresCustomAgentAdapter,
  PostgresGameFiDbAdapter,
  PostgresKillSwitchDbAdapter,
  PostgresProposalDbAdapter,
  PostgresKolDbAdapter,
  PostgresDualControlDbAdapter,
  PostgresRpcDbAdapter,
  PostgresDraftDbAdapter,
  PostgresBountyDbAdapter,
  PostgresBillingDbAdapter,
  PostgresBinanceExecutionDbAdapter,
  PostgresBountyMerkleSnapshotDbAdapter,
  type SnapshotTransitionAction,
  type UserProviderKeyMeta,
  type SubscriptionRecord,
  type AiFeatureWeights,
  type PlatformFeeAndRiskConfig,
};

export const defaultProviderKeyVaultAdapter = new PostgresProviderKeyVaultAdapter();
export const defaultCustomAgentAdapter = new PostgresCustomAgentAdapter();
export const defaultGameFiDbAdapter = new PostgresGameFiDbAdapter();
export const defaultKillSwitchDbAdapter = new PostgresKillSwitchDbAdapter();
export const defaultProposalDbAdapter = new PostgresProposalDbAdapter();
export const defaultKolDbAdapter = new PostgresKolDbAdapter();
export const defaultDualControlDbAdapter = new PostgresDualControlDbAdapter();
export const defaultRpcDbAdapter = new PostgresRpcDbAdapter();
export const defaultRpcManager = new ModularRpcManager(defaultRpcDbAdapter);
export const defaultDraftDbAdapter = new PostgresDraftDbAdapter();
export const defaultBountyDbAdapter = new PostgresBountyDbAdapter();
export const defaultBillingDbAdapter = new PostgresBillingDbAdapter();
export const defaultBinanceExecutionDbAdapter = new PostgresBinanceExecutionDbAdapter();
export const defaultBountyMerkleSnapshotDbAdapter = new PostgresBountyMerkleSnapshotDbAdapter();

export function getDefaultRpcManager(): ModularRpcManager {
  return defaultRpcManager;
}

