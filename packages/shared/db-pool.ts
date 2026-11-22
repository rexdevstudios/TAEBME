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

export type SnapshotTransitionAction = 'INSERT' | 'APPLY_UPDATE' | 'NO_OP_IDENTICAL' | 'IGNORED_STALE';

export class OrderSnapshotStateMachine {
  static evaluateTransition(
    existing: {
      intentId?: string;
      exchangeOrderId?: string;
      symbol?: string;
      status: string;
      executedQty: number;
      cummulativeQuoteQty: number;
    } | null,
    incoming: {
      intentId: string;
      exchangeOrderId: string;
      symbol: string;
      status: string;
      executedQty: number;
      cummulativeQuoteQty: number;
    }
  ): { action: SnapshotTransitionAction; reason?: string } {
    // 0. Status validation
    const VALID_STATUSES = ['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'PENDING_CANCEL', 'REJECTED', 'EXPIRED'];
    if (!VALID_STATUSES.includes(incoming.status)) {
      throw new Error(`INVALID_ORDER_STATUS: Unknown or malformed order status: ${incoming.status}`);
    }

    if (!existing) {
      return { action: 'INSERT' };
    }

    // 1. Identity validation
    if (incoming.symbol && existing.symbol && incoming.symbol.replace('/', '').toUpperCase() !== existing.symbol.replace('/', '').toUpperCase()) {
      throw new Error(`ORDER_SYMBOL_MISMATCH: Incoming symbol ${incoming.symbol} does not match existing ${existing.symbol}`);
    }

    if (incoming.exchangeOrderId && existing.exchangeOrderId && String(incoming.exchangeOrderId) !== String(existing.exchangeOrderId)) {
      throw new Error(`ORDER_IDENTITY_MISMATCH: Incoming exchangeOrderId ${incoming.exchangeOrderId} does not match existing ${existing.exchangeOrderId}`);
    }

    const exQty = Number(existing.executedQty);
    const inQty = Number(incoming.executedQty);
    const exQuote = Number(existing.cummulativeQuoteQty);
    const inQuote = Number(incoming.cummulativeQuoteQty);

    // 2. Identical snapshot check
    if (
      incoming.status === existing.status &&
      Math.abs(inQty - exQty) < 1e-9 &&
      Math.abs(inQuote - exQuote) < 1e-9
    ) {
      return { action: 'NO_OP_IDENTICAL', reason: 'Identical snapshot already recorded' };
    }

    // 3. Terminal state protections
    const terminalStatuses = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'];
    if (terminalStatuses.includes(existing.status)) {
      if (existing.status === 'FILLED') {
        if (incoming.status === 'FILLED') {
          return { action: 'NO_OP_IDENTICAL', reason: 'Identical FILLED snapshot' };
        }
        return { action: 'IGNORED_STALE', reason: `Order is already in terminal state FILLED; contradictory incoming ${incoming.status} ignored` };
      }

      // If existing is CANCELED, REJECTED, EXPIRED:
      // Allow transition to FILLED only if incoming presents definitive execution evidence (inQty > 0, inQty >= exQty, and incoming.status === 'FILLED')
      if (incoming.status === 'FILLED' && inQty > 0 && inQty >= exQty && inQuote >= exQuote) {
        return { action: 'APPLY_UPDATE', reason: 'Authoritative FILLED evidence supersedes prior terminal status' };
      }

      if (inQty < exQty - 1e-9 || Math.abs(inQty - exQty) <= 1e-9) {
        return { action: 'IGNORED_STALE', reason: `Order is already terminal ${existing.status}; incoming ${incoming.status} ignored` };
      }
    }

    // 4. Monotonicity & Tuple Consistency
    // Case A: Executed quantity regresses
    if (inQty < exQty - 1e-9) {
      return { action: 'IGNORED_STALE', reason: `Incoming executedQty ${inQty} is less than recorded ${exQty}; late arrival ignored` };
    }

    // Case B: Executed quantity strictly increases
    if (inQty > exQty + 1e-9) {
      if (inQuote < exQuote - 1e-9) {
        throw new Error(
          `INCONSISTENT_SNAPSHOT: Executed quantity increased (${exQty} -> ${inQty}) but cummulativeQuoteQty regressed (${exQuote} -> ${inQuote})`
        );
      }
      return { action: 'APPLY_UPDATE' };
    }

    // Case C: Executed quantity equal (status progression, e.g. NEW -> PARTIALLY_FILLED or NEW/PARTIAL -> CANCELED)
    if (inQuote < exQuote - 1e-9) {
      throw new Error(
        `INCONSISTENT_SNAPSHOT: Executed quantity unchanged (${exQty}) but cummulativeQuoteQty regressed (${exQuote} -> ${inQuote})`
      );
    }

    return { action: 'APPLY_UPDATE' };
  }
}

export class PostgresBinanceExecutionDbAdapter implements BinanceExecutionDbAdapter {
  private inMemoryIntents: Map<string, TradeIntentRecord> = new Map();
  private inMemoryCredentials: Map<string, any> = new Map();
  private inMemoryFills: any[] = [];
  private inMemoryAuditLogs: any[] = [];
  private intentMutexMap: Map<string, Promise<void>> = new Map();
  private executionTimestampMap: Map<string, number> = new Map();
  private activeDbTransactions = 0;
  public readonly isExplicitInMemory: boolean;

  constructor(private customPool?: Pool | null) {
    // Explicit in-memory mode ONLY if customPool is explicitly set to null
    this.isExplicitInMemory = customPool === null;
  }

  private getPool(): Pool | null {
    if (this.isExplicitInMemory) return null;
    return this.customPool !== undefined ? this.customPool : getDbPool();
  }

  seedIntent(intent: TradeIntentRecord): void {
    this.inMemoryIntents.set(intent.id, intent);
    if (intent.status === 'EXECUTING') {
      const claimTime = (intent as any).executingSince !== undefined
        ? (intent as any).executingSince
        : (intent.createdAt ? new Date(intent.createdAt).getTime() : Date.now());
      this.inMemoryAuditLogs.push({
        actorId: intent.userId || 'binance-order-worker',
        action: 'INTENT_CLAIMED_EXECUTING',
        entityId: intent.id,
        reason: 'Seeded execution claim',
        createdAt: new Date(claimTime).toISOString(),
      });
    }
  }

  seedLegacyIntentWithoutClaim(intent: TradeIntentRecord): void {
    this.inMemoryIntents.set(intent.id, intent);
    this.executionTimestampMap.delete(intent.id);
    this.inMemoryAuditLogs = this.inMemoryAuditLogs.filter((l) => l.entityId !== intent.id);
  }

  seedIntents(intents: TradeIntentRecord[]): void {
    for (const intent of intents) {
      this.seedIntent(intent);
    }
  }

  getInMemoryIntents(): TradeIntentRecord[] {
    return Array.from(this.inMemoryIntents.values());
  }

  getInMemoryAuditLogs(): any[] {
    return [...this.inMemoryAuditLogs];
  }

  seedCredentials(userId: string, creds: any): void {
    this.inMemoryCredentials.set(userId, creds);
  }

  setExecutingTimestamp(intentId: string, timestamp: number): void {
    this.executionTimestampMap.set(intentId, timestamp);
    const mem = this.inMemoryIntents.get(intentId);
    if (mem) {
      (mem as any).executingSince = timestamp;
    }
  }

  getExecutingTimestamp(intentId: string): number | undefined {
    return this.executionTimestampMap.get(intentId);
  }

  clearInMemoryState(): void {
    this.inMemoryIntents.clear();
    this.inMemoryCredentials.clear();
    this.inMemoryBinanceVault = [];
    this.inMemoryFills = [];
    this.inMemoryAuditLogs = [];
    this.intentMutexMap.clear();
    this.executionTimestampMap.clear();
  }

  getAuditLogs(): any[] {
    return [...this.inMemoryAuditLogs];
  }

  getActiveTransactionCount(): number {
    return this.activeDbTransactions;
  }

  getOrderFills(): any[] {
    return [...this.inMemoryFills];
  }

  async getApprovedIntentsQueue(): Promise<TradeIntentRecord[]> {
    if (this.isExplicitInMemory) {
      return Array.from(this.inMemoryIntents.values()).filter((i) => i.status === 'APPROVED');
    }

    const pool = this.getPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is not configured for Binance order worker execution');
    }

    try {
      const res = await pool.query(
        `SELECT id, user_id AS "userId", stage, symbol, side, type,
                quantity::float AS quantity, price::float AS price,
                idempotency_key AS "idempotencyKey", status,
                risk_decision_id AS "riskDecisionId", created_at AS "createdAt"
         FROM trade_intents
         WHERE status = 'APPROVED'
         ORDER BY created_at ASC`
      );
      return res.rows.map((r: any) => ({
        id: r.id,
        userId: r.userId,
        stage: r.stage,
        symbol: r.symbol,
        side: r.side,
        type: r.type,
        quantity: parseFloat(r.quantity),
        price: r.price ? parseFloat(r.price) : undefined,
        maxSlippagePct: 1.0,
        idempotencyKey: r.idempotencyKey,
        status: r.status,
        riskDecisionId: r.riskDecisionId,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
      }));
    } catch (err: any) {
      console.error('[PostgresBinanceExecutionDbAdapter] getApprovedIntentsQueue failed (FAIL-CLOSED):', err?.message || err);
      throw err;
    }
  }

  async claimIntentAtomic(intentId: string): Promise<boolean> {
    this.activeDbTransactions++;
    try {
      if (this.isExplicitInMemory) {
        const mem = this.inMemoryIntents.get(intentId);
        if (mem && mem.status === 'APPROVED') {
          const now = Date.now();
          mem.status = 'EXECUTING';
          (mem as any).executingSince = now;
          this.executionTimestampMap.set(intentId, now);
          this.inMemoryAuditLogs.push({
            actorId: mem.userId || 'binance-order-worker',
            action: 'INTENT_CLAIMED_EXECUTING',
            entityId: intentId,
            reason: `Claimed for execution at ${new Date(now).toISOString()}`,
            createdAt: new Date(now).toISOString(),
          });
          return true;
        }
        return false;
      }

      const pool = this.getPool();
      if (!pool) {
        throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required for atomic intent claim');
      }

      if (!isUuid(intentId)) {
        throw new Error(`INVALID_INTENT_ID: Intent ID ${intentId} must be a valid UUID for atomic claim`);
      }

      const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
      try {
        await client.query('BEGIN');

        const res = await client.query(
          `UPDATE trade_intents
           SET status = 'EXECUTING'
           WHERE id = $1 AND status = 'APPROVED'
           RETURNING id, user_id AS "userId"`,
          [intentId]
        );

        if (res.rows.length === 0) {
          await client.query('ROLLBACK');
          return false;
        }

        const now = Date.now();
        const rawActorId = res.rows[0].userId || 'binance-order-worker';
        let validActorId = rawActorId;
        if (isUuid(rawActorId) || rawActorId.startsWith('0x')) {
          validActorId = await ensureUserEntity(client, rawActorId);
        }

        // Invariant: CAS APPROVED -> EXECUTING and audit log insertion MUST be atomic in the same transaction.
        // If audit insertion fails (e.g. FK constraint violation, connection timeout), the entire claim is rolled back!
        await client.query(
          `INSERT INTO audit_logs (id, actor_id, action, entity_id, reason, created_at)
           VALUES (gen_random_uuid(), $1, 'INTENT_CLAIMED_EXECUTING', $2, $3, NOW())`,
          [validActorId, intentId, `Claimed for execution at ${new Date(now).toISOString()}`]
        );

        await client.query('COMMIT');
        this.executionTimestampMap.set(intentId, now);
        return true;
      } catch (err: any) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback error on disconnected client
        }
        this.executionTimestampMap.delete(intentId);
        console.error(`[PostgresBinanceExecutionDbAdapter] claimIntentAtomic failed for ${intentId} (FAIL-CLOSED, ROLLED BACK):`, err?.message || err);
        throw err;
      } finally {
        if (typeof (client as any).release === 'function') {
          (client as any).release();
        }
      }
    } finally {
      this.activeDbTransactions--;
    }
  }

  async updateIntentStatus(intentId: string, status: string, riskDecisionId?: string): Promise<void> {
    if (status === 'EXECUTING') {
      // Invariant: Single unified claim mechanism.
      // Transition to EXECUTING is strictly a CAS from APPROVED to EXECUTING with atomic audit log insertion.
      // Delegating directly to claimIntentAtomic() guarantees zero bypass of the atomic claim + audit contract.
      const claimed = await this.claimIntentAtomic(intentId);
      if (claimed && riskDecisionId) {
        if (this.isExplicitInMemory) {
          const mem = this.inMemoryIntents.get(intentId);
          if (mem) {
            mem.riskDecisionId = riskDecisionId;
            mem.riskDecisionReason = riskDecisionId;
          }
        }
      }
      return;
    }

    if (this.isExplicitInMemory) {
      const mem = this.inMemoryIntents.get(intentId);
      if (mem) {
        if (mem.status === status) {
          if (riskDecisionId) {
            mem.riskDecisionId = riskDecisionId;
            mem.riskDecisionReason = riskDecisionId;
          }
          return;
        }

        // Terminal state CAS protection:
        // 1. Terminal state EXECUTED is irreversible (cannot regress to FAILED, CANCELLED, or EXECUTING)
        if (mem.status === 'EXECUTED') {
          console.warn(`[PostgresBinanceExecutionDbAdapter] Blocked attempt to mutate terminal EXECUTED intent ${intentId} to ${status}`);
          return;
        }
        // 2. Terminal CANCELLED cannot be overwritten by speculative local transitions.
        // Authoritative corrections to EXECUTED must pass through recordOrderFill() with exchange evidence.
        if (mem.status === 'CANCELLED') {
          console.warn(`[PostgresBinanceExecutionDbAdapter] Blocked attempt to mutate CANCELLED intent ${intentId} to ${status}. Authoritative corrections must pass through recordOrderFill().`);
          return;
        }
        // 3. Terminal FAILED / REJECTED cannot regress to non-terminal
        if ((mem.status === 'FAILED' || mem.status === 'REJECTED') && status === 'APPROVED') {
          console.warn(`[PostgresBinanceExecutionDbAdapter] Blocked attempt to mutate terminal ${mem.status} intent ${intentId} to ${status}`);
          return;
        }
        mem.status = status;
        this.executionTimestampMap.delete(intentId);
        if (riskDecisionId) {
          mem.riskDecisionId = riskDecisionId;
          mem.riskDecisionReason = riskDecisionId;
        }
      }
      return;
    }

    const pool = this.getPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required for updating intent status');
    }

    if (!isUuid(intentId)) {
      throw new Error(`INVALID_INTENT_ID: Intent ID ${intentId} must be a valid UUID`);
    }

    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE trade_intents
         SET status = $2,
             risk_decision_id = COALESCE($3, risk_decision_id)
         WHERE id = $1
           AND status != 'EXECUTED'
           AND status != 'CANCELLED'
           AND (status NOT IN ('FAILED', 'REJECTED') OR $2 NOT IN ('EXECUTING', 'APPROVED'))`,
        [intentId, status, riskDecisionId || null]
      );

      this.executionTimestampMap.delete(intentId);
      await client.query('COMMIT');
    } catch (err: any) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      this.executionTimestampMap.delete(intentId);
      console.error(`[PostgresBinanceExecutionDbAdapter] updateIntentStatus failed for ${intentId} (FAIL-CLOSED):`, err?.message || err);
      throw err;
    } finally {
      if (typeof (client as any).release === 'function') {
        (client as any).release();
      }
    }
  }

  async getStaleExecutingIntents(staleThresholdMs: number): Promise<TradeIntentRecord[]> {
    if (this.isExplicitInMemory) {
      const now = Date.now();
      return Array.from(this.inMemoryIntents.values()).filter((i) => {
        if (i.status !== 'EXECUTING') return false;

        // 1. Check in-process claim timestamp
        const inProcessClaim = this.executionTimestampMap.get(i.id);
        if (inProcessClaim !== undefined) {
          // If within threshold, definitely NOT stale
          if ((now - inProcessClaim) < staleThresholdMs) {
            return false;
          }
          // Past threshold: eligible candidate
          return true;
        }

        // 2. Check audit logs for historical claim evidence
        const claimAudit = this.inMemoryAuditLogs
          .slice()
          .reverse()
          .find((l) => l.action === 'INTENT_CLAIMED_EXECUTING' && l.entityId === i.id);

        if (claimAudit && claimAudit.createdAt) {
          const claimTime = new Date(claimAudit.createdAt).getTime();
          // Condition 1: Audit claim found and still within threshold -> NOT stale
          // Condition 2: Audit claim found and past threshold -> eligible candidate
          return (now - claimTime) >= staleThresholdMs;
        }

        // Condition 3: Audit claim NOT found:
        // Invariant: Do NOT automatically conclude the intent is stale based on createdAt alone!
        // Preserves intent status to prevent premature speculative reconciliation on unverified claim data.
        return false;
      });
    }

    const pool = this.getPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required for stale intent query');
    }

    try {
      // Invariant: Prevent racing with active execution dispatch.
      // Must have affirmative historical claim evidence past the threshold,
      // and NO recent execution claim within the threshold.
      // Note: audit_logs is historical evidence of claim timestamp, NOT a distributed lease or fencing token.
      // Schema migration for durable lease/fencing remains DEFERRED.
      const res = await pool.query(
        `SELECT ti.id, ti.user_id AS "userId", ti.stage, ti.symbol, ti.side, ti.type,
                ti.quantity::float AS quantity, ti.price::float AS price,
                ti.idempotency_key AS "idempotencyKey", ti.status,
                ti.risk_decision_id AS "riskDecisionId", ti.created_at AS "createdAt"
         FROM trade_intents ti
         WHERE ti.status = 'EXECUTING'
           -- 1. Must have affirmative evidence of an execution claim that has exceeded the stale threshold:
           AND EXISTS (
             SELECT 1 FROM audit_logs al
             WHERE al.entity_id = ti.id
               AND al.action = 'INTENT_CLAIMED_EXECUTING'
               AND al.created_at < NOW() - ($1 || ' milliseconds')::INTERVAL
           )
           -- 2. Must NOT have any newer execution claim within the threshold:
           AND NOT EXISTS (
             SELECT 1 FROM audit_logs al_recent
             WHERE al_recent.entity_id = ti.id
               AND al_recent.action = 'INTENT_CLAIMED_EXECUTING'
               AND al_recent.created_at >= NOW() - ($1 || ' milliseconds')::INTERVAL
           )
         ORDER BY ti.created_at ASC`,
        [staleThresholdMs]
      );
      const now = Date.now();
      return res.rows
        .filter((r: any) => {
          const inProcessClaim = this.executionTimestampMap.get(r.id);
          if (inProcessClaim && (now - inProcessClaim) < staleThresholdMs) {
            return false;
          }
          return true;
        })
        .map((r: any) => ({
          id: r.id,
          userId: r.userId,
          stage: r.stage,
          symbol: r.symbol,
          side: r.side,
          type: r.type,
          quantity: parseFloat(r.quantity),
          price: r.price ? parseFloat(r.price) : undefined,
          maxSlippagePct: 1.0,
          idempotencyKey: r.idempotencyKey,
          status: r.status,
          riskDecisionId: r.riskDecisionId,
          createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
        }));
    } catch (err: any) {
      console.error('[PostgresBinanceExecutionDbAdapter] getStaleExecutingIntents failed (FAIL-CLOSED):', err?.message || err);
      throw err;
    }
  }

  async getBinanceCredentials(userId: string, credentialId?: string): Promise<any> {
    if (this.isExplicitInMemory) {
      if (credentialId) {
        const found = this.inMemoryBinanceVault.find(
          (c) => c.userId === userId.toLowerCase() && c.id === credentialId && c.isActive
        );
        if (found) {
          return {
            id: found.id,
            label: found.label,
            environment: found.environment,
            encryptedApiKey: found.encryptedApiKey,
            encryptedSecretKey: found.encryptedSecretKey,
            permissions: found.permissions,
            isActive: found.isActive,
          };
        }
        return null;
      }
      const userVault = this.inMemoryBinanceVault
        .filter((c) => c.userId === userId.toLowerCase() && c.isActive)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
      if (userVault.length > 0) {
        const top = userVault[0];
        return {
          id: top.id,
          label: top.label,
          environment: top.environment,
          encryptedApiKey: top.encryptedApiKey,
          encryptedSecretKey: top.encryptedSecretKey,
          permissions: top.permissions,
          isActive: top.isActive,
        };
      }
      return this.inMemoryCredentials.get(userId) || null;
    }

    const pool = this.getPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required for fetching credentials');
    }

    if (!isUuid(userId) && !userId.startsWith('0x')) {
      throw new Error(`INVALID_USER_ID: User ID ${userId} must be a valid UUID or EVM address`);
    }

    try {
      const validUserId = await ensureUserEntity(pool, userId);
      const query = credentialId
        ? `SELECT id, label, environment, encrypted_api_key, encrypted_secret_key, key_permissions, is_active
           FROM binance_credentials
           WHERE user_id = $1 AND id = $2 AND is_active = true
           LIMIT 1`
        : `SELECT id, label, environment, encrypted_api_key, encrypted_secret_key, key_permissions, is_active
           FROM binance_credentials
           WHERE user_id = $1 AND is_active = true
           ORDER BY is_default DESC, created_at DESC
           LIMIT 1`;
      const params = credentialId ? [validUserId, credentialId] : [validUserId];
      const res = await pool.query(query, params);
      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          id: row.id,
          label: row.label || 'Binance Primary',
          environment: (row.environment === 'MAINNET' ? 'MAINNET' : 'TESTNET') as 'TESTNET' | 'MAINNET',
          encryptedApiKey: row.encrypted_api_key,
          encryptedSecretKey: row.encrypted_secret_key,
          permissions: row.key_permissions,
          isActive: row.is_active,
        };
      }
      return null;
    } catch (err: any) {
      console.error(`[PostgresBinanceExecutionDbAdapter] getBinanceCredentials failed for ${userId} (FAIL-CLOSED):`, err?.message || err);
      throw err;
    }
  }

  private static readonly MAX_ACTIVE_BINANCE_ACCOUNTS = 50;
  private inMemoryBinanceVault: Array<
    BinanceCredentialMeta & { encryptedApiKey: string; encryptedSecretKey: string }
  > = [];

  static resolveMasterKeyHex(customMasterKeyHex?: string): string {
    const candidate = customMasterKeyHex || process.env.BINANCE_VAULT_MASTER_KEY || process.env.MASTER_VAULT_KEY;
    if (candidate && /^[0-9a-fA-F]{64}$/.test(candidate.trim())) {
      return candidate.trim().toLowerCase();
    }
    const seed =
      candidate ||
      process.env.CREDENTIAL_ENCRYPTION_KEY ||
      process.env.SESSION_SECRET ||
      process.env.JWT_SECRET ||
      'poolnet-v25-binance-vault-master-key';
    return crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
  }

  async listBinanceCredentials(userId: string): Promise<BinanceCredentialMeta[]> {
    if (this.isExplicitInMemory) {
      const norm = userId.toLowerCase();
      return this.inMemoryBinanceVault
        .filter((c) => c.userId === norm && c.isActive)
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
        .map(({ encryptedApiKey: _a, encryptedSecretKey: _s, ...meta }) => meta);
    }

    const pool = this.getPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required for listing Binance credentials');
    }

    const validUserId = await ensureUserEntity(pool, userId);
    const res = await pool.query(
      `SELECT id, user_id, label, masked_api_key, environment, key_permissions, is_default, is_active, last_used_at, created_at
       FROM binance_credentials
       WHERE user_id = $1 AND is_active = true
       ORDER BY is_default DESC, created_at DESC`,
      [validUserId]
    );
    return res.rows.map((r: any) => ({
      id: String(r.id),
      userId: String(r.user_id),
      label: String(r.label || 'Binance Primary'),
      maskedApiKey: String(r.masked_api_key || '****'),
      environment: (r.environment === 'MAINNET' ? 'MAINNET' : 'TESTNET') as 'TESTNET' | 'MAINNET',
      permissions: (r.key_permissions || { read: true, trade: true, withdraw: false }) as BinanceKeyPermissions,
      isDefault: Boolean(r.is_default),
      isActive: Boolean(r.is_active),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    }));
  }

  async addBinanceCredential(params: {
    userId: string;
    label: string;
    rawApiKey: string;
    rawSecretKey: string;
    environment?: string;
    permissions?: Partial<BinanceKeyPermissions>;
    isDefault?: boolean;
    maxAllowed?: number;
    customMasterKeyHex?: string;
  }): Promise<BinanceCredentialMeta> {
    const cleanLabel = (params.label || '').trim().slice(0, 64);
    if (cleanLabel.length < 2) {
      throw new Error('INVALID_ACCOUNT_LABEL: Account label must be at least 2 characters.');
    }

    const effectiveMax = Math.max(
      1,
      Math.min(
        PostgresBinanceExecutionDbAdapter.MAX_ACTIVE_BINANCE_ACCOUNTS,
        Number(params.maxAllowed ?? 10)
      )
    );

    const rawApiKey = (params.rawApiKey || '').trim();
    const rawSecretKey = (params.rawSecretKey || '').trim();
    // Reuse Non-Custodial Guardrail (AGENTS.md Rule 3) — rejects wallet private keys & BIP-39 mnemonics
    assertNotPrivateKeyOrMnemonic(rawApiKey);
    assertNotPrivateKeyOrMnemonic(rawSecretKey);

    const permissions: BinanceKeyPermissions = {
      read: params.permissions?.read !== false,
      trade: params.permissions?.trade !== false,
      withdraw: Boolean(params.permissions?.withdraw),
    };
    // Enforce anti-withdrawal guardrail
    validateBinancePermissions(permissions);

    const envUpper = (params.environment || 'TESTNET').trim().toUpperCase();
    const environment: 'TESTNET' | 'MAINNET' = envUpper === 'MAINNET' ? 'MAINNET' : 'TESTNET';

    const masterKeyHex = PostgresBinanceExecutionDbAdapter.resolveMasterKeyHex(params.customMasterKeyHex);
    const encApi = JSON.stringify(BinanceCredentialVault.encrypt(rawApiKey, masterKeyHex));
    const encSecret = JSON.stringify(BinanceCredentialVault.encrypt(rawSecretKey, masterKeyHex));
    const maskedApiKey = maskApiKey(rawApiKey);

    if (this.isExplicitInMemory) {
      const norm = params.userId.toLowerCase();
      const active = this.inMemoryBinanceVault.filter((c) => c.userId === norm && c.isActive);
      if (active.length >= effectiveMax) {
        throw new Error(
          `MAX_KEYS_REACHED: Maximum ${effectiveMax} active Binance accounts allowed for your plan.`
        );
      }
      const shouldBeDefault = Boolean(params.isDefault) || active.length === 0;
      if (shouldBeDefault) {
        for (const item of active) item.isDefault = false;
      }
      const record = {
        id: crypto.randomUUID(),
        userId: norm,
        label: cleanLabel,
        maskedApiKey,
        environment,
        permissions,
        isDefault: shouldBeDefault,
        isActive: true,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
        encryptedApiKey: encApi,
        encryptedSecretKey: encSecret,
      };
      this.inMemoryBinanceVault.push(record);
      await this.createAuditLog(norm, 'BINANCE_CREDENTIAL_ADDED', record.id, `Added Binance ${environment} account "${cleanLabel}"`);
      const { encryptedApiKey: _a, encryptedSecretKey: _s, ...meta } = record;
      return meta;
    }

    const pool = this.getPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required for saving Binance credentials');
    }

    const validUserId = await ensureUserEntity(pool, params.userId);
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM binance_credentials WHERE user_id = $1 AND is_active = true`,
      [validUserId]
    );
    const existingCount = Number(countRes.rows[0]?.cnt || 0);
    if (existingCount >= effectiveMax) {
      throw new Error(
        `MAX_KEYS_REACHED: Maximum ${effectiveMax} active Binance accounts allowed for your plan.`
      );
    }

    const shouldBeDefault = Boolean(params.isDefault) || existingCount === 0;
    if (shouldBeDefault) {
      await pool.query(`UPDATE binance_credentials SET is_default = false WHERE user_id = $1`, [validUserId]);
    }

    const id = crypto.randomUUID();
    const res = await pool.query(
      `INSERT INTO binance_credentials (
         id, user_id, label, masked_api_key, environment,
         encrypted_api_key, encrypted_secret_key, key_permissions,
         is_default, is_active, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, true, NOW(), NOW())
       RETURNING id, user_id, label, masked_api_key, environment, key_permissions, is_default, is_active, last_used_at, created_at`,
      [id, validUserId, cleanLabel, maskedApiKey, environment, encApi, encSecret, JSON.stringify(permissions), shouldBeDefault]
    );
    const r = res.rows[0];
    await this.createAuditLog(validUserId, 'BINANCE_CREDENTIAL_ADDED', id, `Added Binance ${environment} account "${cleanLabel}" (${maskedApiKey})`);
    return {
      id: String(r.id),
      userId: String(r.user_id),
      label: String(r.label),
      maskedApiKey: String(r.masked_api_key),
      environment: (r.environment === 'MAINNET' ? 'MAINNET' : 'TESTNET') as 'TESTNET' | 'MAINNET',
      permissions: r.key_permissions as BinanceKeyPermissions,
      isDefault: Boolean(r.is_default),
      isActive: Boolean(r.is_active),
      lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    };
  }

  async setDefaultBinanceCredential(userId: string, credentialId: string): Promise<boolean> {
    if (this.isExplicitInMemory) {
      const norm = userId.toLowerCase();
      const target = this.inMemoryBinanceVault.find(
        (c) => c.userId === norm && c.id === credentialId && c.isActive
      );
      if (!target) return false;
      for (const c of this.inMemoryBinanceVault) {
        if (c.userId === norm && c.isActive) c.isDefault = c.id === credentialId;
      }
      return true;
    }

    const pool = this.getPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required');
    }
    const validUserId = await ensureUserEntity(pool, userId);
    const check = await pool.query(
      `SELECT id FROM binance_credentials WHERE id = $1 AND user_id = $2 AND is_active = true`,
      [credentialId, validUserId]
    );
    if (check.rows.length === 0) return false;
    await pool.query(`UPDATE binance_credentials SET is_default = false, updated_at = NOW() WHERE user_id = $1`, [validUserId]);
    await pool.query(
      `UPDATE binance_credentials SET is_default = true, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
      [credentialId, validUserId]
    );
    return true;
  }

  async revokeBinanceCredential(userId: string, credentialId: string): Promise<boolean> {
    if (this.isExplicitInMemory) {
      const norm = userId.toLowerCase();
      const target = this.inMemoryBinanceVault.find(
        (c) => c.userId === norm && c.id === credentialId && c.isActive
      );
      if (!target) return false;
      target.isActive = false;
      target.isDefault = false;
      await this.createAuditLog(norm, 'BINANCE_CREDENTIAL_REVOKED', credentialId, `Revoked Binance account "${target.label}"`);
      return true;
    }

    const pool = this.getPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required');
    }
    const validUserId = await ensureUserEntity(pool, userId);
    const res = await pool.query(
      `UPDATE binance_credentials
       SET is_active = false, is_default = false, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND is_active = true
       RETURNING id, label`,
      [credentialId, validUserId]
    );
    if (res.rows.length === 0) return false;
    await this.createAuditLog(
      validUserId,
      'BINANCE_CREDENTIAL_REVOKED',
      credentialId,
      `Revoked Binance account "${res.rows[0].label || credentialId}"`
    );
    return true;
  }

  async touchBinanceCredentialLastUsed(credentialId: string): Promise<void> {
    if (!credentialId) return;
    if (this.isExplicitInMemory) {
      const target = this.inMemoryBinanceVault.find((c) => c.id === credentialId);
      if (target) {
        target.lastUsedAt = new Date().toISOString();
      }
      return;
    }

    const pool = this.getPool();
    if (!pool) return;
    try {
      await pool.query(`UPDATE binance_credentials SET last_used_at = NOW(), updated_at = NOW() WHERE id = $1`, [credentialId]);
    } catch {
      // Non-blocking telemetry update
    }
  }

  async recordOrderFill(fill: {
    intentId: string;
    exchangeOrderId: string;
    symbol: string;
    status: string;
    executedQty: number;
    cummulativeQuoteQty: number;
    audit?: {
      actorId?: string;
      action: string;
      reason?: string;
    };
  }): Promise<void> {
    const currentMutex = this.intentMutexMap.get(fill.intentId) || Promise.resolve();
    let releaseMutex!: () => void;
    const nextMutex = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    this.intentMutexMap.set(fill.intentId, nextMutex);

    await currentMutex;
    this.activeDbTransactions++;
    try {
      if (this.isExplicitInMemory) {
        const memIntent = this.inMemoryIntents.get(fill.intentId);
        if (!memIntent) {
          throw new Error(`PARENT_INTENT_NOT_FOUND: Trade intent ${fill.intentId} does not exist`);
        }

        const existing = this.inMemoryFills.find((f) => f.intentId === fill.intentId);
        const transition = OrderSnapshotStateMachine.evaluateTransition(existing || null, fill);
        if (transition.action === 'INSERT') {
          this.inMemoryFills.push({ ...fill, createdAt: new Date().toISOString() });
        } else if (transition.action === 'APPLY_UPDATE') {
          const idx = this.inMemoryFills.findIndex((f) => f.intentId === fill.intentId);
          if (idx >= 0) {
            this.inMemoryFills[idx] = { ...this.inMemoryFills[idx], ...fill, updatedAt: new Date().toISOString() };
          }
        }
        if (transition.action === 'INSERT' || transition.action === 'APPLY_UPDATE') {
          // If snapshot is FILLED, sync inMemoryIntents status to EXECUTED
          if (fill.status === 'FILLED') {
            memIntent.status = 'EXECUTED';
          } else if (fill.status === 'CANCELED' || fill.status === 'EXPIRED') {
            if (memIntent.status !== 'EXECUTED') {
              memIntent.status = 'CANCELLED';
            }
          } else if (fill.status === 'REJECTED') {
            if (memIntent.status !== 'EXECUTED' && memIntent.status !== 'CANCELLED') {
              memIntent.status = 'FAILED';
            }
          }

          const memActorId = fill.audit?.actorId || memIntent.userId || 'system';
          const memAction = fill.audit?.action || (fill.status === 'FILLED' ? 'BINANCE_ORDER_EXECUTED' : 'BINANCE_ORDER_FILL_SNAPSHOT');
          const memReason = fill.audit?.reason || `Symbol: ${fill.symbol}, Status: ${fill.status}, ExecutedQty: ${fill.executedQty}, CumQuoteQty: ${fill.cummulativeQuoteQty}, ExchangeOrderId: ${fill.exchangeOrderId}`;
          this.inMemoryAuditLogs.push({
            actorId: memActorId,
            action: memAction,
            entityId: fill.intentId,
            reason: memReason,
            createdAt: new Date().toISOString(),
          });
        }
        return;
      }

      const pool = this.getPool();
      if (!pool) {
        throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required for recording order fill');
      }

      if (!isUuid(fill.intentId)) {
        throw new Error(`INVALID_INTENT_ID: Intent ID ${fill.intentId} must be a valid UUID for recording order fill`);
      }

      const hasConnect = typeof (pool as any).connect === 'function';
      const client = hasConnect ? await (pool as any).connect() : pool;
      try {
        await client.query('BEGIN');
        const parentCheck = await client.query(
          'SELECT id, status, user_id AS "userId" FROM trade_intents WHERE id = $1 FOR UPDATE',
          [fill.intentId]
        );
        if (parentCheck.rows.length === 0) {
          throw new Error(`PARENT_INTENT_NOT_FOUND: Trade intent ${fill.intentId} does not exist`);
        }

        const existingOrderRes = await client.query(
          `SELECT id, intent_id, exchange_order_id AS "exchangeOrderId", symbol, status,
                  executed_qty::float AS "executedQty",
                  cummulative_quote_qty::float AS "cummulativeQuoteQty"
           FROM orders
           WHERE intent_id = $1
           LIMIT 1`,
          [fill.intentId]
        );

        const existing = existingOrderRes.rows.length > 0 ? existingOrderRes.rows[0] : null;
        const transition = OrderSnapshotStateMachine.evaluateTransition(existing, fill);

        if (transition.action === 'INSERT') {
          await client.query(
            `INSERT INTO orders (
              intent_id, exchange_order_id, symbol, status,
              executed_qty, cummulative_quote_qty, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
            [
              fill.intentId,
              fill.exchangeOrderId,
              fill.symbol,
              fill.status,
              fill.executedQty,
              fill.cummulativeQuoteQty,
            ]
          );
        } else if (transition.action === 'APPLY_UPDATE') {
          await client.query(
            `UPDATE orders
             SET status = $2,
                 executed_qty = $3,
                 cummulative_quote_qty = $4,
                 updated_at = NOW()
             WHERE intent_id = $1`,
            [
              fill.intentId,
              fill.status,
              fill.executedQty,
              fill.cummulativeQuoteQty,
            ]
          );
        }

        if (transition.action === 'INSERT' || transition.action === 'APPLY_UPDATE') {
          if (fill.status === 'FILLED') {
            await client.query(
              `UPDATE trade_intents SET status = 'EXECUTED' WHERE id = $1 AND status != 'EXECUTED'`,
              [fill.intentId]
            );
          } else if (fill.status === 'CANCELED' || fill.status === 'EXPIRED') {
            await client.query(
              `UPDATE trade_intents SET status = 'CANCELLED' WHERE id = $1 AND status NOT IN ('EXECUTED', 'CANCELLED')`,
              [fill.intentId]
            );
          } else if (fill.status === 'REJECTED') {
            await client.query(
              `UPDATE trade_intents SET status = 'FAILED' WHERE id = $1 AND status NOT IN ('EXECUTED', 'CANCELLED', 'FAILED')`,
              [fill.intentId]
            );
          }

          // Atomic audit log insertion within the SAME transaction connection:
          const rawActorId = fill.audit?.actorId || parentCheck.rows[0].userId || 'system';
          const auditAction = fill.audit?.action || (fill.status === 'FILLED' ? 'BINANCE_ORDER_EXECUTED' : 'BINANCE_ORDER_FILL_SNAPSHOT');
          const auditReason = fill.audit?.reason || `Symbol: ${fill.symbol}, Status: ${fill.status}, ExecutedQty: ${fill.executedQty}, CumQuoteQty: ${fill.cummulativeQuoteQty}, ExchangeOrderId: ${fill.exchangeOrderId}`;

          let validActorId = rawActorId;
          if (isUuid(rawActorId) || rawActorId.startsWith('0x')) {
            validActorId = await ensureUserEntity(client, rawActorId);
          }

          await client.query(
            `INSERT INTO audit_logs (id, actor_id, action, entity_id, reason, created_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())`,
            [validActorId, auditAction, fill.intentId, auditReason]
          );
        }

        await client.query('COMMIT');

        const existingMemIdx = this.inMemoryFills.findIndex((f) => f.intentId === fill.intentId);
        if (existingMemIdx >= 0) {
          if (transition.action === 'APPLY_UPDATE') {
            this.inMemoryFills[existingMemIdx] = { ...this.inMemoryFills[existingMemIdx], ...fill, updatedAt: new Date().toISOString() };
          }
        } else if (transition.action === 'INSERT') {
          this.inMemoryFills.push({ ...fill, createdAt: new Date().toISOString() });
        }
      } catch (txErr: any) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        if (hasConnect && typeof client.release === 'function') {
          client.release();
        }
      }
    } catch (err: any) {
      console.error(`[PostgresBinanceExecutionDbAdapter] recordOrderFill failed for intent ${fill.intentId} (FAIL-CLOSED):`, err?.message || err);
      throw err;
    } finally {
      this.activeDbTransactions--;
      releaseMutex();
      if (this.intentMutexMap.get(fill.intentId) === nextMutex) {
        this.intentMutexMap.delete(fill.intentId);
      }
    }
  }

  async createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void> {
    if (this.isExplicitInMemory) {
      this.inMemoryAuditLogs.push({
        actorId,
        action,
        entityId,
        intentId: entityId,
        reason,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const pool = this.getPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required for recording audit log');
    }

    try {
      const validActorId = await ensureUserEntity(pool, actorId);
      let validEntityId: string | null = null;
      if (entityId && isUuid(entityId)) {
        const entityCheck = await pool.query('SELECT id FROM entities WHERE id = $1', [entityId]);
        if (entityCheck.rows.length > 0) {
          validEntityId = entityId;
        }
      }

      await pool.query(
        `INSERT INTO audit_logs (id, actor_id, action, entity_id, reason, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())`,
        [validActorId, action, validEntityId, reason || '']
      );

      this.inMemoryAuditLogs.push({
        actorId,
        action,
        entityId,
        reason,
        createdAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error(`[PostgresBinanceExecutionDbAdapter] createAuditLog failed for action ${action} (FAIL-CLOSED):`, err?.message || err);
      throw err;
    }
  }

  async getActiveKillSwitches(): Promise<any[]> {
    if (this.isExplicitInMemory) {
      return defaultKillSwitchDbAdapter.getActiveKillSwitches();
    }

    const pool = this.getPool();
    if (!pool) {
      throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is required for querying active kill switches');
    }

    try {
      const res = await pool.query(
        `SELECT id, scope, target_id as "targetId", is_active as "isActive", reason
         FROM kill_switches WHERE is_active = TRUE`
      );
      return res.rows.map((r: any) => ({
        id: r.id,
        scope: r.scope,
        targetId: r.targetId || undefined,
        isActive: r.isActive,
        reason: r.reason,
      }));
    } catch (err: any) {
      console.error('[PostgresBinanceExecutionDbAdapter] getActiveKillSwitches failed (FAIL-CLOSED):', err?.message || err);
      throw err;
    }
  }
}

export const defaultBinanceExecutionDbAdapter = new PostgresBinanceExecutionDbAdapter();

// ============================================================================
// POSTGRES GAMEFI & NFT DATABASE ADAPTER -> Extracted to packages/db/gamefi-repo.ts (Phase AD2)
// ============================================================================

// POSTGRES PROPOSAL ADAPTER -> Extracted to packages/db/proposal-repo.ts (Phase AE1)

// POSTGRES BILLING DB ADAPTER -> Extracted to packages/db/billing-repo.ts (Phase AI2)

// POSTGRES DUAL-CONTROL DB ADAPTER -> Extracted to packages/db/dual-control-repo.ts (Phase AF1)


// ============================================================================
// B3.2 — POSTGRESQL BOUNTY MERKLE SNAPSHOT DB ADAPTER
// ============================================================================
//
// Implements BountyMerkleSnapshotDbAdapter from bounty-merkle-snapshot-service.ts.
// All DB calls use getDbPool() — fail-closed: throws DATABASE_UNAVAILABLE if pool absent.
// No live transaction signing or broadcasting occurs here (B3.3 scope).
// ============================================================================

import {
  BountyMerkleSnapshotDbAdapter,
  BountyMerkleSnapshotRecord,
  BountyMerkleRecipientRecord,
  BountyMerkleAllocationRecord,
  BountyMerkleAuditLogRecord,
  VerifiedClaimSourceItem,
  TokenLaunchInfo,
} from '../launchpad/bounty-merkle-snapshot-service';

class PostgresBountyMerkleSnapshotDbAdapter implements BountyMerkleSnapshotDbAdapter {
  private requirePool(): import('pg').Pool {
    const pool = getDbPool();
    if (!pool) throw new Error('DATABASE_UNAVAILABLE: PostgreSQL pool is not initialised');
    return pool;
  }

  async getLaunch(launchId: string): Promise<TokenLaunchInfo | null> {
    const pool = this.requirePool();
    const res = await pool.query<{
      id: string;
      chain_id: string;
      network_id: string;
      contract_address: string;
      token_address: string;
      name: string | null;
      symbol: string | null;
    }>(
      `SELECT
         id,
         COALESCE(chain_id::text, '8453') AS chain_id,
         COALESCE(network_id, 'base-mainnet') AS network_id,
         COALESCE(contract_address, '') AS contract_address,
         COALESCE(token_address, contract_address, '') AS token_address,
         name,
         symbol
       FROM token_launches
       WHERE id = $1
       LIMIT 1`,
      [launchId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      chainId: BigInt(r.chain_id),
      networkId: r.network_id,
      contractAddress: r.contract_address,
      tokenAddress: r.token_address || r.contract_address,
      name: r.name ?? undefined,
      symbol: r.symbol ?? undefined,
    };
  }

  async getVerifiedClaims(launchId: string, campaignId?: string): Promise<VerifiedClaimSourceItem[]> {
    const pool = this.requirePool();
    const params: unknown[] = [launchId];
    let campaignFilter = '';
    if (campaignId) {
      params.push(campaignId);
      campaignFilter = `AND bc.id = $${params.length}`;
    }
    const res = await pool.query<{
      claim_id: string;
      campaign_id: string;
      launch_id: string;
      kol_id: string;
      claimant_wallet_id: string;
      claimant_wallet: string;
      allocated_amount: string;
      reward_per_kol: string;
      verification_status: string;
    }>(
      `SELECT
         bcl.id AS claim_id,
         bc.id AS campaign_id,
         bc.launch_id,
         bcl.kol_id,
         COALESCE(bcl.kol_id, bcl.id) AS claimant_wallet_id,
         COALESCE(kp.wallet_address, bcl.kol_id) AS claimant_wallet,
         bc.reward_per_kol::text AS allocated_amount,
         bc.reward_per_kol::text AS reward_per_kol,
         bcl.verification_status
       FROM bounty_claims bcl
       JOIN bounty_campaigns bc ON bc.id = bcl.campaign_id
       LEFT JOIN kol_profiles kp ON kp.id = bcl.kol_id
       WHERE bc.launch_id = $1
         AND bcl.verification_status = 'VERIFIED'
         ${campaignFilter}`,
      params
    );
    return res.rows.map((r) => ({
      claimId: r.claim_id,
      campaignId: r.campaign_id,
      launchId: r.launch_id,
      kolId: r.kol_id,
      claimantWalletId: r.claimant_wallet_id,
      claimantWallet: r.claimant_wallet,
      allocatedAmount: BigInt(r.allocated_amount),
      campaignRewardPerKol: BigInt(r.reward_per_kol),
      verificationStatus: 'VERIFIED' as const,
    }));
  }

  async findSnapshotByIdempotencyKey(key: string): Promise<BountyMerkleSnapshotRecord | null> {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT * FROM bounty_merkle_snapshots WHERE idempotency_key = $1 LIMIT 1`,
      [key]
    );
    if (res.rows.length === 0) return null;
    return this._rowToSnapshotRecord(res.rows[0]);
  }

  async getActivePublishedSnapshot(
    tokenAddress: string,
    chainId?: bigint,
    contractAddress?: string
  ): Promise<BountyMerkleSnapshotRecord | null> {
    const pool = this.requirePool();
    const params: unknown[] = [tokenAddress.toLowerCase()];
    let extra = '';
    if (chainId !== undefined) {
      params.push(chainId.toString());
      extra += ` AND chain_id = $${params.length}`;
    }
    if (contractAddress) {
      params.push(contractAddress.toLowerCase());
      extra += ` AND LOWER(contract_address) = $${params.length}`;
    }
    const res = await pool.query(
      `SELECT * FROM bounty_merkle_snapshots
       WHERE LOWER(token_address) = $1
         AND status = 'PUBLISHED'
         ${extra}
       ORDER BY version DESC
       LIMIT 1`,
      params
    );
    if (res.rows.length === 0) return null;
    return this._rowToSnapshotRecord(res.rows[0]);
  }

  async getLatestSnapshotVersion(
    chainId: bigint,
    contractAddress: string,
    tokenAddress: string,
    campaignId?: string | null
  ): Promise<number> {
    const pool = this.requirePool();
    const params: unknown[] = [chainId.toString(), contractAddress.toLowerCase(), tokenAddress.toLowerCase()];
    let campaignFilter = 'AND campaign_id IS NULL';
    if (campaignId !== undefined && campaignId !== null) {
      params.push(campaignId);
      campaignFilter = `AND campaign_id = $${params.length}`;
    }
    const res = await pool.query<{ max_version: string | null }>(
      `SELECT MAX(version) AS max_version
       FROM bounty_merkle_snapshots
       WHERE chain_id = $1
         AND LOWER(contract_address) = $2
         AND LOWER(token_address) = $3
         ${campaignFilter}`,
      params
    );
    return Number(res.rows[0]?.max_version ?? 0) + 1;
  }

  async createDraftSnapshotTransaction(params: {
    snapshot: BountyMerkleSnapshotRecord;
    recipients: BountyMerkleRecipientRecord[];
    allocations: BountyMerkleAllocationRecord[];
    auditLog?: BountyMerkleAuditLogRecord;
  }): Promise<BountyMerkleSnapshotRecord> {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Insert snapshot header
      await client.query(
        `INSERT INTO bounty_merkle_snapshots (
           id, launch_id, campaign_id, network_id, chain_id, contract_address, token_address,
           version, snapshot_type, total_reward_tokens, total_recipients, total_claims_count,
           merkle_root, tree_depth, leaf_encoding_version, tree_algorithm, pair_hashing_convention,
           leaf_sorting_rule, proof_format_version, status, idempotency_key, created_by,
           created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW(),NOW()
         )`,
        [
          params.snapshot.id,
          params.snapshot.launch_id,
          params.snapshot.campaign_id ?? null,
          params.snapshot.network_id,
          params.snapshot.chain_id.toString(),
          params.snapshot.contract_address,
          params.snapshot.token_address,
          params.snapshot.version,
          params.snapshot.snapshot_type,
          params.snapshot.total_reward_tokens.toString(),
          params.snapshot.total_recipients,
          params.snapshot.total_claims_count,
          params.snapshot.merkle_root ?? null,
          params.snapshot.tree_depth ?? null,
          params.snapshot.leaf_encoding_version,
          params.snapshot.tree_algorithm,
          params.snapshot.pair_hashing_convention,
          params.snapshot.leaf_sorting_rule,
          params.snapshot.proof_format_version,
          params.snapshot.status,
          params.snapshot.idempotency_key ?? null,
          params.snapshot.created_by ?? null,
        ]
      );

      // 2. Bulk-insert recipients
      for (const r of params.recipients) {
        await client.query(
          `INSERT INTO bounty_merkle_snapshot_recipients (
             id, snapshot_id, kol_id, claimant_wallet_id, claimant_wallet,
             token_amount, leaf_index, leaf_hash, merkle_proof, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
          [
            r.id,
            r.snapshot_id,
            r.kol_id,
            r.claimant_wallet_id,
            r.claimant_wallet,
            r.token_amount.toString(),
            r.leaf_index ?? null,
            r.leaf_hash ?? null,
            r.merkle_proof ? JSON.stringify(r.merkle_proof) : null,
          ]
        );
      }

      // 3. Bulk-insert allocations
      for (const a of params.allocations) {
        await client.query(
          `INSERT INTO bounty_merkle_snapshot_allocations (
             id, snapshot_id, launch_id, campaign_id, claim_id, recipient_id, kol_id,
             allocated_amount, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
          [
            a.id,
            a.snapshot_id,
            a.launch_id,
            a.campaign_id,
            a.claim_id,
            a.recipient_id,
            a.kol_id,
            a.allocated_amount.toString(),
          ]
        );
      }

      // 4. Optional audit log
      if (params.auditLog) {
        await this._insertAuditLog(client, params.auditLog);
      }

      await client.query('COMMIT');

      // Return fresh copy from DB
      const saved = await pool.query(`SELECT * FROM bounty_merkle_snapshots WHERE id = $1`, [params.snapshot.id]);
      return this._rowToSnapshotRecord(saved.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async rollbackDraftSnapshotTransaction(idempotencyKey?: string | null): Promise<void> {
    if (!idempotencyKey) return;
    const pool = this.requirePool();
    // Only deletes DRAFT snapshots with the given idempotency key.
    // Finalized/Published snapshots are protected by fn_prevent_physical_delete trigger.
    await pool.query(
      `DELETE FROM bounty_merkle_snapshots
       WHERE idempotency_key = $1 AND status = 'DRAFT'`,
      [idempotencyKey]
    );
  }

  async getSnapshot(snapshotId: string): Promise<BountyMerkleSnapshotRecord | null> {
    const pool = this.requirePool();
    const res = await pool.query(`SELECT * FROM bounty_merkle_snapshots WHERE id = $1`, [snapshotId]);
    if (res.rows.length === 0) return null;
    return this._rowToSnapshotRecord(res.rows[0]);
  }

  async getSnapshotRecipients(snapshotId: string): Promise<BountyMerkleRecipientRecord[]> {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT * FROM bounty_merkle_snapshot_recipients WHERE snapshot_id = $1 ORDER BY leaf_index ASC NULLS LAST`,
      [snapshotId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      snapshot_id: r.snapshot_id,
      kol_id: r.kol_id,
      claimant_wallet_id: r.claimant_wallet_id,
      claimant_wallet: r.claimant_wallet,
      token_amount: BigInt(r.token_amount),
      leaf_index: r.leaf_index ?? null,
      leaf_hash: r.leaf_hash ?? null,
      merkle_proof: r.merkle_proof ? (typeof r.merkle_proof === 'string' ? JSON.parse(r.merkle_proof) : r.merkle_proof) : null,
      created_at: r.created_at,
    }));
  }

  async getSnapshotAllocations(snapshotId: string): Promise<BountyMerkleAllocationRecord[]> {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT * FROM bounty_merkle_snapshot_allocations WHERE snapshot_id = $1`,
      [snapshotId]
    );
    return res.rows.map((r) => ({
      id: r.id,
      snapshot_id: r.snapshot_id,
      launch_id: r.launch_id,
      campaign_id: r.campaign_id,
      claim_id: r.claim_id,
      recipient_id: r.recipient_id,
      kol_id: r.kol_id,
      allocated_amount: BigInt(r.allocated_amount),
      created_at: r.created_at,
    }));
  }

  async finalizeSnapshotTransaction(params: {
    snapshotId: string;
    merkleRoot: string;
    treeDepth: number;
    recipientsWithProofs: { id: string; leafIndex: number; leafHash: string; merkleProof: string[] }[];
    finalizedBy?: string;
    finalizedAt?: Date;
    auditLog?: BountyMerkleAuditLogRecord;
  }): Promise<BountyMerkleSnapshotRecord> {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Update recipient rows with leaf proofs FIRST while parent snapshot is still DRAFT
      // (SQL trigger trg_bmsr_mutation_guard rejects detail mutations once status != 'DRAFT')
      for (const rp of params.recipientsWithProofs) {
        await client.query(
          `UPDATE bounty_merkle_snapshot_recipients
           SET leaf_index = $2, leaf_hash = $3, merkle_proof = $4
           WHERE id = $1`,
          [rp.id, rp.leafIndex, rp.leafHash, JSON.stringify(rp.merkleProof)]
        );
      }

      // 2. Seal snapshot header to FINALIZED (triggers fn_bms_finalization_check)
      await client.query(
        `UPDATE bounty_merkle_snapshots
         SET status = 'FINALIZED',
             merkle_root = $2,
             tree_depth = $3,
             finalized_by = $4,
             finalized_at = $5,
             updated_at = NOW()
         WHERE id = $1`,
        [
          params.snapshotId,
          params.merkleRoot,
          params.treeDepth,
          params.finalizedBy ?? null,
          params.finalizedAt ?? new Date(),
        ]
      );

      // 3. Audit log
      if (params.auditLog) {
        await this._insertAuditLog(client, params.auditLog);
      }

      await client.query('COMMIT');

      const updated = await pool.query(`SELECT * FROM bounty_merkle_snapshots WHERE id = $1`, [params.snapshotId]);
      return this._rowToSnapshotRecord(updated.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async markSnapshotPublished(
    snapshotId: string,
    txHash: string,
    options?: { confirmedBlockNumber?: bigint; confirmedRoot?: string; publishedBy?: string | null; auditLog?: BountyMerkleAuditLogRecord }
  ): Promise<BountyMerkleSnapshotRecord> {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const snapRes = await client.query(
        `SELECT * FROM bounty_merkle_snapshots WHERE id = $1 FOR UPDATE`,
        [snapshotId]
      );
      if (snapRes.rows.length === 0) {
        throw new Error(`SNAPSHOT_NOT_FOUND: Snapshot ${snapshotId} does not exist`);
      }
      const snap = snapRes.rows[0];
      if (snap.status !== 'FINALIZED') {
        throw new Error(`INVALID_STATUS_TRANSITION: Cannot publish snapshot in status ${snap.status}`);
      }

      // Supersede any prior PUBLISHED snapshot for the same (chain_id, contract_address, token_address)
      // to satisfy partial unique index uq_bms_single_active_published.
      await client.query(
        `UPDATE bounty_merkle_snapshots
         SET status = 'SUPERSEDED', updated_at = NOW()
         WHERE id != $1
           AND chain_id = $2
           AND LOWER(contract_address) = LOWER($3)
           AND LOWER(token_address) = LOWER($4)
           AND status = 'PUBLISHED'`,
        [snapshotId, snap.chain_id, snap.contract_address, snap.token_address]
      );

      await client.query(
        `UPDATE bounty_merkle_snapshots
         SET status = 'PUBLISHED',
             publication_tx_hash = $2,
             confirmed_block_number = $3,
             confirmed_root = $4,
             published_by = $5,
             published_at = NOW(),
             publication_status = 'CONFIRMED',
             finality_status = 'SEQUENCER_CONFIRMED',
             updated_at = NOW()
         WHERE id = $1`,
        [
          snapshotId,
          txHash,
          options?.confirmedBlockNumber !== undefined ? options.confirmedBlockNumber.toString() : null,
          options?.confirmedRoot ?? snap.merkle_root ?? null,
          options?.publishedBy ?? null,
        ]
      );

      if (options?.auditLog) {
        await this._insertAuditLog(client, options.auditLog);
      }

      await client.query('COMMIT');

      const updated = await pool.query(`SELECT * FROM bounty_merkle_snapshots WHERE id = $1`, [snapshotId]);
      return this._rowToSnapshotRecord(updated.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listActivePublishedSnapshots(networkId?: string): Promise<
    Array<{
      id: string;
      token_address: string;
      contract_address: string;
      network_id: string;
      chain_id: bigint;
      merkle_root: string;
      confirmed_block_number: bigint | null;
    }>
  > {
    const pool = this.requirePool();
    const res = networkId
      ? await pool.query(
          `SELECT id, token_address, contract_address, network_id, chain_id, merkle_root, confirmed_block_number
           FROM bounty_merkle_snapshots
           WHERE status = 'PUBLISHED' AND merkle_root IS NOT NULL AND network_id = $1
           ORDER BY published_at DESC`,
          [networkId]
        )
      : await pool.query(
          `SELECT id, token_address, contract_address, network_id, chain_id, merkle_root, confirmed_block_number
           FROM bounty_merkle_snapshots
           WHERE status = 'PUBLISHED' AND merkle_root IS NOT NULL
           ORDER BY published_at DESC`
        );

    return res.rows.map((r: any) => ({
      id: r.id,
      token_address: r.token_address,
      contract_address: r.contract_address,
      network_id: r.network_id,
      chain_id: BigInt(r.chain_id),
      merkle_root: r.merkle_root,
      confirmed_block_number: r.confirmed_block_number != null ? BigInt(r.confirmed_block_number) : null,
    }));
  }

  async markSnapshotReorgDetected(snapshotId: string, reason: string): Promise<void> {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT status FROM bounty_merkle_snapshots WHERE id = $1 FOR UPDATE`,
        [snapshotId]
      );
      if (cur.rows.length === 0) {
        throw new Error(`SNAPSHOT_NOT_FOUND: Snapshot ${snapshotId} does not exist`);
      }
      if (cur.rows[0].status !== 'PUBLISHED') {
        throw new Error(
          `INVALID_TRANSITION: markSnapshotReorgDetected requires snapshot.status = PUBLISHED (got ${cur.rows[0].status})`
        );
      }

      await client.query(
        `UPDATE bounty_merkle_snapshots
         SET status = 'REORG_DETECTED', updated_at = NOW()
         WHERE id = $1`,
        [snapshotId]
      );

      await client.query(
        `INSERT INTO bounty_merkle_audit_logs (
           snapshot_id, event_type, event_source, old_state, new_state, metadata, severity, created_at
         ) VALUES ($1, 'REORG_DETECTED', 'VERCEL_CRON_SWEEPER', $2, $3, $4, 'CRITICAL', NOW())`,
        [
          snapshotId,
          JSON.stringify({ status: 'PUBLISHED' }),
          JSON.stringify({ status: 'REORG_DETECTED' }),
          JSON.stringify({ reason }),
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async abandonSnapshotTransaction(params: {
    snapshotId: string;
    reason: string;
    abandonedBy?: string;
    auditLog?: BountyMerkleAuditLogRecord;
  }): Promise<BountyMerkleSnapshotRecord> {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE bounty_merkle_snapshots
         SET status = 'ABANDONED', updated_at = NOW()
         WHERE id = $1`,
        [params.snapshotId]
      );

      if (params.auditLog) {
        await this._insertAuditLog(client, params.auditLog);
      }

      await client.query('COMMIT');

      const updated = await pool.query(`SELECT * FROM bounty_merkle_snapshots WHERE id = $1`, [params.snapshotId]);
      return this._rowToSnapshotRecord(updated.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createAuditLog(auditLog: BountyMerkleAuditLogRecord): Promise<void> {
    const pool = getDbPool();
    if (!pool) return; // Non-blocking: audit logs are best-effort when pool absent
    const client = await pool.connect();
    try {
      await this._insertAuditLog(client, auditLog);
    } finally {
      client.release();
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _insertAuditLog(
    client: import('pg').PoolClient,
    auditLog: BountyMerkleAuditLogRecord
  ): Promise<void> {
    await client.query(
      `INSERT INTO bounty_merkle_audit_logs (
         id, snapshot_id, event_type, event_source, old_state, new_state, metadata, severity, created_at
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, NOW()
       )`,
      [
        auditLog.snapshot_id ?? null,
        auditLog.event_type,
        auditLog.event_source,
        auditLog.old_state ? JSON.stringify(auditLog.old_state) : null,
        auditLog.new_state ? JSON.stringify(auditLog.new_state) : null,
        auditLog.metadata ? JSON.stringify(auditLog.metadata) : null,
        auditLog.severity,
      ]
    );
  }

  private _rowToSnapshotRecord(r: Record<string, unknown>): BountyMerkleSnapshotRecord {
    return {
      id: r.id as string,
      launch_id: r.launch_id as string,
      campaign_id: (r.campaign_id as string | null) ?? null,
      network_id: r.network_id as string,
      chain_id: BigInt(r.chain_id as string),
      contract_address: r.contract_address as string,
      token_address: r.token_address as string,
      version: Number(r.version),
      snapshot_type: r.snapshot_type as BountyMerkleSnapshotRecord['snapshot_type'],
      total_reward_tokens: BigInt(r.total_reward_tokens as string),
      total_recipients: Number(r.total_recipients),
      total_claims_count: Number(r.total_claims_count),
      merkle_root: (r.merkle_root as string | null) ?? null,
      tree_depth: r.tree_depth !== null && r.tree_depth !== undefined ? Number(r.tree_depth) : null,
      leaf_encoding_version: r.leaf_encoding_version as string,
      tree_algorithm: r.tree_algorithm as string,
      pair_hashing_convention: r.pair_hashing_convention as string,
      leaf_sorting_rule: r.leaf_sorting_rule as string,
      proof_format_version: r.proof_format_version as string,
      status: r.status as BountyMerkleSnapshotRecord['status'],
      idempotency_key: (r.idempotency_key as string | null) ?? null,
      created_by: (r.created_by as string | null) ?? null,
      published_by: (r.published_by as string | null) ?? null,
      published_at: r.published_at ? new Date(r.published_at as string) : null,
      publication_tx_hash: (r.publication_tx_hash as string | null) ?? null,
      confirmed_block_number: r.confirmed_block_number !== null && r.confirmed_block_number !== undefined
        ? BigInt(r.confirmed_block_number as string)
        : null,
      confirmed_root: (r.confirmed_root as string | null) ?? null,
      publication_status: (r.publication_status as string | null) ?? null,
      finality_status: (r.finality_status as string | null) ?? null,
      created_at: new Date(r.created_at as string),
      updated_at: new Date(r.updated_at as string),
      finalized_at: r.finalized_at ? new Date(r.finalized_at as string) : null,
      finalized_by: (r.finalized_by as string | null) ?? null,
    };
  }
}

export const defaultBountyMerkleSnapshotDbAdapter = new PostgresBountyMerkleSnapshotDbAdapter();

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

export {
  HandleConflictError,
  DEFAULT_AI_FEATURE_WEIGHTS,
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

export function getDefaultRpcManager(): ModularRpcManager {
  return defaultRpcManager;
}
