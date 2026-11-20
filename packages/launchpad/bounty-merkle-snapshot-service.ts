// ============================================================================
// IMMUTABLE MERKLE SNAPSHOT SERVICE (PHASE 3.3C.4)
// ============================================================================
//
// Invariants & Standards:
// 1. Solidity V1 Contract Model: Merkle roots are bound per tokenAddress (BondingCurveLaunchpad.sol:473).
//    All verified bounty claims across campaigns for a single token launch MUST be aggregated into
//    a single cumulative leaf per recipient address: TokenAmount_leaf = SUM(AllocatedAmount).
// 2. Payout Wallet Grouping: Grouping is strictly keyed by normalized claimant wallet address.
//    Multiple claims or KOL profiles sharing the same payout wallet are consolidated into a single leaf.
// 3. Immutability Lockdown: Snapshots in FINALIZED / PUBLISHED state cannot be modified or physically deleted.
// 4. Zero Floating Point: All reward tokens and allocations strictly handled as bigint / uint256.
// 5. Parity & Conservation: Total header tokens == sum(recipient leaf amounts) == sum(allocations).
// 6. Deterministic Merkle Trees: Leaf encoding, canonical ordering, and proof computation 100% compatible
//    with MerkleTreeEngine, OpenZeppelin MerkleProof.sol, and Solidity V1.
// 7. Idempotency & Concurrency: Draft creation and finalization are strictly idempotent and concurrency-safe.
// 8. On-Chain Claim Guard: getSnapshotProof clearly distinguishes off-chain proofs from active on-chain proofs.
// ============================================================================

import { ethers } from 'ethers';
import { randomUUID } from 'crypto';
import { MerkleTreeEngine, UINT256_MAX, EMPTY_MERKLE_ROOT } from './merkle-tree-engine';

export type SnapshotStatus =
  | 'DRAFT'
  | 'FINALIZED'
  | 'PUBLISHED'
  | 'SUPERSEDED'
  | 'REORG_DETECTED'
  | 'ABANDONED';

export type SnapshotType = 'SINGLE_CAMPAIGN' | 'MULTI_CAMPAIGN' | 'AGGREGATED';

export interface BountyMerkleSnapshotRecord {
  id: string;
  launch_id: string;
  campaign_id?: string | null;
  network_id: string;
  chain_id: bigint;
  contract_address: string;
  token_address: string;
  version: number;
  snapshot_type: SnapshotType;
  total_reward_tokens: bigint;
  total_recipients: number;
  total_claims_count: number;
  merkle_root?: string | null;
  tree_depth?: number | null;
  leaf_encoding_version: string;
  tree_algorithm: string;
  pair_hashing_convention: string;
  leaf_sorting_rule: string;
  proof_format_version: string;
  status: SnapshotStatus;
  idempotency_key?: string | null;
  created_by?: string | null;
  published_by?: string | null;
  published_at?: Date | null;
  publication_tx_hash?: string | null;
  confirmed_block_number?: bigint | null;
  confirmed_root?: string | null;
  publication_status?: string | null;
  finality_status?: string | null;
  created_at: Date;
  updated_at: Date;
  finalized_at?: Date | null;
  finalized_by?: string | null;
}

export interface BountyMerkleRecipientRecord {
  id: string;
  snapshot_id: string;
  kol_id: string;
  claimant_wallet_id: string;
  claimant_wallet: string;
  token_amount: bigint;
  leaf_index?: number | null;
  leaf_hash?: string | null;
  merkle_proof?: string[] | null;
  created_at: Date;
}

export interface BountyMerkleAllocationRecord {
  id: string;
  snapshot_id: string;
  launch_id: string;
  campaign_id: string;
  claim_id: string;
  recipient_id: string;
  kol_id: string;
  allocated_amount: bigint;
  created_at: Date;
}

export interface BountyMerkleAuditLogRecord {
  id?: string;
  snapshot_id?: string;
  event_type: string;
  event_source: string;
  old_state?: any;
  new_state?: any;
  metadata?: any;
  severity: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
  created_at?: Date;
}

export interface VerifiedClaimSourceItem {
  claimId: string;
  campaignId: string;
  launchId: string;
  kolId: string;
  claimantWalletId: string;
  claimantWallet: string;
  allocatedAmount: bigint;
  campaignRewardPerKol: bigint;
  verificationStatus: 'VERIFIED' | 'PENDING' | 'REJECTED' | 'CLAIMED';
}

export interface TokenLaunchInfo {
  id: string;
  chainId: bigint;
  networkId: string;
  contractAddress: string;
  tokenAddress: string;
  name?: string;
  symbol?: string;
}

export interface CreateSnapshotDraftParams {
  launchId: string;
  campaignId?: string;
  idempotencyKey?: string;
  createdBy?: string;
}

export interface FinalizeSnapshotParams {
  snapshotId: string;
  finalizedBy?: string;
}

export interface AbandonSnapshotParams {
  snapshotId: string;
  reason: string;
  abandonedBy?: string;
}

export interface FinalizeSnapshotResult {
  snapshot: BountyMerkleSnapshotRecord;
  merkleRoot: string;
  treeDepth: number;
  totalRecipients: number;
  totalRewardTokens: bigint;
  recipients: {
    kolId: string;
    walletAddress: string;
    tokenAmount: bigint;
    leafIndex: number;
    leafHash: string;
    proof: string[];
  }[];
}

export interface SnapshotProofResult {
  merkleRoot: string;
  tokenAddress: string;
  claimantWallet: string;
  tokenAmount: bigint;
  leafIndex: number;
  leafHash: string;
  merkleProof: string[];
  isSnapshotPublished: boolean;
  canClaimOnChain: boolean;
}

export interface GetActiveClaimProofParams {
  tokenAddress: string;
  walletAddress: string;
  chainId?: bigint;
  contractAddress?: string;
  snapshotId?: string;
}

export interface BountyMerkleSnapshotDbAdapter {
  getLaunch(launchId: string): Promise<TokenLaunchInfo | null>;
  getVerifiedClaims(launchId: string, campaignId?: string): Promise<VerifiedClaimSourceItem[]>;
  findSnapshotByIdempotencyKey(key: string): Promise<BountyMerkleSnapshotRecord | null>;
  getActivePublishedSnapshot?(tokenAddress: string, chainId?: bigint, contractAddress?: string): Promise<BountyMerkleSnapshotRecord | null>;
  getLatestSnapshotVersion(chainId: bigint, contractAddress: string, tokenAddress: string, campaignId?: string | null): Promise<number>;
  createDraftSnapshotTransaction(params: {
    snapshot: BountyMerkleSnapshotRecord;
    recipients: BountyMerkleRecipientRecord[];
    allocations: BountyMerkleAllocationRecord[];
    auditLog?: BountyMerkleAuditLogRecord;
  }): Promise<BountyMerkleSnapshotRecord>;
  rollbackDraftSnapshotTransaction?(idempotencyKey?: string | null): Promise<void>;
  getSnapshot(snapshotId: string): Promise<BountyMerkleSnapshotRecord | null>;
  getSnapshotRecipients(snapshotId: string): Promise<BountyMerkleRecipientRecord[]>;
  getSnapshotAllocations(snapshotId: string): Promise<BountyMerkleAllocationRecord[]>;
  finalizeSnapshotTransaction(params: {
    snapshotId: string;
    merkleRoot: string;
    treeDepth: number;
    recipientsWithProofs: {
      id: string;
      leafIndex: number;
      leafHash: string;
      merkleProof: string[];
    }[];
    finalizedBy?: string;
    finalizedAt?: Date;
    auditLog?: BountyMerkleAuditLogRecord;
  }): Promise<BountyMerkleSnapshotRecord>;
  abandonSnapshotTransaction(params: {
    snapshotId: string;
    reason: string;
    abandonedBy?: string;
    auditLog?: BountyMerkleAuditLogRecord;
  }): Promise<BountyMerkleSnapshotRecord>;
  createAuditLog(auditLog: BountyMerkleAuditLogRecord): Promise<void>;
}

// ============================================================================
// CORE SERVICE IMPLEMENTATION
// ============================================================================

export class BountyMerkleSnapshotService {
  constructor(private db: BountyMerkleSnapshotDbAdapter) {}

  /**
   * Creates an atomic, deterministic Merkle snapshot draft from verified bounty claims.
   * Enforces payout wallet cumulative aggregation (Solidity V1 invariant: 1 leaf per payout wallet).
   */
  async createDraftSnapshot(params: CreateSnapshotDraftParams): Promise<{
    snapshot: BountyMerkleSnapshotRecord;
    isExisting: boolean;
  }> {
    if (!params.launchId || typeof params.launchId !== 'string') {
      throw new Error('INVALID_LAUNCH_ID: Launch ID must be a non-empty string');
    }

    // 1. Idempotency check
    if (params.idempotencyKey) {
      const existing = await this.db.findSnapshotByIdempotencyKey(params.idempotencyKey);
      if (existing) {
        return { snapshot: existing, isExisting: true };
      }
    }

    // 2. Fetch token launch metadata
    const launch = await this.db.getLaunch(params.launchId);
    if (!launch) {
      throw new Error(`LAUNCH_NOT_FOUND: Token launch ${params.launchId} does not exist`);
    }

    if (!ethers.isAddress(launch.contractAddress)) {
      throw new Error(`INVALID_CONTRACT_ADDRESS: ${launch.contractAddress} is not a valid EVM address`);
    }
    if (!ethers.isAddress(launch.tokenAddress)) {
      throw new Error(`INVALID_TOKEN_ADDRESS: ${launch.tokenAddress} is not a valid EVM address`);
    }

    const normalizedContractAddress = ethers.getAddress(launch.contractAddress);
    const normalizedTokenAddress = ethers.getAddress(launch.tokenAddress);

    // 3. Gather verified claims
    const claims = await this.db.getVerifiedClaims(params.launchId, params.campaignId);
    if (!claims || claims.length === 0) {
      throw new Error(`NO_VERIFIED_CLAIMS_FOUND: No verified claims available for launch ${params.launchId}`);
    }

    // 4. Validate claim integrity & verify statuses
    const unverifiedClaims = claims.filter((c) => c.verificationStatus !== 'VERIFIED');
    if (unverifiedClaims.length > 0) {
      throw new Error(`UNVERIFIED_CLAIMS_DETECTED: ${unverifiedClaims.length} claims do not have verification_status VERIFIED`);
    }

    // 5. Aggregate claims per payout wallet (Solidity V1 cumulative leaf requirement)
    // Structure: normalizedWallet -> { walletAddress, walletId, primaryKolId, kolIds, totalAmount, claims }
    const recipientMap = new Map<
      string,
      {
        walletAddress: string;
        walletId: string;
        primaryKolId: string;
        kolIds: Set<string>;
        totalAmount: bigint;
        claims: { claimId: string; campaignId: string; kolId: string; amount: bigint }[];
      }
    >();

    const kolToWalletMap = new Map<string, string>();

    for (const claim of claims) {
      if (!ethers.isAddress(claim.claimantWallet)) {
        throw new Error(`INVALID_CLAIMANT_WALLET: Claim ${claim.claimId} has invalid wallet ${claim.claimantWallet}`);
      }
      const normalizedWallet = ethers.getAddress(claim.claimantWallet);

      if (typeof claim.allocatedAmount !== 'bigint' || claim.allocatedAmount <= 0n) {
        throw new Error(`INVALID_ALLOCATION_AMOUNT: Claim ${claim.claimId} allocated amount must be positive bigint`);
      }
      if (claim.allocatedAmount > UINT256_MAX) {
        throw new Error(`UINT256_OVERFLOW: Claim ${claim.claimId} allocated amount exceeds uint256 max`);
      }

      // Parity check with campaign reward_per_kol
      if (claim.allocatedAmount !== claim.campaignRewardPerKol) {
        throw new Error(
          `CAMPAIGN_REWARD_MISMATCH: Claim ${claim.claimId} allocation (${claim.allocatedAmount}) diverges from campaign reward_per_kol (${claim.campaignRewardPerKol})`
        );
      }

      // Assert that a single KOL profile cannot register conflicting payout wallets in the same snapshot
      const existingWalletForKol = kolToWalletMap.get(claim.kolId);
      if (existingWalletForKol && existingWalletForKol !== normalizedWallet) {
        throw new Error(
          `KOL_WALLET_MISMATCH: KOL ${claim.kolId} has conflicting payout wallets (${existingWalletForKol} vs ${normalizedWallet})`
        );
      }
      kolToWalletMap.set(claim.kolId, normalizedWallet);

      const existingRecipient = recipientMap.get(normalizedWallet);
      if (existingRecipient) {
        const newTotal = existingRecipient.totalAmount + claim.allocatedAmount;
        if (newTotal > UINT256_MAX) {
          throw new Error(`UINT256_OVERFLOW: Cumulative total for wallet ${normalizedWallet} exceeds uint256 max`);
        }
        existingRecipient.totalAmount = newTotal;
        existingRecipient.kolIds.add(claim.kolId);
        existingRecipient.claims.push({
          claimId: claim.claimId,
          campaignId: claim.campaignId,
          kolId: claim.kolId,
          amount: claim.allocatedAmount,
        });
      } else {
        recipientMap.set(normalizedWallet, {
          walletAddress: normalizedWallet,
          walletId: claim.claimantWalletId,
          primaryKolId: claim.kolId,
          kolIds: new Set([claim.kolId]),
          totalAmount: claim.allocatedAmount,
          claims: [
            {
              claimId: claim.claimId,
              campaignId: claim.campaignId,
              kolId: claim.kolId,
              amount: claim.allocatedAmount,
            },
          ],
        });
      }
    }

    // 6. Compute totals & version
    let totalRewardTokens = 0n;
    for (const rec of recipientMap.values()) {
      totalRewardTokens += rec.totalAmount;
      if (totalRewardTokens > UINT256_MAX) {
        throw new Error('UINT256_OVERFLOW: Total reward tokens across all recipients exceeds uint256 max');
      }
    }

    const nextVersion = await this.db.getLatestSnapshotVersion(
      launch.chainId,
      normalizedContractAddress,
      normalizedTokenAddress,
      params.campaignId ?? null
    );

    const snapshotId = randomUUID();
    const snapshotType: SnapshotType = params.campaignId ? 'SINGLE_CAMPAIGN' : 'MULTI_CAMPAIGN';

    const snapshotRecord: BountyMerkleSnapshotRecord = {
      id: snapshotId,
      launch_id: params.launchId,
      campaign_id: params.campaignId ?? null,
      network_id: launch.networkId,
      chain_id: launch.chainId,
      contract_address: normalizedContractAddress,
      token_address: normalizedTokenAddress,
      version: nextVersion,
      snapshot_type: snapshotType,
      total_reward_tokens: totalRewardTokens,
      total_recipients: recipientMap.size,
      total_claims_count: claims.length,
      merkle_root: null,
      tree_depth: null,
      leaf_encoding_version: 'EIP712_KECCAK256_V1',
      tree_algorithm: 'STANDARD_COMMUTATIVE_PAIR',
      pair_hashing_convention: 'SORTED_LEAF_ORDER',
      leaf_sorting_rule: 'HEX_STRING_LEXICOGRAPHICAL',
      proof_format_version: 'BYTES32_ARRAY_V1',
      status: 'DRAFT',
      idempotency_key: params.idempotencyKey ?? null,
      created_by: params.createdBy ?? null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    // 7. Prepare child records
    const recipientRecords: BountyMerkleRecipientRecord[] = [];
    const allocationRecords: BountyMerkleAllocationRecord[] = [];

    for (const rec of recipientMap.values()) {
      const recipientId = randomUUID();
      recipientRecords.push({
        id: recipientId,
        snapshot_id: snapshotId,
        kol_id: rec.primaryKolId,
        claimant_wallet_id: rec.walletId,
        claimant_wallet: rec.walletAddress,
        token_amount: rec.totalAmount,
        leaf_index: null,
        leaf_hash: null,
        merkle_proof: null,
        created_at: new Date(),
      });

      for (const c of rec.claims) {
        allocationRecords.push({
          id: randomUUID(),
          snapshot_id: snapshotId,
          launch_id: params.launchId,
          campaign_id: c.campaignId,
          claim_id: c.claimId,
          recipient_id: recipientId,
          kol_id: c.kolId,
          allocated_amount: c.amount,
          created_at: new Date(),
        });
      }
    }

    const auditLog: BountyMerkleAuditLogRecord = {
      snapshot_id: snapshotId,
      event_type: 'SNAPSHOT_DRAFT_CREATED',
      event_source: 'BountyMerkleSnapshotService',
      severity: 'INFO',
      new_state: {
        snapshotId,
        launchId: params.launchId,
        campaignId: params.campaignId ?? null,
        version: nextVersion,
        totalRecipients: recipientRecords.length,
        totalClaimsCount: allocationRecords.length,
        totalRewardTokens: totalRewardTokens.toString(),
      },
    };

    // 8. Commit atomic transaction with concurrency retry for idempotency
    try {
      const saved = await this.db.createDraftSnapshotTransaction({
        snapshot: snapshotRecord,
        recipients: recipientRecords,
        allocations: allocationRecords,
        auditLog,
      });
      return { snapshot: saved, isExisting: false };
    } catch (err: any) {
      if (params.idempotencyKey && (err?.message?.includes('UNIQUE') || err?.message?.includes('idempotency'))) {
        for (let i = 0; i < 10; i++) {
          const existing = await this.db.findSnapshotByIdempotencyKey(params.idempotencyKey);
          if (existing) {
            return { snapshot: existing, isExisting: true };
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      throw err;
    }
  }

  /**
   * Finalizes a snapshot draft: computes deterministic Merkle tree, verifies relational
   * parity constraints, assigns proofs to recipients, and permanently seals the snapshot.
   */
  async finalizeSnapshot(params: FinalizeSnapshotParams): Promise<FinalizeSnapshotResult> {
    if (!params.snapshotId || typeof params.snapshotId !== 'string') {
      throw new Error('INVALID_SNAPSHOT_ID: Snapshot ID must be a non-empty string');
    }

    // 1. Fetch snapshot header
    const snapshot = await this.db.getSnapshot(params.snapshotId);
    if (!snapshot) {
      throw new Error(`SNAPSHOT_NOT_FOUND: Snapshot ${params.snapshotId} does not exist`);
    }

    if (snapshot.status === 'FINALIZED' || snapshot.status === 'PUBLISHED') {
      throw new Error(`SNAPSHOT_ALREADY_FINALIZED: Snapshot ${params.snapshotId} is already in ${snapshot.status} status`);
    }
    if (snapshot.status !== 'DRAFT') {
      throw new Error(`INVALID_STATUS_TRANSITION: Cannot finalize snapshot in status ${snapshot.status}`);
    }

    // 2. Fetch recipients and allocations
    const recipients = await this.db.getSnapshotRecipients(params.snapshotId);
    const allocations = await this.db.getSnapshotAllocations(params.snapshotId);

    // 3. Replicate all checks from SQL trigger fn_bms_finalization_check
    if (recipients.length !== snapshot.total_recipients) {
      throw new Error(
        `RECIPIENT_COUNT_MISMATCH: Header specifies ${snapshot.total_recipients}, actual table contains ${recipients.length}`
      );
    }

    let actualTokenSum = 0n;
    for (const r of recipients) {
      actualTokenSum += r.token_amount;
    }
    if (actualTokenSum !== snapshot.total_reward_tokens) {
      throw new Error(
        `TOTAL_REWARD_TOKENS_MISMATCH: Header specifies ${snapshot.total_reward_tokens}, actual sum of leaves is ${actualTokenSum}`
      );
    }

    if (allocations.length !== snapshot.total_claims_count) {
      throw new Error(
        `CLAIMS_COUNT_MISMATCH: Header specifies ${snapshot.total_claims_count}, actual allocations count is ${allocations.length}`
      );
    }

    // 3.1 Verify recipient wallet match with source claim payout wallet (Scope 1 invariant)
    const recipientMap = new Map<string, BountyMerkleRecipientRecord>();
    for (const r of recipients) {
      recipientMap.set(r.id, r);
    }

    const verifiedClaims = await this.db.getVerifiedClaims(snapshot.launch_id, snapshot.campaign_id ?? undefined);
    const claimMap = new Map(verifiedClaims.map((c) => [c.claimId, c]));

    for (const a of allocations) {
      const r = recipientMap.get(a.recipient_id);
      if (!r) {
        throw new Error(`ALLOCATION_ORPHANED: Allocation ${a.id} references non-existent recipient ${a.recipient_id}`);
      }
      const c = claimMap.get(a.claim_id);
      if (c) {
        // NULL-safe wallet parity: treat empty/null wallet on either side as a distinct value (fail closed).
        const sourceWallet = c.claimantWallet?.trim() ?? '';
        const recipientWallet = r.claimant_wallet?.trim() ?? '';
        if (!sourceWallet) {
          throw new Error(
            `RECIPIENT_WALLET_MISMATCH: Allocation ${a.id} source claim ${a.claim_id} has an empty or null payout wallet — cannot verify recipient wallet parity`
          );
        }
        if (!recipientWallet) {
          throw new Error(
            `RECIPIENT_WALLET_MISMATCH: Allocation ${a.id} recipient leaf ${a.recipient_id} has an empty or null claimant_wallet — cannot verify wallet parity`
          );
        }
        if (sourceWallet.toLowerCase() !== recipientWallet.toLowerCase()) {
          throw new Error(
            `RECIPIENT_WALLET_MISMATCH: Allocation ${a.id} recipient wallet (${recipientWallet}) diverges from source claim payout wallet (${sourceWallet})`
          );
        }
      }
    }

    // 3.2 Check allocation sum parity per recipient leaf
    const allocationSumPerRecipient = new Map<string, bigint>();
    for (const a of allocations) {
      const current = allocationSumPerRecipient.get(a.recipient_id) ?? 0n;
      allocationSumPerRecipient.set(a.recipient_id, current + a.allocated_amount);
    }

    for (const r of recipients) {
      const allocatedSum = allocationSumPerRecipient.get(r.id) ?? 0n;
      if (r.token_amount !== allocatedSum) {
        throw new Error(
          `RECIPIENT_ALLOCATION_MISMATCH: Recipient leaf ${r.id} (${r.claimant_wallet}) token amount ${r.token_amount} diverges from allocation sum ${allocatedSum}`
        );
      }
    }

    // 4. Construct deterministic Merkle tree via MerkleTreeEngine
    const treeClaims = recipients.map((r) => ({
      walletAddress: r.claimant_wallet,
      tokenAmount: r.token_amount,
    }));

    const tree = MerkleTreeEngine.generateTree(treeClaims);
    if (!tree.root || !tree.root.match(/^0x[0-9a-fA-F]{64}$/)) {
      throw new Error(`INVALID_MERKLE_ROOT_GENERATED: Merkle root ${tree.root} is not a valid 32-byte hex`);
    }

    // 5. Calculate leaf index, leaf hash, and Merkle proof for each recipient
    const recipientResults: {
      kolId: string;
      walletAddress: string;
      tokenAmount: bigint;
      leafIndex: number;
      leafHash: string;
      proof: string[];
    }[] = [];

    const recipientsWithProofs = recipients.map((r) => {
      const leafHash = MerkleTreeEngine.hashClaim(r.claimant_wallet, r.token_amount);
      const proof = tree.getProof(r.claimant_wallet, r.token_amount);
      const leafIndex = tree.leaves.indexOf(leafHash);

      if (leafIndex === -1) {
        throw new Error(`CORRUPTED_LEAF_INDEX: Leaf hash ${leafHash} not found in generated tree leaves`);
      }

      // In-memory verification assertion: replicates OpenZeppelin MerkleProof.verify
      const isValid = MerkleTreeEngine.verifyProof(tree.root, leafHash, proof);
      if (!isValid) {
        throw new Error(
          `PROOF_VERIFICATION_FAILED: Generated proof for wallet ${r.claimant_wallet} failed in-memory verification against root ${tree.root}`
        );
      }

      recipientResults.push({
        kolId: r.kol_id,
        walletAddress: r.claimant_wallet,
        tokenAmount: r.token_amount,
        leafIndex,
        leafHash,
        proof,
      });

      return {
        id: r.id,
        leafIndex,
        leafHash,
        merkleProof: proof,
      };
    });

    const auditLog: BountyMerkleAuditLogRecord = {
      snapshot_id: params.snapshotId,
      event_type: 'MERKLE_SNAPSHOT_FINALIZED',
      event_source: 'BountyMerkleSnapshotService',
      severity: 'INFO',
      metadata: {
        snapshotId: params.snapshotId,
        merkleRoot: tree.root,
        treeDepth: tree.depth,
        recipientsCount: recipients.length,
        totalRewardTokens: actualTokenSum.toString(),
        finalizedBy: params.finalizedBy ?? null,
      },
    };

    // 6. Execute atomic finalization transaction
    const finalizedAt = new Date();
    const updatedSnapshot = await this.db.finalizeSnapshotTransaction({
      snapshotId: params.snapshotId,
      merkleRoot: tree.root,
      treeDepth: tree.depth,
      recipientsWithProofs,
      finalizedBy: params.finalizedBy,
      finalizedAt,
      auditLog,
    });

    return {
      snapshot: updatedSnapshot,
      merkleRoot: tree.root,
      treeDepth: tree.depth,
      totalRecipients: recipients.length,
      totalRewardTokens: actualTokenSum,
      recipients: recipientResults,
    };
  }

  /**
   * Abandons an unfinalized snapshot draft (tombstone pattern).
   */
  async abandonSnapshot(params: AbandonSnapshotParams): Promise<BountyMerkleSnapshotRecord> {
    if (!params.snapshotId || typeof params.snapshotId !== 'string') {
      throw new Error('INVALID_SNAPSHOT_ID: Snapshot ID must be a non-empty string');
    }

    const snapshot = await this.db.getSnapshot(params.snapshotId);
    if (!snapshot) {
      throw new Error(`SNAPSHOT_NOT_FOUND: Snapshot ${params.snapshotId} does not exist`);
    }

    if (snapshot.status === 'FINALIZED' || snapshot.status === 'PUBLISHED') {
      throw new Error(`CANNOT_ABANDON_FINALIZED_SNAPSHOT: Snapshot in status ${snapshot.status} cannot be abandoned`);
    }

    const auditLog: BountyMerkleAuditLogRecord = {
      snapshot_id: params.snapshotId,
      event_type: 'SNAPSHOT_ABANDONED',
      event_source: 'BountyMerkleSnapshotService',
      severity: 'WARN',
      metadata: {
        snapshotId: params.snapshotId,
        reason: params.reason,
        abandonedBy: params.abandonedBy ?? null,
      },
    };

    return await this.db.abandonSnapshotTransaction({
      snapshotId: params.snapshotId,
      reason: params.reason,
      abandonedBy: params.abandonedBy,
      auditLog,
    });
  }

  /**
   * Retrieves Merkle proof and leaf claim details for an individual wallet.
   * If options.requirePublished is true, strictly requires the snapshot to be PUBLISHED on-chain.
   */
  async getSnapshotProof(
    snapshotId: string,
    walletAddress: string,
    options?: { requirePublished?: boolean }
  ): Promise<SnapshotProofResult> {
    if (!ethers.isAddress(walletAddress)) {
      throw new Error(`INVALID_WALLET_ADDRESS: ${walletAddress}`);
    }
    const normalizedWallet = ethers.getAddress(walletAddress);

    const snapshot = await this.db.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`SNAPSHOT_NOT_FOUND: Snapshot ${snapshotId} does not exist`);
    }
    if (snapshot.status === 'SUPERSEDED') {
      throw new Error(`SNAPSHOT_SUPERSEDED: Snapshot ${snapshotId} has been superseded by a newer published root on-chain`);
    }
    if (snapshot.status !== 'FINALIZED' && snapshot.status !== 'PUBLISHED') {
      throw new Error(`SNAPSHOT_NOT_READY: Proofs are only available for FINALIZED or PUBLISHED snapshots (current: ${snapshot.status})`);
    }

    if (options?.requirePublished && snapshot.status !== 'PUBLISHED') {
      throw new Error(
        `SNAPSHOT_NOT_PUBLISHED: Snapshot ${snapshotId} is in status ${snapshot.status}. Cannot use proof on-chain until root is mined and confirmed.`
      );
    }

    const recipients = await this.db.getSnapshotRecipients(snapshotId);
    const recipient = recipients.find((r) => r.claimant_wallet.toLowerCase() === normalizedWallet.toLowerCase());

    if (!recipient) {
      throw new Error(`RECIPIENT_NOT_IN_SNAPSHOT: Wallet ${normalizedWallet} is not an allocated recipient in snapshot ${snapshotId}`);
    }

    if (!recipient.leaf_hash || recipient.leaf_index === null || recipient.leaf_index === undefined || !recipient.merkle_proof) {
      throw new Error(`PROOF_NOT_GENERATED: Merkle proof data missing for recipient in snapshot ${snapshotId}`);
    }

    // Verify proof integrity
    const isValid = MerkleTreeEngine.verifyProof(snapshot.merkle_root!, recipient.leaf_hash, recipient.merkle_proof);
    if (!isValid) {
      throw new Error(`CORRUPTED_PROOF: Stored Merkle proof failed verification against snapshot root`);
    }

    const isPublished = snapshot.status === 'PUBLISHED';

    return {
      merkleRoot: snapshot.merkle_root!,
      tokenAddress: snapshot.token_address,
      claimantWallet: normalizedWallet,
      tokenAmount: recipient.token_amount,
      leafIndex: recipient.leaf_index,
      leafHash: recipient.leaf_hash,
      merkleProof: recipient.merkle_proof,
      isSnapshotPublished: isPublished,
      canClaimOnChain: isPublished,
    };
  }

  /**
   * Dedicated helper for retrieving active on-chain claim proofs.
   * Strictly enforces that the snapshot has been published and confirmed on-chain,
   * matches the target token and chain, and has not been superseded by a newer root.
   */
  async getActiveClaimProof(
    paramsOrSnapshotId: string | GetActiveClaimProofParams,
    maybeWalletAddress?: string
  ): Promise<SnapshotProofResult & { isSnapshotPublished: true; canClaimOnChain: true }> {
    let snapshotId: string;
    let walletAddress: string;
    let expectedTokenAddress: string | undefined;
    let expectedChainId: bigint | undefined;
    let expectedContractAddress: string | undefined;

    if (typeof paramsOrSnapshotId === 'string') {
      snapshotId = paramsOrSnapshotId;
      if (!maybeWalletAddress) {
        throw new Error('INVALID_ARGUMENTS: walletAddress must be provided when snapshotId is passed as string');
      }
      walletAddress = maybeWalletAddress;
    } else {
      const params = paramsOrSnapshotId;
      walletAddress = params.walletAddress;
      expectedTokenAddress = params.tokenAddress;
      expectedChainId = params.chainId;
      expectedContractAddress = params.contractAddress;

      if (params.snapshotId) {
        snapshotId = params.snapshotId;
      } else {
        const activeSnap = await this.db.getActivePublishedSnapshot(
          params.tokenAddress,
          params.chainId,
          params.contractAddress
        );
        if (!activeSnap) {
          throw new Error(`NO_ACTIVE_PUBLISHED_SNAPSHOT: No active published Merkle snapshot found for token ${params.tokenAddress}`);
        }
        snapshotId = activeSnap.id;
      }
    }

    const snapshot = await this.db.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`SNAPSHOT_NOT_FOUND: Snapshot ${snapshotId} does not exist`);
    }

    if (snapshot.status === 'SUPERSEDED') {
      throw new Error(`SNAPSHOT_SUPERSEDED: Snapshot ${snapshotId} has been superseded by a newer published root on-chain`);
    }

    if (snapshot.status !== 'PUBLISHED') {
      throw new Error(`SNAPSHOT_NOT_PUBLISHED: Snapshot ${snapshotId} is in status ${snapshot.status}. Only PUBLISHED snapshots can provide active on-chain claim proofs.`);
    }

    if (expectedTokenAddress && snapshot.token_address.toLowerCase() !== expectedTokenAddress.toLowerCase()) {
      throw new Error(`TOKEN_ADDRESS_MISMATCH: Snapshot token ${snapshot.token_address} does not match requested ${expectedTokenAddress}`);
    }

    if (expectedChainId !== undefined && snapshot.chain_id !== expectedChainId) {
      throw new Error(`CHAIN_ID_MISMATCH: Snapshot chainId ${snapshot.chain_id} does not match requested ${expectedChainId}`);
    }

    if (expectedContractAddress && snapshot.contract_address.toLowerCase() !== expectedContractAddress.toLowerCase()) {
      throw new Error(`CONTRACT_ADDRESS_MISMATCH: Snapshot contract ${snapshot.contract_address} does not match requested ${expectedContractAddress}`);
    }

    const proof = await this.getSnapshotProof(snapshotId, walletAddress, { requirePublished: true });
    return {
      ...proof,
      isSnapshotPublished: true,
      canClaimOnChain: true,
    };
  }

  /**
   * B3.1.4.1 / B3.1.4.2 / B3.1.4.3 — Read-only on-chain Merkle root consistency verifier.
   *
   * Calls `bountyMerkleRoots(tokenAddress)` on the BondingCurveLaunchpad contract
   * (a Solidity V1 `view` function — stateMutability: "view", no signing or broadcasting).
   * Compares the on-chain root against the snapshot's finalized merkle_root.
   *
   * Fail-closed: any RPC failure, chain identity mismatch, missing root, stale (zero)
   * root, or root mismatch throws.  Chain identity MUST be checked before the contract call.
   *
   * ─── PROVIDER TRUST BOUNDARY (B3.1.4.3) ─────────────────────────────────────────────
   * `provider.getNetwork().chainId` is a SELF-REPORTED value returned by the JSON-RPC
   * endpoint (`eth_chainId`).  It is NOT cryptographic proof of chain identity:
   *
   *   • A misconfigured or compromised RPC node may return any chainId it chooses.
   *   • The check reduces the attack surface for accidentally pointing at the wrong
   *     chain or for a naïve replay by a provider that does not control the contract.
   *   • It does NOT guarantee that the provider is connected to the canonical chain
   *     (Ethereum PoW forks, shadow forks, and privately-deployed testnets can all
   *     report any chainId).
   *
   * Callers MUST ensure the provider instance is obtained from a trusted, authenticated
   * RPC source (e.g. Alchemy / Infura with API key, internal node, or a provider that
   * has been validated against a pinned genesis hash).  Passing an arbitrary or
   * user-supplied provider to this method without out-of-band validation is insecure.
   * ─────────────────────────────────────────────────────────────────────────────────────
   *
   * @param snapshotId - ID of a FINALIZED or PUBLISHED snapshot
   * @param provider   - trusted provider: must expose call() and getNetwork(); see trust
   *                     boundary note above — provider must come from a trusted source
   * @returns { onChainRoot, snapshotRoot, matched, providerChainId } — all roots as
   *          0x-prefixed 32-byte hex; providerChainId added for auditability
   */
  async verifyOnChainMerkleRootConsistency(
    snapshotId: string,
    provider: {
      call(tx: { to: string; data: string }): Promise<string>;
      getNetwork(): Promise<{ chainId: bigint }>;
    }
  ): Promise<{
    onChainRoot: string;
    snapshotRoot: string;
    matched: boolean;
    tokenAddress: string;
    contractAddress: string;
    chainId: bigint;
    providerChainId: bigint;
  }> {
    // 1. Load snapshot
    const snapshot = await this.db.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`ON_CHAIN_VERIFY_FAIL: Snapshot ${snapshotId} not found`);
    }

    // 2. Require finalized or published — no point checking a DRAFT
    if (snapshot.status !== 'FINALIZED' && snapshot.status !== 'PUBLISHED') {
      throw new Error(
        `ON_CHAIN_VERIFY_FAIL: Snapshot ${snapshotId} is in status ${snapshot.status}. ` +
          `Only FINALIZED or PUBLISHED snapshots can be verified against on-chain root.`
      );
    }

    // 3. Require a merkle_root to be present in DB
    if (!snapshot.merkle_root || snapshot.merkle_root === ethers.ZeroHash) {
      throw new Error(
        `ON_CHAIN_VERIFY_FAIL: Snapshot ${snapshotId} has no finalized merkle_root. Cannot verify consistency.`
      );
    }

    // 4. Validate required scope fields
    const { token_address, contract_address, chain_id } = snapshot;
    if (!ethers.isAddress(token_address)) {
      throw new Error(`ON_CHAIN_VERIFY_FAIL: Snapshot token_address '${token_address}' is not a valid EVM address`);
    }
    if (!ethers.isAddress(contract_address)) {
      throw new Error(`ON_CHAIN_VERIFY_FAIL: Snapshot contract_address '${contract_address}' is not a valid EVM address`);
    }

    // 5. [B3.1.4.2 / B3.1.4.3] Provider chain identity check — BEFORE the contract call.
    //
    //    TRUST BOUNDARY: provider.getNetwork() returns a self-reported chainId from the
    //    JSON-RPC `eth_chainId` call.  This is NOT cryptographic chain authentication.
    //    A compromised or misconfigured provider could return any chainId.  This check
    //    reduces — but does not eliminate — cross-chain confusion and naive replay risk.
    //    The provider MUST be sourced from a trusted, authenticated RPC endpoint by the caller.
    //
    //    Fail closed if getNetwork() throws, returns null/undefined, or mismatches snapshot.chain_id.
    let providerChainId: bigint;
    try {
      const network = await provider.getNetwork();
      providerChainId = BigInt(network.chainId); // throws if null / undefined
    } catch (netErr: any) {
      throw new Error(
        `ON_CHAIN_VERIFY_FAIL: Unable to verify provider chain identity for snapshot ${snapshotId} ` +
          `(expected chainId ${chain_id}): ${netErr?.message ?? String(netErr)}`
      );
    }

    if (providerChainId !== chain_id) {
      throw new Error(
        `ON_CHAIN_CHAIN_MISMATCH: Provider reports chain ${providerChainId} but snapshot ` +
          `${snapshotId} was created on chain ${chain_id}. ` +
          `Refusing to call contract ${contract_address} on the wrong network. ` +
          `Note: provider chainId is self-reported; ensure the provider is from a trusted source.`
      );
    }


    // 6. Encode call to bountyMerkleRoots(address)
    const iface = new ethers.Interface([
      'function bountyMerkleRoots(address tokenAddress) view returns (bytes32)',
    ]);
    const calldata = iface.encodeFunctionData('bountyMerkleRoots', [ethers.getAddress(token_address)]);

    // 7. Call the contract (view — no gas, no signing, no broadcasting)
    let rawResult: string;
    try {
      rawResult = await provider.call({ to: ethers.getAddress(contract_address), data: calldata });
    } catch (rpcErr: any) {
      throw new Error(
        `ON_CHAIN_VERIFY_FAIL: RPC call to bountyMerkleRoots failed on chain ${chain_id} ` +
          `contract ${contract_address}: ${rpcErr?.message ?? String(rpcErr)}`
      );
    }

    // 8. Decode result
    let onChainRoot: string;
    try {
      const decoded = iface.decodeFunctionResult('bountyMerkleRoots', rawResult);
      onChainRoot = decoded[0] as string; // bytes32 → 0x hex string
    } catch (decodeErr: any) {
      throw new Error(
        `ON_CHAIN_VERIFY_FAIL: Failed to decode bountyMerkleRoots result '${rawResult}': ${decodeErr?.message}`
      );
    }

    // 9. Stale / unset root guard — contract returns bytes32(0) if no root set
    if (!onChainRoot || onChainRoot === ethers.ZeroHash) {
      throw new Error(
        `ON_CHAIN_VERIFY_FAIL: Contract ${contract_address} has no on-chain Merkle root set for ` +
          `token ${token_address} on chain ${chain_id}. ` +
          `Snapshot ${snapshotId} root is ${snapshot.merkle_root}. Expected root not published yet.`
      );
    }

    // 10. Normalise and compare
    const snapshotRoot = snapshot.merkle_root.toLowerCase();
    const onChainRootNorm = onChainRoot.toLowerCase();
    const matched = snapshotRoot === onChainRootNorm;

    if (!matched) {
      throw new Error(
        `ON_CHAIN_ROOT_MISMATCH: Snapshot ${snapshotId} root ${snapshotRoot} does not match ` +
          `on-chain root ${onChainRootNorm} for token ${token_address} ` +
          `on chain ${chain_id} contract ${contract_address}. ` +
          `A newer root may have been published, or the snapshot is stale/superseded.`
      );
    }

    return {
      onChainRoot: onChainRootNorm,
      snapshotRoot,
      matched: true,
      tokenAddress: token_address,
      contractAddress: contract_address,
      chainId: chain_id,
      providerChainId,
    };
  }
}



// ============================================================================
// IN-MEMORY MOCK ADAPTER FOR ISOLATED TESTING & UNIT VERIFICATION
// ============================================================================

export class MockBountyMerkleSnapshotDbAdapter implements BountyMerkleSnapshotDbAdapter {
  public launches = new Map<string, TokenLaunchInfo>();
  public claims = new Map<string, VerifiedClaimSourceItem[]>();
  public snapshots = new Map<string, BountyMerkleSnapshotRecord>();
  public recipients = new Map<string, BountyMerkleRecipientRecord[]>();
  public allocations = new Map<string, BountyMerkleAllocationRecord[]>();
  public auditLogs: BountyMerkleAuditLogRecord[] = [];
  public inFlightIdempotencyKeys = new Set<string>();

  async getLaunch(launchId: string): Promise<TokenLaunchInfo | null> {
    return this.launches.get(launchId) ?? null;
  }

  async getVerifiedClaims(launchId: string, campaignId?: string): Promise<VerifiedClaimSourceItem[]> {
    const list = this.claims.get(launchId) ?? [];
    if (campaignId) {
      return list.filter((c) => c.campaignId === campaignId);
    }
    return list;
  }

  async findSnapshotByIdempotencyKey(key: string): Promise<BountyMerkleSnapshotRecord | null> {
    for (const snap of this.snapshots.values()) {
      if (snap.idempotency_key === key) {
        return snap;
      }
    }
    return null;
  }

  async getActivePublishedSnapshot(
    tokenAddress: string,
    chainId?: bigint,
    contractAddress?: string
  ): Promise<BountyMerkleSnapshotRecord | null> {
    const matching: BountyMerkleSnapshotRecord[] = [];
    for (const snap of this.snapshots.values()) {
      if (
        snap.token_address.toLowerCase() === tokenAddress.toLowerCase() &&
        snap.status === 'PUBLISHED'
      ) {
        if (chainId !== undefined && snap.chain_id !== chainId) continue;
        if (contractAddress !== undefined && snap.contract_address.toLowerCase() !== contractAddress.toLowerCase()) continue;
        matching.push(snap);
      }
    }
    if (matching.length === 0) return null;
    matching.sort((a, b) => b.version - a.version);
    return { ...matching[0] };
  }

  async rollbackDraftSnapshotTransaction(idempotencyKey?: string | null): Promise<void> {
    if (idempotencyKey) {
      this.inFlightIdempotencyKeys.delete(idempotencyKey);
      for (const [id, snap] of this.snapshots.entries()) {
        if (snap.idempotency_key === idempotencyKey && snap.status === 'DRAFT') {
          this.snapshots.delete(id);
          this.recipients.delete(id);
          this.allocations.delete(id);
        }
      }
    }
  }

  async getLatestSnapshotVersion(
    chainId: bigint,
    contractAddress: string,
    tokenAddress: string,
    campaignId?: string | null
  ): Promise<number> {
    let maxVer = 0;
    for (const snap of this.snapshots.values()) {
      if (
        snap.chain_id === chainId &&
        snap.contract_address.toLowerCase() === contractAddress.toLowerCase() &&
        snap.token_address.toLowerCase() === tokenAddress.toLowerCase()
      ) {
        if (campaignId !== undefined) {
          if (snap.campaign_id === campaignId && snap.version > maxVer) {
            maxVer = snap.version;
          }
        } else if (snap.version > maxVer) {
          maxVer = snap.version;
        }
      }
    }
    return maxVer + 1;
  }

  async createDraftSnapshotTransaction(params: {
    snapshot: BountyMerkleSnapshotRecord;
    recipients: BountyMerkleRecipientRecord[];
    allocations: BountyMerkleAllocationRecord[];
    auditLog?: BountyMerkleAuditLogRecord;
  }): Promise<BountyMerkleSnapshotRecord> {
    if (params.snapshot.idempotency_key) {
      if (this.inFlightIdempotencyKeys.has(params.snapshot.idempotency_key)) {
        throw new Error(`UNIQUE_VIOLATION: idempotency_key ${params.snapshot.idempotency_key} already exists`);
      }
      this.inFlightIdempotencyKeys.add(params.snapshot.idempotency_key);
      const existing = await this.findSnapshotByIdempotencyKey(params.snapshot.idempotency_key);
      if (existing) {
        throw new Error(`UNIQUE_VIOLATION: idempotency_key ${params.snapshot.idempotency_key} already exists`);
      }
    }

    // Check unique wallet per snapshot constraint (mirroring uq_bmsr_snapshot_wallet)
    const walletSet = new Set<string>();
    for (const r of params.recipients) {
      const w = r.claimant_wallet.toLowerCase();
      if (walletSet.has(w)) {
        throw new Error(`UNIQUE_VIOLATION: Duplicate claimant_wallet ${r.claimant_wallet} in snapshot (uq_bmsr_snapshot_wallet)`);
      }
      walletSet.add(w);
    }

    this.snapshots.set(params.snapshot.id, { ...params.snapshot });
    this.recipients.set(params.snapshot.id, params.recipients.map((r) => ({ ...r })));
    this.allocations.set(params.snapshot.id, params.allocations.map((a) => ({ ...a })));
    if (params.auditLog) {
      this.auditLogs.push(params.auditLog);
    }
    return { ...params.snapshot };
  }

  async getSnapshot(snapshotId: string): Promise<BountyMerkleSnapshotRecord | null> {
    const snap = this.snapshots.get(snapshotId);
    return snap ? { ...snap } : null;
  }

  async getSnapshotRecipients(snapshotId: string): Promise<BountyMerkleRecipientRecord[]> {
    const list = this.recipients.get(snapshotId) ?? [];
    return list.map((r) => ({ ...r }));
  }

  async getSnapshotAllocations(snapshotId: string): Promise<BountyMerkleAllocationRecord[]> {
    const list = this.allocations.get(snapshotId) ?? [];
    return list.map((a) => ({ ...a }));
  }

  async finalizeSnapshotTransaction(params: {
    snapshotId: string;
    merkleRoot: string;
    treeDepth: number;
    recipientsWithProofs: {
      id: string;
      leafIndex: number;
      leafHash: string;
      merkleProof: string[];
    }[];
    finalizedBy?: string;
    finalizedAt?: Date;
    auditLog?: BountyMerkleAuditLogRecord;
  }): Promise<BountyMerkleSnapshotRecord> {
    const snapshot = this.snapshots.get(params.snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot ${params.snapshotId} not found`);
    }

    if (snapshot.status !== 'DRAFT') {
      throw new Error(`INVALID_STATUS_TRANSITION: Cannot finalize snapshot in status ${snapshot.status}`);
    }

    snapshot.status = 'FINALIZED';
    snapshot.merkle_root = params.merkleRoot;
    snapshot.tree_depth = params.treeDepth;
    snapshot.finalized_by = params.finalizedBy ?? null;
    snapshot.finalized_at = params.finalizedAt ?? new Date();
    snapshot.updated_at = new Date();

    const recipientsList = this.recipients.get(params.snapshotId) ?? [];
    const proofMap = new Map(params.recipientsWithProofs.map((p) => [p.id, p]));

    for (const rec of recipientsList) {
      const p = proofMap.get(rec.id);
      if (p) {
        rec.leaf_index = p.leafIndex;
        rec.leaf_hash = p.leafHash;
        rec.merkle_proof = p.merkleProof;
      }
    }

    if (params.auditLog) {
      this.auditLogs.push(params.auditLog);
    }

    return { ...snapshot };
  }

  async abandonSnapshotTransaction(params: {
    snapshotId: string;
    reason: string;
    abandonedBy?: string;
    auditLog?: BountyMerkleAuditLogRecord;
  }): Promise<BountyMerkleSnapshotRecord> {
    const snapshot = this.snapshots.get(params.snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot ${params.snapshotId} not found`);
    }

    if (snapshot.status === 'FINALIZED' || snapshot.status === 'PUBLISHED') {
      throw new Error(`CANNOT_ABANDON_FINALIZED_SNAPSHOT: Snapshot in status ${snapshot.status} cannot be abandoned`);
    }

    snapshot.status = 'ABANDONED';
    snapshot.updated_at = new Date();
    if (params.auditLog) {
      this.auditLogs.push(params.auditLog);
    }
    return { ...snapshot };
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    throw new Error(
      `PHYSICAL_DELETE_PROHIBITED: Physical deletion or truncation is strictly prohibited on table bounty_merkle_snapshots (SQLSTATE 23514)`
    );
  }

  /**
   * Simulates child detail table mutation attempt (mirroring PostgreSQL fn_bms_detail_mutation_guard).
   */
  async mutateRecipients(snapshotId: string, mutator: (list: BountyMerkleRecipientRecord[]) => void): Promise<void> {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) throw new Error(`Snapshot ${snapshotId} not found`);
    if (snap.status !== 'DRAFT') {
      throw new Error(
        `IMMUTABLE_SNAPSHOT_LOCKED: Child detail table bounty_merkle_snapshot_recipients is frozen for snapshot in status ${snap.status} (SQLSTATE 23514)`
      );
    }
    const list = this.recipients.get(snapshotId) ?? [];
    mutator(list);
  }

  /**
   * Simulates child detail table mutation attempt (mirroring PostgreSQL fn_bms_detail_mutation_guard).
   */
  async mutateAllocations(snapshotId: string, mutator: (list: BountyMerkleAllocationRecord[]) => void): Promise<void> {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) throw new Error(`Snapshot ${snapshotId} not found`);
    if (snap.status !== 'DRAFT') {
      throw new Error(
        `IMMUTABLE_SNAPSHOT_LOCKED: Child detail table bounty_merkle_snapshot_allocations is frozen for snapshot in status ${snap.status} (SQLSTATE 23514)`
      );
    }
    const list = this.allocations.get(snapshotId) ?? [];
    mutator(list);
  }

  async createAuditLog(auditLog: BountyMerkleAuditLogRecord): Promise<void> {
    this.auditLogs.push(auditLog);
  }

  async markSnapshotPublished(snapshotId: string, txHash: string): Promise<BountyMerkleSnapshotRecord> {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) throw new Error(`Snapshot ${snapshotId} not found`);
    // Supersede any previously published snapshot for the same contract, token, and chain (matching uq_bms_single_active_published)
    for (const other of this.snapshots.values()) {
      if (
        other.id !== snapshotId &&
        other.contract_address.toLowerCase() === snap.contract_address.toLowerCase() &&
        other.token_address.toLowerCase() === snap.token_address.toLowerCase() &&
        other.chain_id === snap.chain_id &&
        other.status === 'PUBLISHED'
      ) {
        other.status = 'SUPERSEDED';
        other.updated_at = new Date();
      }
    }
    snap.status = 'PUBLISHED';
    snap.publication_tx_hash = txHash;
    snap.published_at = new Date();
    snap.updated_at = new Date();
    return { ...snap };
  }

  async markSnapshotSuperseded(snapshotId: string): Promise<BountyMerkleSnapshotRecord> {
    const snap = this.snapshots.get(snapshotId);
    if (!snap) throw new Error(`Snapshot ${snapshotId} not found`);
    snap.status = 'SUPERSEDED';
    snap.updated_at = new Date();
    return { ...snap };
  }
}
