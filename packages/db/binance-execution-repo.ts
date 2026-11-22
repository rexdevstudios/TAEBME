/**
 * packages/db/binance-execution-repo.ts
 *
 * Modular Domain Repository for OrderSnapshotStateMachine & PostgresBinanceExecutionDbAdapter.
 * Extracted verbatim from packages/shared/db-pool.ts (Phase AJ2) with zero breaking changes.
 */

import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type { BinanceExecutionDbAdapter, BinanceCredentialMeta, TradeIntentRecord } from '../trading/execution-types';
import { BinanceCredentialVault } from '../trading/binance-vault';
import { validateBinancePermissions, type BinanceKeyPermissions } from '../shared/types/domain';
import { maskApiKey, assertNotPrivateKeyOrMnemonic } from '../shared/credential-vault';

export interface BinanceExecutionRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool | PoolClient, userIdentifier: string) => Promise<string>;
  isUuid: (val: string | undefined | null) => boolean;
  getActiveKillSwitches: () => Promise<any[]>;
}

let registeredDeps: BinanceExecutionRepoDeps | null = null;

export function registerBinanceExecutionRepoDeps(deps: BinanceExecutionRepoDeps): void {
  registeredDeps = deps;
}

function resolvePool(): Pool | null {
  return registeredDeps ? registeredDeps.getDbPool() : null;
}

function resolveEnsureUserEntity(pool: Pool | PoolClient, userIdentifier: string): Promise<string> {
  if (!registeredDeps) throw new Error('BINANCE_REPO_DEPS_NOT_REGISTERED');
  return registeredDeps.ensureUserEntity(pool, userIdentifier);
}

function checkIsUuid(val: string | undefined | null): boolean {
  if (registeredDeps) return registeredDeps.isUuid(val);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(val || ''));
}

function resolveActiveKillSwitches(): Promise<any[]> {
  return registeredDeps ? registeredDeps.getActiveKillSwitches() : Promise.resolve([]);
}

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
    return this.customPool !== undefined ? this.customPool : resolvePool();
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

      if (!checkIsUuid(intentId)) {
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
        if (checkIsUuid(rawActorId) || rawActorId.startsWith('0x')) {
          validActorId = await resolveEnsureUserEntity(client, rawActorId);
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

    if (!checkIsUuid(intentId)) {
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

    if (!checkIsUuid(userId) && !userId.startsWith('0x')) {
      throw new Error(`INVALID_USER_ID: User ID ${userId} must be a valid UUID or EVM address`);
    }

    try {
      const validUserId = await resolveEnsureUserEntity(pool, userId);
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

    const validUserId = await resolveEnsureUserEntity(pool, userId);
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

    const validUserId = await resolveEnsureUserEntity(pool, params.userId);
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
    const validUserId = await resolveEnsureUserEntity(pool, userId);
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
    const validUserId = await resolveEnsureUserEntity(pool, userId);
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

      if (!checkIsUuid(fill.intentId)) {
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
          if (checkIsUuid(rawActorId) || rawActorId.startsWith('0x')) {
            validActorId = await resolveEnsureUserEntity(client, rawActorId);
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
      const validActorId = await resolveEnsureUserEntity(pool, actorId);
      let validEntityId: string | null = null;
      if (entityId && checkIsUuid(entityId)) {
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
      return resolveActiveKillSwitches();
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

