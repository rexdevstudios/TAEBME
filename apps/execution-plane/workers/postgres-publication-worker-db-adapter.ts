// ============================================================================
// POSTGRES PUBLICATION WORKER DB ADAPTER (PHASE 3.3C.4 — B3.4)
// ============================================================================
// Execution boundary: apps/execution-plane ONLY (never bundled into Vercel).
// Persists MerklePublicationWorker intents, EIP-1559 attempts, and audit logs
// directly to PostgreSQL SSOT (pg.Pool) in strict compliance with:
//   - phase3_3c_4_bounty_merkle_snapshots.sql triggers (fn_bmpi_guard, fn_bmpa_guard)
//   - SEC-03 (atomic nonce reservation via pg_advisory_xact_lock + DB check)
//   - SEC-05 (markAttemptReplaced before escalation)
//   - SEC-06 / SEC-07 (canonical status & column translation)
//   - SEC-08 (markSnapshotReorgDetected strictly restricted to PUBLISHED state)
// ============================================================================

import type { Pool, PoolClient } from 'pg';
import { ethers } from 'ethers';
import {
  createWorkerDbPool,
  getDbPool,
  defaultBountyMerkleSnapshotDbAdapter,
} from '../../../packages/shared/db-pool';
import {
  type PublicationWorkerDbAdapter,
  type PublicationIntentRecord,
  type PublicationAttemptRecord,
  type PublicationIntentStatus,
  type PublicationAttemptStatus,
  type SnapshotMinimal,
  type PublicationAuditLog,
  type DbIntentStatus,
  workerIntentStatusToDb,
  dbIntentStatusToWorker,
  workerAttemptStatusToDb,
} from './merkle-publication-worker';

export class PostgresPublicationWorkerDbAdapter implements PublicationWorkerDbAdapter {
  private poolInstance?: Pool | null;
  private readonly localNonceLocks = new Set<string>();

  constructor(pool?: Pool) {
    this.poolInstance = pool;
  }

  private requirePool(): Pool {
    if (!this.poolInstance) {
      this.poolInstance = createWorkerDbPool() ?? getDbPool();
    }
    if (!this.poolInstance) {
      throw new Error('DATABASE_UNAVAILABLE: Worker PostgreSQL pool is not initialised');
    }
    return this.poolInstance;
  }

  private rowToIntent(row: any): PublicationIntentRecord {
    return {
      id: row.id,
      idempotency_key: row.idempotency_key,
      snapshot_id: row.snapshot_id,
      token_address: row.token_address,
      network_id: row.network_id,
      chain_id: BigInt(row.chain_id),
      contract_address: row.contract_address,
      merkle_root: row.expected_root,
      status: dbIntentStatusToWorker(row.status as DbIntentStatus),
      error_message: null,
      created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
      claimed_at: null,
      confirmed_at: null,
    };
  }

  private rowToAttempt(row: any): PublicationAttemptRecord {
    const dbStatus = String(row.attempt_status || 'BROADCAST');
    let mappedStatus: PublicationAttemptStatus = 'BROADCAST_OK';
    if (dbStatus === 'MINED') mappedStatus = 'RECEIPT_CONFIRMED';
    else if (dbStatus === 'REPLACED') mappedStatus = 'REPLACED';
    else if (dbStatus === 'ABANDONED' || dbStatus === 'REVERTED') mappedStatus = 'REORG_DETECTED';

    return {
      id: row.id,
      intent_id: row.intent_id,
      attempt_index: Math.max(0, Number(row.attempt_number) - 1),
      signer_address: row.sender_address,
      nonce: Number(row.nonce),
      max_fee_per_gas: String(row.max_fee_per_gas),
      max_priority_fee_per_gas: String(row.max_priority_fee_per_gas),
      gas_limit: String(row.gas_limit),
      signed_payload: row.raw_signed_payload,
      tx_hash: row.tx_hash ?? null,
      broadcast_status: mappedStatus,
      broadcast_error: null,
      receipt_block_number: row.mined_block_number != null ? BigInt(row.mined_block_number) : null,
      receipt_block_hash: null,
      receipt_status: dbStatus === 'MINED' ? 1 : dbStatus === 'REVERTED' ? 0 : null,
      confirmed_block_number: row.mined_block_number != null ? BigInt(row.mined_block_number) : null,
      confirmed_block_hash: null,
      confirmations_at_check: null,
      created_at: row.broadcast_at instanceof Date ? row.broadcast_at : new Date(row.broadcast_at),
      updated_at: row.mined_at instanceof Date ? row.mined_at : new Date(row.broadcast_at),
    };
  }

  async claimNextPendingIntent(
    networkId: string,
    contractAddress: string
  ): Promise<PublicationIntentRecord | null> {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT bmpi.*, bms.network_id
         FROM bounty_merkle_publication_intents bmpi
         JOIN bounty_merkle_snapshots bms ON bms.id = bmpi.snapshot_id
         WHERE ($1 = '' OR bms.network_id = $1)
           AND ($2 = '' OR LOWER(bmpi.contract_address) = LOWER($2))
           AND bmpi.status = 'CREATED'
         ORDER BY bmpi.created_at ASC
         LIMIT 1
         FOR UPDATE OF bmpi SKIP LOCKED`,
        [networkId, contractAddress]
      );

      if (res.rows.length === 0) {
        await client.query('COMMIT');
        return null;
      }

      const row = res.rows[0];
      await client.query(
        `UPDATE bounty_merkle_publication_intents SET updated_at = NOW() WHERE id = $1`,
        [row.id]
      );
      await client.query('COMMIT');
      return this.rowToIntent(row);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getActiveIntentForToken(
    tokenAddress: string,
    networkId: string,
    contractAddress: string
  ): Promise<PublicationIntentRecord | null> {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT bmpi.*, bms.network_id
       FROM bounty_merkle_publication_intents bmpi
       JOIN bounty_merkle_snapshots bms ON bms.id = bmpi.snapshot_id
       WHERE LOWER(bmpi.token_address) = LOWER($1)
         AND bms.network_id = $2
         AND LOWER(bmpi.contract_address) = LOWER($3)
         AND bmpi.status IN ('CREATED', 'SUBMITTED', 'MINED')
       ORDER BY bmpi.created_at DESC
       LIMIT 1`,
      [tokenAddress, networkId, contractAddress]
    );
    return res.rows.length > 0 ? this.rowToIntent(res.rows[0]) : null;
  }

  async createIntent(params: {
    id: string;
    idempotency_key: string;
    snapshot_id: string;
    token_address: string;
    network_id: string;
    chain_id: bigint;
    contract_address: string;
    merkle_root: string;
  }): Promise<{ record: PublicationIntentRecord; isExisting: boolean }> {
    const pool = this.requirePool();
    const existing = await pool.query(
      `SELECT bmpi.*, bms.network_id
       FROM bounty_merkle_publication_intents bmpi
       JOIN bounty_merkle_snapshots bms ON bms.id = bmpi.snapshot_id
       WHERE bmpi.idempotency_key = $1
       LIMIT 1`,
      [params.idempotency_key]
    );
    if (existing.rows.length > 0) {
      return { record: this.rowToIntent(existing.rows[0]), isExisting: true };
    }

    const inserted = await pool.query(
      `INSERT INTO bounty_merkle_publication_intents (
         id, snapshot_id, chain_id, contract_address, token_address,
         expected_root, idempotency_key, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'CREATED', NOW(), NOW())
       RETURNING *`,
      [
        params.id,
        params.snapshot_id,
        params.chain_id.toString(),
        params.contract_address,
        params.token_address,
        params.merkle_root,
        params.idempotency_key,
      ]
    );
    return {
      record: this.rowToIntent({ ...inserted.rows[0], network_id: params.network_id }),
      isExisting: false,
    };
  }

  async updateIntentStatus(
    intentId: string,
    status: PublicationIntentStatus,
    metadata?: { errorMessage?: string | null; confirmedAt?: Date }
  ): Promise<void> {
    const pool = this.requirePool();
    const targetDbStatus = workerIntentStatusToDb(status);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT status, snapshot_id FROM bounty_merkle_publication_intents WHERE id = $1 FOR UPDATE`,
        [intentId]
      );
      if (cur.rows.length === 0) {
        throw new Error(`INTENT_NOT_FOUND: Publication intent ${intentId} not found`);
      }

      const currentDbStatus = cur.rows[0].status as DbIntentStatus;
      if (currentDbStatus !== targetDbStatus) {
        await client.query(
          `UPDATE bounty_merkle_publication_intents
           SET status = $2, updated_at = NOW()
           WHERE id = $1`,
          [intentId, targetDbStatus]
        );
      } else {
        await client.query(
          `UPDATE bounty_merkle_publication_intents SET updated_at = NOW() WHERE id = $1`,
          [intentId]
        );
      }

      if (metadata?.errorMessage || metadata?.confirmedAt) {
        await client.query(
          `INSERT INTO bounty_merkle_audit_logs (
             snapshot_id, event_type, event_source, old_state, new_state, metadata, severity, created_at
           ) VALUES ($1, $2, 'PUBLICATION_WORKER', $3, $4, $5, $6, NOW())`,
          [
            cur.rows[0].snapshot_id,
            `INTENT_STATUS_${status}`,
            JSON.stringify({ dbStatus: currentDbStatus }),
            JSON.stringify({ dbStatus: targetDbStatus, workerStatus: status }),
            JSON.stringify({
              intentId,
              errorMessage: metadata.errorMessage ?? null,
              confirmedAt: metadata.confirmedAt?.toISOString() ?? null,
            }),
            metadata.errorMessage ? 'WARN' : 'INFO',
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createAttempt(
    params: Omit<PublicationAttemptRecord, 'created_at' | 'updated_at'>
  ): Promise<PublicationAttemptRecord> {
    const pool = this.requirePool();
    const intentRes = await pool.query(
      `SELECT snapshot_id, chain_id, contract_address, token_address, expected_root
       FROM bounty_merkle_publication_intents
       WHERE id = $1`,
      [params.intent_id]
    );
    if (intentRes.rows.length === 0) {
      throw new Error(`INTENT_NOT_FOUND: Cannot create attempt for unknown intent ${params.intent_id}`);
    }
    const intent = intentRes.rows[0];
    const resolvedTxHash = params.tx_hash || ethers.keccak256(params.signed_payload);
    const dbAttemptStatus = workerAttemptStatusToDb(params.broadcast_status);

    const res = await pool.query(
      `INSERT INTO bounty_merkle_publication_attempts (
         id, intent_id, snapshot_id, chain_id, contract_address, token_address,
         expected_root, attempt_number, sender_address, nonce, tx_hash,
         max_fee_per_gas, max_priority_fee_per_gas, gas_limit,
         raw_signed_payload, attempt_status, broadcast_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13, $14,
         $15, $16, NOW()
       )
       RETURNING *`,
      [
        params.id,
        params.intent_id,
        intent.snapshot_id,
        intent.chain_id,
        intent.contract_address,
        intent.token_address,
        intent.expected_root,
        params.attempt_index + 1,
        params.signer_address,
        params.nonce,
        resolvedTxHash,
        params.max_fee_per_gas,
        params.max_priority_fee_per_gas,
        params.gas_limit,
        params.signed_payload,
        dbAttemptStatus,
      ]
    );
    return this.rowToAttempt(res.rows[0]);
  }

  async updateAttemptStatus(
    attemptId: string,
    broadcastStatus: PublicationAttemptStatus,
    metadata?: {
      txHash?: string | null;
      broadcastError?: string | null;
      receiptBlockNumber?: bigint | null;
      receiptBlockHash?: string | null;
      receiptStatus?: number | null;
      confirmedBlockNumber?: bigint | null;
      confirmedBlockHash?: string | null;
      confirmationsAtCheck?: number | null;
    }
  ): Promise<void> {
    const pool = this.requirePool();
    const dbStatus =
      metadata?.receiptStatus === 0 ? 'REVERTED' : workerAttemptStatusToDb(broadcastStatus);

    const minedBlock =
      metadata?.confirmedBlockNumber ?? metadata?.receiptBlockNumber ?? null;

    await pool.query(
      `UPDATE bounty_merkle_publication_attempts
       SET attempt_status = $2,
           mined_block_number = COALESCE($3, mined_block_number),
           mined_at = CASE WHEN $2 = 'MINED' THEN COALESCE(mined_at, NOW()) ELSE mined_at END
       WHERE id = $1
         AND attempt_status != $2`,
      [attemptId, dbStatus, minedBlock !== null ? minedBlock.toString() : null]
    );
  }

  async markAttemptReplaced(attemptId: string): Promise<void> {
    const pool = this.requirePool();
    await pool.query(
      `UPDATE bounty_merkle_publication_attempts
       SET attempt_status = 'REPLACED'
       WHERE id = $1 AND attempt_status = 'BROADCAST'`,
      [attemptId]
    );
  }

  async getLatestAttemptForIntent(intentId: string): Promise<PublicationAttemptRecord | null> {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT * FROM bounty_merkle_publication_attempts
       WHERE intent_id = $1
       ORDER BY attempt_number DESC
       LIMIT 1`,
      [intentId]
    );
    return res.rows.length > 0 ? this.rowToAttempt(res.rows[0]) : null;
  }

  async getInFlightNoncesForSigner(signerAddress: string, chainId: bigint): Promise<number[]> {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT DISTINCT nonce
       FROM bounty_merkle_publication_attempts
       WHERE chain_id = $1
         AND LOWER(sender_address) = LOWER($2)
         AND attempt_status IN ('CREATED', 'BROADCAST')
       ORDER BY nonce ASC`,
      [chainId.toString(), signerAddress]
    );
    return res.rows.map((r: any) => Number(r.nonce));
  }

  async reserveNonce(
    signerAddress: string,
    chainId: bigint,
    nonce: number,
    _intentId: string
  ): Promise<boolean> {
    const lockKey = `${chainId.toString()}:${signerAddress.toLowerCase()}:${nonce}`;
    if (this.localNonceLocks.has(lockKey)) {
      return false;
    }

    const pool = this.requirePool();
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);

      const check = await client.query(
        `SELECT 1 FROM bounty_merkle_publication_attempts
         WHERE chain_id = $1
           AND LOWER(sender_address) = LOWER($2)
           AND nonce = $3
           AND attempt_status IN ('CREATED', 'BROADCAST', 'MINED')
         LIMIT 1`,
        [chainId.toString(), signerAddress, nonce]
      );

      if (check.rows.length > 0) {
        await client.query('COMMIT');
        return false;
      }

      this.localNonceLocks.add(lockKey);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotMinimal | null> {
    const pool = this.requirePool();
    const res = await pool.query(
      `SELECT id, status, merkle_root, token_address, network_id, chain_id, contract_address, total_reward_tokens
       FROM bounty_merkle_snapshots
       WHERE id = $1`,
      [snapshotId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      status: r.status,
      merkle_root: r.merkle_root ?? null,
      token_address: r.token_address,
      network_id: r.network_id,
      chain_id: BigInt(r.chain_id),
      contract_address: r.contract_address,
      total_reward_tokens: BigInt(r.total_reward_tokens ?? 0),
    };
  }

  async markSnapshotPublished(params: {
    snapshotId: string;
    publicationTxHash: string;
    confirmedBlockNumber: bigint;
    confirmedRoot: string;
    publishedBy: string;
  }): Promise<void> {
    await defaultBountyMerkleSnapshotDbAdapter.markSnapshotPublished(
      params.snapshotId,
      params.publicationTxHash,
      {
        confirmedBlockNumber: params.confirmedBlockNumber,
        confirmedRoot: params.confirmedRoot,
        publishedBy: /^[0-9a-f-]{36}$/i.test(params.publishedBy) ? params.publishedBy : null,
      }
    );
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
         ) VALUES ($1, 'REORG_DETECTED', 'PUBLICATION_WORKER', $2, $3, $4, 'CRITICAL', NOW())`,
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

  async createAuditLog(log: PublicationAuditLog): Promise<void> {
    const pool = this.requirePool();
    const intentRes = await pool.query(
      `SELECT snapshot_id FROM bounty_merkle_publication_intents WHERE id = $1`,
      [log.intent_id]
    );
    const snapshotId = intentRes.rows[0]?.snapshot_id ?? null;

    await pool.query(
      `INSERT INTO bounty_merkle_audit_logs (
         snapshot_id, event_type, event_source, metadata, severity, created_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        snapshotId,
        log.event_type,
        log.event_source,
        JSON.stringify({
          intent_id: log.intent_id,
          attempt_id: log.attempt_id ?? null,
          ...(log.metadata ?? {}),
        }),
        log.severity,
      ]
    );
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
}
