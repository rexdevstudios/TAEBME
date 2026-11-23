/**
 * packages/db/gamefi-repo.ts
 *
 * Modular Domain Repository for GameFi Profiles, Quest Idempotency, and NFT Mint Registry.
 * Extracted from packages/shared/db-pool.ts (Phase AD2) with zero breaking changes via barrel facade.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import type {
  UserGameFiProfile,
  QuestCompletion,
  NftItemRecord,
  NftCollectionRecord,
} from '../shared/types/domain';

export interface GameFiRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool, userIdentifier: string) => Promise<string>;
  isUuid: (val: string) => boolean;
}

const inMemoryGameFiProfiles = new Map<string, UserGameFiProfile>();
const inMemoryQuestCompletions: QuestCompletion[] = [];
const inMemoryNftItems: NftItemRecord[] = [];
const inMemoryNftCollections: NftCollectionRecord[] = [];
const inMemorySybilRegistry = new Set<string>();
const inMemoryTradeRegistry = new Set<string>();

let registeredDeps: GameFiRepoDeps | null = null;

export function registerGameFiRepoDeps(deps: GameFiRepoDeps): void {
  registeredDeps = deps;
}

export function resolveQuestDefinitionMetadata(
  questId: string,
  xpGranted: number
): { title: string; description: string; badgeTier: 'BRONZE' | 'SILVER' | 'GOLD' } {
  if (questId.startsWith('daily_checkin:')) {
    const day = questId.slice('daily_checkin:'.length);
    return {
      title: `Daily Check-In (${day} UTC)`,
      description: 'Daily UTC-scoped check-in reward for active RTrader traders.',
      badgeTier: 'BRONZE',
    };
  }
  if (questId === 'connect_siwe') {
    return {
      title: 'Connect SIWE Wallet',
      description: 'Verify non-custodial EIP-4361 Sign-In With Ethereum session.',
      badgeTier: 'BRONZE',
    };
  }
  if (questId === 'verify_sybil') {
    return {
      title: 'Verify Anti-Sybil Identity',
      description: 'Verify KOL profile, World ID, or Web3 Social Passport.',
      badgeTier: 'SILVER',
    };
  }
  if (questId === 'first_trade_or_launch') {
    return {
      title: 'Execute Trade or Token Launch',
      description: 'Execute first trade intent or publish a Bonding Curve token launch.',
      badgeTier: 'GOLD',
    };
  }
  return {
    title: `Quest ${questId}`,
    description: `RTrader GameFi progression quest (${xpGranted} XP).`,
    badgeTier: xpGranted >= 500 ? 'GOLD' : xpGranted >= 250 ? 'SILVER' : 'BRONZE',
  };
}

export class PostgresGameFiDbAdapter {
  private poolOverride?: Pool | null;
  private isExplicitInMemory: boolean = false;
  private readonly deps?: GameFiRepoDeps;

  constructor(poolOverride?: Pool | null, isExplicitInMemory: boolean = false, deps?: GameFiRepoDeps) {
    this.poolOverride = poolOverride;
    this.isExplicitInMemory = isExplicitInMemory;
    this.deps = deps;
  }

  private resolveDeps(): GameFiRepoDeps | null {
    return this.deps || registeredDeps;
  }

  private checkIsUuid(val: string): boolean {
    const deps = this.resolveDeps();
    if (deps) return deps.isUuid(val);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
  }

  setExplicitInMemory(enabled: boolean): void {
    this.isExplicitInMemory = enabled;
  }

  private getPool(): Pool | null {
    if (this.isExplicitInMemory) return null;
    if (this.poolOverride !== undefined) return this.poolOverride;
    const deps = this.resolveDeps();
    if (!deps) return null;
    try {
      return deps.getDbPool();
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
    if (pool) {
      const resolvedUuid = await this.resolveGameFiUserUuid(pool, userId, walletAddress);
      if (resolvedUuid) {
        try {
          const res = await pool.query(
            `SELECT 1 FROM trust_evidence
             WHERE subject_user_id = $1 AND direction = 'POSITIVE'
               AND evidence_type IN ('WORLD_ID_ORB', 'WORLD_ID_DEVICE', 'GITCOIN_PASSPORT')
             LIMIT 1`,
            [resolvedUuid]
          );
          if (res.rows.length > 0) return true;
        } catch {}

        try {
          const kolRes = await pool.query(
            `SELECT 1 FROM kol_profiles WHERE user_id = $1 LIMIT 1`,
            [resolvedUuid]
          );
          if (kolRes.rows.length > 0) return true;
        } catch {}
      }

      if (walletAddress || resolvedUuid) {
        try {
          const nullifierRes = await pool.query(
            `SELECT 1 FROM verified_nullifiers
             WHERE LOWER(signal) = LOWER($1) OR scope_id = $2
             LIMIT 1`,
            [walletAddress || '', resolvedUuid || userId]
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
    if (pool) {
      const resolvedUuid = await this.resolveGameFiUserUuid(pool, userId, walletAddress);
      if (resolvedUuid) {
        try {
          const tradeRes = await pool.query(
            `SELECT 1 FROM trade_intents WHERE user_id = $1 LIMIT 1`,
            [resolvedUuid]
          );
          if (tradeRes.rows.length > 0) return true;
        } catch {}

        try {
          const draftRes = await pool.query(
            `SELECT 1 FROM launch_drafts WHERE user_id = $1 AND status IN ('PUBLISHED', 'LAUNCHED') LIMIT 1`,
            [resolvedUuid]
          );
          if (draftRes.rows.length > 0) return true;
        } catch {}
      }

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

  private async resolveGameFiUserUuid(pool: Pool, userId: string, walletAddress?: string): Promise<string | null> {
    if (this.checkIsUuid(userId)) return userId;
    const lookupKey = walletAddress || userId;
    const deps = this.resolveDeps();
    if (!lookupKey || !deps) return null;
    try {
      return await deps.ensureUserEntity(pool, lookupKey);
    } catch {
      return null;
    }
  }

  async getCompletedQuestIds(userId: string, walletAddress?: string): Promise<string[]> {
    const pool = this.getPool();
    if (pool) {
      try {
        const resolvedUuid = await this.resolveGameFiUserUuid(pool, userId, walletAddress);
        if (resolvedUuid) {
          const res = await pool.query(
            `SELECT quest_id FROM quest_completions WHERE user_id = $1 AND status = 'COMPLETED'`,
            [resolvedUuid]
          );
          return res.rows.map((r: any) => String(r.quest_id));
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }
    return inMemoryQuestCompletions
      .filter((c) => c.userId === userId && c.status === 'COMPLETED')
      .map((c) => c.questId);
  }

  async getUserGameFiProfile(userId: string, walletAddress?: string): Promise<UserGameFiProfile> {
    const pool = this.getPool();
    if (pool) {
      try {
        const resolvedUuid = await this.resolveGameFiUserUuid(pool, userId, walletAddress);
        if (resolvedUuid) {
          const res = await pool.query(
            `SELECT user_id as "userId", xp, level, quests_completed as "questsCompleted", updated_at as "updatedAt"
             FROM user_gamefi_profiles WHERE user_id = $1 LIMIT 1`,
            [resolvedUuid]
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
          return {
            userId: resolvedUuid,
            xp: 0,
            level: 1,
            questsCompleted: 0,
            updatedAt: new Date(),
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
    walletAddress?: string;
    questId: string;
    xpGranted: number;
  }): Promise<{ profile: UserGameFiProfile; completion: QuestCompletion }> {
    const { userId, walletAddress, questId, xpGranted } = params;
    const pool = this.getPool();
    const resolvedUuid = pool ? await this.resolveGameFiUserUuid(pool, userId, walletAddress) : null;

    if (pool && resolvedUuid) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Ensure parent quest_definitions row exists (self-healing for dynamic UTC daily_checkin:YYYY-MM-DD & fresh DBs)
        const questMeta = resolveQuestDefinitionMetadata(questId, xpGranted);
        await client.query(
          `INSERT INTO quest_definitions (id, title, description, xp_reward, badge_tier, is_active)
           VALUES ($1, $2, $3, $4, $5, true)
           ON CONFLICT (id) DO NOTHING`,
          [questId, questMeta.title, questMeta.description, xpGranted, questMeta.badgeTier]
        );

        const completionUuid = crypto.randomUUID();
        const insertRes = await client.query(
          `INSERT INTO quest_completions (id, user_id, quest_id, status, xp_granted, completed_at)
           VALUES ($1, $2, $3, 'COMPLETED', $4, NOW())
           ON CONFLICT (user_id, quest_id) DO NOTHING
           RETURNING id, completed_at`,
          [completionUuid, resolvedUuid, questId, xpGranted]
        );

        if (insertRes.rows.length === 0) {
          await client.query('ROLLBACK');
          throw new Error(`QUEST_ALREADY_COMPLETED: User ${userId} has already completed quest '${questId}'`);
        }

        const completedAt = insertRes.rows[0].completed_at;

        const profileRes = await client.query(
          `INSERT INTO user_gamefi_profiles (user_id, xp, level, quests_completed, updated_at)
           VALUES ($1, $2, 1 + FLOOR($2 / 500), 1, NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             xp = user_gamefi_profiles.xp + EXCLUDED.xp,
             level = 1 + FLOOR((user_gamefi_profiles.xp + EXCLUDED.xp) / 500),
             quests_completed = user_gamefi_profiles.quests_completed + 1,
             updated_at = NOW()
           RETURNING user_id as "userId", xp, level, quests_completed as "questsCompleted", updated_at as "updatedAt"`,
          [resolvedUuid, xpGranted]
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
          userId: resolvedUuid,
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

    const existing = inMemoryQuestCompletions.find(
      (c) => c.userId === userId && c.questId === questId
    );
    if (existing) {
      throw new Error(`QUEST_ALREADY_COMPLETED: User ${userId} has already completed quest '${questId}'`);
    }

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

    if (pool && this.checkIsUuid(item.collectionId)) {
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
        (c) => c.chain === chain && c.name.toLowerCase() === name.toLowerCase() && c.isActive !== false
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
