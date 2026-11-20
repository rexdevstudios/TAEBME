// ============================================================================
// MERKLE ROOT PUBLICATION WORKER (PHASE 3.3C.4 — B3.3)
// ============================================================================
// Execution boundary: apps/execution-plane (persistent Node.js process).
// NEVER run inside Vercel serverless functions.
//
// Security invariants:
//  1. Only FINALIZED snapshots may be published.
//  2. Pre-broadcast verification gate checks token, chain, contract, calldata, root.
//  3. Signed payload persisted BEFORE any broadcast.
//  4. Nonce reconciled against DB in-flight attempts AND chain pending nonce.
//  5. Missing receipt does NOT prove reorg — requires canonical block hash check.
//  6. PUBLISHED only after N-confirmation receipt AND stable block hash.
//  7. One active intent per (tokenAddress, networkId, contractAddress).
//  8. Signer private key NEVER stored in DB, logs, or audit records.
// ============================================================================

import { ethers } from 'ethers';
import { randomUUID } from 'crypto';

// Worker-internal intent lifecycle states.
// A production Prisma adapter MUST translate these to/from DB CHECK values (SEC-06).
export type PublicationIntentStatus =
  | 'PENDING'              // DB: 'CREATED'
  | 'CLAIMING'             // DB: 'CREATED' (transient)
  | 'SIGNING'              // DB: 'CREATED' (transient)
  | 'BROADCASTING'         // DB: 'SUBMITTED'
  | 'CONFIRMING'           // DB: 'SUBMITTED'
  | 'CONFIRMED'            // DB: 'CONFIRMED'
  | 'SIGN_FAILED'          // DB: 'ABANDONED' (CREATED → ABANDONED per fn_bmpi_guard)
  | 'BROADCAST_FAILED'     // DB: 'FAILED'
  | 'CONFIRMATION_FAILED'  // DB: 'FAILED'
  | 'REORG_DETECTED'       // DB: 'REPLACED' (only after PUBLISHED snapshot — SEC-08)
  | 'SUPERSEDED';          // DB: 'REPLACED'

// Worker-internal attempt lifecycle states (SEC-06).
export type PublicationAttemptStatus =
  | 'SIGNED'            // DB attempt_status: 'BROADCAST'
  | 'BROADCAST_PENDING' // DB: 'BROADCAST'
  | 'BROADCAST_TIMEOUT' // DB: 'BROADCAST'
  | 'BROADCAST_OK'      // DB: 'BROADCAST'
  | 'RECEIPT_PENDING'   // DB: 'BROADCAST'
  | 'RECEIPT_CONFIRMED' // DB: 'MINED'
  | 'RECEIPT_MISSING'   // DB: 'BROADCAST'
  | 'REORG_DETECTED'    // DB: 'ABANDONED'
  | 'REPLACED';         // DB: 'REPLACED'

// ===========================================================================
// DB SCHEMA CANONICAL STATUS SETS (SEC-06, SEC-07)
// Extracted verbatim from db/migrations/phase3_3c_4_bounty_merkle_snapshots.sql
// Use these for adapter translation and schema-derived tests.
// ===========================================================================

/** DB CHECK values for bounty_merkle_publication_intents.status */
export const DB_INTENT_STATUSES = [
  'CREATED', 'SUBMITTED', 'MINED', 'CONFIRMED', 'FAILED', 'REPLACED', 'ABANDONED',
] as const;
export type DbIntentStatus = (typeof DB_INTENT_STATUSES)[number];

/** DB CHECK values for bounty_merkle_publication_attempts.attempt_status */
export const DB_ATTEMPT_STATUSES = [
  'CREATED', 'BROADCAST', 'MINED', 'REPLACED', 'REVERTED', 'ABANDONED',
] as const;
export type DbAttemptStatus = (typeof DB_ATTEMPT_STATUSES)[number];

/** DB CHECK values for bounty_merkle_snapshots.status */
export const DB_SNAPSHOT_STATUSES = [
  'DRAFT', 'FINALIZED', 'PUBLISHED', 'SUPERSEDED', 'REORG_DETECTED', 'ABANDONED',
] as const;
export type DbSnapshotStatus = (typeof DB_SNAPSHOT_STATUSES)[number];

/** Translate worker intent status → DB intent status (B3.4 Prisma adapter). */
export function workerIntentStatusToDb(s: PublicationIntentStatus): DbIntentStatus {
  switch (s) {
    case 'PENDING':             return 'CREATED';
    case 'CLAIMING':            return 'CREATED';
    case 'SIGNING':             return 'CREATED';
    case 'BROADCASTING':        return 'SUBMITTED';
    case 'CONFIRMING':          return 'SUBMITTED';
    case 'CONFIRMED':           return 'CONFIRMED';
    case 'SIGN_FAILED':         return 'ABANDONED';
    case 'BROADCAST_FAILED':    return 'FAILED';
    case 'CONFIRMATION_FAILED': return 'FAILED';
    case 'REORG_DETECTED':      return 'REPLACED';
    case 'SUPERSEDED':          return 'REPLACED';
  }
}

/** Translate DB intent status → worker intent status (loading from DB). */
export function dbIntentStatusToWorker(s: DbIntentStatus): PublicationIntentStatus {
  switch (s) {
    case 'CREATED':   return 'PENDING';
    case 'SUBMITTED': return 'CONFIRMING';
    case 'MINED':     return 'CONFIRMING';
    case 'CONFIRMED': return 'CONFIRMED';
    case 'FAILED':    return 'CONFIRMATION_FAILED';
    case 'REPLACED':  return 'REORG_DETECTED';
    case 'ABANDONED': return 'SIGN_FAILED';
  }
}

/** Translate worker attempt status → DB attempt_status. */
export function workerAttemptStatusToDb(s: PublicationAttemptStatus): DbAttemptStatus {
  switch (s) {
    case 'SIGNED':            return 'BROADCAST';
    case 'BROADCAST_PENDING': return 'BROADCAST';
    case 'BROADCAST_TIMEOUT': return 'BROADCAST';
    case 'BROADCAST_OK':      return 'BROADCAST';
    case 'RECEIPT_PENDING':   return 'BROADCAST';
    case 'RECEIPT_CONFIRMED': return 'MINED';
    case 'RECEIPT_MISSING':   return 'BROADCAST';
    case 'REORG_DETECTED':    return 'ABANDONED';
    case 'REPLACED':          return 'REPLACED';
  }
}

/**
 * Permitted DB intent status transitions.
 * Source: SQL trigger fn_bmpi_guard.
 */
export const DB_INTENT_TRANSITIONS: Readonly<Record<DbIntentStatus, ReadonlyArray<DbIntentStatus>>> = {
  CREATED:   ['SUBMITTED', 'ABANDONED'],
  SUBMITTED: ['MINED', 'CONFIRMED', 'FAILED', 'REPLACED'],
  MINED:     ['CONFIRMED'],
  CONFIRMED: [],
  FAILED:    [],
  REPLACED:  [],
  ABANDONED: [],
};

/**
 * Permitted DB snapshot status transitions.
 * Source: SQL trigger fn_bms_status_transition.
 */
export const DB_SNAPSHOT_TRANSITIONS: Readonly<Record<DbSnapshotStatus, ReadonlyArray<DbSnapshotStatus>>> = {
  DRAFT:          ['FINALIZED', 'ABANDONED'],
  FINALIZED:      ['PUBLISHED'],
  PUBLISHED:      ['SUPERSEDED', 'REORG_DETECTED'],
  REORG_DETECTED: ['PUBLISHED'],
  SUPERSEDED:     [],
  ABANDONED:      [],
};

export interface PublicationIntentRecord {
  id: string;
  idempotency_key: string;
  snapshot_id: string;
  token_address: string;
  network_id: string;              // no DB column; derived from snapshot join
  chain_id: bigint;
  contract_address: string;
  merkle_root: string;             // DB column: expected_root (SEC-07)
  status: PublicationIntentStatus;
  error_message?: string | null;   // no DB column; store in audit log metadata
  created_at: Date;
  updated_at: Date;
  claimed_at?: Date | null;        // no DB column; derived from status transitions
  confirmed_at?: Date | null;      // no DB column; store in audit log metadata
}

export interface PublicationAttemptRecord {
  id: string;
  intent_id: string;
  attempt_index: number;           // DB column: attempt_number (1-based; adapter adds 1) (SEC-07)
  signer_address: string;          // DB column: sender_address (SEC-07)
  nonce: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  gas_limit: string;
  signed_payload: string;          // DB column: raw_signed_payload (SEC-07)
  tx_hash?: string | null;
  broadcast_status: PublicationAttemptStatus; // DB column: attempt_status (translated) (SEC-06)
  broadcast_error?: string | null; // no DB column; store in audit log metadata
  receipt_block_number?: bigint | null;  // no DB column; use mined_block_number for MINED state
  receipt_block_hash?: string | null;    // no DB column; store in audit log
  receipt_status?: number | null;        // no DB column; use attempt_status (REVERTED)
  confirmed_block_number?: bigint | null;// no DB column; use mined_block_number
  confirmed_block_hash?: string | null;  // no DB column; store in audit log
  confirmations_at_check?: number | null;// no DB column; store in audit log metadata
  created_at: Date;
  updated_at: Date;
}

export interface SnapshotMinimal {
  id: string;
  status: string;
  merkle_root: string | null;
  token_address: string;
  network_id: string;
  chain_id: bigint;
  contract_address: string;
  total_reward_tokens: bigint;
}

export interface PublicationAuditLog {
  intent_id: string;
  attempt_id?: string | null;
  event_type: string;
  event_source: string;
  severity: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  metadata?: Record<string, unknown> | null;
}

export interface PublicationWorkerDbAdapter {
  /** Production: SELECT ... FOR UPDATE SKIP LOCKED. */
  claimNextPendingIntent(networkId: string, contractAddress: string): Promise<PublicationIntentRecord | null>;
  getActiveIntentForToken(tokenAddress: string, networkId: string, contractAddress: string): Promise<PublicationIntentRecord | null>;
  createIntent(params: {
    id: string; idempotency_key: string; snapshot_id: string; token_address: string;
    network_id: string; chain_id: bigint; contract_address: string; merkle_root: string;
  }): Promise<{ record: PublicationIntentRecord; isExisting: boolean }>;
  updateIntentStatus(intentId: string, status: PublicationIntentStatus, metadata?: { errorMessage?: string | null; confirmedAt?: Date }): Promise<void>;
  createAttempt(params: Omit<PublicationAttemptRecord, 'created_at' | 'updated_at'>): Promise<PublicationAttemptRecord>;
  updateAttemptStatus(attemptId: string, broadcastStatus: PublicationAttemptStatus, metadata?: {
    txHash?: string | null; broadcastError?: string | null;
    receiptBlockNumber?: bigint | null; receiptBlockHash?: string | null; receiptStatus?: number | null;
    confirmedBlockNumber?: bigint | null; confirmedBlockHash?: string | null; confirmationsAtCheck?: number | null;
  }): Promise<void>;
  /**
   * SEC-05: Mark a superseded attempt as REPLACED before creating its escalation replacement.
   * Production: single UPDATE WHERE attempt_status = 'BROADCAST'.
   */
  markAttemptReplaced(attemptId: string): Promise<void>;
  getLatestAttemptForIntent(intentId: string): Promise<PublicationAttemptRecord | null>;
  getInFlightNoncesForSigner(signerAddress: string, chainId: bigint): Promise<number[]>;
  /**
   * SEC-03: Atomically reserve a nonce (compare-and-swap).
   * Returns true if reserved successfully, false if already taken.
   * Production: INSERT ... ON CONFLICT DO NOTHING, or advisory lock.
   */
  reserveNonce(signerAddress: string, chainId: bigint, nonce: number, intentId: string): Promise<boolean>;
  getSnapshot(snapshotId: string): Promise<SnapshotMinimal | null>;
  markSnapshotPublished(params: { snapshotId: string; publicationTxHash: string; confirmedBlockNumber: bigint; confirmedRoot: string; publishedBy: string; }): Promise<void>;
  /**
   * SEC-08: Only valid when snapshot.status = PUBLISHED.
   * Must throw INVALID_TRANSITION if called on FINALIZED or other non-PUBLISHED state.
   */
  markSnapshotReorgDetected(snapshotId: string, reason: string): Promise<void>;
  createAuditLog(log: PublicationAuditLog): Promise<void>;
}

export interface MerklePublicationWorkerOptions {
  confirmationsRequired?: number;
  receiptPollIntervalMs?: number;
  maxReceiptPollAttempts?: number;
  /**
   * SEC-02: Max retries when getBlock returns null (inconclusive RPC lag, not a reorg).
   * Default: 3. Poll attempt is skipped (not classified as reorg) after exhaustion.
   */
  nullBlockRetries?: number;
  gasLimit?: bigint;
  feeEscalationBps?: number;
  broadcastTimeoutMs?: number;
  pollIntervalMs?: number;
  workerTag?: string;
  dryRun?: boolean;
  /** Injectable provider factory — defaults to `new ethers.JsonRpcProvider(url)`. Override in tests for ESM-safe mocking. */
  providerFactory?: (rpcUrl: string) => ethers.JsonRpcProvider;
}

export interface PreBroadcastVerificationResult {
  passed: boolean;
  errors: string[];
  verifiedTokenAddress: string;
  verifiedRoot: string;
  verifiedChainId: bigint;
  verifiedContractAddress: string;
}

export class MerklePublicationWorker {
  private static readonly CONTRACT_ABI_FRAGMENT = [
    'function setBountyMerkleRoot(address tokenAddress, bytes32 newRoot)',
  ];

  private readonly confirmationsRequired: number;
  private readonly receiptPollIntervalMs: number;
  private readonly maxReceiptPollAttempts: number;
  private readonly nullBlockRetries: number;
  private readonly gasLimit: bigint;
  private readonly feeEscalationBps: number;
  private readonly broadcastTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly workerTag: string;
  private readonly dryRun: boolean;
  private readonly providerFactory: (rpcUrl: string) => ethers.JsonRpcProvider;
  private _isRunning = false;
  private _isStopping = false;

  constructor(
    private readonly db: PublicationWorkerDbAdapter,
    private readonly signer: ethers.Signer,
    private readonly rpcManager: { getActiveHttpRpc(networkId: string, domain: 'LAUNCHPAD'): Promise<string> },
    options: MerklePublicationWorkerOptions = {}
  ) {
    this.confirmationsRequired = options.confirmationsRequired ?? 12;
    this.receiptPollIntervalMs = options.receiptPollIntervalMs ?? 5_000;
    this.maxReceiptPollAttempts = options.maxReceiptPollAttempts ?? 72;
    this.nullBlockRetries = options.nullBlockRetries ?? 3;
    this.gasLimit = options.gasLimit ?? 100_000n;
    this.feeEscalationBps = options.feeEscalationBps ?? 115;
    this.broadcastTimeoutMs = options.broadcastTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.workerTag = options.workerTag ?? 'MerklePublicationWorker';
    this.dryRun = options.dryRun ?? false;
    this.providerFactory = options.providerFactory ?? ((url) => new ethers.JsonRpcProvider(url));
  }

  async start(): Promise<void> {
    this._isRunning = true;
    this._isStopping = false;
    while (this._isRunning && !this._isStopping) {
      try { await this.processNextIntent(); } catch (err: unknown) {
        console.error(`[${this.workerTag}] Unhandled error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this._isRunning && !this._isStopping) await sleep(this.pollIntervalMs);
    }
  }

  stop(): void { this._isStopping = true; this._isRunning = false; }
  isRunning(): boolean { return this._isRunning; }

  async processNextIntent(): Promise<boolean> {
    let signerAddress: string;
    try { signerAddress = await this.signer.getAddress(); }
    catch (err: unknown) { throw new Error(`SIGNER_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`); }

    const intent = await this.db.claimNextPendingIntent('', '');
    if (!intent) return false;

    const snapshot = await this.db.getSnapshot(intent.snapshot_id);
    if (!snapshot) {
      await this._failIntent(intent, 'SIGN_FAILED', `SNAPSHOT_NOT_FOUND: Snapshot ${intent.snapshot_id} does not exist`);
      return true;
    }
    if (snapshot.status !== 'FINALIZED') {
      await this._failIntent(intent, 'SIGN_FAILED',
        `NON_FINALIZED_SNAPSHOT: Snapshot ${intent.snapshot_id} has status ${snapshot.status}. Only FINALIZED snapshots may be published.`);
      return true;
    }
    if (!snapshot.merkle_root) {
      await this._failIntent(intent, 'SIGN_FAILED', `MISSING_MERKLE_ROOT: Snapshot ${intent.snapshot_id} has no merkle_root`);
      return true;
    }

    const latestAttempt = await this.db.getLatestAttemptForIntent(intent.id);
    if (latestAttempt) {
      if (['BROADCAST_OK', 'BROADCAST_PENDING', 'RECEIPT_PENDING'].includes(latestAttempt.broadcast_status)) {
        await this.db.updateIntentStatus(intent.id, 'CONFIRMING');
        return await this._pollReceiptAndConfirm(intent, latestAttempt, snapshot, signerAddress);
      }
      if (latestAttempt.broadcast_status === 'BROADCAST_TIMEOUT' && latestAttempt.tx_hash) {
        await this.db.updateIntentStatus(intent.id, 'CONFIRMING');
        return await this._pollReceiptAndConfirm(intent, latestAttempt, snapshot, signerAddress);
      }
    }

    let provider: ethers.JsonRpcProvider;
    try {
      const rpcUrl = await this.rpcManager.getActiveHttpRpc(intent.network_id, 'LAUNCHPAD');
      provider = this.providerFactory(rpcUrl);
    } catch (err: unknown) {
      await this._failIntent(intent, 'SIGN_FAILED',
        `PROVIDER_UNAVAILABLE: ${intent.network_id}: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }

    let providerChainId: bigint;
    try { const net = await provider.getNetwork(); providerChainId = net.chainId; }
    catch (err: unknown) {
      await this._failIntent(intent, 'SIGN_FAILED', `CHAIN_ID_CHECK_FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }

    if (providerChainId !== intent.chain_id) {
      await this._failIntent(intent, 'SIGN_FAILED', `CHAIN_MISMATCH: Provider chain ${providerChainId} != intent chain ${intent.chain_id}`);
      return true;
    }

    let nonce: number;
    try { nonce = await this._allocateNonce(signerAddress, intent.chain_id, provider, latestAttempt, intent.id); }
    catch (err: unknown) {
      await this._failIntent(intent, 'SIGN_FAILED', `NONCE_ALLOCATION_FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }

    await this.db.updateIntentStatus(intent.id, 'SIGNING');

    let feeData: ethers.FeeData;
    try { feeData = await provider.getFeeData(); }
    catch (err: unknown) {
      await this._failIntent(intent, 'SIGN_FAILED', `FEE_DATA_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }

    if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
      await this._failIntent(intent, 'SIGN_FAILED', 'FEE_DATA_UNAVAILABLE: Provider returned null EIP-1559 fee fields');
      return true;
    }

    let maxFeePerGas = feeData.maxFeePerGas;
    let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    let precedingAttemptIdToReplace: string | null = null;

    if (latestAttempt && ['BROADCAST_TIMEOUT', 'BROADCAST_OK', 'RECEIPT_MISSING'].includes(latestAttempt.broadcast_status) && latestAttempt.nonce === nonce) {
      const prevMaxFee = BigInt(latestAttempt.max_fee_per_gas);
      const prevPriority = BigInt(latestAttempt.max_priority_fee_per_gas);
      const bumpedMaxFee = (prevMaxFee * BigInt(this.feeEscalationBps)) / 100n;
      const bumpedPriority = (prevPriority * BigInt(this.feeEscalationBps)) / 100n;
      maxFeePerGas = bumpedMaxFee > maxFeePerGas ? bumpedMaxFee : maxFeePerGas;
      maxPriorityFeePerGas = bumpedPriority > maxPriorityFeePerGas ? bumpedPriority : maxPriorityFeePerGas;
      // SEC-05: record the superseded attempt so we can explicitly mark it REPLACED
      precedingAttemptIdToReplace = latestAttempt.id;
    }

    const iface = new ethers.Interface(MerklePublicationWorker.CONTRACT_ABI_FRAGMENT);
    const calldata = iface.encodeFunctionData('setBountyMerkleRoot', [
      ethers.getAddress(intent.token_address), intent.merkle_root,
    ]);

    const verification = this._verifyPreBroadcast({
      calldata, tokenAddress: intent.token_address, merkleRoot: intent.merkle_root,
      chainId: intent.chain_id, contractAddress: intent.contract_address, providerChainId,
    });

    if (!verification.passed) {
      await this._failIntent(intent, 'SIGN_FAILED', `PRE_BROADCAST_VERIFICATION_FAILED: ${verification.errors.join('; ')}`);
      return true;
    }

    const txRequest: ethers.TransactionRequest = {
      to: ethers.getAddress(intent.contract_address), data: calldata,
      chainId: intent.chain_id, nonce, gasLimit: this.gasLimit,
      maxFeePerGas, maxPriorityFeePerGas, type: 2,
    };

    let signedTx: string;
    try { signedTx = await this.signer.signTransaction(txRequest); }
    catch (err: unknown) {
      await this._failIntent(intent, 'SIGN_FAILED', `TX_SIGN_FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }

    const parsedTx = ethers.Transaction.from(signedTx);
    const txHash = parsedTx.hash!;
    const attemptIndex = latestAttempt ? latestAttempt.attempt_index + 1 : 0;

    // SEC-05: Atomically mark the superseded attempt REPLACED before creating the escalation.
    if (precedingAttemptIdToReplace) {
      await this.db.markAttemptReplaced(precedingAttemptIdToReplace);
    }

    const attempt = await this.db.createAttempt({
      id: randomUUID(), intent_id: intent.id, attempt_index: attemptIndex,
      signer_address: signerAddress, nonce,
      max_fee_per_gas: maxFeePerGas.toString(), max_priority_fee_per_gas: maxPriorityFeePerGas.toString(),
      gas_limit: this.gasLimit.toString(), signed_payload: signedTx, tx_hash: txHash,
      broadcast_status: 'SIGNED', broadcast_error: null,
      receipt_block_number: null, receipt_block_hash: null, receipt_status: null,
      confirmed_block_number: null, confirmed_block_hash: null, confirmations_at_check: null,
    });

    await this.db.createAuditLog({
      intent_id: intent.id, attempt_id: attempt.id, event_type: 'ATTEMPT_SIGNED',
      event_source: this.workerTag, severity: 'INFO',
      metadata: { attempt_index: attemptIndex, nonce, tx_hash: txHash },
    });

    if (this.dryRun) {
      await this.db.updateAttemptStatus(attempt.id, 'BROADCAST_OK', { txHash });
      await this.db.updateIntentStatus(intent.id, 'BROADCASTING');
      await this.db.createAuditLog({
        intent_id: intent.id, attempt_id: attempt.id, event_type: 'DRY_RUN_BROADCAST_SKIPPED',
        event_source: this.workerTag, severity: 'INFO', metadata: { tx_hash: txHash, nonce },
      });
      return true;
    }

    await this.db.updateIntentStatus(intent.id, 'BROADCASTING');

    let broadcastOk = false;
    try {
      await Promise.race([
        provider.broadcastTransaction(signedTx),
        sleep(this.broadcastTimeoutMs).then(() => {
          throw new Error('BROADCAST_TIMEOUT: eth_sendRawTransaction did not respond within timeout');
        }),
      ]);
      broadcastOk = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('BROADCAST_TIMEOUT')) {
        await this.db.updateAttemptStatus(attempt.id, 'BROADCAST_TIMEOUT', { broadcastError: msg, txHash });
        await this.db.createAuditLog({
          intent_id: intent.id, attempt_id: attempt.id, event_type: 'BROADCAST_TIMEOUT',
          event_source: this.workerTag, severity: 'WARN', metadata: { tx_hash: txHash, nonce, error: msg },
        });
        return true;
      }
      // "already known" means our exact tx is already in the mempool — safe to proceed.
      if (msg.toLowerCase().includes('already known')) {
        broadcastOk = true;
      } else if (msg.toLowerCase().includes('nonce too low')) {
        // SEC-04: "nonce too low" is AMBIGUOUS — could be our tx or a competing one at the same nonce.
        // Verify on-chain: if getTransaction returns our txHash from our signer address, proceed.
        // Otherwise, another tx won the nonce race — treat as BROADCAST_FAILED.
        const isOurTx = await this._verifyTxIdentity(provider, txHash);
        if (isOurTx) {
          broadcastOk = true;
          await this.db.createAuditLog({
            intent_id: intent.id, attempt_id: attempt.id, event_type: 'NONCE_TOO_LOW_VERIFIED',
            event_source: this.workerTag, severity: 'WARN',
            metadata: { tx_hash: txHash, nonce, message: 'nonce too low; on-chain identity confirmed as our tx' },
          });
        } else {
          await this.db.updateAttemptStatus(attempt.id, 'BROADCAST_PENDING', { broadcastError: msg, txHash });
          await this._failIntent(intent, 'BROADCAST_FAILED',
            `NONCE_TOO_LOW_UNVERIFIED: A different transaction occupies nonce ${nonce}. ${msg}`);
          return true;
        }
      } else if (msg.toLowerCase().includes('replacement transaction underpriced')) {
        broadcastOk = true;
      } else {
        await this.db.updateAttemptStatus(attempt.id, 'BROADCAST_PENDING', { broadcastError: msg, txHash });
        await this._failIntent(intent, 'BROADCAST_FAILED', `BROADCAST_ERROR: ${msg}`);
        return true;
      }
    }

    if (broadcastOk) await this.db.updateAttemptStatus(attempt.id, 'BROADCAST_OK', { txHash });
    await this.db.updateIntentStatus(intent.id, 'CONFIRMING');
    return await this._pollReceiptAndConfirm(intent, attempt, snapshot, signerAddress);
  }

  private async _pollReceiptAndConfirm(
    intent: PublicationIntentRecord, attempt: PublicationAttemptRecord,
    snapshot: SnapshotMinimal, signerAddress: string
  ): Promise<boolean> {
    if (!attempt.tx_hash) {
      await this._failIntent(intent, 'CONFIRMATION_FAILED', 'MISSING_TX_HASH: Attempt has no tx_hash');
      return true;
    }

    let provider: ethers.JsonRpcProvider;
    try {
      const rpcUrl = await this.rpcManager.getActiveHttpRpc(intent.network_id, 'LAUNCHPAD');
      provider = this.providerFactory(rpcUrl);
    } catch { return true; }

    for (let pollNum = 0; pollNum < this.maxReceiptPollAttempts; pollNum++) {
      if (pollNum > 0) await sleep(this.receiptPollIntervalMs);

      let receipt: ethers.TransactionReceipt | null;
      try { receipt = await provider.getTransactionReceipt(attempt.tx_hash!); }
      catch { continue; }
      if (!receipt) continue;

      let currentBlock: number;
      try { currentBlock = await provider.getBlockNumber(); }
      catch { continue; }

      const confirmations = currentBlock - Number(receipt.blockNumber) + 1;
      if (confirmations < this.confirmationsRequired) continue;

      // SEC-02: getBlock may return null due to RPC lag, not a confirmed reorg.
      // Retry up to nullBlockRetries times. If still null, skip this poll cycle (inconclusive).
      let canonicalBlock: ethers.Block | null = null;
      let nullBlockCount = 0;
      while (nullBlockCount <= this.nullBlockRetries) {
        try { canonicalBlock = await provider.getBlock(receipt.blockNumber); }
        catch { break; }
        if (canonicalBlock !== null) break;
        nullBlockCount++;
        if (nullBlockCount <= this.nullBlockRetries) await sleep(this.receiptPollIntervalMs);
      }

      if (canonicalBlock === null) {
        // Still null after retries: INCONCLUSIVE — skip cycle, do NOT declare reorg.
        await this.db.createAuditLog({
          intent_id: intent.id, attempt_id: attempt.id, event_type: 'CANONICAL_BLOCK_INCONCLUSIVE',
          event_source: this.workerTag, severity: 'WARN',
          metadata: { tx_hash: attempt.tx_hash, block_number: receipt.blockNumber, retries: nullBlockCount },
        });
        continue;
      }

      if (canonicalBlock.hash !== receipt.blockHash) {
        const receiptBlockNum = BigInt(receipt.blockNumber);
        await this.db.updateAttemptStatus(attempt.id, 'REORG_DETECTED', {
          txHash: attempt.tx_hash, receiptBlockNumber: receiptBlockNum,
          receiptBlockHash: receipt.blockHash, confirmedBlockNumber: BigInt(canonicalBlock.number),
          confirmedBlockHash: canonicalBlock.hash ?? undefined, confirmationsAtCheck: confirmations,
        });
        await this._handleReorg(intent, snapshot, attempt, receiptBlockNum);
        return true;
      }

      if (receipt.status === 0) {
        await this.db.updateAttemptStatus(attempt.id, 'RECEIPT_CONFIRMED', {
          txHash: attempt.tx_hash, receiptBlockNumber: BigInt(receipt.blockNumber),
          receiptBlockHash: receipt.blockHash, receiptStatus: 0,
          confirmedBlockNumber: BigInt(canonicalBlock.number), confirmedBlockHash: canonicalBlock.hash ?? undefined,
          confirmationsAtCheck: confirmations,
        });
        await this._failIntent(intent, 'CONFIRMATION_FAILED', `TX_REVERTED: Transaction ${attempt.tx_hash} reverted (status=0)`);
        return true;
      }

      await this.db.updateAttemptStatus(attempt.id, 'RECEIPT_CONFIRMED', {
        txHash: attempt.tx_hash, receiptBlockNumber: BigInt(receipt.blockNumber),
        receiptBlockHash: receipt.blockHash, receiptStatus: 1,
        confirmedBlockNumber: BigInt(canonicalBlock.number), confirmedBlockHash: canonicalBlock.hash ?? undefined,
        confirmationsAtCheck: confirmations,
      });
      await this.db.markSnapshotPublished({
        snapshotId: snapshot.id, publicationTxHash: attempt.tx_hash!,
        confirmedBlockNumber: BigInt(canonicalBlock.number),
        confirmedRoot: intent.merkle_root, publishedBy: signerAddress,
      });
      await this.db.updateIntentStatus(intent.id, 'CONFIRMED', { confirmedAt: new Date() });
      await this.db.createAuditLog({
        intent_id: intent.id, attempt_id: attempt.id, event_type: 'PUBLICATION_CONFIRMED',
        event_source: this.workerTag, severity: 'INFO',
        metadata: { tx_hash: attempt.tx_hash, confirmed_block: canonicalBlock.number, confirmations, merkle_root: intent.merkle_root },
      });
      return true;
    }

    await this.db.updateAttemptStatus(attempt.id, 'RECEIPT_MISSING', { txHash: attempt.tx_hash });
    await this._failIntent(intent, 'CONFIRMATION_FAILED',
      `RECEIPT_TIMEOUT: Transaction ${attempt.tx_hash} not confirmed after ${this.maxReceiptPollAttempts} poll attempts.`);
    return true;
  }

  /**
   * SEC-08: Only call markSnapshotReorgDetected when snapshot is PUBLISHED.
   * Pre-publication reorgs must NOT attempt FINALIZED → REORG_DETECTED (the DB trigger blocks it).
   * Leave snapshot as FINALIZED — it is retryable with a new intent.
   */
  private async _handleReorg(
    intent: PublicationIntentRecord,
    snapshot: SnapshotMinimal,
    attempt: PublicationAttemptRecord,
    receiptBlockNumber?: bigint
  ): Promise<void> {
    const blockNum = receiptBlockNumber ?? attempt.receipt_block_number;
    if (snapshot.status === 'PUBLISHED') {
      await this.db.markSnapshotReorgDetected(
        snapshot.id,
        `REORG: Transaction ${attempt.tx_hash} at block ${blockNum} was reorganized`
      );
      await this.db.updateIntentStatus(intent.id, 'REORG_DETECTED', {
        errorMessage: `Transaction ${attempt.tx_hash} evicted from canonical chain`,
      });
      await this.db.createAuditLog({
        intent_id: intent.id, attempt_id: attempt.id, event_type: 'REORG_DETECTED',
        event_source: this.workerTag, severity: 'CRITICAL',
        metadata: { tx_hash: attempt.tx_hash, receipt_block: blockNum?.toString(), merkle_root: intent.merkle_root },
      });
    } else {
      // Snapshot is FINALIZED (not yet PUBLISHED) — reorg before publication confirmed.
      // Do NOT call markSnapshotReorgDetected; snapshot stays FINALIZED for retry.
      await this._failIntent(
        intent,
        'CONFIRMATION_FAILED',
        `PRE_PUBLICATION_REORG: Transaction ${attempt.tx_hash} evicted before publication confirmed. Snapshot ${snapshot.id} remains FINALIZED and is retryable.`
      );
      await this.db.createAuditLog({
        intent_id: intent.id, attempt_id: attempt.id, event_type: 'PRE_PUBLICATION_REORG',
        event_source: this.workerTag, severity: 'CRITICAL',
        metadata: { tx_hash: attempt.tx_hash, receipt_block: blockNum?.toString(), snapshot_status: snapshot.status, merkle_root: intent.merkle_root },
      });
    }
  }

  /**
   * SEC-03: Atomic nonce allocation using compare-and-swap reservation.
   * Early-returns the existing nonce when recovering a timed-out or missing attempt.
   * For fresh attempts, finds the highest safe candidate and atomically reserves it.
   */
  private async _allocateNonce(
    signerAddress: string,
    chainId: bigint,
    provider: ethers.JsonRpcProvider,
    latestAttempt: PublicationAttemptRecord | null,
    intentId: string
  ): Promise<number> {
    // Recovery path: preserve the nonce for BROADCAST_TIMEOUT / RECEIPT_MISSING
    if (latestAttempt && ['BROADCAST_TIMEOUT', 'RECEIPT_MISSING'].includes(latestAttempt.broadcast_status)) {
      return latestAttempt.nonce;
    }

    const chainPendingNonce = await provider.getTransactionCount(signerAddress, 'pending');
    const dbNonces = await this.db.getInFlightNoncesForSigner(signerAddress, chainId);
    const dbMaxNonce = dbNonces.length > 0 ? Math.max(...dbNonces) + 1 : 0;
    let candidate = Math.max(chainPendingNonce, dbMaxNonce);

    // CAS loop: try up to 10 candidates before giving up
    for (let i = 0; i < 10; i++) {
      const reserved = await this.db.reserveNonce(signerAddress, chainId, candidate, intentId);
      if (reserved) return candidate;
      candidate++;
    }
    throw new Error(
      `NONCE_EXHAUSTED: Unable to atomically reserve a nonce for ${signerAddress} on chain ${chainId} after 10 attempts`
    );
  }

  /**
   * SEC-04: Verify that txHash belongs to our signer on-chain.
   * Returns true if confirmed ours; false if absent, different sender, or RPC error.
   */
  private async _verifyTxIdentity(provider: ethers.JsonRpcProvider, txHash: string): Promise<boolean> {
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx) return false;
      const signerAddress = await this.signer.getAddress();
      return tx.from?.toLowerCase() === signerAddress.toLowerCase();
    } catch {
      return false;
    }
  }

  _verifyPreBroadcast(params: {
    calldata: string; tokenAddress: string; merkleRoot: string;
    chainId: bigint; contractAddress: string; providerChainId: bigint;
  }): PreBroadcastVerificationResult {
    const errors: string[] = [];
    const iface = new ethers.Interface(MerklePublicationWorker.CONTRACT_ABI_FRAGMENT);
    let decodedToken = '', decodedRoot = '';
    try {
      const decoded = iface.decodeFunctionData('setBountyMerkleRoot', params.calldata);
      decodedToken = decoded[0] as string; decodedRoot = decoded[1] as string;
    } catch (err: unknown) {
      errors.push(`CALLDATA_DECODE_FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return { passed: false, errors, verifiedTokenAddress: '', verifiedRoot: '', verifiedChainId: 0n, verifiedContractAddress: '' };
    }
    if (decodedToken.toLowerCase() !== params.tokenAddress.toLowerCase()) errors.push(`TOKEN_MISMATCH: calldata token ${decodedToken} != intent token ${params.tokenAddress}`);
    if (decodedRoot.toLowerCase() !== params.merkleRoot.toLowerCase()) errors.push(`ROOT_MISMATCH: calldata root ${decodedRoot} != intent root ${params.merkleRoot}`);
    if (params.providerChainId !== params.chainId) errors.push(`CHAIN_MISMATCH: provider chain ${params.providerChainId} != intent chain ${params.chainId}`);
    if (!ethers.isAddress(params.contractAddress)) errors.push(`INVALID_CONTRACT_ADDRESS: ${params.contractAddress}`);
    return { passed: errors.length === 0, errors, verifiedTokenAddress: decodedToken, verifiedRoot: decodedRoot, verifiedChainId: params.providerChainId, verifiedContractAddress: params.contractAddress };
  }

  private async _failIntent(intent: PublicationIntentRecord, status: PublicationIntentStatus, errorMessage: string): Promise<void> {
    await this.db.updateIntentStatus(intent.id, status, { errorMessage });
    await this.db.createAuditLog({
      intent_id: intent.id, attempt_id: null, event_type: status,
      event_source: this.workerTag, severity: 'ERROR',
      metadata: { error: errorMessage, snapshot_id: intent.snapshot_id },
    });
  }
}

export class InMemoryPublicationWorkerDbAdapter implements PublicationWorkerDbAdapter {
  public intents: Map<string, PublicationIntentRecord> = new Map();
  public attempts: Map<string, PublicationAttemptRecord> = new Map();
  public snapshots: Map<string, SnapshotMinimal> = new Map();
  public auditLogs: PublicationAuditLog[] = [];
  // SEC-03: nonce reservation registry — simulates atomic DB reservation
  private _nonceReservations: Map<string, string> = new Map();

  async claimNextPendingIntent(_n: string, _c: string): Promise<PublicationIntentRecord | null> {
    for (const intent of this.intents.values()) {
      if (intent.status === 'PENDING') { intent.status = 'CLAIMING'; intent.updated_at = new Date(); return { ...intent }; }
    }
    return null;
  }

  async getActiveIntentForToken(tokenAddress: string, networkId: string, contractAddress: string): Promise<PublicationIntentRecord | null> {
    const terminal: PublicationIntentStatus[] = ['CONFIRMED', 'SIGN_FAILED', 'BROADCAST_FAILED', 'CONFIRMATION_FAILED', 'REORG_DETECTED', 'SUPERSEDED'];
    for (const intent of this.intents.values()) {
      if (intent.token_address.toLowerCase() === tokenAddress.toLowerCase() && intent.network_id === networkId && intent.contract_address.toLowerCase() === contractAddress.toLowerCase() && !terminal.includes(intent.status)) return { ...intent };
    }
    return null;
  }

  async createIntent(params: { id: string; idempotency_key: string; snapshot_id: string; token_address: string; network_id: string; chain_id: bigint; contract_address: string; merkle_root: string; }): Promise<{ record: PublicationIntentRecord; isExisting: boolean }> {
    for (const e of this.intents.values()) { if (e.idempotency_key === params.idempotency_key) return { record: { ...e }, isExisting: true }; }
    const record: PublicationIntentRecord = { ...params, status: 'PENDING', error_message: null, created_at: new Date(), updated_at: new Date(), claimed_at: null, confirmed_at: null };
    this.intents.set(record.id, record);
    return { record: { ...record }, isExisting: false };
  }

  async updateIntentStatus(intentId: string, status: PublicationIntentStatus, metadata?: { errorMessage?: string | null; confirmedAt?: Date }): Promise<void> {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error(`Intent ${intentId} not found`);
    intent.status = status; intent.updated_at = new Date();
    if (metadata?.errorMessage !== undefined) intent.error_message = metadata.errorMessage ?? null;
    if (metadata?.confirmedAt) intent.confirmed_at = metadata.confirmedAt;
  }

  async createAttempt(params: Omit<PublicationAttemptRecord, 'created_at' | 'updated_at'>): Promise<PublicationAttemptRecord> {
    const attempt: PublicationAttemptRecord = { ...params, created_at: new Date(), updated_at: new Date() };
    this.attempts.set(attempt.id, attempt);
    return { ...attempt };
  }

  async updateAttemptStatus(attemptId: string, broadcastStatus: PublicationAttemptStatus, metadata?: { txHash?: string | null; broadcastError?: string | null; receiptBlockNumber?: bigint | null; receiptBlockHash?: string | null; receiptStatus?: number | null; confirmedBlockNumber?: bigint | null; confirmedBlockHash?: string | null; confirmationsAtCheck?: number | null; }): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error(`Attempt ${attemptId} not found`);
    attempt.broadcast_status = broadcastStatus; attempt.updated_at = new Date();
    if (metadata?.txHash !== undefined) attempt.tx_hash = metadata.txHash ?? null;
    if (metadata?.broadcastError !== undefined) attempt.broadcast_error = metadata.broadcastError ?? null;
    if (metadata?.receiptBlockNumber !== undefined) attempt.receipt_block_number = metadata.receiptBlockNumber ?? null;
    if (metadata?.receiptBlockHash !== undefined) attempt.receipt_block_hash = metadata.receiptBlockHash ?? null;
    if (metadata?.receiptStatus !== undefined) attempt.receipt_status = metadata.receiptStatus ?? null;
    if (metadata?.confirmedBlockNumber !== undefined) attempt.confirmed_block_number = metadata.confirmedBlockNumber ?? null;
    if (metadata?.confirmedBlockHash !== undefined) attempt.confirmed_block_hash = metadata.confirmedBlockHash ?? null;
    if (metadata?.confirmationsAtCheck !== undefined) attempt.confirmations_at_check = metadata.confirmationsAtCheck ?? null;
  }

  /** SEC-05: Explicitly mark a superseded attempt as REPLACED. */
  async markAttemptReplaced(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new Error(`Attempt ${attemptId} not found`);
    attempt.broadcast_status = 'REPLACED';
    attempt.updated_at = new Date();
  }

  async getLatestAttemptForIntent(intentId: string): Promise<PublicationAttemptRecord | null> {
    let latest: PublicationAttemptRecord | null = null;
    for (const attempt of this.attempts.values()) {
      if (attempt.intent_id === intentId && (!latest || attempt.attempt_index > latest.attempt_index)) latest = attempt;
    }
    return latest ? { ...latest } : null;
  }

  async getInFlightNoncesForSigner(signerAddress: string, chainId: bigint): Promise<number[]> {
    const inFlight: PublicationAttemptStatus[] = ['SIGNED', 'BROADCAST_PENDING', 'BROADCAST_TIMEOUT', 'BROADCAST_OK', 'RECEIPT_PENDING'];
    const nonces: number[] = [];
    for (const attempt of this.attempts.values()) {
      if (attempt.signer_address.toLowerCase() === signerAddress.toLowerCase() && inFlight.includes(attempt.broadcast_status)) {
        const intent = this.intents.get(attempt.intent_id);
        if (intent && intent.chain_id === chainId) nonces.push(attempt.nonce);
      }
    }
    return nonces;
  }

  /**
   * SEC-03: Atomic nonce reservation (compare-and-swap).
   * Returns true if reserved, false if already taken by another intent.
   */
  async reserveNonce(signerAddress: string, chainId: bigint, nonce: number, intentId: string): Promise<boolean> {
    const key = `${signerAddress.toLowerCase()}:${chainId}:${nonce}`;
    if (this._nonceReservations.has(key)) return false;
    this._nonceReservations.set(key, intentId);
    return true;
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotMinimal | null> { return this.snapshots.get(snapshotId) ?? null; }

  async markSnapshotPublished(params: { snapshotId: string; publicationTxHash: string; confirmedBlockNumber: bigint; confirmedRoot: string; publishedBy: string; }): Promise<void> {
    const snap = this.snapshots.get(params.snapshotId);
    if (!snap) throw new Error(`Snapshot ${params.snapshotId} not found`);
    if (snap.status !== 'FINALIZED') throw new Error(`INVALID_STATE: Cannot publish snapshot in status ${snap.status}`);
    snap.status = 'PUBLISHED';
  }

  /**
   * SEC-08: Enforces PUBLISHED source state invariant (mirrors SQL trigger fn_bms_status_transition).
   * Throws INVALID_TRANSITION if called on a FINALIZED or any other non-PUBLISHED snapshot.
   */
  async markSnapshotReorgDetected(snapshotId: string, _reason: string): Promise<void> {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) throw new Error(`Snapshot ${snapshotId} not found`);
    if (snap.status !== 'PUBLISHED') {
      throw new Error(
        `INVALID_TRANSITION: Cannot transition snapshot ${snapshotId} from ${snap.status} to REORG_DETECTED. ` +
        `Only PUBLISHED → REORG_DETECTED is permitted (mirrors SQL trigger fn_bms_status_transition).`
      );
    }
    snap.status = 'REORG_DETECTED';
  }

  async createAuditLog(log: PublicationAuditLog): Promise<void> { this.auditLogs.push({ ...log }); }
}

function sleep(ms: number): Promise<void> { return new Promise((res) => setTimeout(res, ms)); }
