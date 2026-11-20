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
import { BinanceExecutionDbAdapter, TradeIntentRecord } from '../trading/execution-types';
import { ProposalDbAdapter, AgentProposalRecord } from '../agent/proposal-engine';
import { DualControlDbAdapter, DualControlRequestRecord } from '../admin/dual-control';
import { PlanId, BillingDbAdapter } from '../billing/subscriptions-engine';

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

  const cleanAddress = actorOrWallet.startsWith('usr-')
    ? actorOrWallet.slice(4).toLowerCase()
    : actorOrWallet.toLowerCase();

  const existingWallet = await pool.query(
    'SELECT user_id FROM wallets WHERE LOWER(address) = LOWER($1) LIMIT 1',
    [cleanAddress]
  );
  if (existingWallet.rows.length > 0) {
    return existingWallet.rows[0].user_id;
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

// ----------------------------------------------------------------------------
// IN-MEMORY FALLBACK STORES (DEV / TEST / SIMULATION)
// ----------------------------------------------------------------------------
const inMemoryDrafts: any[] = [];
const inMemoryKolProfiles: Map<string, KolProfile> = new Map();
const inMemoryClaims: Map<string, BountyClaim> = new Map();
const inMemorySettledTxHashes: Map<string, string> = new Map();
const inMemoryInFlightSettlements: Set<string> = new Set();
const inMemoryCampaigns: BountyCampaign[] = [
  {
    id: 'campaign-degen-1',
    launchId: 'launch-degen-moon',
    creatorId: 'usr-creator-1',
    title: 'Degen Moon Viral TikTok & X Raid',
    campaignType: 'BOUNTY',
    requiredHashtag: '#DegenMoon',
    minFollowers: 500,
    rewardPerKol: 1000000000000000000000n, // 1,000 tokens
    maxParticipants: 50,
    currentParticipants: 12,
    isActive: true,
  },
  {
    id: 'campaign-cdao-2',
    launchId: 'launch-creator-dao',
    creatorId: 'usr-creator-2',
    title: 'CreatorDAO Community Bounty',
    campaignType: 'BOUNTY',
    requiredHashtag: '#CreatorDAO',
    minFollowers: 1000,
    rewardPerKol: 2500000000000000000000n, // 2,500 tokens
    maxParticipants: 20,
    currentParticipants: 8,
    isActive: true,
  },
];


// ----------------------------------------------------------------------------
// POSTGRES DRAFT DB ADAPTER
// ----------------------------------------------------------------------------
export class PostgresDraftDbAdapter implements LaunchDraftDbAdapter {
  async saveDraft(draft: any): Promise<string> {
    const pool = getDbPool();
    if (pool) {
      try {
        const draftUuid = isUuid(draft.id) ? draft.id : crypto.randomUUID();
        const creatorUserId = await ensureUserEntity(pool, draft.creatorWallet || draft.creatorId);

        await pool.query("INSERT INTO entities (id, type) VALUES ($1, 'LAUNCH_DRAFT') ON CONFLICT (id) DO NOTHING", [draftUuid]);

        await pool.query(
          `INSERT INTO launch_drafts (
            id, creator_id, name, ticker, description, image_url,
            launch_mode, target_chain, total_supply, creator_allocation_pct,
            bonding_curve_config, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            updated_at = NOW()`,
          [
            draftUuid,
            creatorUserId,
            draft.name,
            draft.ticker,
            draft.description || '',
            draft.imageUrl || '',
            draft.launchMode || 'BONDING_CURVE',
            draft.targetChain || 'base-mainnet',
            draft.totalSupply?.toString() || '1000000000',
            draft.creatorAllocationPct || 0.0,
            JSON.stringify(draft.bondingCurveConfig || {}),
            draft.status || 'DRAFT',
          ]
        );
        const stored = { ...draft, id: draftUuid };
        inMemoryDrafts.unshift(stored);
        return draftUuid;
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresDraftDbAdapter] DB insert failed, falling back to memory:', err.message);
      }
    }
    inMemoryDrafts.unshift(draft);
    return draft.id;
  }

  async saveWhitelist(launchDraftId: string, merkleRoot: string, maxAllocation: bigint): Promise<void> {
    const pool = getDbPool();
    if (pool) {
      try {
        const targetDraftId = isUuid(launchDraftId) ? launchDraftId : undefined;
        if (targetDraftId) {
          await pool.query(
            `INSERT INTO launch_whitelists (launch_draft_id, merkle_root, max_allocation_per_wallet)
             VALUES ($1, $2, $3)`,
            [targetDraftId, merkleRoot, maxAllocation.toString()]
          );
        }
        return;
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresDraftDbAdapter] DB whitelist insert failed, fallback:', err.message);
      }
    }
  }

  async createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void> {
    const pool = getDbPool();
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [actorId, action, entityId || null, reason || null]
        );
      } catch {
        // Non-blocking for audit log fallback
      }
    }
  }

  async getDrafts(filter?: { creatorId?: string; creatorWallet?: string }): Promise<any[]> {
    const pool = getDbPool();
    if (pool) {
      try {
        let queryStr = `SELECT * FROM launch_drafts`;
        const params: any[] = [];
        if (filter?.creatorId || filter?.creatorWallet) {
          const userUuid = await ensureUserEntity(pool, filter.creatorWallet || filter.creatorId || '');
          queryStr += ` WHERE creator_id = $1`;
          params.push(userUuid);
        }
        queryStr += ` ORDER BY created_at DESC LIMIT 50`;
        const res = await pool.query(queryStr, params);
        if (res.rows.length > 0) {
          return res.rows.map((r) => ({
            id: r.id,
            draftId: r.id,
            creatorId: r.creator_id,
            name: r.name,
            symbol: r.ticker,
            ticker: r.ticker,
            description: r.description,
            imageUrl: r.image_url,
            mode: r.launch_mode,
            launchMode: r.launch_mode,
            targetChain: r.target_chain,
            totalSupply: r.total_supply,
            status: r.status,
            createdAt: r.created_at,
          }));
        }
        return [];
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }

    if (filter?.creatorId || filter?.creatorWallet) {
      const targetId = filter.creatorId?.toLowerCase();
      const targetWallet = filter.creatorWallet?.toLowerCase();
      return inMemoryDrafts.filter((d) => {
        const draftCreatorId = (d.creatorId || d.actorId || '').toLowerCase();
        const draftCreatorWallet = (d.creatorWallet || '').toLowerCase();
        return (targetId && (draftCreatorId === targetId || draftCreatorWallet === targetId)) ||
               (targetWallet && (draftCreatorWallet === targetWallet || draftCreatorId === targetWallet));
      });
    }

    return inMemoryDrafts;
  }

  clearDrafts(): void {
    inMemoryDrafts.length = 0;
  }

  async getLaunchDraftById(draftId: string): Promise<any | null> {
    const pool = getDbPool();
    if (pool && isUuid(draftId)) {
      try {
        const res = await pool.query(`SELECT * FROM launch_drafts WHERE id = $1 LIMIT 1`, [draftId]);
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            id: r.id,
            draftId: r.id,
            creatorId: r.creator_id,
            name: r.name,
            symbol: r.ticker,
            ticker: r.ticker,
            description: r.description,
            imageUrl: r.image_url,
            mode: r.launch_mode,
            launchMode: r.launch_mode,
            targetChain: r.target_chain,
            totalSupply: r.total_supply,
            status: r.status,
            createdAt: r.created_at,
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }
    return inMemoryDrafts.find((d) => d.id === draftId) || null;
  }

  async getActiveTokenLaunches(): Promise<any[]> {
    const pool = getDbPool();
    if (pool) {
      try {
        const queryText = `
          SELECT 
            tl.id as launch_id,
            tl.draft_id,
            tl.contract_address,
            tl.chain,
            tl.current_supply,
            tl.raised_amount,
            tl.graduation_threshold,
            tl.is_graduated,
            tl.dex_pair_address,
            tl.risk_score,
            tl.published_at,
            ld.name,
            ld.ticker,
            ld.description,
            ld.image_url,
            ld.launch_mode,
            w.address as creator_wallet
          FROM token_launches tl
          JOIN launch_drafts ld ON ld.id = tl.draft_id
          LEFT JOIN users u ON u.id = ld.creator_id
          LEFT JOIN wallets w ON w.user_id = u.id AND w.is_primary = true
          ORDER BY tl.published_at DESC
          LIMIT 50
        `;
        const res = await pool.query(queryText);
        if (res.rows.length > 0) {
          return res.rows.map((r) => ({
            launchId: r.launch_id,
            draftId: r.draft_id,
            contractAddress: r.contract_address,
            chain: r.chain,
            currentSupply: r.current_supply?.toString() || '1000000000',
            raisedAmount: Number(r.raised_amount || 0),
            graduationThreshold: Number(r.graduation_threshold || 69000),
            isGraduated: Boolean(r.is_graduated),
            dexPairAddress: r.dex_pair_address,
            riskScore: r.risk_score ?? 90,
            publishedAt: r.published_at,
            name: r.name,
            ticker: r.ticker,
            description: r.description,
            imageUrl: r.image_url,
            launchMode: r.launch_mode,
            creatorWallet: r.creator_wallet || '0x000000000000000000000000000000000000dEaD',
          }));
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresDraftDbAdapter] getActiveTokenLaunches failed:', err.message);
      }
    }
    // Fallback: derive mock active launches from confirmed inMemoryDrafts
    return inMemoryDrafts
      .filter((d) => d.status === 'PUBLISHED' || d.status === 'DRAFT_CREATED')
      .map((d, i) => ({
        launchId: d.id,
        draftId: d.id,
        contractAddress: '0x' + (i + 1).toString().padStart(40, '0'),
        chain: d.targetChain || 'base-mainnet',
        currentSupply: d.totalSupply?.toString() || '1000000000',
        raisedAmount: 12500,
        graduationThreshold: 69000,
        isGraduated: false,
        dexPairAddress: null,
        riskScore: 92,
        publishedAt: d.createdAt || new Date(),
        name: d.name,
        ticker: d.ticker,
        description: d.description,
        imageUrl: d.imageUrl,
        launchMode: d.launchMode,
        creatorWallet: d.creatorWallet || '0x000000000000000000000000000000000000dEaD',
      }));
  }

  async getTokenLaunchByAddress(chain: string, address: string): Promise<any | null> {
    const norm = normalizeTokenIdentifier(chain, address);
    const lookupAddress = norm.contractAddress || address;
    const pool = getDbPool();

    if (pool && lookupAddress) {
      try {
        const whereClause = norm.isSolana
          ? `WHERE tl.contract_address = $1`
          : `WHERE LOWER(tl.contract_address) = LOWER($1)`;

        const queryText = `
          SELECT 
            tl.id as launch_id,
            tl.draft_id,
            tl.contract_address,
            tl.chain,
            tl.current_supply,
            tl.raised_amount,
            tl.graduation_threshold,
            tl.is_graduated,
            tl.dex_pair_address,
            tl.risk_score,
            tl.published_at,
            ld.name,
            ld.ticker,
            ld.description,
            ld.image_url,
            ld.launch_mode,
            w.address as creator_wallet
          FROM token_launches tl
          JOIN launch_drafts ld ON ld.id = tl.draft_id
          LEFT JOIN users u ON u.id = ld.creator_id
          LEFT JOIN wallets w ON w.user_id = u.id AND w.is_primary = true
          ${whereClause}
          ORDER BY CASE WHEN LOWER(tl.chain) LIKE '%' || LOWER($2) || '%' THEN 0 ELSE 1 END, tl.published_at DESC
          LIMIT 1
        `;
        const res = await pool.query(queryText, [lookupAddress, norm.chain]);
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            launchId: r.launch_id,
            draftId: r.draft_id,
            contractAddress: r.contract_address,
            chain: r.chain,
            currentSupply: r.current_supply?.toString() || '1000000000',
            raisedAmount: Number(r.raised_amount || 0),
            graduationThreshold: Number(r.graduation_threshold || 69000),
            isGraduated: Boolean(r.is_graduated),
            dexPairAddress: r.dex_pair_address,
            riskScore: r.risk_score ?? 90,
            publishedAt: r.published_at,
            name: r.name,
            ticker: r.ticker,
            description: r.description,
            imageUrl: r.image_url,
            launchMode: r.launch_mode,
            creatorWallet: r.creator_wallet || '0x000000000000000000000000000000000000dEaD',
            source: 'neon_postgres',
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresDraftDbAdapter] getTokenLaunchByAddress failed:', err.message);
      }
    }

    // In-memory fallback
    const activeLaunches = await this.getActiveTokenLaunches();
    const found = activeLaunches.find((l) => {
      if (!l.contractAddress) return false;
      return norm.isSolana
        ? l.contractAddress === lookupAddress
        : l.contractAddress.toLowerCase() === lookupAddress.toLowerCase();
    });
    if (found) {
      return { ...found, source: 'in_memory' };
    }

    return null;
  }

  async publishLaunchDraft(params: {
    draftId: string;
    contractAddress: string;
    chain: string;
    txHash?: string;
    currentSupply?: string;
    graduationThreshold?: number;
    riskScore?: number;
  }): Promise<{ launchId: string; contractAddress: string }> {
    const pool = getDbPool();
    const cleanAddress = ethers.isAddress(params.contractAddress)
      ? ethers.getAddress(params.contractAddress)
      : params.contractAddress;

    if (pool && isUuid(params.draftId)) {
      try {
        const resolvedChain = await ensureNetworkInPool(pool, params.chain || 'base-mainnet');

        // Check if launch already exists for this draft or contract address
        const existingLaunch = await pool.query(
          `SELECT id, contract_address FROM token_launches WHERE draft_id = $1 OR contract_address = $2 LIMIT 1`,
          [params.draftId, cleanAddress]
        );

        let launchId: string;
        if (existingLaunch.rows.length > 0) {
          launchId = existingLaunch.rows[0].id;
          await pool.query(
            `UPDATE token_launches 
             SET contract_address = $1, chain = $2, current_supply = COALESCE($3, current_supply)
             WHERE id = $4`,
            [cleanAddress, resolvedChain, params.currentSupply || '1000000000', launchId]
          );
        } else {
          launchId = crypto.randomUUID();
          await pool.query("INSERT INTO entities (id, type) VALUES ($1, 'TOKEN') ON CONFLICT (id) DO NOTHING", [launchId]);
          await pool.query(
            `INSERT INTO token_launches (
              id, draft_id, contract_address, chain, current_supply,
              raised_amount, graduation_threshold, risk_score, published_at
            ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, NOW())`,
            [
              launchId,
              params.draftId,
              cleanAddress,
              resolvedChain,
              params.currentSupply || '1000000000',
              params.graduationThreshold || 69000,
              params.riskScore || 92,
            ]
          );
        }

        // Update draft status to PUBLISHED
        await pool.query(
          `UPDATE launch_drafts SET status = 'PUBLISHED', updated_at = NOW() WHERE id = $1`,
          [params.draftId]
        );

        // Fetch draft creator to create audit log
        const draftRes = await pool.query(`SELECT creator_id FROM launch_drafts WHERE id = $1 LIMIT 1`, [params.draftId]);
        const creatorId = draftRes.rows[0]?.creator_id;
        if (creatorId) {
          await pool.query(
            `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
             VALUES ($1, 'TOKEN_LAUNCH_PUBLISHED', $2, $3, NOW())`,
            [creatorId, launchId, `Contract: ${cleanAddress}${params.txHash ? ` Tx: ${params.txHash}` : ''}`]
          );
        }

        // Update memory store if present
        const memDraft = inMemoryDrafts.find((d) => d.id === params.draftId);
        if (memDraft) {
          memDraft.status = 'PUBLISHED';
          memDraft.contractAddress = cleanAddress;
          memDraft.chain = resolvedChain;
        }

        return { launchId, contractAddress: cleanAddress };
      } catch (err: any) {
        console.error('[PostgresDraftDbAdapter] publishLaunchDraft error:', err?.message || err);
        throw err;
      }
    }

    // In-memory fallback
    const memDraft = inMemoryDrafts.find((d) => d.id === params.draftId);
    if (memDraft) {
      memDraft.status = 'PUBLISHED';
      memDraft.contractAddress = cleanAddress;
      memDraft.chain = params.chain;
    }
    return { launchId: params.draftId, contractAddress: cleanAddress };
  }

  async graduateTokenLaunch(params: {
    launchId?: string;
    contractAddress?: string;
    dexPairAddress?: string;
    raisedAmount?: number;
  }): Promise<{
    launchId: string;
    contractAddress: string;
    dexPairAddress: string;
    isGraduated: boolean;
    graduatedAt: Date;
  }> {
    const pool = getDbPool();
    const cleanAddress = params.contractAddress && ethers.isAddress(params.contractAddress)
      ? ethers.getAddress(params.contractAddress)
      : params.contractAddress;

    if (pool && (params.launchId || cleanAddress)) {
      try {
        // 1. Locate token launch row
        const queryText = params.launchId
          ? `SELECT tl.id, tl.contract_address, tl.chain, tl.raised_amount, tl.graduation_threshold, tl.is_graduated, tl.dex_pair_address, ld.creator_id, ld.ticker
             FROM token_launches tl
             JOIN launch_drafts ld ON ld.id = tl.draft_id
             WHERE tl.id = $1 LIMIT 1`
          : `SELECT tl.id, tl.contract_address, tl.chain, tl.raised_amount, tl.graduation_threshold, tl.is_graduated, tl.dex_pair_address, ld.creator_id, ld.ticker
             FROM token_launches tl
             JOIN launch_drafts ld ON ld.id = tl.draft_id
             WHERE LOWER(tl.contract_address) = LOWER($1) LIMIT 1`;

        const queryArg = params.launchId || cleanAddress;
        const res = await pool.query(queryText, [queryArg]);

        if (res.rows.length === 0) {
          throw new Error(`TOKEN_LAUNCH_NOT_FOUND: Token launch not found for ${queryArg}`);
        }

        const launch = res.rows[0];
        const launchId = launch.id;
        const contractAddr = launch.contract_address;
        const chain = launch.chain;
        const creatorId = launch.creator_id;
        const ticker = launch.ticker;

        // 2. Resolve DEX Pair Address (either provided or derived via DexPairFactoryService)
        const finalPairAddress = params.dexPairAddress && ethers.isAddress(params.dexPairAddress)
          ? ethers.getAddress(params.dexPairAddress)
          : (launch.dex_pair_address && ethers.isAddress(launch.dex_pair_address)
              ? ethers.getAddress(launch.dex_pair_address)
              : DexPairFactoryService.deriveDexPairAddress(chain, contractAddr));

        const finalRaisedAmount = params.raisedAmount ?? Number(launch.raised_amount || launch.graduation_threshold || 69000);
        const graduatedAt = new Date();

        // 3. Update token_launches state in PostgreSQL SSOT
        await pool.query(
          `UPDATE token_launches
           SET is_graduated = TRUE,
               graduated_at = COALESCE(graduated_at, NOW()),
               dex_pair_address = $1,
               raised_amount = GREATEST(raised_amount, $2)
           WHERE id = $3`,
          [finalPairAddress, finalRaisedAmount, launchId]
        );

        // 4. Record audit log
        if (creatorId) {
          await pool.query(
            `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
             VALUES ($1, 'TOKEN_GRADUATED_TO_DEX', $2, $3, NOW())`,
            [
              creatorId,
              launchId,
              `Token $${ticker} (${contractAddr}) graduated to DEX. Pair: ${finalPairAddress}, Raised: $${finalRaisedAmount}`,
            ]
          );
        }

        return {
          launchId,
          contractAddress: contractAddr,
          dexPairAddress: finalPairAddress,
          isGraduated: true,
          graduatedAt,
        };
      } catch (err: any) {
        console.error('[PostgresDraftDbAdapter] graduateTokenLaunch error:', err?.message || err);
        throw err;
      }
    }

    // In-memory fallback
    const memDraft = inMemoryDrafts.find(
      (d) => (params.launchId && d.id === params.launchId) || (cleanAddress && d.contractAddress?.toLowerCase() === cleanAddress.toLowerCase())
    );
    const pair = params.dexPairAddress || '0x6ad81aa97f7ea92310225fe11a6af51339180460';
    if (memDraft) {
      memDraft.isGraduated = true;
      memDraft.dexPairAddress = pair;
    }
    return {
      launchId: params.launchId || (memDraft ? memDraft.id : 'launch-fallback'),
      contractAddress: cleanAddress || '0x0000000000000000000000000000000000000000',
      dexPairAddress: pair,
      isGraduated: true,
      graduatedAt: new Date(),
    };
  }
}

// ----------------------------------------------------------------------------
// SEC-02: Typed error for twitter_handle uniqueness constraint (PG 23505).
// Route handlers must catch this specifically to return HTTP 409 HANDLE_CONFLICT
// without leaking raw database error messages or constraint names.
// ----------------------------------------------------------------------------
export class HandleConflictError extends Error {
  readonly code = 'HANDLE_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'HandleConflictError';
  }
}

// ----------------------------------------------------------------------------
// POSTGRES KOL DB ADAPTER
// ----------------------------------------------------------------------------
export class PostgresKolDbAdapter implements KolDbAdapter {
  async upsertKolProfile(p: Partial<KolProfile> & { userId: string }): Promise<KolProfile> {
    const pool = getDbPool();
    const existing = inMemoryKolProfiles.get(p.userId) || {
      id: `kol-${Date.now()}`,
      userId: p.userId,
      twitterHandle: p.twitterHandle,
      followersCount: p.followersCount || 0,
      trustScore: p.trustScore || 50,
      completedBounties: 0,
      totalEarnedUsd: 0,
      isVerified: p.isVerified || false,
    };

    const updated: KolProfile = {
      ...existing,
      ...p,
      id: existing.id,
      userId: p.userId,
      followersCount: p.followersCount ?? existing.followersCount,
      trustScore: p.trustScore ?? existing.trustScore,
      isVerified: p.isVerified ?? existing.isVerified,
    };

    if (pool) {
      try {
        const userId = await ensureUserEntity(pool, p.userId);
        const res = await pool.query(
          `INSERT INTO kol_profiles (
            user_id, twitter_handle, followers_count, trust_score, is_verified, updated_at
          ) VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (user_id) DO UPDATE SET
            twitter_handle = COALESCE(EXCLUDED.twitter_handle, kol_profiles.twitter_handle),
            followers_count = COALESCE(EXCLUDED.followers_count, kol_profiles.followers_count),
            trust_score = COALESCE(EXCLUDED.trust_score, kol_profiles.trust_score),
            is_verified = COALESCE(EXCLUDED.is_verified, kol_profiles.is_verified),
            updated_at = NOW()
          RETURNING id, user_id, twitter_handle, followers_count, trust_score, is_verified, completed_bounties, total_earned_usd`,
          [
            userId,
            // SEC-03: Normalize to lowercase at DB write boundary (defense-in-depth;
            // application layer in kol-service.ts also lowercases before calling here).
            updated.twitterHandle ? updated.twitterHandle.toLowerCase() : null,
            updated.followersCount,
            updated.trustScore,
            updated.isVerified,
          ]
        );

        if (res.rows.length > 0) {
          const row = res.rows[0];
          const dbProfile: KolProfile = {
            id: row.id,
            userId: row.user_id,
            twitterHandle: row.twitter_handle,
            followersCount: row.followers_count,
            trustScore: row.trust_score,
            completedBounties: row.completed_bounties || 0,
            totalEarnedUsd: Number(row.total_earned_usd || 0),
            isVerified: row.is_verified,
          };
          inMemoryKolProfiles.set(p.userId, dbProfile);
          return dbProfile;
        }
      } catch (err: any) {
        // SEC-02: Distinguish twitter_handle uniqueness violation (PG error 23505)
        // from other DB errors so the route handler can return HTTP 409 cleanly.
        if (err?.code === '23505' && err?.constraint?.includes('twitter_handle')) {
          throw new HandleConflictError(
            `Twitter handle '${p.twitterHandle}' is already registered to another account.`
          );
        }
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresKolDbAdapter] DB upsert failed, fallback to memory:', err.message);
      }
    }

    inMemoryKolProfiles.set(p.userId, updated);
    return updated;
  }

  async getKolProfile(userIdOrAddress: string): Promise<KolProfile | null> {
    const pool = getDbPool();
    if (pool) {
      try {
        const cleanAddress = userIdOrAddress.startsWith('usr-')
          ? userIdOrAddress.slice(4).toLowerCase()
          : userIdOrAddress.toLowerCase();

        const res = await pool.query(
          `SELECT kp.* FROM kol_profiles kp
           LEFT JOIN wallets w ON w.user_id = kp.user_id
           WHERE kp.user_id::text = $1 
              OR LOWER(kp.twitter_handle) = LOWER($1)
              OR LOWER(w.address) = LOWER($2)
           LIMIT 1`,
          [userIdOrAddress, cleanAddress]
        );

        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            id: row.id,
            userId: row.user_id,
            twitterHandle: row.twitter_handle,
            followersCount: row.followers_count,
            trustScore: row.trust_score,
            completedBounties: row.completed_bounties || 0,
            totalEarnedUsd: Number(row.total_earned_usd || 0),
            isVerified: row.is_verified,
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }
    return inMemoryKolProfiles.get(userIdOrAddress) || null;
  }

  async createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void> {
    const pool = getDbPool();
    if (pool) {
      try {
        let validActorId = actorId;
        if (!isUuid(validActorId)) {
          validActorId = await ensureUserEntity(pool, actorId);
        }
        let validEntityId: string | null = null;
        if (entityId && isUuid(entityId)) {
          const entityCheck = await pool.query('SELECT id FROM entities WHERE id = $1', [entityId]);
          if (entityCheck.rows.length > 0) {
            validEntityId = entityId;
          }
        }
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [validActorId, action, validEntityId, reason || null]
        );
      } catch {
        // Non-blocking
      }
    }
  }
}

// ----------------------------------------------------------------------------
// POSTGRES BOUNTY DB ADAPTER
// ----------------------------------------------------------------------------
export class PostgresBountyDbAdapter implements BountyDbAdapter {
  async listCampaigns(launchId?: string): Promise<BountyCampaign[]> {
    const pool = getDbPool();
    if (pool) {
      try {
        let query = `SELECT * FROM bounty_campaigns WHERE is_active = true`;
        const params: any[] = [];
        if (launchId && isUuid(launchId)) {
          params.push(launchId);
          query += ` AND launch_id = $1`;
        }
        query += ` ORDER BY created_at DESC LIMIT 50`;

        const res = await pool.query(query, params);
        if (res.rows.length > 0) {
          return res.rows.map((r) => ({
            id: r.id,
            launchId: r.launch_id,
            creatorId: r.creator_id,
            title: r.title,
            description: r.description,
            campaignType: (r.campaign_type || 'BOUNTY') as import('./types/trust').CampaignType,
            minTrustTier: (r.min_trust_tier || 'NEW') as import('./types/trust').TrustTier,
            requiredHashtag: r.required_hashtag,
            minFollowers: r.min_followers,
            rewardPerKol: BigInt(r.reward_per_kol || '0'),
            maxParticipants: r.max_participants,
            currentParticipants: r.current_participants,
            isActive: r.is_active,
          }));
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresBountyDbAdapter] listCampaigns failed, fallback to memory:', err.message);
      }
    }
    if (launchId) {
      return inMemoryCampaigns.filter((c) => c.launchId === launchId);
    }
    return inMemoryCampaigns;
  }

  async createCampaign(campaign: BountyCampaign): Promise<string> {
    const pool = getDbPool();
    const campaignId = isUuid(campaign.id) ? campaign.id : crypto.randomUUID();
    if (pool) {
      try {
        const creatorUserId = await ensureUserEntity(pool, campaign.creatorId);

        let targetLaunchId = campaign.launchId;
        if (!isUuid(targetLaunchId)) {
          const latestLaunch = await pool.query(`SELECT id FROM token_launches ORDER BY published_at DESC LIMIT 1`);
          if (latestLaunch.rows.length > 0) {
            targetLaunchId = latestLaunch.rows[0].id;
          } else {
            const placeholderDraftId = crypto.randomUUID();
            await pool.query("INSERT INTO entities (id, type) VALUES ($1, 'LAUNCH_DRAFT')", [placeholderDraftId]);
            await pool.query(
              `INSERT INTO launch_drafts (id, creator_id, name, ticker, launch_mode, target_chain, total_supply)
               VALUES ($1, $2, 'Default Campaign Token', 'DCT', 'BONDING_CURVE', 'base-mainnet', 1000000000)`,
              [placeholderDraftId, creatorUserId]
            );
            targetLaunchId = crypto.randomUUID();
            await pool.query("INSERT INTO entities (id, type) VALUES ($1, 'TOKEN')", [targetLaunchId]);
            await pool.query(
              `INSERT INTO token_launches (id, draft_id, contract_address, chain, current_supply, graduation_threshold)
               VALUES ($1, $2, $3, 'base-mainnet', 1000000000, 69000)`,
              [targetLaunchId, placeholderDraftId, '0x0000000000000000000000000000000000000001']
            );
          }
        }

        await pool.query(
          `INSERT INTO bounty_campaigns (
            id, launch_id, creator_id, title, description,
            required_hashtag, min_followers, reward_per_kol,
            max_participants, current_participants, is_active,
            campaign_type, min_trust_tier, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
          [
            campaignId,
            targetLaunchId,
            creatorUserId,
            campaign.title,
            (campaign as any).description || '',
            campaign.requiredHashtag,
            campaign.minFollowers,
            campaign.rewardPerKol.toString(),
            campaign.maxParticipants,
            campaign.currentParticipants || 0,
            campaign.isActive !== undefined ? campaign.isActive : true,
            campaign.campaignType || 'BOUNTY',
            campaign.minTrustTier || 'NEW',
          ]
        );
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresBountyDbAdapter] createCampaign failed, fallback to memory:', err.message);
      }
    }
    const saved: BountyCampaign = { ...campaign, id: campaignId, minTrustTier: campaign.minTrustTier || 'NEW' };
    inMemoryCampaigns.unshift(saved);
    return campaignId;
  }

  async getLaunchById(launchId: string): Promise<{ contractAddress?: string; chain?: string } | null> {
    const pool = getDbPool();
    if (pool && isUuid(launchId)) {
      try {
        const res = await pool.query(
          `SELECT contract_address, chain FROM token_launches WHERE id = $1 LIMIT 1`,
          [launchId]
        );
        if (res.rows.length > 0) {
          return {
            contractAddress: res.rows[0].contract_address,
            chain: res.rows[0].chain,
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }
    return {
      contractAddress: '0x1234567890123456789012345678901234567890',
      chain: 'base-mainnet',
    };
  }

  async getCampaign(id: string): Promise<BountyCampaign | null> {
    const pool = getDbPool();
    if (pool && isUuid(id)) {
      try {
        const res = await pool.query(
          `SELECT bc.*, tl.contract_address as token_address, tl.chain
           FROM bounty_campaigns bc
           LEFT JOIN token_launches tl ON tl.id = bc.launch_id
           WHERE bc.id = $1 LIMIT 1`,
          [id]
        );
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            id: r.id,
            launchId: r.launch_id,
            creatorId: r.creator_id,
            title: r.title,
            description: r.description,
            campaignType: (r.campaign_type || 'BOUNTY') as import('./types/trust').CampaignType,
            minTrustTier: (r.min_trust_tier || 'NEW') as import('./types/trust').TrustTier,
            requiredHashtag: r.required_hashtag,
            minFollowers: r.min_followers,
            rewardPerKol: BigInt(r.reward_per_kol || '0'),
            maxParticipants: r.max_participants,
            currentParticipants: r.current_participants,
            isActive: r.is_active,
            requiresHumanityProof: r.requires_humanity_proof,
            minGitcoinScore: r.min_gitcoin_score,
            tokenAddress: r.token_address || undefined,
            chain: r.chain || undefined,
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }

    const found = inMemoryCampaigns.find((c) => c.id === id);
    if (found) {
      return {
        ...found,
        tokenAddress: found.tokenAddress || '0x1234567890123456789012345678901234567890',
        chain: found.chain || 'base-mainnet',
      };
    }

    return {
      id,
      launchId: 'launch-demo',
      creatorId: 'usr-creator',
      title: 'Demo Marketing Campaign',
      campaignType: 'BOUNTY' as const,
      minTrustTier: 'NEW' as const,
      requiredHashtag: '#DegenMoon',
      minFollowers: 500,
      rewardPerKol: 1000000000000000000000n,
      maxParticipants: 50,
      currentParticipants: 2,
      isActive: true,
      tokenAddress: '0x1234567890123456789012345678901234567890',
      chain: 'base-mainnet',
    };
  }

  async getClaimById(claimId: string): Promise<BountyClaim | null> {
    const pool = getDbPool();
    if (pool && isUuid(claimId)) {
      try {
        const res = await pool.query(
          `SELECT bc.*, kp.user_id as kol_user_id
           FROM bounty_claims bc
           JOIN kol_profiles kp ON kp.id = bc.kol_id
           WHERE bc.id = $1 LIMIT 1`,
          [claimId]
        );
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            id: r.id || claimId,
            campaignId: r.campaign_id || 'camp-1',
            kolId: r.kol_id || r.kol_user_id || r.kol_wallet_address || '',
            proofUrl: r.proof_url || '',
            verificationStatus: r.verification_status || 'VERIFIED',
            trustTierAtClaim: r.trust_tier_at_claim || undefined,
            settlementTxHash: r.tx_hash || undefined,
            claimedAt: r.claimed_at ? new Date(r.claimed_at) : undefined,
            createdAt: r.created_at ? new Date(r.created_at) : new Date(),
            kolUserId: r.kol_user_id || r.kol_wallet_address || undefined,
            launchpadContractAddress: r.launchpad_contract_address || undefined,
            tokenAddress: r.token_address || undefined,
            rewardPerKol: r.reward_per_kol ? BigInt(r.reward_per_kol) : undefined,
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }
    for (const claim of inMemoryClaims.values()) {
      if (claim.id === claimId) {
        return claim;
      }
    }
    return null;
  }

  async getClaim(campaignId: string, kolId: string): Promise<BountyClaim | null> {
    const pool = getDbPool();
    if (pool && isUuid(campaignId) && isUuid(kolId)) {
      try {
        const res = await pool.query(
          `SELECT * FROM bounty_claims WHERE campaign_id = $1 AND kol_id = $2 LIMIT 1`,
          [campaignId, kolId]
        );
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            id: r.id,
            campaignId: r.campaign_id,
            kolId: r.kol_id,
            proofUrl: r.proof_url,
            verificationStatus: r.verification_status,
            trustTierAtClaim: r.trust_tier_at_claim || undefined,
            claimedAt: r.claimed_at,
            createdAt: r.created_at,
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }
    return inMemoryClaims.get(`${campaignId}:${kolId}`) || null;
  }

  async createClaim(
    campaignId: string,
    kolId: string,
    proofUrl: string,
    trustTierAtClaim?: import('./types/trust').TrustTier
  ): Promise<BountyClaim> {
    const claimUuid = crypto.randomUUID();
    const claim: BountyClaim = {
      id: claimUuid,
      campaignId,
      kolId,
      proofUrl,
      verificationStatus: 'PENDING',
      trustTierAtClaim: trustTierAtClaim || undefined,
      createdAt: new Date(),
    };

    const pool = getDbPool();
    if (pool && isUuid(campaignId) && isUuid(kolId)) {
      try {
        const res = await pool.query(
          `INSERT INTO bounty_claims (id, campaign_id, kol_id, proof_url, verification_status, trust_tier_at_claim, created_at)
           VALUES ($1, $2, $3, $4, 'PENDING', $5, NOW())
           ON CONFLICT (campaign_id, kol_id) DO UPDATE SET
             proof_url = EXCLUDED.proof_url
           RETURNING id, campaign_id, kol_id, proof_url, verification_status, created_at, claimed_at, trust_tier_at_claim`,
          [claimUuid, campaignId, kolId, proofUrl, trustTierAtClaim || null]
        );
        if (res.rows.length > 0) {
          const r = res.rows[0];
          const dbClaim: BountyClaim = {
            id: r.id,
            campaignId: r.campaign_id,
            kolId: r.kol_id,
            proofUrl: r.proof_url,
            verificationStatus: r.verification_status,
            trustTierAtClaim: r.trust_tier_at_claim || undefined,
            createdAt: r.created_at,
            claimedAt: r.claimed_at,
          };
          inMemoryClaims.set(`${campaignId}:${kolId}`, dbClaim);
          return dbClaim;
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }

    const existingMem = inMemoryClaims.get(`${campaignId}:${kolId}`);
    if (existingMem) {
      existingMem.proofUrl = proofUrl;
      // Never overwrite trustTierAtClaim if already present
      if (!existingMem.trustTierAtClaim && trustTierAtClaim) {
        existingMem.trustTierAtClaim = trustTierAtClaim;
      }
      return existingMem;
    }

    inMemoryClaims.set(`${campaignId}:${kolId}`, claim);
    return claim;
  }

  async updateClaimStatus(claimId: string, status: 'VERIFIED' | 'REJECTED' | 'CLAIMED'): Promise<void> {
    const pool = getDbPool();
    if (pool && isUuid(claimId)) {
      try {
        await pool.query(
          `UPDATE bounty_claims 
           SET verification_status = $1, 
               claimed_at = CASE WHEN $2 = true THEN NOW() ELSE claimed_at END
           WHERE id = $3`,
          [status, status === 'CLAIMED', claimId]
        );
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }

    for (const val of inMemoryClaims.values()) {
      if (val.id === claimId) {
        val.verificationStatus = status;
        if (status === 'CLAIMED') val.claimedAt = new Date();
        break;
      }
    }
  }

  async incrementCampaignParticipant(campaignId: string): Promise<void> {
    const pool = getDbPool();
    if (pool && isUuid(campaignId)) {
      try {
        await pool.query(
          `UPDATE bounty_campaigns SET current_participants = current_participants + 1 WHERE id = $1`,
          [campaignId]
        );
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }
  }

  async createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void> {
    const pool = getDbPool();
    if (pool) {
      try {
        let validActorId = actorId;
        if (!isUuid(validActorId)) {
          validActorId = await ensureUserEntity(pool, actorId);
        }
        let validEntityId: string | null = null;
        if (entityId && isUuid(entityId)) {
          const entityCheck = await pool.query('SELECT id FROM entities WHERE id = $1', [entityId]);
          if (entityCheck.rows.length > 0) {
            validEntityId = entityId;
          }
        }
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [validActorId, action, validEntityId, reason || null]
        );
      } catch {
        // Non-blocking
      }
    }
  }

  async recordBountyAllocation(
    userId: string,
    claimId: string,
    amount: string,
    currency: string,
    creatorId?: string
  ): Promise<void> {
    const pool = getDbPool();
    if (pool) {
      try {
        let validKolUserId = userId;
        if (!isUuid(validKolUserId)) {
          validKolUserId = await ensureUserEntity(pool, userId);
        }
        const numericAmount = isNaN(Number(amount)) ? '1000.0000' : Math.abs(Number(amount)).toFixed(4);
        const kolDescription = `Bounty Reward Allocation for claim ${claimId}`;
        const kolRef = `${claimId}:kol`;

        // 1. Credit Leg: KOL Payable Reward (+)
        await pool.query(
          `INSERT INTO ledger_entries (user_id, amount, currency, type, reference_id, description, created_at)
           SELECT $1::uuid, $2::numeric, $3::varchar, 'BOUNTY_REWARD_ALLOCATED', $4::varchar, $5::text, NOW()
           WHERE NOT EXISTS (
             SELECT 1 FROM ledger_entries WHERE reference_id = $4::varchar
           )`,
          [validKolUserId, numericAmount, currency, kolRef, kolDescription]
        );

        // 2. Debit Leg: Campaign Escrow Disbursement (-)
        if (creatorId) {
          let validCreatorUserId = creatorId;
          if (!isUuid(validCreatorUserId)) {
            validCreatorUserId = await ensureUserEntity(pool, creatorId);
          }
          const debitAmount = `-${numericAmount}`;
          const escrowDescription = `Bounty Escrow Disbursement for claim ${claimId}`;
          const escrowRef = `${claimId}:escrow`;

          await pool.query(
            `INSERT INTO ledger_entries (user_id, amount, currency, type, reference_id, description, created_at)
             SELECT $1::uuid, $2::numeric, $3::varchar, 'BOUNTY_ESCROW_DISBURSED', $4::varchar, $5::text, NOW()
             WHERE NOT EXISTS (
               SELECT 1 FROM ledger_entries WHERE reference_id = $4::varchar
             )`,
            [validCreatorUserId, debitAmount, currency, escrowRef, escrowDescription]
          );
        }
      } catch (err: any) {
        console.error('[DB] recordBountyAllocation error:', err?.message || err);
      }
    }
  }

  async settleClaimOnChain(
    claimId: string,
    txHash: string,
    blockNumber?: number
  ): Promise<import('../launchpad/bounty-escrow').SettleClaimResult> {
    const lowerTx = txHash.toLowerCase();

    // Check in-memory settled hash store first (cross-store protection)
    const existingClaimIdForTx = inMemorySettledTxHashes.get(lowerTx);
    if (existingClaimIdForTx && existingClaimIdForTx !== claimId) {
      return {
        success: false,
        txAlreadyUsed: true,
        error: 'Hash transaksi ini sudah digunakan untuk menyelesaikan klaim bounty lain.',
      };
    }

    if (inMemoryInFlightSettlements.has(lowerTx)) {
      return {
        success: false,
        txAlreadyUsed: true,
        error: 'Hash transaksi ini sedang diproses untuk klaim lain.',
      };
    }
    inMemoryInFlightSettlements.add(lowerTx);

    try {
      const pool = getDbPool();
      if (pool && isUuid(claimId)) {
        const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
        try {
          if (typeof pool.connect === 'function') {
            await client.query('BEGIN');
          }

          // Check if this txHash was already used anywhere in bounty_claims
          const existingTxRes = await client.query(
            `SELECT id, verification_status FROM bounty_claims WHERE tx_hash = $1 LIMIT 1`,
            [txHash]
          );
          if (existingTxRes.rows.length > 0) {
            const row = existingTxRes.rows[0];
            if (typeof pool.connect === 'function') {
              await client.query('ROLLBACK');
            }
            if (row.id === claimId && row.verification_status === 'CLAIMED') {
              return { success: true, alreadySettled: true };
            }
            return {
              success: false,
              txAlreadyUsed: true,
              error: 'Hash transaksi ini sudah digunakan untuk menyelesaikan klaim bounty lain.',
            };
          }

          // Lock the claim row FOR UPDATE OF bc
          const claimRowRes = await client.query(
            `SELECT bc.id, bc.campaign_id, bc.verification_status, bc.tx_hash, kp.user_id, utp.trust_tier
             FROM bounty_claims bc
             JOIN kol_profiles kp ON kp.id = bc.kol_id
             LEFT JOIN user_trust_profiles utp ON utp.user_id = kp.user_id
             WHERE bc.id = $1
             FOR UPDATE OF bc`,
            [claimId]
          );

          if (claimRowRes.rows.length === 0) {
            if (typeof pool.connect === 'function') {
              await client.query('ROLLBACK');
            }
            if (existingClaimIdForTx && existingClaimIdForTx !== claimId) {
              return {
                success: false,
                txAlreadyUsed: true,
                error: 'Hash transaksi ini sudah digunakan untuk menyelesaikan klaim bounty lain.',
              };
            }
            let memClaim: BountyClaim | null = null;
            for (const val of inMemoryClaims.values()) {
              if (val.id === claimId) {
                memClaim = val;
                break;
              }
            }
            if (memClaim) {
              if (memClaim.verificationStatus === 'CLAIMED' || memClaim.settlementTxHash) {
                return { success: true, alreadySettled: true };
              }
              memClaim.verificationStatus = 'CLAIMED';
              memClaim.claimedAt = new Date();
              memClaim.settlementTxHash = txHash;
              inMemorySettledTxHashes.set(lowerTx, claimId);
              return { success: true };
            }
            return { success: false, error: 'Claim tidak ditemukan.' };
          }

          const claimRow = claimRowRes.rows[0];
          if (claimRow.verification_status === 'CLAIMED' || (claimRow.tx_hash !== null && claimRow.tx_hash !== undefined)) {
            if (typeof pool.connect === 'function') {
              await client.query('ROLLBACK');
            }
            return { success: true, alreadySettled: true };
          }

          if (claimRow.trust_tier === 'REVIEW') {
            await client.query(
              `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
               VALUES ($1, 'SETTLEMENT_BLOCKED_UNDER_REVIEW', $2, 'Settlement blocked: claimant is currently in REVIEW status', NOW())`,
              [claimRow.user_id, claimId]
            );
            if (typeof pool.connect === 'function') {
              await client.query('COMMIT');
            }
            throw new Error(`SETTLEMENT_BLOCKED_UNDER_REVIEW: Claimant ${claimRow.user_id} is currently under REVIEW`);
          }

          // Atomic update with WHERE tx_hash IS NULL
          const updateRes = await client.query(
            `UPDATE bounty_claims
             SET verification_status = 'CLAIMED',
                 claimed_at = NOW(),
                 tx_hash = $2
             WHERE id = $1
               AND verification_status = 'VERIFIED'
               AND tx_hash IS NULL`,
            [claimId, txHash]
          );

          if ((updateRes.rowCount ?? 0) === 0) {
            if (typeof pool.connect === 'function') {
              await client.query('ROLLBACK');
            }
            throw new Error('SETTLEMENT_IDEMPOTENCY_VIOLATION: Claim cannot be transitioned to CLAIMED.');
          }

          await client.query(
            `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
             VALUES ($1, 'BOUNTY_REWARD_CLAIMED_ONCHAIN', NULL, $2, NOW())`,
            [claimRow.user_id, `Tx: ${txHash}${blockNumber ? ` (Block #${blockNumber})` : ''}`]
          );

          await client.query(
            `UPDATE ledger_entries
             SET description = description || ' [Settled On-Chain: ' || $1 || ']'
             WHERE reference_id IN ($2, $3) AND description NOT LIKE '%[Settled On-Chain%'`,
            [txHash.slice(0, 18) + '...', `${claimId}:kol`, `${claimId}:escrow`]
          );

          if (typeof pool.connect === 'function') {
            await client.query('COMMIT');
          }

          // Sync in-memory map
          inMemorySettledTxHashes.set(lowerTx, claimId);

          return { success: true };
        } catch (err: any) {
          if (typeof pool.connect === 'function') {
            await client.query('ROLLBACK').catch(() => {});
          }
          if (
            err?.message?.includes('SETTLEMENT_BLOCKED_UNDER_REVIEW') ||
            err?.message?.includes('SETTLEMENT_IDEMPOTENCY_VIOLATION')
          ) {
            throw err;
          }
          if (err.code === '23505') {
            const isTxReplay =
              err.constraint === 'uq_bounty_claims_tx_hash' ||
              err.constraint === 'idx_bounty_claims_tx_hash' ||
              err.constraint?.includes('tx_hash') ||
              err.message?.includes('tx_hash');
            if (isTxReplay) {
              return {
                success: false,
                txAlreadyUsed: true,
                error: 'Hash transaksi ini sudah digunakan untuk menyelesaikan klaim bounty lain.',
              };
            }
            return {
              success: false,
              error: `UNIQUE_CONSTRAINT_VIOLATION: ${err.constraint || err.message || 'Pelanggaran constraint unik basis data.'}`,
            };
          }
          console.error('[DB] settleClaimOnChain error:', err?.message || err);
          return { success: false, error: err?.message || 'Database error during settlement' };
        } finally {
          if ('release' in client && typeof (client as any).release === 'function') {
            (client as any).release();
          }
        }
      }

      // In-Memory Fallback
      let foundClaim: BountyClaim | null = null;
      for (const val of inMemoryClaims.values()) {
        if (val.id === claimId) {
          foundClaim = val;
          break;
        }
      }

      if (!foundClaim) {
        foundClaim = {
          id: claimId,
          campaignId: 'camp-default',
          kolId: 'kol-default',
          proofUrl: 'https://x.com/proof',
          verificationStatus: 'VERIFIED',
          createdAt: new Date(),
        };
        inMemoryClaims.set(claimId, foundClaim);
      }

      if (foundClaim.verificationStatus === 'CLAIMED' || foundClaim.settlementTxHash) {
        return { success: true, alreadySettled: true };
      }

      foundClaim.verificationStatus = 'CLAIMED';
      foundClaim.claimedAt = new Date();
      foundClaim.settlementTxHash = txHash;
      inMemorySettledTxHashes.set(lowerTx, claimId);

      return { success: true };
    } finally {
      inMemoryInFlightSettlements.delete(lowerTx);
    }
  }

  async getVerifiedClaims(campaignId?: string): Promise<BountyClaimItem[]> {
    const pool = getDbPool();
    if (pool) {
      try {
        let queryText = `
          SELECT DISTINCT ON (COALESCE(w.address, kp.user_id::text, bc.kol_id::text))
            COALESCE(w.address, kp.user_id::text, bc.kol_id::text) as wallet_address,
            c.reward_per_kol as token_amount,
            bc.id as claim_id,
            bc.verification_status
          FROM bounty_claims bc
          JOIN bounty_campaigns c ON c.id = bc.campaign_id
          LEFT JOIN kol_profiles kp ON (kp.id = bc.kol_id OR kp.user_id = bc.kol_id)
          LEFT JOIN LATERAL (
            SELECT address FROM wallets
            WHERE user_id = kp.user_id AND chain_type = 'EVM'
            ORDER BY is_primary DESC, created_at ASC, id ASC
            LIMIT 1
          ) w ON true
          WHERE bc.verification_status IN ('VERIFIED', 'CLAIMED')
        `;
        const params: any[] = [];
        if (campaignId && isUuid(campaignId)) {
          params.push(campaignId);
          queryText += ` AND bc.campaign_id = $1`;
        }

        queryText += ` ORDER BY COALESCE(w.address, kp.user_id::text, bc.kol_id::text) ASC, bc.created_at DESC, bc.id ASC`;

        const res = await pool.query(queryText, params);
        if (res.rows.length > 0) {
          const items: BountyClaimItem[] = [];
          for (const r of res.rows) {
            if (r.wallet_address && ethers.isAddress(r.wallet_address)) {
              items.push({
                walletAddress: r.wallet_address,
                tokenAmount: BigInt(r.token_amount || '0'),
                claimId: r.claim_id,
                isClaimed: r.verification_status === 'CLAIMED',
              });
            }
          }
          if (items.length > 0) {
            return items;
          }
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresBountyDbAdapter] getVerifiedClaims DB query failed, fallback to memory:', err.message);
      }
    }

    // In-memory fallback (used in isolated unit tests / environments without active DB)
    const fallbackClaims: BountyClaimItem[] = [];
    for (const claim of inMemoryClaims.values()) {
      if (claim.verificationStatus === 'VERIFIED' || claim.verificationStatus === 'CLAIMED') {
        if (!campaignId || claim.campaignId === campaignId) {
          const camp = inMemoryCampaigns.find((c) => c.id === claim.campaignId);
          const reward = camp ? camp.rewardPerKol : 1000000000000000000000n;
          const kol = inMemoryKolProfiles.get(claim.kolId);
          const wallet = (kol && ethers.isAddress(kol.userId))
            ? kol.userId
            : (ethers.isAddress(claim.kolId) ? claim.kolId : '0x1111111111111111111111111111111111111111');
          fallbackClaims.push({
            walletAddress: wallet,
            tokenAmount: reward,
            claimId: claim.id,
            isClaimed: claim.verificationStatus === 'CLAIMED',
          });
        }
      }
    }
    if (fallbackClaims.length > 0) {
      return fallbackClaims;
    }

    // H-05 Fix: Do not return hardcoded mock wallet addresses in any environment.
    // Production DB failures throw above. Dev/test without DB returns empty list.
    // Merkle trees built on fake seeds would corrupt on-chain claim verification.
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[PostgresBountyDbAdapter] getVerifiedClaims: no DB and no in-memory claims. Returning empty list.');
    }
    return [];
  }
}

// Single instances for API routes
export const defaultDraftDbAdapter = new PostgresDraftDbAdapter();
export const defaultKolDbAdapter = new PostgresKolDbAdapter();
export const defaultBountyDbAdapter = new PostgresBountyDbAdapter();

/**
 * PostgreSQL Database Adapter for ModularRpcManager.
 * Reads endpoints and domain configurations from Neon SSOT tables (`rpc_endpoints`, `rpc_domain_configs`).
 * Provides in-memory baseline fallback when database is unconfigured (unit test environments).
 */
export class PostgresRpcDbAdapter implements RpcDatabaseAdapter {
  async getEndpointsForNetwork(networkId: string): Promise<RpcEndpointConfig[]> {
    const pool = getDbPool();
    if (!pool) {
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
        return [{
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
        }];
      }
      if (networkId === 'robinhood-mainnet') {
        const robinhoodUrl =
          process.env.ROBINHOOD_RPC_URL?.trim() ||
          process.env.RPC_URL_ROBINHOOD?.trim() ||
          'https://rpc.mainnet.chain.robinhood.com';
        return [{
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
        }];
      }
      if (networkId === 'arbitrum-mainnet') {
        const arbitrumUrl =
          process.env.ARBITRUM_RPC_URL?.trim() ||
          'https://arb1.arbitrum.io/rpc';
        return [{
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
        }];
      }
      // BSC, Polygon, Optimism, Arc: architecture-blocked — no safe default public URL.
      // Configure via rpc_endpoints table in PostgreSQL SSOT.
      return [];
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
      // Env var precedence: RPC_URL_BASE_SEPOLIA (legacy db-pool name) preferred;
      // BASE_SEPOLIA_RPC_URL accepted as alias (used in some .env.local files).
      // Public fallback: https://sepolia.base.org (rate-limited; only for dev/test).
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
      // Env var precedence: ROBINHOOD_RPC_URL (canonical — matches src/config.ts and .env.example);
      // RPC_URL_ROBINHOOD accepted as legacy alias for backward compatibility.
      // Public fallback: Robinhood official RPC endpoint.
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
      // Env var: ARBITRUM_RPC_URL (canonical — matches src/config.ts and .env.example).
      // Public fallback: Arbitrum official RPC — used only in dev/test when no configured endpoint is available.
      // Not production-eligible without ARBITRUM_RPC_URL pointing to a private/paid endpoint.
      const arbitrumUrl =
        process.env.ARBITRUM_RPC_URL?.trim() ||
        'https://arb1.arbitrum.io/rpc';
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
    // BSC, Polygon, Optimism, Arc: no in-memory fallback.
    // These networks are architecture-blocked (no deployed launchpad contract; no safe default public URL).
    // Configure via rpc_endpoints table in PostgreSQL SSOT.
    return [];
  }

  async getDomainConfig(domain: string, networkId: string): Promise<RpcDomainConfig | null> {
    const pool = getDbPool();
    if (!pool) {
      if (domain === 'LAUNCHPAD' && networkId === 'base-mainnet') {
        return {
          domain: 'LAUNCHPAD',
          networkId: 'base-mainnet',
          primaryRpcId: '11111111-1111-1111-1111-111111111111',
          fallbackRpcId: '22222222-2222-2222-2222-222222222222',
        };
      }
      if (domain === 'LAUNCHPAD' && networkId === 'base-sepolia') {
        return {
          domain: 'LAUNCHPAD',
          networkId: 'base-sepolia',
          primaryRpcId: '33333333-3333-3333-3333-333333333333',
        };
      }
      if (domain === 'LAUNCHPAD' && networkId === 'robinhood-mainnet') {
        return {
          domain: 'LAUNCHPAD',
          networkId: 'robinhood-mainnet',
          primaryRpcId: '44444444-4444-4444-4444-444444444444',
        };
      }
      if (domain === 'LAUNCHPAD' && networkId === 'arbitrum-mainnet') {
        return {
          domain: 'LAUNCHPAD',
          networkId: 'arbitrum-mainnet',
          primaryRpcId: '66666666-6666-6666-6666-666666666666',
        };
      }
      return null;
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

    if (domain === 'LAUNCHPAD' && networkId === 'base-mainnet') {
      return {
        domain: 'LAUNCHPAD',
        networkId: 'base-mainnet',
        primaryRpcId: '11111111-1111-1111-1111-111111111111',
        fallbackRpcId: '22222222-2222-2222-2222-222222222222',
      };
    }
    if (domain === 'LAUNCHPAD' && networkId === 'base-sepolia') {
      return {
        domain: 'LAUNCHPAD',
        networkId: 'base-sepolia',
        primaryRpcId: '33333333-3333-3333-3333-333333333333',
      };
    }
    if (domain === 'LAUNCHPAD' && networkId === 'robinhood-mainnet') {
      return {
        domain: 'LAUNCHPAD',
        networkId: 'robinhood-mainnet',
        primaryRpcId: '44444444-4444-4444-4444-444444444444',
      };
    }
    if (domain === 'LAUNCHPAD' && networkId === 'arbitrum-mainnet') {
      return {
        domain: 'LAUNCHPAD',
        networkId: 'arbitrum-mainnet',
        primaryRpcId: '66666666-6666-6666-6666-666666666666',
      };
    }
    return null;
  }

  async updateEndpointHealth(endpointId: string, health: RpcHealthStatus, latencyMs: number): Promise<void> {
    const pool = getDbPool();
    if (!pool) return;
    await pool.query(
      `UPDATE rpc_endpoints
       SET health_status = $1, latency_ms = $2, updated_at = NOW()
       WHERE id = $3`,
      [health, latencyMs, endpointId]
    ).catch(() => {});
  }

  async createAuditLog(entry: RpcAuditLogEntry): Promise<void> {
    // Non-blocking telemetry
  }
}

export const defaultRpcDbAdapter = new PostgresRpcDbAdapter();
export const defaultRpcManager = new ModularRpcManager(defaultRpcDbAdapter);

export function getDefaultRpcManager(): ModularRpcManager {
  return defaultRpcManager;
}

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

export class PostgresKillSwitchDbAdapter implements KillSwitchDbAdapter {
  private inMemorySwitches: Map<string, KillSwitchRecord> = new Map();

  seedKillSwitch(ks: {
    id: string;
    scope: 'GLOBAL' | 'USER' | 'TOKEN';
    targetId?: string;
    isActive: boolean;
    reason: string;
    triggeredBy?: string;
    triggeredAt?: Date | string;
  }): void {
    this.inMemorySwitches.set(ks.id, {
      id: ks.id,
      scope: ks.scope,
      targetId: ks.targetId,
      isActive: ks.isActive,
      reason: ks.reason,
      activatedBy: ks.triggeredBy || 'admin',
      activatedAt: ks.triggeredAt instanceof Date ? ks.triggeredAt.toISOString() : (ks.triggeredAt || new Date().toISOString()),
    });
  }

  clearKillSwitches(): void {
    this.inMemorySwitches.clear();
  }

  async activateKillSwitch(ks: Omit<KillSwitchRecord, 'id' | 'activatedAt'>): Promise<string> {
    const id = crypto.randomUUID();
    const activatedAt = new Date().toISOString();
    const pool = getDbPool();

    if (pool) {
      try {
        const validUserId = await ensureUserEntity(pool, ks.activatedBy);
        const targetUuid = isUuid(ks.targetId) ? ks.targetId : null;

        // Deactivate any existing active switches for same scope/target first
        await pool.query(
          `UPDATE kill_switches SET is_active = FALSE, deactivated_at = NOW()
           WHERE scope = $1 AND (target_id = $2 OR ($2 IS NULL AND target_id IS NULL)) AND is_active = TRUE`,
          [ks.scope, targetUuid]
        );

        const res = await pool.query(
          `INSERT INTO kill_switches (id, scope, target_id, is_active, reason, activated_by, activated_at)
           VALUES ($1, $2, $3, TRUE, $4, $5, $6) RETURNING id`,
          [id, ks.scope, targetUuid, ks.reason, validUserId, activatedAt]
        );
        return res.rows[0]?.id || id;
      } catch (err: any) {
        console.error('[PostgresKillSwitchDbAdapter] activateKillSwitch error:', err?.message || err);
        throw new Error(`DB_KILL_SWITCH_ACTIVATE_FAILED: ${err?.message}`);
      }
    }

    // In-memory fallback for local dev/test
    const record: KillSwitchRecord = { id, activatedAt, ...ks };
    this.inMemorySwitches.set(id, record);
    return id;
  }

  async deactivateKillSwitch(idOrScope: string, deactivatedBy: string): Promise<void> {
    const pool = getDbPool();
    if (pool) {
      try {
        const validUserId = await ensureUserEntity(pool, deactivatedBy);
        if (isUuid(idOrScope)) {
          await pool.query(
            `UPDATE kill_switches SET is_active = FALSE, deactivated_by = $1, deactivated_at = NOW() WHERE id = $2`,
            [validUserId, idOrScope]
          );
        } else {
          await pool.query(
            `UPDATE kill_switches SET is_active = FALSE, deactivated_by = $1, deactivated_at = NOW() WHERE scope = $2 AND is_active = TRUE`,
            [validUserId, idOrScope.toUpperCase()]
          );
        }
        return;
      } catch (err: any) {
        console.error('[PostgresKillSwitchDbAdapter] deactivateKillSwitch error:', err?.message || err);
        throw new Error(`DB_KILL_SWITCH_DEACTIVATE_FAILED: ${err?.message}`);
      }
    }

    for (const record of this.inMemorySwitches.values()) {
      if (record.id === idOrScope || record.scope === idOrScope.toUpperCase()) {
        record.isActive = false;
        record.deactivatedBy = deactivatedBy;
        record.deactivatedAt = new Date().toISOString();
      }
    }
  }

  async getActiveKillSwitches(): Promise<KillSwitchRecord[]> {
    const memSwitches = Array.from(this.inMemorySwitches.values()).filter((ks) => ks.isActive);
    const pool = getDbPool();
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT id, scope, target_id as "targetId", is_active as "isActive", reason,
                  activated_by as "activatedBy", deactivated_by as "deactivatedBy",
                  activated_at as "activatedAt", deactivated_at as "deactivatedAt"
           FROM kill_switches WHERE is_active = TRUE`
        );
        const dbSwitches = res.rows.map((r) => ({
          id: r.id,
          scope: r.scope,
          targetId: r.targetId || undefined,
          isActive: r.isActive,
          reason: r.reason,
          activatedBy: r.activatedBy,
          deactivatedBy: r.deactivatedBy || undefined,
          activatedAt: r.activatedAt?.toISOString ? r.activatedAt.toISOString() : String(r.activatedAt),
          deactivatedAt: r.deactivatedAt?.toISOString ? r.deactivatedAt.toISOString() : r.deactivatedAt,
        }));
        const combined = new Map<string, KillSwitchRecord>();
        for (const s of dbSwitches) combined.set(s.id, s);
        for (const s of memSwitches) combined.set(s.id, s);
        return Array.from(combined.values());
      } catch (err: any) {
        console.error('[PostgresKillSwitchDbAdapter] getActiveKillSwitches error (FAIL-CLOSED):', err?.message || err);
        throw new Error(`DATABASE_UNAVAILABLE: Failed to query active kill switches: ${err?.message || err}`);
      }
    }

    return memSwitches;
  }

  async createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void> {
    const pool = getDbPool();
    if (pool) {
      try {
        const validUserId = await ensureUserEntity(pool, actorId);
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
          [validUserId, action, validEntityId, reason || '']
        );
      } catch (err: any) {
        console.warn('[PostgresKillSwitchDbAdapter] createAuditLog warning:', err?.message || err);
      }
    }
  }
}

export const defaultKillSwitchDbAdapter = new PostgresKillSwitchDbAdapter();

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

  async getBinanceCredentials(userId: string): Promise<any> {
    if (this.isExplicitInMemory) {
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
      const res = await pool.query(
        `SELECT id, encrypted_api_key, encrypted_secret_key, key_permissions, is_active
         FROM binance_credentials
         WHERE user_id = $1 AND is_active = true
         ORDER BY created_at DESC
         LIMIT 1`,
        [validUserId]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          id: row.id,
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
// POSTGRES GAMEFI & NFT DATABASE ADAPTER
// ============================================================================

const inMemoryGameFiProfiles = new Map<string, UserGameFiProfile>();
const inMemoryQuestCompletions: QuestCompletion[] = [];
const inMemoryNftItems: NftItemRecord[] = [];
const inMemoryNftCollections: NftCollectionRecord[] = [];
const inMemorySybilRegistry = new Set<string>();
const inMemoryTradeRegistry = new Set<string>();

export class PostgresGameFiDbAdapter {
  private poolOverride?: Pool | null;
  private isExplicitInMemory: boolean = false;

  constructor(poolOverride?: Pool | null, isExplicitInMemory: boolean = false) {
    this.poolOverride = poolOverride;
    this.isExplicitInMemory = isExplicitInMemory;
  }

  setExplicitInMemory(enabled: boolean): void {
    this.isExplicitInMemory = enabled;
  }

  private getPool(): Pool | null {
    if (this.isExplicitInMemory) return null;
    if (this.poolOverride !== undefined) return this.poolOverride;
    try {
      return getDbPool();
    } catch (err) {
      if (process.env.NODE_ENV === 'production') throw err;
      return null;
    }
  }

  clearInMemoryStores(): void {
    inMemoryGameFiProfiles.clear();
    inMemoryQuestCompletions.length = 0;
    inMemoryNftItems.length = 0;
    inMemoryNftCollections.length = 0;
    inMemorySybilRegistry.clear();
    inMemoryTradeRegistry.clear();
  }

  setMockCollection(collection: NftCollectionRecord): void {
    const idx = inMemoryNftCollections.findIndex(
      (c) => c.chain === collection.chain && c.name.toLowerCase() === collection.name.toLowerCase()
    );
    if (idx >= 0) inMemoryNftCollections[idx] = collection;
    else inMemoryNftCollections.push(collection);
  }

  setMockSybilEvidence(identifier: string, verified: boolean): void {
    if (verified) inMemorySybilRegistry.add(identifier.toLowerCase());
    else inMemorySybilRegistry.delete(identifier.toLowerCase());
  }

  setMockTradeActivity(identifier: string, hasActivity: boolean): void {
    if (hasActivity) inMemoryTradeRegistry.add(identifier.toLowerCase());
    else inMemoryTradeRegistry.delete(identifier.toLowerCase());
  }

  async hasSybilEvidence(userId: string, walletAddress?: string): Promise<boolean> {
    if (
      inMemorySybilRegistry.has(userId.toLowerCase()) ||
      (walletAddress && inMemorySybilRegistry.has(walletAddress.toLowerCase()))
    ) {
      return true;
    }

    const pool = this.getPool();
    if (pool && isUuid(userId)) {
      try {
        const res = await pool.query(
          `SELECT 1 FROM trust_evidence
           WHERE subject_user_id = $1 AND direction = 'POSITIVE'
             AND evidence_type IN ('WORLD_ID_ORB', 'WORLD_ID_DEVICE', 'GITCOIN_PASSPORT')
           LIMIT 1`,
          [userId]
        );
        if (res.rows.length > 0) return true;
      } catch {}

      if (walletAddress) {
        try {
          const nullifierRes = await pool.query(
            `SELECT 1 FROM verified_nullifiers
             WHERE LOWER(signal) = LOWER($1) OR scope_id = $2
             LIMIT 1`,
            [walletAddress, userId]
          );
          if (nullifierRes.rows.length > 0) return true;
        } catch {}
      }
    }
    return false;
  }

  async hasTradeOrLaunchActivity(userId: string, walletAddress?: string): Promise<boolean> {
    if (
      inMemoryTradeRegistry.has(userId.toLowerCase()) ||
      (walletAddress && inMemoryTradeRegistry.has(walletAddress.toLowerCase()))
    ) {
      return true;
    }

    const pool = this.getPool();
    if (pool && isUuid(userId)) {
      try {
        const draftRes = await pool.query(
          `SELECT 1 FROM launch_drafts WHERE user_id = $1 AND status IN ('PUBLISHED', 'LAUNCHED') LIMIT 1`,
          [userId]
        );
        if (draftRes.rows.length > 0) return true;
      } catch {}

      if (walletAddress) {
        try {
          const tokenRes = await pool.query(
            `SELECT 1 FROM launchpad_tokens WHERE LOWER(creator_wallet) = LOWER($1) LIMIT 1`,
            [walletAddress]
          );
          if (tokenRes.rows.length > 0) return true;
        } catch {}
      }
    }
    return false;
  }

  async getUserGameFiProfile(userId: string): Promise<UserGameFiProfile> {
    const pool = this.getPool();
    if (pool && isUuid(userId)) {
      try {
        const res = await pool.query(
          `SELECT user_id as "userId", xp, level, quests_completed as "questsCompleted", updated_at as "updatedAt"
           FROM user_gamefi_profiles WHERE user_id = $1 LIMIT 1`,
          [userId]
        );
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            userId: r.userId,
            xp: Number(r.xp),
            level: Number(r.level),
            questsCompleted: Number(r.questsCompleted),
            updatedAt: r.updatedAt,
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }

    if (!inMemoryGameFiProfiles.has(userId)) {
      inMemoryGameFiProfiles.set(userId, {
        userId,
        xp: 0,
        level: 1,
        questsCompleted: 0,
        updatedAt: new Date(),
      });
    }
    return inMemoryGameFiProfiles.get(userId)!;
  }

  async recordQuestCompletion(params: {
    userId: string;
    questId: string;
    xpGranted: number;
  }): Promise<{ profile: UserGameFiProfile; completion: QuestCompletion }> {
    const { userId, questId, xpGranted } = params;
    const pool = this.getPool();

    if (pool && isUuid(userId)) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const completionUuid = crypto.randomUUID();
        // 1. Strict idempotency enforcement: ON CONFLICT DO NOTHING
        const insertRes = await client.query(
          `INSERT INTO quest_completions (id, user_id, quest_id, status, xp_granted, completed_at)
           VALUES ($1, $2, $3, 'COMPLETED', $4, NOW())
           ON CONFLICT (user_id, quest_id) DO NOTHING
           RETURNING id, completed_at`,
          [completionUuid, userId, questId, xpGranted]
        );

        if (insertRes.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new Error(`QUEST_ALREADY_COMPLETED: User ${userId} has already completed quest '${questId}'`);
        }

        const completedAt = insertRes.rows[0].completed_at;

        // 2. Concurrency-safe atomic SQL increment in Postgres within same client transaction
        const profileRes = await client.query(
          `INSERT INTO user_gamefi_profiles (user_id, xp, level, quests_completed, updated_at)
           VALUES ($1, $2, 1 + FLOOR($2 / 500), 1, NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             xp = user_gamefi_profiles.xp + EXCLUDED.xp,
             level = 1 + FLOOR((user_gamefi_profiles.xp + EXCLUDED.xp) / 500),
             quests_completed = user_gamefi_profiles.quests_completed + 1,
             updated_at = NOW()
           RETURNING user_id as "userId", xp, level, quests_completed as "questsCompleted", updated_at as "updatedAt"`,
          [userId, xpGranted]
        );

        await client.query('COMMIT');

        const r = profileRes.rows[0];
        const updatedProfile: UserGameFiProfile = {
          userId: r.userId,
          xp: Number(r.xp),
          level: Number(r.level),
          questsCompleted: Number(r.questsCompleted),
          updatedAt: r.updatedAt,
        };

        const completion: QuestCompletion = {
          id: completionUuid,
          userId,
          questId,
          status: 'COMPLETED',
          xpGranted,
          completedAt,
        };

        return { profile: updatedProfile, completion };
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    // In-memory fallback (isolated unit tests and non-UUID test identifiers)
    const existing = inMemoryQuestCompletions.find(
      (c) => c.userId === userId && c.questId === questId
    );
    if (existing) {
      throw new Error(`QUEST_ALREADY_COMPLETED: User ${userId} has already completed quest '${questId}'`);
    }

    // Synchronously register completion before async yields to guarantee concurrency safety and avoid race conditions
    const completion: QuestCompletion = {
      id: crypto.randomUUID(),
      userId,
      questId,
      status: 'COMPLETED',
      xpGranted,
      completedAt: new Date(),
    };
    inMemoryQuestCompletions.push(completion);

    try {
      const current = await this.getUserGameFiProfile(userId);
      const newXp = current.xp + xpGranted;
      const newLevel = Math.floor(newXp / 500) + 1;
      const questsCount = current.questsCompleted + 1;

      const updatedProfile: UserGameFiProfile = {
        userId,
        xp: newXp,
        level: newLevel,
        questsCompleted: questsCount,
        updatedAt: new Date(),
      };
      inMemoryGameFiProfiles.set(userId, updatedProfile);

      return { profile: updatedProfile, completion };
    } catch (err) {
      // Roll back in-memory reservation if profile update throws
      const idx = inMemoryQuestCompletions.indexOf(completion);
      if (idx !== -1) inMemoryQuestCompletions.splice(idx, 1);
      throw err;
    }
  }

  async getUserNfts(ownerWallet: string): Promise<NftItemRecord[]> {
    const cleanWallet = ownerWallet.toLowerCase();
    const pool = this.getPool();
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT id, collection_id as "collectionId", token_id as "tokenId",
                  owner_wallet as "ownerWallet", tier, metadata_uri as "metadataUri",
                  mint_tx_hash as "mintTxHash", minted_at as "mintedAt"
           FROM nft_items WHERE LOWER(owner_wallet) = $1 ORDER BY minted_at DESC`,
          [cleanWallet]
        );
        if (res.rows.length > 0) {
          return res.rows.map((r: any) => ({
            id: r.id,
            collectionId: r.collectionId,
            tokenId: Number(r.tokenId),
            ownerWallet: r.ownerWallet,
            tier: r.tier,
            metadataUri: r.metadataUri,
            mintTxHash: r.mintTxHash || undefined,
            mintedAt: r.mintedAt,
          }));
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }
    return inMemoryNftItems.filter((i) => i.ownerWallet.toLowerCase() === cleanWallet);
  }

  async saveNftItem(item: Omit<NftItemRecord, 'id' | 'mintedAt'>): Promise<NftItemRecord> {
    const pool = this.getPool();
    const itemId = crypto.randomUUID();
    const now = new Date();

    if (pool && isUuid(item.collectionId)) {
      try {
        await pool.query(
          `INSERT INTO nft_items (id, collection_id, token_id, owner_wallet, tier, metadata_uri, mint_tx_hash, minted_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [itemId, item.collectionId, item.tokenId, item.ownerWallet, item.tier, item.metadataUri, item.mintTxHash || null]
        );
        return { ...item, id: itemId, mintedAt: now };
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }

    const created: NftItemRecord = { ...item, id: itemId, mintedAt: now };
    inMemoryNftItems.push(created);
    return created;
  }

  async getCollectionByChainAndName(chain: string, name: string): Promise<NftCollectionRecord | null> {
    if (this.isExplicitInMemory) {
      const matches = inMemoryNftCollections.filter(
        (c) => c.chain === chain && c.name.toLowerCase() === name.toLowerCase() && (c.isActive !== false)
      );
      if (matches.length > 1) {
        throw new Error(
          `AMBIGUOUS_COLLECTION_REGISTRY: Multiple active collections found for chain "${chain}" and name "${name}". Found ${matches.length} records. Aborting to prevent split-brain execution.`
        );
      }
      return matches[0] || null;
    }

    let pool: Pool | null = null;
    try {
      pool = this.getPool();
    } catch (poolErr: any) {
      throw new Error(`DATABASE_UNAVAILABLE: Database connection pool failure: ${poolErr?.message || poolErr}`);
    }

    if (!pool) {
      throw new Error(
        'DATABASE_UNAVAILABLE: PostgreSQL connection pool is unconfigured or unavailable. PostgreSQL SSOT collection resolution failed closed.'
      );
    }

    try {
      const res = await pool.query(
        `SELECT id, name, symbol, contract_address as "contractAddress", chain, is_active as "isActive", max_supply as "maxSupply", created_at as "createdAt"
         FROM nft_collections
         WHERE chain = $1 AND LOWER(name) = LOWER($2) AND is_active = true`,
        [chain, name]
      );

      if (res.rows.length === 0) {
        return null;
      }

      if (res.rows.length > 1) {
        throw new Error(
          `AMBIGUOUS_COLLECTION_REGISTRY: Multiple active collections found for chain "${chain}" and name "${name}". Found ${res.rows.length} records. Aborting to prevent split-brain execution.`
        );
      }

      const r = res.rows[0];
      return {
        id: r.id,
        name: r.name,
        symbol: r.symbol,
        contractAddress: r.contractAddress || undefined,
        chain: r.chain,
        isActive: r.isActive,
        maxSupply: Number(r.maxSupply),
        createdAt: r.createdAt,
      };
    } catch (err: any) {
      if (err.message && err.message.startsWith('AMBIGUOUS_COLLECTION_REGISTRY')) {
        throw err;
      }
      console.error('[PostgresGameFiDbAdapter] getCollectionByChainAndName query error:', err?.message || err);
      throw new Error(`DATABASE_UNAVAILABLE: Failed to query PostgreSQL collection registry: ${err?.message || err}`);
    }
  }
}

export const defaultGameFiDbAdapter = new PostgresGameFiDbAdapter();

export class PostgresProposalDbAdapter implements ProposalDbAdapter {
  private inMemoryProposals: Map<string, AgentProposalRecord> = new Map();
  private inMemoryAuditLogs: Array<{ actorId: string; action: string; entityId?: string; reason?: string; createdAt: string }> = [];

  async createProposal(proposal: Omit<AgentProposalRecord, 'id'>): Promise<string> {
    const id = crypto.randomUUID();
    const record: AgentProposalRecord = {
      ...proposal,
      id,
    };
    this.inMemoryProposals.set(id, record);

    const pool = getDbPool();
    if (!pool && process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_UNAVAILABLE: Neon connection pool is not available in production.');
    }

    if (pool) {
      try {
        const validUserId = await ensureUserEntity(pool, proposal.userId);
        let validAgentId: string = proposal.agentId;
        if (!isUuid(validAgentId)) {
          const agentRes = await pool.query('SELECT id FROM agent_profiles LIMIT 1');
          if (agentRes.rows.length > 0) {
            validAgentId = agentRes.rows[0].id;
          } else {
            const newAgentId = crypto.randomUUID();
            await pool.query("INSERT INTO entities (id, type) VALUES ($1, 'AGENT')", [newAgentId]);
            await pool.query(
              "INSERT INTO agent_profiles (id, owner_id, name, strategy_description, system_prompt, risk_tolerance_level) VALUES ($1, $2, 'Default Agent', 'Momentum trading strategy', 'Analyze market signals and propose trades', 'MODERATE')",
              [newAgentId, validUserId]
            );
            validAgentId = newAgentId;
          }
        }

        await pool.query(
          `INSERT INTO agent_proposals (
            id, agent_id, user_id, target_symbol, action, suggested_qty, suggested_price,
            rationale, confidence_score, status, expires_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            id,
            validAgentId,
            validUserId,
            proposal.targetSymbol,
            proposal.action,
            proposal.suggestedQty,
            proposal.suggestedPrice || null,
            proposal.rationale,
            proposal.confidenceScore,
            proposal.status || 'PENDING_APPROVAL',
            proposal.expiresAt,
            proposal.createdAt || new Date().toISOString(),
          ]
        );
      } catch (err: any) {
        console.warn('[PostgresProposalDbAdapter] createProposal DB write warning:', err?.message || err);
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`DATABASE_ERROR: Failed to persist agent proposal to PostgreSQL SSOT: ${err?.message || err}`);
        }
      }
    }

    return id;
  }

  async getProposalById(id: string): Promise<AgentProposalRecord | null> {
    const pool = getDbPool();
    if (pool) {
      try {
        const res = await pool.query('SELECT * FROM agent_proposals WHERE id = $1', [id]);
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            id: r.id,
            agentId: r.agent_id,
            userId: r.user_id,
            targetSymbol: r.target_symbol,
            action: r.action,
            suggestedQty: Number(r.suggested_qty),
            suggestedPrice: r.suggested_price ? Number(r.suggested_price) : undefined,
            rationale: r.rationale,
            confidenceScore: Number(r.confidence_score),
            status: r.status,
            expiresAt: r.expires_at?.toISOString ? r.expires_at.toISOString() : String(r.expires_at),
            createdAt: r.created_at?.toISOString ? r.created_at.toISOString() : String(r.created_at),
          };
        }
      } catch (err: any) {
        console.warn('[PostgresProposalDbAdapter] getProposalById warning:', err?.message || err);
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`DATABASE_ERROR: Failed to query agent proposal from PostgreSQL SSOT: ${err?.message || err}`);
        }
      }
    }

    return this.inMemoryProposals.get(id) || null;
  }

  async updateProposalStatus(id: string, status: 'APPROVED' | 'REJECTED' | 'EXPIRED'): Promise<void> {
    const mem = this.inMemoryProposals.get(id);
    if (mem) {
      mem.status = status;
    }

    const pool = getDbPool();
    if (!pool && process.env.NODE_ENV === 'production') {
      throw new Error('DATABASE_UNAVAILABLE: Neon connection pool is not available in production.');
    }

    if (pool) {
      try {
        await pool.query('UPDATE agent_proposals SET status = $1 WHERE id = $2', [status, id]);
      } catch (err: any) {
        console.warn('[PostgresProposalDbAdapter] updateProposalStatus warning:', err?.message || err);
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`DATABASE_ERROR: Failed to update agent proposal status in PostgreSQL SSOT: ${err?.message || err}`);
        }
      }
    }
  }

  async createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void> {
    this.inMemoryAuditLogs.push({
      actorId,
      action,
      entityId,
      reason,
      createdAt: new Date().toISOString(),
    });

    const pool = getDbPool();
    if (pool) {
      try {
        const validUserId = await ensureUserEntity(pool, actorId);
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
          [validUserId, action, validEntityId, reason || '']
        );
      } catch (err: any) {
        console.warn('[PostgresProposalDbAdapter] createAuditLog warning:', err?.message || err);
        if (process.env.NODE_ENV === 'production') {
          throw new Error(`DATABASE_ERROR: Failed to write audit log to PostgreSQL SSOT: ${err?.message || err}`);
        }
      }
    }
  }

  getAuditLogs() {
    return [...this.inMemoryAuditLogs];
  }

  clearInMemoryState() {
    this.inMemoryProposals.clear();
    this.inMemoryAuditLogs = [];
  }
}

export const defaultProposalDbAdapter = new PostgresProposalDbAdapter();

// ----------------------------------------------------------------------------
// POSTGRES BILLING DB ADAPTER
// ----------------------------------------------------------------------------
export interface SubscriptionRecord {
  id: string;
  userId: string;
  planId: PlanId;
  status: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  credits: number;
}

export class PostgresBillingDbAdapter implements BillingDbAdapter {
  private inMemorySubscriptions: Map<string, SubscriptionRecord> = new Map();

  seedSubscription(userId: string, sub: {
    planId: PlanId;
    status?: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'CANCELLED';
    currentPeriodEnd?: Date;
    credits?: number;
  }): void {
    this.inMemorySubscriptions.set(userId, {
      id: crypto.randomUUID(),
      userId,
      planId: sub.planId,
      status: sub.status || 'ACTIVE',
      currentPeriodStart: new Date(),
      currentPeriodEnd: sub.currentPeriodEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      credits: sub.credits ?? 5000,
    });
  }

  clearSubscriptions(): void {
    this.inMemorySubscriptions.clear();
  }

  async getUserPlan(userId: string): Promise<PlanId> {
    const pool = getDbPool();
    if (!pool) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DATABASE_UNAVAILABLE: Neon connection pool is not available in production.');
      }
      if (process.env.NODE_ENV !== 'test') {
        return 'FREE';
      }
    }

    if (pool) {
      try {
        const validUserId = await ensureUserEntity(pool, userId);
        const res = await pool.query(
          `SELECT plan_id, status, current_period_end
           FROM subscriptions
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [validUserId]
        );
        if (res.rows.length === 0) {
          return 'FREE';
        }
        const row = res.rows[0];
        const isActive = row.status === 'ACTIVE';
        const isNotExpired = new Date(row.current_period_end).getTime() > Date.now();
        if (isActive && isNotExpired) {
          const plan = row.plan_id?.toUpperCase();
          if (plan === 'TRADER' || plan === 'AGENT' || plan === 'CREATOR' || plan === 'FREE') {
            return plan as PlanId;
          }
        }
        return 'FREE';
      } catch (err: any) {
        throw new Error(`DATABASE_UNAVAILABLE: Failed to query user subscription: ${err?.message || err}`);
      }
    }

    const sub = this.inMemorySubscriptions.get(userId);
    if (!sub) return 'FREE';
    const isActive = sub.status === 'ACTIVE';
    const isNotExpired = new Date(sub.currentPeriodEnd).getTime() > Date.now();
    if (isActive && isNotExpired) {
      return sub.planId;
    }
    return 'FREE';
  }

  async getUserEntitlement(userId: string): Promise<{ planId: PlanId; hasLiveTrading: boolean; paperTrading: boolean }> {
    const planId = await this.getUserPlan(userId);
    const hasLiveTrading = planId === 'TRADER' || planId === 'AGENT';
    return {
      planId,
      hasLiveTrading,
      paperTrading: true,
    };
  }

  async getUserCreditBalance(userId: string): Promise<number> {
    const pool = getDbPool();
    if (pool) {
      try {
        const validUserId = await ensureUserEntity(pool, userId);
        const res = await pool.query(
          `SELECT COALESCE(SUM(amount), 0)::numeric AS balance, COUNT(*)::int AS cnt
           FROM ledger_entries
           WHERE user_id = $1 AND currency = 'CREDITS'`,
          [validUserId]
        );
        const cnt = Number(res.rows[0]?.cnt ?? 0);
        if (cnt > 0) {
          return Math.max(0, Math.round(Number(res.rows[0]?.balance ?? 0)));
        }
        const plan = await this.getUserPlan(userId).catch(() => 'FREE' as PlanId);
        const defaultCredits: Record<PlanId, number> = {
          FREE: 100,
          CREATOR: 2000,
          TRADER: 5000,
          AGENT: 15000,
        };
        return defaultCredits[plan] ?? 100;
      } catch {
        // Fallback to in-memory
      }
    }
    const sub = this.inMemorySubscriptions.get(userId);
    return sub?.credits ?? 100;
  }

  async recordLedgerEntry(entry: {
    userId: string;
    amount: number;
    currency: string;
    type: string;
    referenceId?: string;
    description: string;
  }): Promise<void> {
    const sub = this.inMemorySubscriptions.get(entry.userId);
    if (sub) {
      sub.credits = Math.max(0, (sub.credits ?? 0) + entry.amount);
    }
    const pool = getDbPool();
    if (pool) {
      try {
        const validUserId = await ensureUserEntity(pool, entry.userId);
        await pool.query(
          `INSERT INTO ledger_entries (
             id, user_id, amount, currency, type, reference_id, description, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [
            crypto.randomUUID(),
            validUserId,
            entry.amount,
            entry.currency || 'CREDITS',
            entry.type,
            entry.referenceId ?? null,
            entry.description,
          ]
        );
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] recordLedgerEntry warning:', err?.message);
      }
    }
  }

  async updateUserSubscription(userId: string, planId: PlanId, stripeSubId?: string): Promise<void> {
    const planCredits: Record<PlanId, number> = {
      FREE: 100,
      CREATOR: 2000,
      TRADER: 5000,
      AGENT: 15000,
    };
    this.seedSubscription(userId, { planId, status: 'ACTIVE', credits: planCredits[planId] ?? 100 });
    const pool = getDbPool();
    if (pool) {
      try {
        const validUserId = await ensureUserEntity(pool, userId);
        const priceCents: Record<PlanId, number> = {
          FREE: 0,
          CREATOR: 4900,
          TRADER: 7900,
          AGENT: 14900,
        };
        await pool.query(
          `INSERT INTO plans (id, name, base_price_cents, monthly_credits, features)
           VALUES ($1, $2, $3, $4, '{}'::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [planId, `${planId} Tier`, priceCents[planId] ?? 0, planCredits[planId] ?? 100]
        );
        await pool.query(
          `INSERT INTO subscriptions (
             id, user_id, plan_id, stripe_subscription_id, status,
             current_period_start, current_period_end, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, 'ACTIVE', NOW(), NOW() + INTERVAL '30 days', NOW(), NOW())`,
          [crypto.randomUUID(), validUserId, planId, stripeSubId ?? null]
        );
        if (planId === 'CREATOR' || planId === 'AGENT') {
          await pool.query(
            `INSERT INTO user_roles (user_id, role, created_at)
             VALUES ($1, 'CREATOR', NOW())
             ON CONFLICT (user_id, role) DO NOTHING`,
            [validUserId]
          );
        }
      } catch (err: any) {
        console.warn('[PostgresBillingDbAdapter] updateUserSubscription warning:', err?.message);
      }
    }
  }

  async createAuditLog(_actorId: string, _action: string, _entityId?: string, _reason?: string): Promise<void> {
    // Audit log
  }
}

export const defaultBillingDbAdapter = new PostgresBillingDbAdapter();

// ----------------------------------------------------------------------------
// POSTGRES DUAL-CONTROL DB ADAPTER
// ----------------------------------------------------------------------------
export class PostgresDualControlDbAdapter implements DualControlDbAdapter {
  private inMemoryRequests: Map<string, DualControlRequestRecord> = new Map();
  private inMemoryAuditLogs: any[] = [];

  seedRequest(req: DualControlRequestRecord): void {
    this.inMemoryRequests.set(req.id, { ...req });
  }

  clearRequests(): void {
    this.inMemoryRequests.clear();
    this.inMemoryAuditLogs = [];
  }

  getAuditLogs(): any[] {
    return [...this.inMemoryAuditLogs];
  }

  async createRequest(req: Omit<DualControlRequestRecord, 'id'>): Promise<string> {
    const id = crypto.randomUUID();
    const record: DualControlRequestRecord = { id, ...req };
    const pool = getDbPool();
    if (pool) {
      try {
        const validRequesterId = await ensureUserEntity(pool, req.requestedBy);
        await pool.query(
          `INSERT INTO dual_control_requests (
            id, action_type, requested_by, payload, status, expires_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            id,
            req.actionType,
            validRequesterId,
            JSON.stringify(req.payload),
            req.status,
            req.expiresAt,
          ]
        );
        this.inMemoryRequests.set(id, record);
        return id;
      } catch (err: any) {
        throw new Error(`DB_DUAL_CONTROL_CREATE_FAILED: ${err?.message}`);
      }
    }
    this.inMemoryRequests.set(id, record);
    return id;
  }

  async getRequestById(id: string): Promise<DualControlRequestRecord | null> {
    if (this.inMemoryRequests.has(id)) {
      return this.inMemoryRequests.get(id) || null;
    }
    const pool = getDbPool();
    if (pool) {
      try {
        const res = await pool.query(
          `SELECT id, action_type AS "actionType", requested_by AS "requestedBy",
                  approved_by AS "approvedBy", payload, status,
                  expires_at AS "expiresAt", created_at AS "createdAt"
           FROM dual_control_requests
           WHERE id = $1 LIMIT 1`,
          [id]
        );
        if (res.rows.length > 0) {
          const row = res.rows[0];
          return {
            id: row.id,
            actionType: row.actionType,
            requestedBy: row.requestedBy,
            approvedBy: row.approvedBy,
            payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
            reason: row.payload?.reason || 'Dual-control request',
            status: row.status,
            expiresAt: new Date(row.expiresAt).toISOString(),
            createdAt: new Date(row.createdAt).toISOString(),
          };
        }
        return this.inMemoryRequests.get(id) || null;
      } catch (err: any) {
        throw new Error(`DB_DUAL_CONTROL_GET_FAILED: ${err?.message}`);
      }
    }
    return this.inMemoryRequests.get(id) || null;
  }

  async updateRequestStatus(id: string, status: string, approvedBy?: string, expectedStatus?: string): Promise<boolean> {
    const memReq = this.inMemoryRequests.get(id);
    const pool = getDbPool();
    if (pool) {
      try {
        const validApproverId = approvedBy ? await ensureUserEntity(pool, approvedBy) : null;
        const res = await pool.query(
          `UPDATE dual_control_requests
           SET status = $1, approved_by = COALESCE($2, approved_by)
           WHERE id = $3 AND ($4::varchar IS NULL OR status = $4)`,
          [status, validApproverId, id, expectedStatus || null]
        );
        if (expectedStatus && res.rowCount === 0 && !memReq) {
          return false;
        }
      } catch (err: any) {
        if (!memReq) {
          throw new Error(`DB_DUAL_CONTROL_UPDATE_FAILED: ${err?.message}`);
        }
      }
    }
    if (memReq) {
      if (expectedStatus && memReq.status !== expectedStatus) {
        return false;
      }
      memReq.status = status as any;
      if (approvedBy) memReq.approvedBy = approvedBy;
    }
    return true;
  }

  async createAuditLog(entry: {
    actorId: string;
    action: string;
    entityId?: string;
    payloadBefore?: unknown;
    payloadAfter?: unknown;
    reason?: string;
  }): Promise<void> {
    this.inMemoryAuditLogs.push({ ...entry, timestamp: new Date().toISOString() });
    const pool = getDbPool();
    if (pool) {
      try {
        const validActorId = await ensureUserEntity(pool, entry.actorId);
        await pool.query(
          `INSERT INTO audit_logs (
            actor_id, action, entity_id, payload_before, payload_after, reason, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            validActorId,
            entry.action,
            entry.entityId && isUuid(entry.entityId) ? entry.entityId : null,
            JSON.stringify(entry.payloadBefore || {}),
            JSON.stringify(entry.payloadAfter || {}),
            entry.reason || null,
          ]
        );
      } catch {
        // Non-blocking fallback
      }
    }
  }
}

export const defaultDualControlDbAdapter = new PostgresDualControlDbAdapter();


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
