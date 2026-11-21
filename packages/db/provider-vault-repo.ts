/**
 * packages/db/provider-vault-repo.ts
 *
 * Modular Domain Repository for Multi-Provider BYOK Vault (`user_provider_api_keys`).
 * Supports BANKR, GEMINI, OPENAI with AES-256-GCM, multi-chain scope isolation, and write-only metadata.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import {
  encryptSecret,
  decryptSecret,
  maskApiKey,
  validateChainScope,
  assertChainScopeMatches,
  type ProviderKeyChainScope,
} from '../shared/credential-vault';

export interface UserProviderKeyMeta {
  id: string;
  userId: string;
  provider: string;
  label: string;
  maskedKey: string;
  chainScope: ProviderKeyChainScope;
  isDefault: boolean;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

interface InMemoryProviderKeyRow extends UserProviderKeyMeta {
  encryptedApiKey: string;
  keyIv: string;
  keyTag: string;
}

export interface ProviderVaultRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool, userIdentifier: string) => Promise<string>;
  isUuid: (val: string) => boolean;
  createAuditLog: (actorId: string, action: string, entityId: string, reason: string) => Promise<void>;
}

const inMemoryProviderKeys: InMemoryProviderKeyRow[] = [];

let registeredDeps: ProviderVaultRepoDeps | null = null;

export function registerProviderVaultRepoDeps(deps: ProviderVaultRepoDeps): void {
  registeredDeps = deps;
}

export class PostgresProviderKeyVaultAdapter {
  private static readonly MAX_ACTIVE_KEYS_PER_USER = 50;
  private readonly deps?: ProviderVaultRepoDeps;

  constructor(deps?: ProviderVaultRepoDeps) {
    this.deps = deps;
  }

  private resolveDeps(): ProviderVaultRepoDeps | null {
    return this.deps || registeredDeps;
  }

  async listKeys(userIdentifier: string, provider: string = 'BANKR'): Promise<UserProviderKeyMeta[]> {
    const cleanProvider = (provider || 'BANKR').trim().toUpperCase();
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const userId = await deps.ensureUserEntity(pool, userIdentifier);
        const res = await pool.query(
          `SELECT id, user_id, provider, label, masked_key, chain_scope, is_default, is_active, last_used_at, created_at
           FROM user_provider_api_keys
           WHERE user_id = $1 AND UPPER(provider) = $2 AND is_active = true
           ORDER BY is_default DESC, created_at DESC`,
          [userId, cleanProvider]
        );
        return res.rows.map((r: any) => ({
          id: String(r.id),
          userId: String(r.user_id),
          provider: String(r.provider),
          label: String(r.label),
          maskedKey: String(r.masked_key),
          chainScope: (r.chain_scope || 'all') as ProviderKeyChainScope,
          isDefault: Boolean(r.is_default),
          isActive: Boolean(r.is_active),
          lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        }));
      } catch (err: any) {
        console.warn('[PostgresProviderKeyVaultAdapter] listKeys fallback to memory:', err?.message);
      }
    }

    const normUser = userIdentifier.toLowerCase();
    return inMemoryProviderKeys
      .filter((k) => k.userId === normUser && k.provider === cleanProvider && k.isActive)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
      .map(({ encryptedApiKey: _e, keyIv: _i, keyTag: _t, ...meta }) => meta);
  }

  async addKey(params: {
    userIdentifier: string;
    provider?: string;
    label: string;
    rawApiKey: string;
    chainScope?: string;
    isDefault?: boolean;
    maxAllowed?: number;
  }): Promise<UserProviderKeyMeta> {
    const cleanProvider = (params.provider || 'BANKR').trim().toUpperCase();
    const cleanLabel = (params.label || 'Bankr Key').trim().slice(0, 64);
    if (cleanLabel.length < 2) {
      throw new Error('INVALID_KEY_LABEL: Key label must be at least 2 characters.');
    }
    const effectiveMax = Math.max(
      1,
      Math.min(
        PostgresProviderKeyVaultAdapter.MAX_ACTIVE_KEYS_PER_USER,
        Number(params.maxAllowed ?? 10)
      )
    );
    const chainScope = validateChainScope(params.chainScope);
    const enc = encryptSecret(params.rawApiKey);
    const masked = maskApiKey(params.rawApiKey);

    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const userId = await deps.ensureUserEntity(pool, params.userIdentifier);
        const countRes = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM user_provider_api_keys WHERE user_id = $1 AND UPPER(provider) = $2 AND is_active = true`,
          [userId, cleanProvider]
        );
        const existingCount = Number(countRes.rows[0]?.cnt || 0);
        if (existingCount >= effectiveMax) {
          throw new Error(
            `MAX_KEYS_REACHED: Maximum ${effectiveMax} active API keys allowed for your plan.`
          );
        }

        const shouldBeDefault = Boolean(params.isDefault) || existingCount === 0;
        if (shouldBeDefault) {
          await pool.query(
            `UPDATE user_provider_api_keys SET is_default = false, updated_at = NOW() WHERE user_id = $1 AND UPPER(provider) = $2`,
            [userId, cleanProvider]
          );
        }

        const res = await pool.query(
          `INSERT INTO user_provider_api_keys (
             user_id, provider, label, encrypted_api_key, key_iv, key_tag,
             masked_key, chain_scope, is_default, is_active, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, NOW(), NOW())
           RETURNING id, user_id, provider, label, masked_key, chain_scope, is_default, is_active, last_used_at, created_at`,
          [userId, cleanProvider, cleanLabel, enc.ciphertext, enc.iv, enc.authTag, masked, chainScope, shouldBeDefault]
        );
        const r = res.rows[0];

        await deps
          .createAuditLog(
            userId,
            'BYOK_PROVIDER_KEY_ADDED',
            String(r.id),
            `Added ${cleanProvider} key "${cleanLabel}" (${masked}, scope=${chainScope})`
          )
          .catch(() => {});

        return {
          id: String(r.id),
          userId: String(r.user_id),
          provider: String(r.provider),
          label: String(r.label),
          maskedKey: String(r.masked_key),
          chainScope: (r.chain_scope || 'all') as ProviderKeyChainScope,
          isDefault: Boolean(r.is_default),
          isActive: Boolean(r.is_active),
          lastUsedAt: null,
          createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        };
      } catch (err: any) {
        if (
          err?.message?.startsWith('MAX_KEYS_REACHED') ||
          err?.message?.startsWith('FORBIDDEN_PRIVATE_KEY') ||
          err?.message?.startsWith('INVALID_')
        ) {
          throw err;
        }
        console.warn('[PostgresProviderKeyVaultAdapter] addKey fallback to memory:', err?.message);
      }
    }

    const normUser = params.userIdentifier.toLowerCase();
    const userActive = inMemoryProviderKeys.filter(
      (k) => k.userId === normUser && k.provider === cleanProvider && k.isActive
    );
    if (userActive.length >= effectiveMax) {
      throw new Error(
        `MAX_KEYS_REACHED: Maximum ${effectiveMax} active API keys allowed for your plan.`
      );
    }
    const shouldBeDefault = Boolean(params.isDefault) || userActive.length === 0;
    if (shouldBeDefault) {
      for (const k of userActive) k.isDefault = false;
    }
    const row: InMemoryProviderKeyRow = {
      id: crypto.randomUUID(),
      userId: normUser,
      provider: cleanProvider,
      label: cleanLabel,
      maskedKey: masked,
      chainScope,
      isDefault: shouldBeDefault,
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
      encryptedApiKey: enc.ciphertext,
      keyIv: enc.iv,
      keyTag: enc.authTag,
    };
    inMemoryProviderKeys.unshift(row);
    const { encryptedApiKey: _e, keyIv: _i, keyTag: _t, ...meta } = row;
    return meta;
  }

  async setDefaultKey(userIdentifier: string, keyId: string, provider: string = 'BANKR'): Promise<boolean> {
    const cleanProvider = (provider || 'BANKR').trim().toUpperCase();
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps && deps.isUuid(keyId)) {
      try {
        const userId = await deps.ensureUserEntity(pool, userIdentifier);
        const check = await pool.query(
          `SELECT id FROM user_provider_api_keys WHERE id = $1 AND user_id = $2 AND UPPER(provider) = $3 AND is_active = true LIMIT 1`,
          [keyId, userId, cleanProvider]
        );
        if (check.rows.length === 0) return false;

        await pool.query(
          `UPDATE user_provider_api_keys SET is_default = (id = $1), updated_at = NOW() WHERE user_id = $2 AND UPPER(provider) = $3 AND is_active = true`,
          [keyId, userId, cleanProvider]
        );
        return true;
      } catch (err: any) {
        console.warn('[PostgresProviderKeyVaultAdapter] setDefaultKey fallback to memory:', err?.message);
      }
    }

    const normUser = userIdentifier.toLowerCase();
    const target = inMemoryProviderKeys.find(
      (k) => k.id === keyId && k.userId === normUser && k.provider === cleanProvider && k.isActive
    );
    if (!target) return false;
    for (const k of inMemoryProviderKeys) {
      if (k.userId === normUser && k.provider === cleanProvider) {
        k.isDefault = k.id === keyId;
      }
    }
    return true;
  }

  async revokeKey(userIdentifier: string, keyId: string): Promise<boolean> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps && deps.isUuid(keyId)) {
      try {
        const userId = await deps.ensureUserEntity(pool, userIdentifier);
        const res = await pool.query(
          `UPDATE user_provider_api_keys
           SET is_active = false, is_default = false, updated_at = NOW()
           WHERE id = $1 AND user_id = $2 AND is_active = true
           RETURNING id, label, masked_key`,
          [keyId, userId]
        );
        if (res.rows.length === 0) return false;

        await deps
          .createAuditLog(
            userId,
            'BYOK_PROVIDER_KEY_REVOKED',
            keyId,
            `Revoked key "${res.rows[0].label}" (${res.rows[0].masked_key})`
          )
          .catch(() => {});
        return true;
      } catch (err: any) {
        console.warn('[PostgresProviderKeyVaultAdapter] revokeKey fallback to memory:', err?.message);
      }
    }

    const normUser = userIdentifier.toLowerCase();
    const target = inMemoryProviderKeys.find((k) => k.id === keyId && k.userId === normUser && k.isActive);
    if (!target) return false;
    target.isActive = false;
    target.isDefault = false;
    return true;
  }

  async resolveDecryptedKeyForDeploy(params: {
    userIdentifier: string;
    targetChain: string;
    keyId?: string;
    provider?: string;
  }): Promise<{ apiKey: string; keyId: string; label: string; maskedKey: string; chainScope: ProviderKeyChainScope } | null> {
    const cleanProvider = (params.provider || 'BANKR').trim().toUpperCase();
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const userId = await deps.ensureUserEntity(pool, params.userIdentifier);
        const query = params.keyId
          ? `SELECT id, label, encrypted_api_key, key_iv, key_tag, masked_key, chain_scope
             FROM user_provider_api_keys
             WHERE id = $1 AND user_id = $2 AND UPPER(provider) = $3 AND is_active = true
             LIMIT 1`
          : `SELECT id, label, encrypted_api_key, key_iv, key_tag, masked_key, chain_scope
             FROM user_provider_api_keys
             WHERE user_id = $1 AND UPPER(provider) = $2 AND is_active = true AND is_default = true
             ORDER BY updated_at DESC
             LIMIT 1`;
        const qParams = params.keyId ? [params.keyId, userId, cleanProvider] : [userId, cleanProvider];
        const res = await pool.query(query, qParams);

        if (res.rows.length === 0) {
          if (params.keyId) {
            throw new Error('BYOK_KEY_NOT_FOUND_OR_FORBIDDEN: Selected API key does not belong to your account or was revoked.');
          }
          return null;
        }

        const r = res.rows[0];
        assertChainScopeMatches(r.chain_scope || 'all', params.targetChain);
        const decrypted = decryptSecret({
          ciphertext: r.encrypted_api_key,
          iv: r.key_iv,
          authTag: r.key_tag,
        });

        await pool
          .query(`UPDATE user_provider_api_keys SET last_used_at = NOW() WHERE id = $1`, [r.id])
          .catch(() => {});

        return {
          apiKey: decrypted,
          keyId: String(r.id),
          label: String(r.label),
          maskedKey: String(r.masked_key),
          chainScope: (r.chain_scope || 'all') as ProviderKeyChainScope,
        };
      } catch (err: any) {
        if (
          err?.message?.startsWith('BYOK_KEY_NOT_FOUND') ||
          err?.message?.startsWith('CHAIN_SCOPE_MISMATCH') ||
          err?.message?.startsWith('VAULT_DECRYPT_TAMPERED')
        ) {
          throw err;
        }
        console.warn('[PostgresProviderKeyVaultAdapter] resolveDecryptedKeyForDeploy fallback to memory:', err?.message);
      }
    }

    const normUser = params.userIdentifier.toLowerCase();
    const row = params.keyId
      ? inMemoryProviderKeys.find(
          (k) => k.id === params.keyId && k.userId === normUser && k.provider === cleanProvider && k.isActive
        )
      : inMemoryProviderKeys.find(
          (k) => k.userId === normUser && k.provider === cleanProvider && k.isActive && k.isDefault
        );

    if (!row) {
      if (params.keyId) {
        throw new Error('BYOK_KEY_NOT_FOUND_OR_FORBIDDEN: Selected API key does not belong to your account or was revoked.');
      }
      return null;
    }

    assertChainScopeMatches(row.chainScope, params.targetChain);
    const decrypted = decryptSecret({
      ciphertext: row.encryptedApiKey,
      iv: row.keyIv,
      authTag: row.keyTag,
    });
    row.lastUsedAt = new Date().toISOString();

    return {
      apiKey: decrypted,
      keyId: row.id,
      label: row.label,
      maskedKey: row.maskedKey,
      chainScope: row.chainScope,
    };
  }
}
