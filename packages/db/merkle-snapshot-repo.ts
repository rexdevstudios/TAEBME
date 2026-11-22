/**
 * packages/db/merkle-snapshot-repo.ts
 *
 * Modular Domain Repository for B3.2 PostgreSQL Bounty Merkle Snapshot Lifecycle.
 * Extracted verbatim from packages/shared/db-pool.ts (Phase AJ2) with zero breaking changes.
 */

import type { Pool } from 'pg';
import type {
  BountyMerkleSnapshotDbAdapter,
  BountyMerkleSnapshotRecord,
  BountyMerkleRecipientRecord,
  BountyMerkleAllocationRecord,
  BountyMerkleAuditLogRecord,
  VerifiedClaimSourceItem,
  TokenLaunchInfo,
} from '../launchpad/bounty-merkle-snapshot-service';

export interface MerkleSnapshotRepoDeps {
  getDbPool: () => Pool | null;
}

let registeredDeps: MerkleSnapshotRepoDeps | null = null;

export function registerMerkleSnapshotRepoDeps(deps: MerkleSnapshotRepoDeps): void {
  registeredDeps = deps;
}

function resolvePool(): Pool | null {
  return registeredDeps ? registeredDeps.getDbPool() : null;
}

export class PostgresBountyMerkleSnapshotDbAdapter implements BountyMerkleSnapshotDbAdapter {
  private requirePool(): import('pg').Pool {
    const pool = resolvePool();
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
    const pool = resolvePool();
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

