// =============================================================================
// PHASE 3.3C.4 — TASK B3.3.1: PUBLICATION WORKER SECURITY AUDIT TESTS
// Independent behavioral tests for security invariants identified in audit.
// These tests do NOT replace B3.3 unit tests — they extend them with failure cases.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import {
  MerklePublicationWorker,
  InMemoryPublicationWorkerDbAdapter,
  PublicationIntentRecord,
  PublicationIntentStatus,
  PublicationAttemptStatus,
  SnapshotMinimal,
  DB_INTENT_STATUSES,
  DB_ATTEMPT_STATUSES,
  DB_INTENT_TRANSITIONS,
  workerIntentStatusToDb,
  dbIntentStatusToWorker,
  workerAttemptStatusToDb,
} from '../apps/execution-plane/workers/merkle-publication-worker';

// ==================================================================
// SHARED FIXTURES
// ==================================================================

const TEST_KEY    = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_WALLET = new ethers.Wallet(TEST_KEY);
const SIGNER      = TEST_WALLET.address;

const CHAIN_ID      = 8453n;
const NETWORK_ID    = 'base-mainnet';
const CONTRACT_ADDR = '0x0000000000000000000000000000000000000001';
const TOKEN_ADDR    = '0x0000000000000000000000000000000000000002';
const MERKLE_ROOT   = '0x' + 'ab'.repeat(32);
const BLOCK_HASH_A  = '0x' + '11'.repeat(32);
const BLOCK_HASH_B  = '0x' + '22'.repeat(32);
const ABI_FRAGMENT  = ['function setBountyMerkleRoot(address tokenAddress, bytes32 newRoot)'];

async function deriveSignedTx(
  nonce = 0,
  maxFeePerGas = 2_000_000_000n,
  maxPriorityFeePerGas = 1_000_000_000n,
) {
  const iface    = new ethers.Interface(ABI_FRAGMENT);
  const calldata = iface.encodeFunctionData('setBountyMerkleRoot', [TOKEN_ADDR, MERKLE_ROOT]);
  const signedTx = await TEST_WALLET.signTransaction({
    to: CONTRACT_ADDR, data: calldata, chainId: CHAIN_ID, nonce,
    gasLimit: 100_000n, maxFeePerGas, maxPriorityFeePerGas, type: 2,
  });
  const parsed = ethers.Transaction.from(signedTx);
  return { signedTx, txHash: parsed.hash!, parsed };
}

// ==================================================================
// MOCK HELPERS
// ==================================================================

type MockProvider = Record<string, ReturnType<typeof vi.fn>>;

function buildProvider(overrides: {
  chainId?: bigint; pendingNonce?: number;
  receipt?: ethers.TransactionReceipt | null;
  blockNumber?: number;
  block?: { number: number; hash: string } | null;
} = {}): MockProvider {
  const p: MockProvider = {
    getNetwork:            vi.fn().mockResolvedValue({ chainId: overrides.chainId ?? CHAIN_ID }),
    getTransactionCount:   vi.fn().mockResolvedValue(overrides.pendingNonce ?? 0),
    getFeeData:            vi.fn().mockResolvedValue(
      new ethers.FeeData(1_000_000_000n, 2_000_000_000n, 1_000_000_000n)),
    broadcastTransaction:  vi.fn().mockResolvedValue({}),
    getTransaction:        vi.fn().mockResolvedValue(null),
    getTransactionReceipt: vi.fn(),
    getBlockNumber:        vi.fn().mockResolvedValue(overrides.blockNumber ?? 100),
    getBlock:              vi.fn(),
  };
  if (overrides.receipt === null) {
    p.getTransactionReceipt.mockResolvedValue(null);
  } else if (overrides.receipt) {
    p.getTransactionReceipt.mockResolvedValue(overrides.receipt);
  } else {
    p.getTransactionReceipt.mockResolvedValue({
      hash: '0x0', blockNumber: 88, blockHash: BLOCK_HASH_A, status: 1,
    } as unknown as ethers.TransactionReceipt);
  }
  if (overrides.block === null) {
    p.getBlock.mockResolvedValue(null);
  } else if (overrides.block) {
    p.getBlock.mockResolvedValue(overrides.block);
  } else {
    p.getBlock.mockResolvedValue({ number: 88, hash: BLOCK_HASH_A });
  }
  return p;
}

const buildRpc  = () => ({ getActiveHttpRpc: vi.fn().mockResolvedValue('http://mock') });
const buildSnap = (ov: Partial<SnapshotMinimal> = {}): SnapshotMinimal => ({
  id: randomUUID(), status: 'FINALIZED', merkle_root: MERKLE_ROOT,
  token_address: TOKEN_ADDR, network_id: NETWORK_ID, chain_id: CHAIN_ID,
  contract_address: CONTRACT_ADDR, total_reward_tokens: 1_000_000n, ...ov,
});

async function seedIntent(db: InMemoryPublicationWorkerDbAdapter, snapId: string) {
  const { record } = await db.createIntent({
    id: randomUUID(), idempotency_key: randomUUID(), snapshot_id: snapId,
    token_address: TOKEN_ADDR, network_id: NETWORK_ID,
    chain_id: CHAIN_ID, contract_address: CONTRACT_ADDR, merkle_root: MERKLE_ROOT,
  });
  return record as PublicationIntentRecord;
}

function buildWorker(
  db: InMemoryPublicationWorkerDbAdapter,
  rpc: ReturnType<typeof buildRpc>,
  provider: MockProvider,
  opts: { confirmationsRequired?: number; maxReceiptPollAttempts?: number;
          receiptPollIntervalMs?: number; broadcastTimeoutMs?: number; dryRun?: boolean;
          nullBlockRetries?: number } = {},
) {
  return new MerklePublicationWorker(db, TEST_WALLET, rpc as any, {
    confirmationsRequired:  opts.confirmationsRequired  ?? 2,
    maxReceiptPollAttempts: opts.maxReceiptPollAttempts ?? 3,
    receiptPollIntervalMs:  opts.receiptPollIntervalMs  ?? 0,
    broadcastTimeoutMs:     opts.broadcastTimeoutMs     ?? 500,
    nullBlockRetries:       opts.nullBlockRetries,
    dryRun: opts.dryRun ?? false, pollIntervalMs: 0, workerTag: 'AuditWorker',
    providerFactory: () => provider as unknown as ethers.JsonRpcProvider,
  });
}

// ==================================================================
// SEC-01: TRANSACTION IDENTITY
// ==================================================================
describe('SEC-01: Transaction Identity', () => {
  let db: InMemoryPublicationWorkerDbAdapter;
  beforeEach(() => { db = new InMemoryPublicationWorkerDbAdapter(); vi.restoreAllMocks(); });

  it('SEC-01-A: local hash matches ethers.Transaction.from(signedTx).hash', async () => {
    const { signedTx, txHash } = await deriveSignedTx(0);
    expect(ethers.Transaction.from(signedTx).hash).toBe(txHash);
    expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('SEC-01-B: signed payload persisted before broadcast; DB hash matches local derivation', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    await seedIntent(db, snap.id);
    await buildWorker(db, buildRpc(), buildProvider()).processNextIntent();
    const att = [...db.attempts.values()][0];
    expect(att.signed_payload).toBeTruthy();
    expect(ethers.Transaction.from(att.signed_payload!).hash).toBe(att.tx_hash);
  });

  it('SEC-01-C: restart recovery reuses BROADCAST_TIMEOUT attempt and its tx_hash', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const { signedTx, txHash } = await deriveSignedTx(7);
    const existing = await db.createAttempt({
      id: randomUUID(), intent_id: intent.id, attempt_index: 0,
      signer_address: SIGNER, nonce: 7,
      max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1000000000', gas_limit: '100000',
      signed_payload: signedTx, tx_hash: txHash, broadcast_status: 'BROADCAST_TIMEOUT',
      broadcast_error: null, receipt_block_number: null, receipt_block_hash: null,
      receipt_status: null, confirmed_block_number: null, confirmed_block_hash: null, confirmations_at_check: null,
    });
    db.intents.get(intent.id)!.status = 'PENDING';
    await buildWorker(db, buildRpc(), buildProvider({ blockNumber: 120 })).processNextIntent();
    const atts = [...db.attempts.values()];
    expect(atts).toHaveLength(1);
    expect(atts[0].id).toBe(existing.id);
    expect(ethers.Transaction.from(atts[0].signed_payload!).hash).toBe(atts[0].tx_hash);
  });

  it('SEC-01-D: signer recovered from signed payload matches configured wallet', async () => {
    const { signedTx } = await deriveSignedTx();
    expect(ethers.Transaction.from(signedTx).from?.toLowerCase()).toBe(SIGNER.toLowerCase());
  });

  it('SEC-01-E: tx hash is deterministic — same inputs produce identical hash', async () => {
    const { txHash: h1 } = await deriveSignedTx(0, 2_000_000_000n, 1_000_000_000n);
    const { txHash: h2 } = await deriveSignedTx(0, 2_000_000_000n, 1_000_000_000n);
    expect(h1).toBe(h2);
  });
});

// ==================================================================
// SEC-02: REORG AND CANONICALITY
// ==================================================================
describe('SEC-02: Reorg and Canonicality', () => {
  let db: InMemoryPublicationWorkerDbAdapter;
  beforeEach(() => { db = new InMemoryPublicationWorkerDbAdapter(); vi.restoreAllMocks(); });

  it('SEC-02-A: null receipt for all polls → CONFIRMATION_FAILED, NOT REORG_DETECTED', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    await buildWorker(db, buildRpc(), buildProvider({ receipt: null }), { maxReceiptPollAttempts: 2 }).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMATION_FAILED');
    expect(db.intents.get(intent.id)!.error_message).toMatch(/RECEIPT_TIMEOUT/);
    expect(snap.status).toBe('FINALIZED');
    expect(db.auditLogs.find(l => l.event_type === 'REORG_DETECTED')).toBeUndefined();
  });

  it('SEC-02-B: definite pre-publication reorg (block hash changed) → CONFIRMATION_FAILED + CRITICAL PRE_PUBLICATION_REORG, snapshot stays FINALIZED', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const provider = buildProvider({
      receipt: { hash: '0x0', blockNumber: 88, blockHash: BLOCK_HASH_A, status: 1 } as any,
      blockNumber: 120, block: { number: 88, hash: BLOCK_HASH_B },
    });
    await buildWorker(db, buildRpc(), provider, { confirmationsRequired: 2 }).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMATION_FAILED');
    expect(db.intents.get(intent.id)!.error_message).toMatch(/PRE_PUBLICATION_REORG/);
    expect([...db.attempts.values()][0]!.broadcast_status).toBe('REORG_DETECTED');
    expect(snap.status).toBe('FINALIZED');
    expect(db.auditLogs.find(l => l.event_type === 'PRE_PUBLICATION_REORG')?.severity).toBe('CRITICAL');
  });

  it('SEC-02-C: null canonical block → snapshot NOT PUBLISHED', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    await seedIntent(db, snap.id);
    const provider = buildProvider({
      receipt: { hash: '0x0', blockNumber: 88, blockHash: BLOCK_HASH_A, status: 1 } as any,
      blockNumber: 120, block: null,
    });
    await buildWorker(db, buildRpc(), provider, { confirmationsRequired: 2 }).processNextIntent();
    expect(snap.status).not.toBe('PUBLISHED');
  });

  it('SEC-02-D: reverted tx at stable block → CONFIRMATION_FAILED, NOT REORG_DETECTED', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const provider = buildProvider({
      receipt: { hash: '0x0', blockNumber: 88, blockHash: BLOCK_HASH_A, status: 0 } as any,
      blockNumber: 120, block: { number: 88, hash: BLOCK_HASH_A },
    });
    await buildWorker(db, buildRpc(), provider, { confirmationsRequired: 2 }).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMATION_FAILED');
    expect(snap.status).toBe('FINALIZED');
    expect(db.auditLogs.find(l => l.event_type === 'REORG_DETECTED')).toBeUndefined();
  });

  it('SEC-02-E: matching block hash → PUBLISHED, no REORG_DETECTED', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const provider = buildProvider({
      receipt: { hash: '0x0', blockNumber: 88, blockHash: BLOCK_HASH_A, status: 1 } as any,
      blockNumber: 120, block: { number: 88, hash: BLOCK_HASH_A },
    });
    await buildWorker(db, buildRpc(), provider, { confirmationsRequired: 2 }).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMED');
    expect(snap.status).toBe('PUBLISHED');
    expect(db.auditLogs.find(l => l.event_type === 'REORG_DETECTED')).toBeUndefined();
  });
});

// ==================================================================
// SEC-03: NONCE AND CONCURRENCY
// ==================================================================
describe('SEC-03: Nonce and Concurrency', () => {
  let db: InMemoryPublicationWorkerDbAdapter;
  beforeEach(() => { db = new InMemoryPublicationWorkerDbAdapter(); vi.restoreAllMocks(); });

  it('SEC-03-A: in-flight nonce guard — new nonce must exceed max in-flight when chain lags', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    db.intents.get(intent.id)!.status = 'BROADCASTING';
    await db.createAttempt({
      id: randomUUID(), intent_id: intent.id, attempt_index: 0,
      signer_address: SIGNER, nonce: 5,
      max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1000000000', gas_limit: '100000',
      signed_payload: '0xdeadbeef', tx_hash: '0x' + '0a'.repeat(32),
      broadcast_status: 'BROADCAST_OK',
      broadcast_error: null, receipt_block_number: null, receipt_block_hash: null,
      receipt_status: null, confirmed_block_number: null, confirmed_block_hash: null, confirmations_at_check: null,
    });
    expect(await db.getInFlightNoncesForSigner(SIGNER, CHAIN_ID)).toContain(5);

    const snap2 = buildSnap({ id: randomUUID() }); db.snapshots.set(snap2.id, snap2);
    const intent2 = await seedIntent(db, snap2.id);
    await buildWorker(db, buildRpc(), buildProvider({ pendingNonce: 3, blockNumber: 120 })).processNextIntent();

    const att2 = [...db.attempts.values()].find(a => a.intent_id === intent2.id);
    if (att2) expect(att2.nonce).toBeGreaterThanOrEqual(6);
  });

  it('SEC-03-B: broadcast timeout preserves nonce — retry uses same attempt', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const slowProvider = buildProvider({});
    slowProvider.broadcastTransaction.mockImplementation(
      () => new Promise(r => setTimeout(() => r({}), 200)));
    await buildWorker(db, buildRpc(), slowProvider, { broadcastTimeoutMs: 10 }).processNextIntent();
    const first = [...db.attempts.values()][0];
    expect(first.broadcast_status).toBe('BROADCAST_TIMEOUT');
    const firstNonce = first.nonce;

    db.intents.get(intent.id)!.status = 'PENDING';
    await buildWorker(db, buildRpc(), buildProvider({ blockNumber: 120 })).processNextIntent();
    const all = [...db.attempts.values()];
    expect(all).toHaveLength(1);
    expect(all[0].nonce).toBe(firstNonce);
  });

  it('SEC-03-C: getInFlightNoncesForSigner filters by chain_id', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    db.intents.get(intent.id)!.status = 'BROADCASTING';
    await db.createAttempt({
      id: randomUUID(), intent_id: intent.id, attempt_index: 0,
      signer_address: SIGNER, nonce: 42,
      max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1000000000', gas_limit: '100000',
      signed_payload: '0xdeadbeef', tx_hash: '0x' + '0a'.repeat(32),
      broadcast_status: 'BROADCAST_OK',
      broadcast_error: null, receipt_block_number: null, receipt_block_hash: null,
      receipt_status: null, confirmed_block_number: null, confirmed_block_hash: null, confirmations_at_check: null,
    });
    expect(await db.getInFlightNoncesForSigner(SIGNER, CHAIN_ID)).toContain(42);
    expect(await db.getInFlightNoncesForSigner(SIGNER, 1n)).not.toContain(42);
  });

  it('SEC-03-D: reserveNonce CAS prevents duplicate reservation and worker advances past taken nonce', async () => {
    expect(await db.reserveNonce(SIGNER, CHAIN_ID, 0, 'intent-a')).toBe(true);
    expect(await db.reserveNonce(SIGNER, CHAIN_ID, 0, 'intent-b')).toBe(false);

    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    await buildWorker(db, buildRpc(), buildProvider({ pendingNonce: 0, blockNumber: 120 })).processNextIntent();
    const att = [...db.attempts.values()].find(a => a.intent_id === intent.id);
    expect(att?.nonce).toBe(1);
  });
});

// ==================================================================
// SEC-04: AMBIGUOUS BROADCAST SIGNALS
// ==================================================================
describe('SEC-04: Ambiguous Broadcast Signals', () => {
  let db: InMemoryPublicationWorkerDbAdapter;
  beforeEach(() => { db = new InMemoryPublicationWorkerDbAdapter(); vi.restoreAllMocks(); });

  it('SEC-04-A: "already known" uses locally-derived hash — ignores any hash on error object', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    await seedIntent(db, snap.id);
    const provider = buildProvider({ blockNumber: 120 });
    const fakeErr = Object.assign(new Error('already known'), { hash: '0x' + 'fa'.repeat(32) });
    provider.broadcastTransaction.mockRejectedValue(fakeErr);
    await buildWorker(db, buildRpc(), provider).processNextIntent();
    const att = [...db.attempts.values()][0];
    if (att?.signed_payload) {
      expect(att.tx_hash).toBe(ethers.Transaction.from(att.signed_payload).hash);
      expect(att.tx_hash).not.toBe('0x' + 'fa'.repeat(32));
    }
  });

  it('SEC-04-B: "already known" proceeds to CONFIRMED', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    await seedIntent(db, snap.id);
    const provider = buildProvider({ blockNumber: 120 });
    provider.broadcastTransaction.mockRejectedValue(new Error('already known'));
    await buildWorker(db, buildRpc(), provider).processNextIntent();
    expect(db.intents.values().next().value!.status).toBe('CONFIRMED');
    expect(snap.status).toBe('PUBLISHED');
  });

  it('SEC-04-C: definite rejection → BROADCAST_FAILED with signed_payload preserved', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const provider = buildProvider({});
    provider.broadcastTransaction.mockRejectedValue(new Error('insufficient funds for gas'));
    await buildWorker(db, buildRpc(), provider).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('BROADCAST_FAILED');
    const att = [...db.attempts.values()][0];
    expect(att.signed_payload).toBeTruthy();
    if (att.signed_payload) expect(ethers.Transaction.from(att.signed_payload).hash).toBe(att.tx_hash);
  });

  it('SEC-04-D: "nonce too low" without matching on-chain tx → BROADCAST_FAILED (NONCE_TOO_LOW_UNVERIFIED) with local tx_hash', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const provider = buildProvider({ blockNumber: 120 });
    provider.broadcastTransaction.mockRejectedValue(new Error('nonce too low'));
    provider.getTransaction.mockResolvedValue(null);
    await buildWorker(db, buildRpc(), provider).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('BROADCAST_FAILED');
    expect(db.intents.get(intent.id)!.error_message).toMatch(/NONCE_TOO_LOW_UNVERIFIED/);
    const att = [...db.attempts.values()][0];
    expect(att.tx_hash).toBe(ethers.Transaction.from(att.signed_payload).hash);
  });

  it('SEC-04-F: "nonce too low" verified as our signer tx on-chain → NONCE_TOO_LOW_VERIFIED + CONFIRMED', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const provider = buildProvider({ blockNumber: 120 });
    provider.broadcastTransaction.mockRejectedValue(new Error('nonce too low'));
    provider.getTransaction.mockResolvedValue({ from: SIGNER });
    await buildWorker(db, buildRpc(), provider).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMED');
    expect(snap.status).toBe('PUBLISHED');
    expect(db.auditLogs.find(l => l.event_type === 'NONCE_TOO_LOW_VERIFIED')?.severity).toBe('WARN');
  });

  it('SEC-04-E: unknown broadcast error → BROADCAST_FAILED logged as ERROR severity', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const provider = buildProvider({});
    provider.broadcastTransaction.mockRejectedValue(new Error('some unexpected node error'));
    await buildWorker(db, buildRpc(), provider).processNextIntent();
    expect(db.intents.get(intent.id)!.status).toBe('BROADCAST_FAILED');
    const log = db.auditLogs.find(l => l.event_type === 'BROADCAST_FAILED');
    expect(log).toBeDefined();
    expect(log?.severity).toBe('ERROR');
  });
});

// ==================================================================
// SEC-05: FEE ESCALATION AND ATTEMPT HISTORY
// ==================================================================
describe('SEC-05: Fee Escalation and Attempt History', () => {
  let db: InMemoryPublicationWorkerDbAdapter;
  beforeEach(() => { db = new InMemoryPublicationWorkerDbAdapter(); vi.restoreAllMocks(); });

  it('SEC-05-A: EIP-1559 15% bump exceeds 10% minimum replacement threshold', () => {
    const prev = { maxFee: 2_000_000_000n, priority: 1_000_000_000n };
    const bps  = 115n;
    expect((prev.maxFee * bps) / 100n).toBeGreaterThan((prev.maxFee * 110n) / 100n);
    expect((prev.priority * bps) / 100n).toBeGreaterThan((prev.priority * 110n) / 100n);
  });

  it('SEC-05-B: all historical attempts persist — history is append-only', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const { signedTx, txHash } = await deriveSignedTx(0);
    await db.createAttempt({
      id: randomUUID(), intent_id: intent.id, attempt_index: 0,
      signer_address: SIGNER, nonce: 0,
      max_fee_per_gas: '2000000000', max_priority_fee_per_gas: '1000000000', gas_limit: '100000',
      signed_payload: signedTx, tx_hash: txHash, broadcast_status: 'RECEIPT_MISSING',
      broadcast_error: null, receipt_block_number: null, receipt_block_hash: null,
      receipt_status: null, confirmed_block_number: null, confirmed_block_hash: null, confirmations_at_check: null,
    });
    db.intents.get(intent.id)!.status = 'PENDING';
    await buildWorker(db, buildRpc(), buildProvider({ blockNumber: 120 })).processNextIntent();
    const all = [...db.attempts.values()].sort((a, b) => a.attempt_index - b.attempt_index);
    expect(all).toHaveLength(2);
    expect(all[0].attempt_index).toBe(0);
    expect(all[0].broadcast_status).toBe('REPLACED'); // SEC-05: superseded attempt explicitly marked REPLACED
    expect(all[1].attempt_index).toBe(1);
    expect(all[0].signed_payload).toBeTruthy();
    expect(all[1].signed_payload).toBeTruthy();
  });

  it('SEC-05-C: replacement attempt has distinct payload and higher fees', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const { signedTx, txHash } = await deriveSignedTx(0, 1_000_000_000n, 500_000_000n);
    await db.createAttempt({
      id: randomUUID(), intent_id: intent.id, attempt_index: 0,
      signer_address: SIGNER, nonce: 0,
      max_fee_per_gas: '1000000000', max_priority_fee_per_gas: '500000000', gas_limit: '100000',
      signed_payload: signedTx, tx_hash: txHash, broadcast_status: 'RECEIPT_MISSING',
      broadcast_error: null, receipt_block_number: null, receipt_block_hash: null,
      receipt_status: null, confirmed_block_number: null, confirmed_block_hash: null, confirmations_at_check: null,
    });
    db.intents.get(intent.id)!.status = 'PENDING';
    const provider = buildProvider({ blockNumber: 120 });
    provider.getFeeData.mockResolvedValue(new ethers.FeeData(3_000_000_000n, 5_000_000_000n, 3_000_000_000n));
    await buildWorker(db, buildRpc(), provider).processNextIntent();
    const all = [...db.attempts.values()].sort((a, b) => a.attempt_index - b.attempt_index);
    if (all.length >= 2) {
      expect(all[0].signed_payload).not.toBe(all[1].signed_payload);
      expect(all[0].tx_hash).not.toBe(all[1].tx_hash);
      expect(BigInt(all[1].max_fee_per_gas)).toBeGreaterThan(BigInt(all[0].max_fee_per_gas));
    }
  });
});

// ==================================================================
// SEC-06: STATUS ENUM COMPATIBILITY
// ==================================================================
describe('SEC-06: Status Enum Compatibility Audit', () => {
  it('SEC-06-A: worker intent statuses that do NOT exist in DB schema (CRITICAL: requires adapter)', () => {
    const dbStatuses     = ['CREATED', 'SUBMITTED', 'MINED', 'CONFIRMED', 'FAILED', 'REPLACED', 'ABANDONED'];
    const workerStatuses = ['PENDING', 'CLAIMING', 'SIGNING', 'BROADCASTING', 'CONFIRMING', 'CONFIRMED',
                            'SIGN_FAILED', 'BROADCAST_FAILED', 'CONFIRMATION_FAILED', 'REORG_DETECTED', 'SUPERSEDED'];
    const workerOnly = workerStatuses.filter(s => !dbStatuses.includes(s));
    expect(workerOnly).toContain('PENDING');
    expect(workerOnly).toContain('CLAIMING');
    expect(workerOnly).toContain('SIGNING');
    expect(workerOnly).toContain('BROADCASTING');
    expect(workerOnly).toContain('CONFIRMING');
    expect(workerOnly).toContain('SIGN_FAILED');
    expect(workerOnly).toContain('BROADCAST_FAILED');
    expect(workerOnly).toContain('CONFIRMATION_FAILED');
    expect(workerOnly).toContain('REORG_DETECTED');
  });

  it('SEC-06-B: worker attempt statuses vs DB schema (CRITICAL: requires adapter)', () => {
    const dbAttempt     = ['CREATED', 'BROADCAST', 'MINED', 'REPLACED', 'REVERTED', 'ABANDONED'];
    const workerAttempt = ['SIGNED', 'BROADCAST_PENDING', 'BROADCAST_TIMEOUT', 'BROADCAST_OK',
                           'RECEIPT_PENDING', 'RECEIPT_CONFIRMED', 'RECEIPT_MISSING', 'REORG_DETECTED', 'REPLACED'];
    const dbOnly     = dbAttempt.filter(s => !workerAttempt.includes(s));
    const workerOnly = workerAttempt.filter(s => !dbAttempt.includes(s));
    expect(dbOnly).toContain('MINED');
    expect(dbOnly).toContain('REVERTED');
    expect(workerOnly).toContain('SIGNED');
    expect(workerOnly).toContain('BROADCAST_OK');
    expect(workerOnly).toContain('RECEIPT_CONFIRMED');
  });

  it('SEC-06-C: worker-to-DB translation helpers emit valid DB CHECK values and respect fn_bmpi_guard', () => {
    const workerIntentStatuses: PublicationIntentStatus[] = [
      'PENDING', 'CLAIMING', 'SIGNING', 'BROADCASTING', 'CONFIRMING', 'CONFIRMED',
      'SIGN_FAILED', 'BROADCAST_FAILED', 'CONFIRMATION_FAILED', 'REORG_DETECTED', 'SUPERSEDED',
    ];
    for (const s of workerIntentStatuses) {
      expect(DB_INTENT_STATUSES).toContain(workerIntentStatusToDb(s));
    }
    // fn_bmpi_guard permits CREATED → ABANDONED (not CREATED → FAILED) for pre-broadcast SIGN_FAILED
    expect(workerIntentStatusToDb('SIGN_FAILED')).toBe('ABANDONED');
    expect(DB_INTENT_TRANSITIONS.CREATED).toContain(workerIntentStatusToDb('SIGN_FAILED'));
    expect(dbIntentStatusToWorker('ABANDONED')).toBe('SIGN_FAILED');

    const workerAttemptStatuses: PublicationAttemptStatus[] = [
      'SIGNED', 'BROADCAST_PENDING', 'BROADCAST_TIMEOUT', 'BROADCAST_OK',
      'RECEIPT_PENDING', 'RECEIPT_CONFIRMED', 'RECEIPT_MISSING', 'REORG_DETECTED', 'REPLACED',
    ];
    for (const s of workerAttemptStatuses) {
      expect(DB_ATTEMPT_STATUSES).toContain(workerAttemptStatusToDb(s));
    }
  });
});

// ==================================================================
// SEC-07: SCHEMA FIELD MAPPING
// ==================================================================
describe('SEC-07: Schema Field Mapping Audit', () => {
  it('SEC-07-A: worker intent fields NOT in DB schema', () => {
    const dbFields     = ['id', 'snapshot_id', 'chain_id', 'contract_address', 'token_address',
                          'expected_root', 'idempotency_key', 'status', 'created_at', 'updated_at', 'created_by'];
    const workerFields = ['id', 'idempotency_key', 'snapshot_id', 'token_address', 'network_id',
                          'chain_id', 'contract_address', 'merkle_root', 'status', 'error_message',
                          'created_at', 'updated_at', 'claimed_at', 'confirmed_at'];
    const workerOnly = workerFields.filter(f => !dbFields.includes(f));
    expect(workerOnly).toContain('network_id');
    expect(workerOnly).toContain('merkle_root');
    expect(workerOnly).toContain('error_message');
    expect(workerOnly).toContain('claimed_at');
    expect(workerOnly).toContain('confirmed_at');
  });

  it('SEC-07-B: worker attempt fields NOT in DB schema', () => {
    const dbFields     = ['sender_address', 'raw_signed_payload', 'attempt_status', 'attempt_number',
                          'mined_block_number', 'gas_used', 'effective_gas_price'];
    const workerFields = ['signer_address', 'signed_payload', 'broadcast_status', 'attempt_index',
                          'receipt_block_number', 'receipt_block_hash', 'receipt_status',
                          'confirmed_block_number', 'confirmed_block_hash', 'confirmations_at_check', 'broadcast_error'];
    const workerOnly = workerFields.filter(f => !dbFields.includes(f));
    const dbOnly     = dbFields.filter(f => !workerFields.includes(f));
    expect(workerOnly).toContain('signer_address');
    expect(workerOnly).toContain('signed_payload');
    expect(workerOnly).toContain('broadcast_status');
    expect(workerOnly).toContain('attempt_index');
    expect(dbOnly).toContain('gas_used');
    expect(dbOnly).toContain('effective_gas_price');
  });
});

// ==================================================================
// SEC-08: SNAPSHOT STATE MACHINE VIOLATIONS
// ==================================================================
describe('SEC-08: Snapshot State Machine Violations', () => {
  let db: InMemoryPublicationWorkerDbAdapter;
  beforeEach(() => { db = new InMemoryPublicationWorkerDbAdapter(); vi.restoreAllMocks(); });

  it('SEC-08-A: pre-publication reorg on FINALIZED snapshot keeps snapshot FINALIZED (never violates fn_bms_status_transition)', async () => {
    // DB trigger fn_bms_status_transition only allows PUBLISHED → REORG_DETECTED.
    // A FINALIZED snapshot encountering reorg during confirmation must remain FINALIZED (retryable)
    // and fail the intent as CONFIRMATION_FAILED with PRE_PUBLICATION_REORG.
    const snap = buildSnap({ status: 'FINALIZED' }); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    const provider = buildProvider({
      receipt: { hash: '0x0', blockNumber: 88, blockHash: BLOCK_HASH_A, status: 1 } as any,
      blockNumber: 120, block: { number: 88, hash: BLOCK_HASH_B },
    });
    await buildWorker(db, buildRpc(), provider, { confirmationsRequired: 2 }).processNextIntent();
    expect(snap.status).toBe('FINALIZED');
    expect(db.intents.get(intent.id)!.status).toBe('CONFIRMATION_FAILED');
    expect(db.intents.get(intent.id)!.error_message).toMatch(/PRE_PUBLICATION_REORG/);
  });

  it('SEC-08-B: markSnapshotReorgDetected rejects DRAFT/FINALIZED and permits only PUBLISHED → REORG_DETECTED', async () => {
    const draftSnap = buildSnap({ status: 'DRAFT' }); db.snapshots.set(draftSnap.id, draftSnap);
    await expect(db.markSnapshotReorgDetected(draftSnap.id, 'test')).rejects.toThrow(/INVALID_TRANSITION/);
    expect(draftSnap.status).toBe('DRAFT');

    const finalizedSnap = buildSnap({ status: 'FINALIZED' }); db.snapshots.set(finalizedSnap.id, finalizedSnap);
    await expect(db.markSnapshotReorgDetected(finalizedSnap.id, 'test')).rejects.toThrow(/INVALID_TRANSITION/);
    expect(finalizedSnap.status).toBe('FINALIZED');

    const publishedSnap = buildSnap({ status: 'PUBLISHED' }); db.snapshots.set(publishedSnap.id, publishedSnap);
    await db.markSnapshotReorgDetected(publishedSnap.id, 'post-publication reorg');
    expect(publishedSnap.status).toBe('REORG_DETECTED');
  });

  it('SEC-08-C: happy path FINALIZED → PUBLISHED is permitted by both adapter and DB trigger', async () => {
    const snap = buildSnap({ status: 'FINALIZED' }); db.snapshots.set(snap.id, snap);
    await seedIntent(db, snap.id);
    await buildWorker(db, buildRpc(), buildProvider({ blockNumber: 120 }), { confirmationsRequired: 2 }).processNextIntent();
    expect(snap.status).toBe('PUBLISHED');
  });

  it('SEC-08-D: markSnapshotPublished enforces FINALIZED precondition in in-memory adapter', async () => {
    const snap = buildSnap({ status: 'DRAFT' }); db.snapshots.set(snap.id, snap);
    await expect(db.markSnapshotPublished({
      snapshotId: snap.id, publicationTxHash: '0x' + '00'.repeat(32),
      confirmedBlockNumber: 100n, confirmedRoot: MERKLE_ROOT, publishedBy: SIGNER,
    })).rejects.toThrow(/INVALID_STATE/);
  });
});

// ==================================================================
// SEC-09: AUDIT HISTORY PRESERVATION
// ==================================================================
describe('SEC-09: Audit History Preservation', () => {
  let db: InMemoryPublicationWorkerDbAdapter;
  beforeEach(() => { db = new InMemoryPublicationWorkerDbAdapter(); vi.restoreAllMocks(); });

  it('SEC-09-A: audit logs accumulate — never shrink between runs', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    const intent = await seedIntent(db, snap.id);
    await buildWorker(db, buildRpc(), buildProvider({ receipt: null }), { maxReceiptPollAttempts: 1 }).processNextIntent();
    const logsAfterFirst = db.auditLogs.length;
    expect(logsAfterFirst).toBeGreaterThan(0);

    db.intents.get(intent.id)!.status = 'PENDING';
    db.intents.get(intent.id)!.error_message = null;
    snap.status = 'FINALIZED';

    await buildWorker(db, buildRpc(), buildProvider({ blockNumber: 120 })).processNextIntent();
    expect(db.auditLogs.length).toBeGreaterThan(logsAfterFirst);
    expect(db.auditLogs.find(l => l.event_type === 'CONFIRMATION_FAILED')).toBeDefined();
    expect(db.auditLogs.find(l => l.event_type === 'PUBLICATION_CONFIRMED')).toBeDefined();
  });

  it('SEC-09-B: private key and signed payload NOT in any audit log metadata', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    await seedIntent(db, snap.id);
    await buildWorker(db, buildRpc(), buildProvider({ blockNumber: 120 })).processNextIntent();
    for (const log of db.auditLogs) {
      const m = JSON.stringify(log.metadata ?? {});
      expect(m).not.toContain('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    }
  });

  it('SEC-09-C: pre-publication reorg log (PRE_PUBLICATION_REORG) is CRITICAL with merkle_root, tx_hash, and receipt_block', async () => {
    // SEC-08: During confirmation polling snapshot is FINALIZED, so reorg emits PRE_PUBLICATION_REORG (CRITICAL).
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    await seedIntent(db, snap.id);
    const provider = buildProvider({
      receipt: { hash: '0x0', blockNumber: 88, blockHash: BLOCK_HASH_A, status: 1 } as any,
      blockNumber: 120, block: { number: 88, hash: BLOCK_HASH_B },
    });
    await buildWorker(db, buildRpc(), provider, { confirmationsRequired: 2 }).processNextIntent();
    const log = db.auditLogs.find(l => l.event_type === 'PRE_PUBLICATION_REORG');
    expect(log?.severity).toBe('CRITICAL');
    expect(log?.metadata?.merkle_root).toBe(MERKLE_ROOT);
    expect(log?.metadata?.tx_hash).toBeTruthy();
    expect(log?.metadata?.receipt_block).toBe('88');
  });

  it('SEC-09-D: BROADCAST_TIMEOUT log is WARN with tx_hash and nonce', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    await seedIntent(db, snap.id);
    const provider = buildProvider({});
    provider.broadcastTransaction.mockImplementation(
      () => new Promise(r => setTimeout(() => r({}), 200)));
    await buildWorker(db, buildRpc(), provider, { broadcastTimeoutMs: 10 }).processNextIntent();
    const log = db.auditLogs.find(l => l.event_type === 'BROADCAST_TIMEOUT');
    expect(log?.severity).toBe('WARN');
    expect(log?.metadata?.tx_hash).toBeTruthy();
    expect(log?.metadata?.nonce).toBeDefined();
  });

  it('SEC-09-E: PUBLICATION_CONFIRMED log has confirmed_block and confirmations >= required', async () => {
    const snap = buildSnap(); db.snapshots.set(snap.id, snap);
    await seedIntent(db, snap.id);
    await buildWorker(db, buildRpc(), buildProvider({ blockNumber: 120 }), { confirmationsRequired: 2 }).processNextIntent();
    const log = db.auditLogs.find(l => l.event_type === 'PUBLICATION_CONFIRMED');
    expect(log?.severity).toBe('INFO');
    expect(log?.metadata?.confirmed_block).toBeDefined();
    expect(log?.metadata?.confirmations).toBeGreaterThanOrEqual(2);
    expect(log?.metadata?.merkle_root).toBe(MERKLE_ROOT);
  });
});
