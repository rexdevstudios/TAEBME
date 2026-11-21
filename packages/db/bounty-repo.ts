/**
 * packages/db/bounty-repo.ts
 *
 * Modular Domain Repository for Bounty Campaigns, Claims, Double-Entry Allocation,
 * and Atomic On-Chain Settlement. Extracted from packages/shared/db-pool.ts (Phase AH1).
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import { ethers } from 'ethers';
import type { BountyDbAdapter, BountyClaimItem, SettleClaimResult } from '../launchpad/bounty-escrow';
import type { BountyCampaign, BountyClaim } from '../shared/types/domain';
import type { CampaignType, TrustTier } from '../shared/types/trust';
import { inMemoryKolProfiles } from './kol-repo';

export interface BountyRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool, userIdentifier: string) => Promise<string>;
  isUuid: (val: string | undefined | null) => boolean;
}

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
    rewardPerKol: 1000000000000000000000n,
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
    rewardPerKol: 2500000000000000000000n,
    maxParticipants: 20,
    currentParticipants: 8,
    isActive: true,
  },
];

let registeredDeps: BountyRepoDeps | null = null;

export function registerBountyRepoDeps(deps: BountyRepoDeps): void {
  registeredDeps = deps;
}

export class PostgresBountyDbAdapter implements BountyDbAdapter {
  private readonly deps?: BountyRepoDeps;

  constructor(deps?: BountyRepoDeps) {
    this.deps = deps;
  }

  private resolveDeps(): BountyRepoDeps | null {
    return this.deps || registeredDeps;
  }

  async listCampaigns(launchId?: string): Promise<BountyCampaign[]> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        let query = `SELECT * FROM bounty_campaigns WHERE is_active = true`;
        const params: any[] = [];
        if (launchId && deps.isUuid(launchId)) {
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
            campaignType: (r.campaign_type || 'BOUNTY') as CampaignType,
            minTrustTier: (r.min_trust_tier || 'NEW') as TrustTier,
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
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    const campaignId = deps?.isUuid(campaign.id) ? campaign.id : crypto.randomUUID();
    if (pool && deps) {
      try {
        const creatorUserId = await deps.ensureUserEntity(pool, campaign.creatorId);

        let targetLaunchId = campaign.launchId;
        if (!deps.isUuid(targetLaunchId)) {
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
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps && deps.isUuid(launchId)) {
      try {
        const res = await pool.query(`SELECT contract_address, chain FROM token_launches WHERE id = $1 LIMIT 1`, [
          launchId,
        ]);
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
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps && deps.isUuid(id)) {
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
            campaignType: (r.campaign_type || 'BOUNTY') as CampaignType,
            minTrustTier: (r.min_trust_tier || 'NEW') as TrustTier,
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
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps && deps.isUuid(claimId)) {
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
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps && deps.isUuid(campaignId) && deps.isUuid(kolId)) {
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
    trustTierAtClaim?: TrustTier
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

    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps && deps.isUuid(campaignId) && deps.isUuid(kolId)) {
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
      if (!existingMem.trustTierAtClaim && trustTierAtClaim) {
        existingMem.trustTierAtClaim = trustTierAtClaim;
      }
      return existingMem;
    }

    inMemoryClaims.set(`${campaignId}:${kolId}`, claim);
    return claim;
  }

  async updateClaimStatus(claimId: string, status: 'VERIFIED' | 'REJECTED' | 'CLAIMED'): Promise<void> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps && deps.isUuid(claimId)) {
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
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps && deps.isUuid(campaignId)) {
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
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        let validActorId = actorId;
        if (!deps.isUuid(validActorId)) {
          validActorId = await deps.ensureUserEntity(pool, actorId);
        }
        let validEntityId: string | null = null;
        if (entityId && deps.isUuid(entityId)) {
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
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        let validKolUserId = userId;
        if (!deps.isUuid(validKolUserId)) {
          validKolUserId = await deps.ensureUserEntity(pool, userId);
        }
        const numericAmount = isNaN(Number(amount)) ? '1000.0000' : Math.abs(Number(amount)).toFixed(4);
        const kolDescription = `Bounty Reward Allocation for claim ${claimId}`;
        const kolRef = `${claimId}:kol`;

        await pool.query(
          `INSERT INTO ledger_entries (user_id, amount, currency, type, reference_id, description, created_at)
           SELECT $1::uuid, $2::numeric, $3::varchar, 'BOUNTY_REWARD_ALLOCATED', $4::varchar, $5::text, NOW()
           WHERE NOT EXISTS (
             SELECT 1 FROM ledger_entries WHERE reference_id = $4::varchar
           )`,
          [validKolUserId, numericAmount, currency, kolRef, kolDescription]
        );

        if (creatorId) {
          let validCreatorUserId = creatorId;
          if (!deps.isUuid(validCreatorUserId)) {
            validCreatorUserId = await deps.ensureUserEntity(pool, creatorId);
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

  async settleClaimOnChain(claimId: string, txHash: string, blockNumber?: number): Promise<SettleClaimResult> {
    const lowerTx = txHash.toLowerCase();

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
      const deps = this.resolveDeps();
      const pool = deps?.getDbPool() || null;
      if (pool && deps && deps.isUuid(claimId)) {
        const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
        try {
          if (typeof pool.connect === 'function') {
            await client.query('BEGIN');
          }

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
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
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
        if (campaignId && deps.isUuid(campaignId)) {
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

    const fallbackClaims: BountyClaimItem[] = [];
    for (const claim of inMemoryClaims.values()) {
      if (claim.verificationStatus === 'VERIFIED' || claim.verificationStatus === 'CLAIMED') {
        if (!campaignId || claim.campaignId === campaignId) {
          const camp = inMemoryCampaigns.find((c) => c.id === claim.campaignId);
          const reward = camp ? camp.rewardPerKol : 1000000000000000000000n;
          const kol = inMemoryKolProfiles.get(claim.kolId);
          const wallet =
            kol && ethers.isAddress(kol.userId)
              ? kol.userId
              : ethers.isAddress(claim.kolId)
                ? claim.kolId
                : '0x1111111111111111111111111111111111111111';
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

    if (process.env.NODE_ENV !== 'production') {
      console.warn('[PostgresBountyDbAdapter] getVerifiedClaims: no DB and no in-memory claims. Returning empty list.');
    }
    return [];
  }
}
