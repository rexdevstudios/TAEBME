// =============================================================================
// PHASE 3.3C.4 — B3.3: MERKLE ROOT PUBLICATION WORKER TEST SUITE
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import {
  MerklePublicationWorker,
  InMemoryPublicationWorkerDbAdapter,
  PublicationIntentRecord,
  SnapshotMinimal,
} from '../apps/execution-plane/workers/merkle-publication-worker';

// =============================================================================
// FIXTURES  — all addresses are valid EIP-55 checksummed
// =============================================================================

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_WALLET    = new ethers.Wallet(TEST_PRIVATE_KEY);
const SIGNER_ADDRESS = TEST_WALLET.address; // 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

const CHAIN_ID = 8453n;
const NETWORK_ID = 'base-mainnet';
// EIP-55 checksummed synthetic addresses (preimage-known, non-production)
const CONTRACT_ADDRESS = '0x0000000000000000000000000000000000000001';
const TOKEN_ADDRESS    = '0x0000000000000000000000000000000000000002';
const WRONG_TOKEN      = '0x0000000000000000000000000000000000000003';
const MERKLE_ROOT      = '0x' + 'ab'.repeat(32);
const WRONG_ROOT       = '0x' + 'ff'.repeat(32);
const BLOCK_HASH_A     = '0x' + '11'.repeat(32);
// A plausible tx hash (32 bytes hex)
const TX_HASH          = '0x' + '8a4085803bcf825c2093d6c0a316e446f2ae9578d0f9475fae412821704986d'.padEnd(64, 'd');

// Shared ABI fragment (no 'nonpayable' — ethers v6 human-readable doesn't support it)
const ABI_FRAGMENT = ['function setBountyMerkleRoot(address tokenAddress, bytes32 newRoot)'];

// =============================================================================
// MOCK PROVIDER BUILDER
// =============================================================================

type MockProvider = {
  getNetwork: ReturnType<typeof vi.fn>;
  getTransactionCount: ReturnType<typeof vi.fn>;
  getFeeData: ReturnType<typeof vi.fn>;
  broadcastTransaction: ReturnType<typeof vi.fn>;
  getTransactionReceipt: ReturnType<typeof vi.fn>;
  getBlockNumber: ReturnType<typeof vi.fn>;
  getBlock: ReturnType<typeof vi.fn>;
};

function buildProvider(overrides: {
  chainId?: bigint;
  pendingNonce?: number;
  broadcastResult?: 'ok' | 'reject' | 'already_known';
  receipt?: ethers.TransactionReceipt | null;
  blockNumber?: number;
  block?: { number: number; hash: string } | null;
}): MockProvider {
  const chainId     = overrides.chainId     ?? CHAIN_ID;
  const blockNumber = overrides.blockNumber ?? 100;
  const pendingNonce = overrides.pendingNonce ?? 0;

  const provider: MockProvider = {
    getNetwork:            vi.fn().mockResolvedValue({ chainId }),
    getTransactionCount:   vi.fn().mockResolvedValue(pendingNonce),
    getFeeData:            vi.fn().mockResolvedValue(new ethers.FeeData(1_000_000_000n, 2_000_000_000n, 1_000_000_000n)),
    broadcastTransaction:  vi.fn(),
    getTransactionReceipt: vi.fn(),
    getBlockNumber:        vi.fn().mockResolvedValue(blockNumber),
    getBlock:              vi.fn(),
  };

  if (overrides.broadcastResult === 'reject') {
    provider.broadcastTransaction.mockRejectedValue(new Error('insufficient funds for gas'));
  } else if (overrides.broadcastResult === 'already_known') {
    provider.broadcastTransaction.mockRejectedValue(new Error('already known'));
  } else {
    provider.broadcastTransaction.mockResolvedValue({ hash: TX_HASH } as any);
  }

  if (overrides.receipt === null) {
    provider.getTransactionReceipt.mockResolvedValue(null);
  } else if (overrides.receipt) {
    provider.getTransactionReceipt.mockResolvedValue(overrides.receipt);
  } else {
    provider.getTransactionReceipt.mockResolvedValue({
      hash: TX_HASH, blockNumber: blockNumber - 12, blockHash: BLOCK_HASH_A, status: 1,
    } as any);
  }

  if (overrides.block === null) {
    provider.getBlock.mockResolvedValue(null);
  } else if (overrides.block) {
    provider.getBlock.mockResolvedValue(overrides.block);
  } else {
    provider.getBlock.mockResolvedValue({ number: blockNumber - 12, hash: BLOCK_HASH_A });
  }

  return provider;
}

function buildRpcManager() {
  return { getActiveHttpRpc: vi.fn().mockResolvedValue('http://mock-rpc') };
}

function buildSnapshot(overrides: Partial<SnapshotMinimal> = {}): SnapshotMinimal {
  return {
    id: randomUUID(), status: 'FINALIZED', merkle_root: MERKLE_ROOT,
    token_address: TOKEN_ADDRESS, network_id: NETWORK_ID, chain_id: CHAIN_ID,
    contract_address: CONTRACT_ADDRESS, total_reward_tokens: 1_000_000n, ...overrides,
  };
}

async function buildIntent(
  db: InMemoryPublicationWorkerDbAdapter, snapshotId: string,
  overrides: Partial<{ id: string; idempotency_key: string }> = {}
): Promise<PublicationIntentRecord> {
  const { record } = await db.createIntent({
    id: overrides.id ?? randomUUID(), idempotency_key: overrides.idempotency_key ?? randomUUID(),
    snapshot_id: snapshotId, token_address: TOKEN_ADDRESS, network_id: NETWORK_ID,
    chain_id: CHAIN_ID, contract_address: CONTRACT_ADDRESS, merkle_root: MERKLE_ROOT,
  });
  return record;
}

function buildWorker(
  db: InMemoryPublicationWorkerDbAdapter,
  rpcManager: ReturnType<typeof buildRpcManager>,
  mockProvider: MockProvider,
  opts: {
    confirmationsRequired?: number; maxReceiptPollAttempts?: number;
    receiptPollIntervalMs?: number; broadcastTimeoutMs?: number; dryRun?: boolean;
    nullBlockRetries?: number;
  } = {}
) {
  return new MerklePublicationWorker(db, TEST_WALLET, rpcManager as any, {
    confirmationsRequired:  opts.confirmationsRequired  ?? 2,
    maxReceiptPollAttempts: opts.maxReceiptPollAttempts ?? 3,
    receiptPollIntervalMs:  opts.receiptPollIntervalMs  ?? 0,
    broadcastTimeoutMs:     opts.broadcastTimeoutMs     ?? 500,
    nullBlockRetries:       opts.nullBlockRetries,
    dryRun:    opts.dryRun    ?? false,
    pollIntervalMs: 0, workerTag: 'TestWorker',
    // ESM-safe injection — avoids vi.spyOn on ethers module namespace
    providerFactory: (_url: string) => mockProvider as unknown as ethers.JsonRpcProvider,
  });
}

// =============================================================================
// TESTS
// =============================================================================

describe('MerklePublicationWorker (B3.3)', () => {
  let db: InMemoryPublicationWorkerDbAdapter;

  beforeEach(() => { db = new InMemoryPublicationWorkerDbAdapter(); vi.restoreAllMocks(); });

  // ─── TC-01: Happy path ────────────────────────────────────────────────────
  it('TC-01: happy path completes PENDING→CONFIRMED with snapshot PUBLISHED', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    const provider = buildProvider({ blockNumber: 120 });
    const worker = buildWorker(db, buildRpcManager(), provider);

    expect(await worker.processNextIntent()).toBe(true);

    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMED');
    expect(db.intents.get(intent.id)!.confirmed_at).toBeDefined();
    expect(snap.status).toBe('PUBLISHED');
    const attempts = [...db.attempts.values()];
    expect(attempts).toHaveLength(1);
    expect(attempts[0].broadcast_status).toBe('RECEIPT_CONFIRMED');
    expect(attempts[0].receipt_status).toBe(1);
    expect(db.auditLogs.find((l) => l.event_type === 'PUBLICATION_CONFIRMED')).toBeDefined();
  });

  // ─── TC-02: No pending intent ─────────────────────────────────────────────
  it('TC-02: returns false and emits no audit when no PENDING intent exists', async () => {
    const provider = buildProvider({});
    expect(await buildWorker(db, buildRpcManager(), provider).processNextIntent()).toBe(false);
    expect(db.auditLogs).toHaveLength(0);
  });

  // ─── TC-03: Non-FINALIZED snapshot ───────────────────────────────────────
  it('TC-03: SIGN_FAILED for DRAFT snapshot — snapshot untouched', async () => {
    const snap = buildSnapshot({ status: 'DRAFT', merkle_root: null });
    db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    const provider = buildProvider({});
    await buildWorker(db, buildRpcManager(), provider).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('SIGN_FAILED');
    expect(db.intents.get(intent.id)!.error_message).toMatch(/NON_FINALIZED_SNAPSHOT/);
    expect(snap.status).toBe('DRAFT');
    expect([...db.attempts.values()]).toHaveLength(0);
  });

  // ─── TC-04: Snapshot not found ────────────────────────────────────────────
  it('TC-04: SIGN_FAILED when snapshot record does not exist', async () => {
    const intent = await buildIntent(db, 'does-not-exist');
    await buildWorker(db, buildRpcManager(), buildProvider({})).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('SIGN_FAILED');
    expect(db.intents.get(intent.id)!.error_message).toMatch(/SNAPSHOT_NOT_FOUND/);
  });

  // ─── TC-05: Chain mismatch ────────────────────────────────────────────────
  it('TC-05: SIGN_FAILED when provider chain ID does not match intent chain ID', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    const provider = buildProvider({ chainId: 1n }); // Ethereum mainnet, not Base
    await buildWorker(db, buildRpcManager(), provider).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('SIGN_FAILED');
    expect(db.intents.get(intent.id)!.error_message).toMatch(/CHAIN_MISMATCH/);
  });

  // ─── TC-06: Broadcast rejected ────────────────────────────────────────────
  it('TC-06: BROADCAST_FAILED on definite broadcast rejection — signed payload persisted', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    const provider = buildProvider({ broadcastResult: 'reject' });
    await buildWorker(db, buildRpcManager(), provider, { broadcastTimeoutMs: 500 }).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('BROADCAST_FAILED');
    const attempts = [...db.attempts.values()];
    expect(attempts).toHaveLength(1);
    expect(attempts[0].signed_payload).toBeTruthy();
    expect(attempts[0].broadcast_status).toBe('BROADCAST_PENDING');
  });

  // ─── TC-07: "already known" treated as broadcast ok ──────────────────────
  it('TC-07: "already known" error treated as broadcast ok, proceeds to receipt polling', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    await buildIntent(db, snap.id);
    const provider = buildProvider({ broadcastResult: 'already_known', blockNumber: 120 });
    await buildWorker(db, buildRpcManager(), provider).processNextIntent();
    expect([...db.intents.values()][0]!.status).toBe('CONFIRMED');
    expect(snap.status).toBe('PUBLISHED');
  });

  // ─── TC-08: Broadcast timeout ────────────────────────────────────────────
  it('TC-08: broadcast timeout records BROADCAST_TIMEOUT and leaves intent in BROADCASTING', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    const provider = buildProvider({});
    // Simulate a slow broadcast that exceeds the 10ms timeout
    provider.broadcastTransaction.mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ hash: TX_HASH } as any), 200))
    );
    await buildWorker(db, buildRpcManager(), provider, { broadcastTimeoutMs: 10 }).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('BROADCASTING');
    const attempts = [...db.attempts.values()];
    expect(attempts).toHaveLength(1);
    expect(attempts[0].broadcast_status).toBe('BROADCAST_TIMEOUT');
    expect(attempts[0].signed_payload).toBeTruthy();
    expect(db.auditLogs.find((l) => l.event_type === 'BROADCAST_TIMEOUT')?.severity).toBe('WARN');
  });

  // ─── TC-09: Receipt timeout ───────────────────────────────────────────────
  it('TC-09: CONFIRMATION_FAILED when receipt never arrives within polling budget', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    const provider = buildProvider({ receipt: null, blockNumber: 100 });
    await buildWorker(db, buildRpcManager(), provider, { maxReceiptPollAttempts: 2 }).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMATION_FAILED');
    expect(db.intents.get(intent.id)!.error_message).toMatch(/RECEIPT_TIMEOUT/);
    expect([...db.attempts.values()][0].broadcast_status).toBe('RECEIPT_MISSING');
  });

  // ─── TC-10: Transaction reverted ─────────────────────────────────────────
  it('TC-10: CONFIRMATION_FAILED when mined transaction reverts (status=0)', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    const provider = buildProvider({
      receipt: { hash: TX_HASH, blockNumber: 88, blockHash: BLOCK_HASH_A, status: 0 } as any,
      blockNumber: 100, block: { number: 88, hash: BLOCK_HASH_A },
    });
    await buildWorker(db, buildRpcManager(), provider, { confirmationsRequired: 2 }).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMATION_FAILED');
    expect(db.intents.get(intent.id)!.error_message).toMatch(/TX_REVERTED/);
    expect(snap.status).toBe('FINALIZED'); // must NOT be PUBLISHED
  });

  // ─── TC-11: Pre-publication reorg — block hash mismatch (SEC-08) ─────────
  it('TC-11: pre-publication reorg keeps FINALIZED snapshot retryable and logs CRITICAL PRE_PUBLICATION_REORG', async () => {
    // SEC-08: During confirmation polling, the snapshot is still FINALIZED (not PUBLISHED).
    // SQL trigger fn_bms_status_transition forbids FINALIZED → REORG_DETECTED, so pre-publication
    // reorg must mark the attempt REORG_DETECTED, fail the intent as CONFIRMATION_FAILED, keep
    // snapshot FINALIZED for retry, and emit a CRITICAL PRE_PUBLICATION_REORG audit log.
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    const BLOCK_HASH_B = '0x' + '22'.repeat(32);
    const provider = buildProvider({
      receipt: { hash: TX_HASH, blockNumber: 88, blockHash: BLOCK_HASH_A, status: 1 } as any,
      blockNumber: 100, block: { number: 88, hash: BLOCK_HASH_B }, // hash changed ⇒ reorg
    });
    await buildWorker(db, buildRpcManager(), provider, { confirmationsRequired: 2 }).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMATION_FAILED');
    expect(db.intents.get(intent.id)!.error_message).toMatch(/PRE_PUBLICATION_REORG/);
    expect([...db.attempts.values()][0]!.broadcast_status).toBe('REORG_DETECTED');
    expect(snap.status).toBe('FINALIZED');
    const reorgLog = db.auditLogs.find((l) => l.event_type === 'PRE_PUBLICATION_REORG');
    expect(reorgLog?.severity).toBe('CRITICAL');
    expect(reorgLog?.metadata?.merkle_root).toBe(MERKLE_ROOT);
    expect(reorgLog?.metadata?.receipt_block).toBe('88');
  });

  // ─── TC-12: Null canonical block — inconclusive (SEC-02) ──────────────────
  it('TC-12: null canonical block treated as CANONICAL_BLOCK_INCONCLUSIVE (not REORG_DETECTED)', async () => {
    // SEC-02: getBlock returning null is INCONCLUSIVE (RPC lag), not a confirmed reorg.
    // The worker retries up to nullBlockRetries times, then skips the poll cycle.
    // After exhausting all poll attempts, intent reaches CONFIRMATION_FAILED and snapshot stays FINALIZED.
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    await buildIntent(db, snap.id);
    const provider = buildProvider({
      receipt: { hash: TX_HASH, blockNumber: 88, blockHash: BLOCK_HASH_A, status: 1 } as any,
      blockNumber: 100, block: null,
    });
    // nullBlockRetries=0, maxReceiptPollAttempts=1 → exhausts immediately
    await buildWorker(db, buildRpcManager(), provider, {
      confirmationsRequired: 2, nullBlockRetries: 0, maxReceiptPollAttempts: 1,
    }).processNextIntent();
    // Block disappearing is INCONCLUSIVE — intent must NOT be REORG_DETECTED
    expect([...db.intents.values()][0]!.status).toBe('CONFIRMATION_FAILED');
    // Snapshot must remain FINALIZED (not PUBLISHED, not REORG_DETECTED)
    expect(snap.status).toBe('FINALIZED');
    // An inconclusive audit log must have been emitted, with no reorg declaration
    expect(db.auditLogs.find((l) => l.event_type === 'CANONICAL_BLOCK_INCONCLUSIVE')?.severity).toBe('WARN');
    expect(db.auditLogs.find((l) => l.event_type === 'REORG_DETECTED' || l.event_type === 'PRE_PUBLICATION_REORG')).toBeUndefined();
  });

  // ─── TC-13: Restart recovery ──────────────────────────────────────────────
  it('TC-13: restart recovery resumes receipt polling for existing BROADCAST_OK attempt', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);

    const existingAttempt = await db.createAttempt({
      id: randomUUID(), intent_id: intent.id, attempt_index: 0,
      signer_address: SIGNER_ADDRESS, nonce: 7,
      max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1000000000', gas_limit: '100000',
      signed_payload: '0xdeadbeef', tx_hash: TX_HASH, broadcast_status: 'BROADCAST_OK',
      broadcast_error: null, receipt_block_number: null, receipt_block_hash: null,
      receipt_status: null, confirmed_block_number: null, confirmed_block_hash: null, confirmations_at_check: null,
    });

    // Reset to PENDING so claimNextPendingIntent picks it up
    db.intents.get(intent.id)!.status = 'PENDING';

    const provider = buildProvider({ blockNumber: 120 });
    await buildWorker(db, buildRpcManager(), provider, { confirmationsRequired: 2 }).processNextIntent();

    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMED');
    expect(snap.status).toBe('PUBLISHED');
    // Should NOT have created a new attempt — reused existing
    const attempts = [...db.attempts.values()];
    expect(attempts).toHaveLength(1);
    expect(attempts[0].id).toBe(existingAttempt.id);
  });

  // ─── TC-14: Idempotency ───────────────────────────────────────────────────
  it('TC-14: idempotent createIntent returns existing record for same idempotency_key', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const key = 'unique-key-abc123';
    const { record: first, isExisting: e1 } = await db.createIntent({
      id: randomUUID(), idempotency_key: key, snapshot_id: snap.id,
      token_address: TOKEN_ADDRESS, network_id: NETWORK_ID,
      chain_id: CHAIN_ID, contract_address: CONTRACT_ADDRESS, merkle_root: MERKLE_ROOT,
    });
    const { record: second, isExisting: e2 } = await db.createIntent({
      id: randomUUID(), idempotency_key: key, snapshot_id: snap.id,
      token_address: TOKEN_ADDRESS, network_id: NETWORK_ID,
      chain_id: CHAIN_ID, contract_address: CONTRACT_ADDRESS, merkle_root: MERKLE_ROOT,
    });
    expect(e1).toBe(false); expect(e2).toBe(true);
    expect(second.id).toBe(first.id);
    expect([...db.intents.values()]).toHaveLength(1);
  });

  // ─── TC-15: Pre-broadcast — token mismatch ────────────────────────────────
  it('TC-15: pre-broadcast verification rejects mismatched token address', () => {
    const worker = buildWorker(db, buildRpcManager(), buildProvider({}));
    const iface = new ethers.Interface(ABI_FRAGMENT);
    // Encode calldata with WRONG_TOKEN (different from TOKEN_ADDRESS)
    const calldata = iface.encodeFunctionData('setBountyMerkleRoot', [WRONG_TOKEN, MERKLE_ROOT]);
    const result = worker._verifyPreBroadcast({
      calldata, tokenAddress: TOKEN_ADDRESS, merkleRoot: MERKLE_ROOT,
      chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS, providerChainId: CHAIN_ID,
    });
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('TOKEN_MISMATCH'))).toBe(true);
  });

  // ─── TC-16: Pre-broadcast — root mismatch ────────────────────────────────
  it('TC-16: pre-broadcast verification rejects mismatched merkle root', () => {
    const worker = buildWorker(db, buildRpcManager(), buildProvider({}));
    const iface = new ethers.Interface(ABI_FRAGMENT);
    const calldata = iface.encodeFunctionData('setBountyMerkleRoot', [TOKEN_ADDRESS, WRONG_ROOT]);
    const result = worker._verifyPreBroadcast({
      calldata, tokenAddress: TOKEN_ADDRESS, merkleRoot: MERKLE_ROOT,
      chainId: CHAIN_ID, contractAddress: CONTRACT_ADDRESS, providerChainId: CHAIN_ID,
    });
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes('ROOT_MISMATCH'))).toBe(true);
  });

  // ─── TC-17: One-active-intent guard ──────────────────────────────────────
  it('TC-17: getActiveIntentForToken returns existing non-terminal intent', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    const active = await db.getActiveIntentForToken(TOKEN_ADDRESS, NETWORK_ID, CONTRACT_ADDRESS);
    expect(active).not.toBeNull();
    expect(active?.id).toBe(intent.id);
  });

  // ─── TC-18: Terminal intent does NOT block new intents ───────────────────
  it('TC-18: getActiveIntentForToken returns null after CONFIRMED terminal state', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    await db.updateIntentStatus(intent.id, 'CONFIRMED');
    expect(await db.getActiveIntentForToken(TOKEN_ADDRESS, NETWORK_ID, CONTRACT_ADDRESS)).toBeNull();
  });

  // ─── TC-19: Nonce floor from DB in-flight attempts ───────────────────────
  it('TC-19: getInFlightNoncesForSigner floors nonce allocation at DB max + 1', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    const intent = await buildIntent(db, snap.id);
    await db.updateIntentStatus(intent.id, 'BROADCASTING');
    await db.createAttempt({
      id: randomUUID(), intent_id: intent.id, attempt_index: 0,
      signer_address: SIGNER_ADDRESS, nonce: 5,
      max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1000000000', gas_limit: '100000',
      signed_payload: '0xabc', tx_hash: TX_HASH, broadcast_status: 'BROADCAST_OK',
      broadcast_error: null, receipt_block_number: null, receipt_block_hash: null,
      receipt_status: null, confirmed_block_number: null, confirmed_block_hash: null, confirmations_at_check: null,
    });
    const inFlight = await db.getInFlightNoncesForSigner(SIGNER_ADDRESS, CHAIN_ID);
    expect(inFlight).toContain(5);
    expect(Math.max(...inFlight) + 1).toBe(6);
  });

  // ─── TC-20: Dry run ───────────────────────────────────────────────────────
  it('TC-20: dryRun=true signs transaction but skips broadcast', async () => {
    const snap = buildSnapshot(); db.snapshots.set(snap.id, snap);
    await buildIntent(db, snap.id);
    const provider = buildProvider({});
    await buildWorker(db, buildRpcManager(), provider, { dryRun: true }).processNextIntent();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(db.auditLogs.find((l) => l.event_type === 'DRY_RUN_BROADCAST_SKIPPED')).toBeDefined();
    const attempts = [...db.attempts.values()];
    expect(attempts).toHaveLength(1);
    expect(attempts[0].broadcast_status).toBe('BROADCAST_OK');
    expect(attempts[0].signed_payload).toBeTruthy();
  });
});
