/**
 * packages/db/kol-repo.ts
 *
 * Modular Domain Repository for KOL Profiles, Twitter Handle Uniqueness Guard (SEC-02),
 * and shared in-memory KOL store. Extracted from packages/shared/db-pool.ts (Phase AF1).
 */

import type { Pool } from 'pg';
import type { KolDbAdapter } from '../social/kol-service';
import type { KolProfile } from '../shared/types/domain';

export interface KolRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool, userIdentifier: string) => Promise<string>;
  isUuid: (val: string | undefined | null) => boolean;
}

export const inMemoryKolProfiles: Map<string, KolProfile> = new Map();

let registeredDeps: KolRepoDeps | null = null;

export function registerKolRepoDeps(deps: KolRepoDeps): void {
  registeredDeps = deps;
}

/**
 * SEC-02: Typed error for twitter_handle uniqueness constraint (PG 23505).
 * Route handlers catch this specifically to return HTTP 409 HANDLE_CONFLICT
 * without leaking raw database error messages or constraint names.
 */
export class HandleConflictError extends Error {
  readonly code = 'HANDLE_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'HandleConflictError';
  }
}

export class PostgresKolDbAdapter implements KolDbAdapter {
  private readonly deps?: KolRepoDeps;

  constructor(deps?: KolRepoDeps) {
    this.deps = deps;
  }

  private resolveDeps(): KolRepoDeps | null {
    return this.deps || registeredDeps;
  }

  async upsertKolProfile(p: Partial<KolProfile> & { userId: string }): Promise<KolProfile> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
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

    if (pool && deps) {
      try {
        const userId = await deps.ensureUserEntity(pool, p.userId);
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
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
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
}
