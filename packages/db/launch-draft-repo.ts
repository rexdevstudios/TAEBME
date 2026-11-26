/**
 * packages/db/launch-draft-repo.ts
 *
 * Modular Domain Repository for Launchpad Drafts, Token Launches, Whitelists, and DEX Graduation.
 * Extracted from packages/shared/db-pool.ts (Phase AG2) with zero breaking changes via barrel facade.
 */

import crypto from 'crypto';
import type { Pool } from 'pg';
import { ethers } from 'ethers';
import type { LaunchDraftDbAdapter } from '../launchpad/launch-draft-service';
import { normalizeTokenIdentifier } from '../shared/token-identifier';
import { DexPairFactoryService } from '../launchpad/dex-pair-factory';

export interface LaunchDraftRepoDeps {
  getDbPool: () => Pool | null;
  ensureUserEntity: (pool: Pool, userIdentifier: string) => Promise<string>;
  ensureNetworkInPool: (pool: Pool, chainStr: string) => Promise<string>;
  isUuid: (val: string | undefined | null) => boolean;
}

const inMemoryDrafts: any[] = [];

let registeredDeps: LaunchDraftRepoDeps | null = null;

export function registerLaunchDraftRepoDeps(deps: LaunchDraftRepoDeps): void {
  registeredDeps = deps;
}

export class PostgresDraftDbAdapter implements LaunchDraftDbAdapter {
  private readonly deps?: LaunchDraftRepoDeps;

  constructor(deps?: LaunchDraftRepoDeps) {
    this.deps = deps;
  }

  private resolveDeps(): LaunchDraftRepoDeps | null {
    return this.deps || registeredDeps;
  }

  async saveDraft(draft: any): Promise<string> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const draftUuid = deps.isUuid(draft.id) ? draft.id : crypto.randomUUID();
        const creatorUserId = await deps.ensureUserEntity(pool, draft.creatorWallet || draft.creatorId);

        await pool.query(
          "INSERT INTO entities (id, type) VALUES ($1, 'LAUNCH_DRAFT') ON CONFLICT (id) DO NOTHING",
          [draftUuid]
        );

        await pool.query(
          `INSERT INTO launch_drafts (
            id, creator_id, name, ticker, description, image_url,
            launch_mode, target_chain, total_supply, creator_allocation_pct,
            bonding_curve_config, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            updated_at = NOW()`,
          [
            draftUuid,
            creatorUserId,
            draft.name,
            draft.ticker,
            draft.description || '',
            draft.imageUrl || '',
            draft.launchMode || 'BONDING_CURVE',
            draft.targetChain || 'base-mainnet',
            draft.totalSupply?.toString() || '1000000000',
            draft.creatorAllocationPct || 0.0,
            JSON.stringify(draft.bondingCurveConfig || {}),
            draft.status || 'DRAFT',
          ]
        );
        const stored = { ...draft, id: draftUuid };
        inMemoryDrafts.unshift(stored);
        return draftUuid;
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresDraftDbAdapter] DB insert failed, falling back to memory:', err.message);
      }
    }
    inMemoryDrafts.unshift(draft);
    return draft.id;
  }

  async saveWhitelist(launchDraftId: string, merkleRoot: string, maxAllocation: bigint): Promise<void> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        const targetDraftId = deps.isUuid(launchDraftId) ? launchDraftId : undefined;
        if (targetDraftId) {
          await pool.query(
            `INSERT INTO launch_whitelists (launch_draft_id, merkle_root, max_allocation_per_wallet)
             VALUES ($1, $2, $3)`,
            [targetDraftId, merkleRoot, maxAllocation.toString()]
          );
        }
        return;
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresDraftDbAdapter] DB whitelist insert failed, fallback:', err.message);
      }
    }
  }

  async createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [actorId, action, entityId || null, reason || null]
        );
      } catch {
        // Non-blocking for audit log fallback
      }
    }
  }

  async getDrafts(filter?: { creatorId?: string; creatorWallet?: string }): Promise<any[]> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps) {
      try {
        let queryStr = `SELECT * FROM launch_drafts`;
        const params: any[] = [];
        if (filter?.creatorId || filter?.creatorWallet) {
          const userUuid = await deps.ensureUserEntity(pool, filter.creatorWallet || filter.creatorId || '');
          queryStr += ` WHERE creator_id = $1`;
          params.push(userUuid);
        }
        queryStr += ` ORDER BY created_at DESC LIMIT 50`;
        const res = await pool.query(queryStr, params);
        if (res.rows.length > 0) {
          return res.rows.map((r) => ({
            id: r.id,
            draftId: r.id,
            creatorId: r.creator_id,
            name: r.name,
            symbol: r.ticker,
            ticker: r.ticker,
            description: r.description,
            imageUrl: r.image_url,
            mode: r.launch_mode,
            launchMode: r.launch_mode,
            targetChain: r.target_chain,
            totalSupply: r.total_supply,
            status: r.status,
            createdAt: r.created_at,
          }));
        }
        return [];
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }

    if (filter?.creatorId || filter?.creatorWallet) {
      const targetId = filter.creatorId?.toLowerCase();
      const targetWallet = filter.creatorWallet?.toLowerCase();
      return inMemoryDrafts.filter((d) => {
        const draftCreatorId = (d.creatorId || d.actorId || '').toLowerCase();
        const draftCreatorWallet = (d.creatorWallet || '').toLowerCase();
        return (
          (targetId && (draftCreatorId === targetId || draftCreatorWallet === targetId)) ||
          (targetWallet && (draftCreatorWallet === targetWallet || draftCreatorId === targetWallet))
        );
      });
    }

    return inMemoryDrafts;
  }

  clearDrafts(): void {
    inMemoryDrafts.length = 0;
  }

  async getLaunchDraftById(draftId: string): Promise<any | null> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool && deps && deps.isUuid(draftId)) {
      try {
        const res = await pool.query(`SELECT * FROM launch_drafts WHERE id = $1 LIMIT 1`, [draftId]);
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            id: r.id,
            draftId: r.id,
            creatorId: r.creator_id,
            name: r.name,
            symbol: r.ticker,
            ticker: r.ticker,
            description: r.description,
            imageUrl: r.image_url,
            mode: r.launch_mode,
            launchMode: r.launch_mode,
            targetChain: r.target_chain,
            totalSupply: r.total_supply,
            status: r.status,
            createdAt: r.created_at,
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
      }
    }
    return inMemoryDrafts.find((d) => d.id === draftId) || null;
  }

  async getActiveTokenLaunches(): Promise<any[]> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    if (pool) {
      try {
        const queryText = `
          SELECT 
            tl.id as launch_id,
            tl.draft_id,
            tl.contract_address,
            tl.chain,
            tl.current_supply,
            tl.raised_amount,
            tl.graduation_threshold,
            tl.is_graduated,
            tl.dex_pair_address,
            tl.risk_score,
            tl.published_at,
            ld.name,
            ld.ticker,
            ld.description,
            ld.image_url,
            ld.launch_mode,
            w.address as creator_wallet,
            kp.is_verified as creator_kol_verified,
            kp.twitter_handle as creator_kol_handle,
            kp.trust_score as creator_trust_score
          FROM token_launches tl
          JOIN launch_drafts ld ON ld.id = tl.draft_id
          LEFT JOIN users u ON u.id = ld.creator_id
          LEFT JOIN wallets w ON w.user_id = u.id AND w.is_primary = true
          LEFT JOIN kol_profiles kp ON kp.user_id = ld.creator_id
          ORDER BY tl.published_at DESC
          LIMIT 50
        `;
        const res = await pool.query(queryText);
        if (res.rows.length > 0) {
          return res.rows.map((r) => ({
            launchId: r.launch_id,
            draftId: r.draft_id,
            contractAddress: r.contract_address,
            chain: r.chain,
            currentSupply: r.current_supply?.toString() || '1000000000',
            raisedAmount: Number(r.raised_amount || 0),
            graduationThreshold: Number(r.graduation_threshold || 69000),
            isGraduated: Boolean(r.is_graduated),
            dexPairAddress: r.dex_pair_address,
            riskScore: r.risk_score ?? 90,
            publishedAt: r.published_at,
            name: r.name,
            ticker: r.ticker,
            description: r.description,
            imageUrl: r.image_url,
            launchMode: r.launch_mode,
            creatorWallet: r.creator_wallet || '0x000000000000000000000000000000000000dEaD',
            creatorKolVerified: Boolean(r.creator_kol_verified),
            creatorKolHandle: r.creator_kol_handle ? String(r.creator_kol_handle) : null,
            creatorTrustScore:
              r.creator_trust_score !== null && r.creator_trust_score !== undefined
                ? Number(r.creator_trust_score)
                : null,
          }));
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresDraftDbAdapter] getActiveTokenLaunches failed:', err.message);
      }
    }
    return inMemoryDrafts
      .filter((d) => d.status === 'PUBLISHED' || d.status === 'DRAFT_CREATED')
      .map((d, i) => ({
        launchId: d.id,
        draftId: d.id,
        contractAddress: '0x' + (i + 1).toString().padStart(40, '0'),
        chain: d.targetChain || 'base-mainnet',
        currentSupply: d.totalSupply?.toString() || '1000000000',
        raisedAmount: 12500,
        graduationThreshold: 69000,
        isGraduated: false,
        dexPairAddress: null,
        riskScore: 92,
        publishedAt: d.createdAt || new Date(),
        name: d.name,
        ticker: d.ticker,
        description: d.description,
        imageUrl: d.imageUrl,
        launchMode: d.launchMode,
        creatorWallet: d.creatorWallet || '0x000000000000000000000000000000000000dEaD',
      }));
  }

  async getTokenLaunchByAddress(chain: string, address: string): Promise<any | null> {
    const norm = normalizeTokenIdentifier(chain, address);
    const lookupAddress = norm.contractAddress || address;
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;

    if (pool && lookupAddress) {
      try {
        const whereClause = norm.isSolana
          ? `WHERE tl.contract_address = $1`
          : `WHERE LOWER(tl.contract_address) = LOWER($1)`;

        const queryText = `
          SELECT 
            tl.id as launch_id,
            tl.draft_id,
            tl.contract_address,
            tl.chain,
            tl.current_supply,
            tl.raised_amount,
            tl.graduation_threshold,
            tl.is_graduated,
            tl.dex_pair_address,
            tl.risk_score,
            tl.published_at,
            ld.name,
            ld.ticker,
            ld.description,
            ld.image_url,
            ld.launch_mode,
            w.address as creator_wallet
          FROM token_launches tl
          JOIN launch_drafts ld ON ld.id = tl.draft_id
          LEFT JOIN users u ON u.id = ld.creator_id
          LEFT JOIN wallets w ON w.user_id = u.id AND w.is_primary = true
          ${whereClause}
          ORDER BY CASE WHEN LOWER(tl.chain) LIKE '%' || LOWER($2) || '%' THEN 0 ELSE 1 END, tl.published_at DESC
          LIMIT 1
        `;
        const res = await pool.query(queryText, [lookupAddress, norm.chain]);
        if (res.rows.length > 0) {
          const r = res.rows[0];
          return {
            launchId: r.launch_id,
            draftId: r.draft_id,
            contractAddress: r.contract_address,
            chain: r.chain,
            currentSupply: r.current_supply?.toString() || '1000000000',
            raisedAmount: Number(r.raised_amount || 0),
            graduationThreshold: Number(r.graduation_threshold || 69000),
            isGraduated: Boolean(r.is_graduated),
            dexPairAddress: r.dex_pair_address,
            riskScore: r.risk_score ?? 90,
            publishedAt: r.published_at,
            name: r.name,
            ticker: r.ticker,
            description: r.description,
            imageUrl: r.image_url,
            launchMode: r.launch_mode,
            creatorWallet: r.creator_wallet || '0x000000000000000000000000000000000000dEaD',
            source: 'neon_postgres',
          };
        }
      } catch (err: any) {
        if (process.env.NODE_ENV === 'production') throw err;
        console.warn('[PostgresDraftDbAdapter] getTokenLaunchByAddress failed:', err.message);
      }
    }

    const activeLaunches = await this.getActiveTokenLaunches();
    const found = activeLaunches.find((l) => {
      if (!l.contractAddress) return false;
      return norm.isSolana
        ? l.contractAddress === lookupAddress
        : l.contractAddress.toLowerCase() === lookupAddress.toLowerCase();
    });
    if (found) {
      return { ...found, source: 'in_memory' };
    }

    return null;
  }

  async publishLaunchDraft(params: {
    draftId: string;
    contractAddress: string;
    chain: string;
    txHash?: string;
    currentSupply?: string;
    graduationThreshold?: number;
    riskScore?: number;
  }): Promise<{ launchId: string; contractAddress: string }> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    const cleanAddress = ethers.isAddress(params.contractAddress)
      ? ethers.getAddress(params.contractAddress)
      : params.contractAddress;

    if (pool && deps && deps.isUuid(params.draftId)) {
      try {
        const resolvedChain = await deps.ensureNetworkInPool(pool, params.chain || 'base-mainnet');

        const existingLaunch = await pool.query(
          `SELECT id, contract_address FROM token_launches WHERE draft_id = $1 OR contract_address = $2 LIMIT 1`,
          [params.draftId, cleanAddress]
        );

        let launchId: string;
        if (existingLaunch.rows.length > 0) {
          launchId = existingLaunch.rows[0].id;
          await pool.query(
            `UPDATE token_launches 
             SET contract_address = $1, chain = $2, current_supply = COALESCE($3, current_supply)
             WHERE id = $4`,
            [cleanAddress, resolvedChain, params.currentSupply || '1000000000', launchId]
          );
        } else {
          launchId = crypto.randomUUID();
          await pool.query("INSERT INTO entities (id, type) VALUES ($1, 'TOKEN') ON CONFLICT (id) DO NOTHING", [
            launchId,
          ]);
          await pool.query(
            `INSERT INTO token_launches (
              id, draft_id, contract_address, chain, current_supply,
              raised_amount, graduation_threshold, risk_score, published_at
            ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, NOW())`,
            [
              launchId,
              params.draftId,
              cleanAddress,
              resolvedChain,
              params.currentSupply || '1000000000',
              params.graduationThreshold || 69000,
              params.riskScore || 92,
            ]
          );
        }

        await pool.query(`UPDATE launch_drafts SET status = 'PUBLISHED', updated_at = NOW() WHERE id = $1`, [
          params.draftId,
        ]);

        const draftRes = await pool.query(`SELECT creator_id FROM launch_drafts WHERE id = $1 LIMIT 1`, [
          params.draftId,
        ]);
        const creatorId = draftRes.rows[0]?.creator_id;
        if (creatorId) {
          await pool.query(
            `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
             VALUES ($1, 'TOKEN_LAUNCH_PUBLISHED', $2, $3, NOW())`,
            [creatorId, launchId, `Contract: ${cleanAddress}${params.txHash ? ` Tx: ${params.txHash}` : ''}`]
          );
        }

        const memDraft = inMemoryDrafts.find((d) => d.id === params.draftId);
        if (memDraft) {
          memDraft.status = 'PUBLISHED';
          memDraft.contractAddress = cleanAddress;
          memDraft.chain = resolvedChain;
        }

        return { launchId, contractAddress: cleanAddress };
      } catch (err: any) {
        console.error('[PostgresDraftDbAdapter] publishLaunchDraft error:', err?.message || err);
        throw err;
      }
    }

    const memDraft = inMemoryDrafts.find((d) => d.id === params.draftId);
    if (memDraft) {
      memDraft.status = 'PUBLISHED';
      memDraft.contractAddress = cleanAddress;
      memDraft.chain = params.chain;
    }
    return { launchId: params.draftId, contractAddress: cleanAddress };
  }

  async graduateTokenLaunch(params: {
    launchId?: string;
    contractAddress?: string;
    dexPairAddress?: string;
    raisedAmount?: number;
  }): Promise<{
    launchId: string;
    contractAddress: string;
    dexPairAddress: string;
    isGraduated: boolean;
    graduatedAt: Date;
  }> {
    const deps = this.resolveDeps();
    const pool = deps?.getDbPool() || null;
    const cleanAddress =
      params.contractAddress && ethers.isAddress(params.contractAddress)
        ? ethers.getAddress(params.contractAddress)
        : params.contractAddress;

    if (pool && (params.launchId || cleanAddress)) {
      try {
        const queryText = params.launchId
          ? `SELECT tl.id, tl.contract_address, tl.chain, tl.raised_amount, tl.graduation_threshold, tl.is_graduated, tl.dex_pair_address, ld.creator_id, ld.ticker
             FROM token_launches tl
             JOIN launch_drafts ld ON ld.id = tl.draft_id
             WHERE tl.id = $1 LIMIT 1`
          : `SELECT tl.id, tl.contract_address, tl.chain, tl.raised_amount, tl.graduation_threshold, tl.is_graduated, tl.dex_pair_address, ld.creator_id, ld.ticker
             FROM token_launches tl
             JOIN launch_drafts ld ON ld.id = tl.draft_id
             WHERE LOWER(tl.contract_address) = LOWER($1) LIMIT 1`;

        const queryArg = params.launchId || cleanAddress;
        const res = await pool.query(queryText, [queryArg]);

        if (res.rows.length === 0) {
          throw new Error(`TOKEN_LAUNCH_NOT_FOUND: Token launch not found for ${queryArg}`);
        }

        const launch = res.rows[0];
        const launchId = launch.id;
        const contractAddr = launch.contract_address;
        const chain = launch.chain;
        const creatorId = launch.creator_id;
        const ticker = launch.ticker;

        const finalPairAddress =
          params.dexPairAddress && ethers.isAddress(params.dexPairAddress)
            ? ethers.getAddress(params.dexPairAddress)
            : launch.dex_pair_address && ethers.isAddress(launch.dex_pair_address)
              ? ethers.getAddress(launch.dex_pair_address)
              : DexPairFactoryService.deriveDexPairAddress(chain, contractAddr);

        const finalRaisedAmount =
          params.raisedAmount ?? Number(launch.raised_amount || launch.graduation_threshold || 69000);
        const graduatedAt = new Date();

        await pool.query(
          `UPDATE token_launches
           SET is_graduated = TRUE,
               graduated_at = COALESCE(graduated_at, NOW()),
               dex_pair_address = $1,
               raised_amount = GREATEST(raised_amount, $2)
           WHERE id = $3`,
          [finalPairAddress, finalRaisedAmount, launchId]
        );

        if (creatorId) {
          await pool.query(
            `INSERT INTO audit_logs (actor_id, action, entity_id, reason, created_at)
             VALUES ($1, 'TOKEN_GRADUATED_TO_DEX', $2, $3, NOW())`,
            [
              creatorId,
              launchId,
              `Token $${ticker} (${contractAddr}) graduated to DEX. Pair: ${finalPairAddress}, Raised: $${finalRaisedAmount}`,
            ]
          );
        }

        return {
          launchId,
          contractAddress: contractAddr,
          dexPairAddress: finalPairAddress,
          isGraduated: true,
          graduatedAt,
        };
      } catch (err: any) {
        console.error('[PostgresDraftDbAdapter] graduateTokenLaunch error:', err?.message || err);
        throw err;
      }
    }

    const memDraft = inMemoryDrafts.find(
      (d) =>
        (params.launchId && d.id === params.launchId) ||
        (cleanAddress && d.contractAddress?.toLowerCase() === cleanAddress.toLowerCase())
    );
    const pair = params.dexPairAddress || '0x6ad81aa97f7ea92310225fe11a6af51339180460';
    if (memDraft) {
      memDraft.isGraduated = true;
      memDraft.dexPairAddress = pair;
    }
    return {
      launchId: params.launchId || (memDraft ? memDraft.id : 'launch-fallback'),
      contractAddress: cleanAddress || '0x0000000000000000000000000000000000000000',
      dexPairAddress: pair,
      isGraduated: true,
      graduatedAt: new Date(),
    };
  }
}
