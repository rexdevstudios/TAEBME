// ============================================================================
// ON-CHAIN SYBIL RESISTANCE SERVICE (GITCOIN PASSPORT & WORLD ID ZK-PROOF)
// ============================================================================
//
// Phase 1 security fix: World ID nullifier registry is now DB-persisted via
// TrustEvidenceService.registerNullifier() / isNullifierUsed().
//
// The in-memory registeredNullifiers Map is retained ONLY for:
//   1. Unit testing isolation (resetNullifiers())
//   2. Backward compatibility with existing sync verifyWorldIdProof() call sites
//
// CANONICAL USAGE:
//   - Use verifyWorldIdProofPersisted() in all production code paths.
//   - verifyWorldIdProof() is retained for backward compatibility but MUST
//     NOT be used as the sole anti-replay gate in production.
//   - Anti-replay MUST be enforced by DB (verified_nullifiers) to survive restart.
//
// INVARIANT:
//   Same valid nullifier CANNOT be accepted twice within the same scope
//   (scope_type='CAMPAIGN', scope_id=campaignId).
//   This invariant MUST survive process and server restart.
// ============================================================================

import { ethers } from 'ethers';
import { WorldIdProofPayload } from '../shared/types/domain';
import { TrustEvidenceService } from './trust-evidence-service';
import { GitcoinScorerClient, RealGitcoinScorerClient } from './gitcoin-scorer';
import { WorldIdVerifier, RealWorldIdVerifier } from './world-id-verifier';

export interface GitcoinPassportVerificationResult {
  walletAddress: string;
  humanityScore: number; // 0 - 100
  passedThreshold: boolean;
  stampsVerified: string[];
}

export interface WorldIdVerificationResult {
  isValid: boolean;
  nullifierHash: string;
  credentialType: 'orb' | 'phone';
  campaignId: string;
  reason?: string;
}

export class SybilResistanceService {
  public static readonly DEFAULT_GITCOIN_THRESHOLD = 20.0; // Standard Gitcoin Passport passing threshold

  /**
   * In-memory nullifier registry — retained for unit test isolation ONLY.
   * NOT used as anti-replay gate in production code paths.
   * Production MUST use verifyWorldIdProofPersisted() with DB-backed persistence.
   */
  private static registeredNullifiers: Map<string, Set<string>> = new Map();

  /**
   * [PRODUCTION] Verifies Gitcoin Passport Humanity Score via real Gitcoin Scorer v2 API.
   * Fails closed if API is unconfigured in production or unreachable.
   */
  static async verifyGitcoinPassportLive(
    walletAddress: string,
    minScore: number = SybilResistanceService.DEFAULT_GITCOIN_THRESHOLD,
    scorerClient?: GitcoinScorerClient
  ): Promise<GitcoinPassportVerificationResult> {
    if (!ethers.isAddress(walletAddress)) {
      throw new Error(`INVALID_WALLET_ADDRESS: ${walletAddress}`);
    }

    const client = scorerClient || new RealGitcoinScorerClient();
    const res = await client.getScore(ethers.getAddress(walletAddress));
    const passedThreshold = res.score >= minScore;

    return {
      walletAddress: ethers.getAddress(walletAddress),
      humanityScore: res.score,
      passedThreshold,
      stampsVerified: res.evidence ? Object.keys(res.evidence) : [],
    };
  }

  /**
   * Evaluates Gitcoin Passport Humanity Score based on Web3 stamp proofs.
   * Retained for backward compatibility and offline simulation scripts.
   * In production, verifyGitcoinPassportLive() must be used.
   */
  static verifyGitcoinPassport(
    walletAddress: string,
    minScore: number = SybilResistanceService.DEFAULT_GITCOIN_THRESHOLD,
    simulatedStamps?: string[]
  ): GitcoinPassportVerificationResult {
    if (!ethers.isAddress(walletAddress)) {
      throw new Error(`INVALID_WALLET_ADDRESS: ${walletAddress}`);
    }

    if (!simulatedStamps || simulatedStamps.length === 0) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('FATAL_SECURITY_ERROR: Default simulated Gitcoin Passport stamps are strictly disallowed in production. Use verifyGitcoinPassportLive()');
      }
      return {
        walletAddress: ethers.getAddress(walletAddress),
        humanityScore: 0,
        passedThreshold: false,
        stampsVerified: [],
      };
    }

    const stamps = simulatedStamps;
    let humanityScore = 0;

    // Bobot stamp reputasi kemanusiaan
    if (stamps.includes('ens')) humanityScore += 7.5;
    if (stamps.includes('twitter')) humanityScore += 6.5;
    if (stamps.includes('github')) humanityScore += 8.0;
    if (stamps.includes('civic')) humanityScore += 10.0;
    if (stamps.includes('brightid')) humanityScore += 12.0;

    const normalizedScore = Number(Math.min(100, humanityScore).toFixed(1));
    const passedThreshold = normalizedScore >= minScore;

    return {
      walletAddress: ethers.getAddress(walletAddress),
      humanityScore: normalizedScore,
      passedThreshold,
      stampsVerified: stamps,
    };
  }

  /**
   * [PRODUCTION] Verifies World ID proof with persistent DB-backed anti-replay AND cryptographic proof verification.
   *
   * Invariants enforced:
   *   - Cryptographic ZK-SNARK proof is verified against World ID Developer API
   *   - Same nullifier within same campaign scope is rejected (survives restart)
   *   - Concurrent duplicate submissions: only first succeeds (UNIQUE constraint)
   *   - Invalid proof fields: rejected before DB interaction
   *   - Successful verification records WORLD_ID_VERIFIED trust evidence when subjectUserId is supplied
   *
   * @param payload - World ID proof payload from client
   * @param campaignId - Campaign UUID (defines anti-replay scope)
   * @param trustService - TrustEvidenceService instance with DB pool
   * @param verifier - Optional WorldIdVerifier for test injection
   * @param subjectUserId - Optional user ID for trust evidence ledger recording
   * @returns WorldIdVerificationResult with isValid and reason
   */
  static async verifyWorldIdProofPersisted(
    payload: WorldIdProofPayload,
    campaignId: string,
    trustService: TrustEvidenceService,
    verifier?: WorldIdVerifier,
    subjectUserId?: string
  ): Promise<WorldIdVerificationResult> {
    // Structural validation — reject before any DB interaction
    if (!payload.merkleRoot || !payload.nullifierHash || !payload.proof) {
      return {
        isValid: false,
        nullifierHash: payload.nullifierHash || '',
        credentialType: payload.credentialType || 'orb',
        campaignId,
        reason: 'INVALID_PROOF_PAYLOAD: Missing required ZK-SNARK proof fields',
      };
    }

    // Validate 32-byte hex nullifier format
    if (!ethers.isHexString(payload.nullifierHash, 32)) {
      return {
        isValid: false,
        nullifierHash: payload.nullifierHash,
        credentialType: payload.credentialType || 'orb',
        campaignId,
        reason: 'MALFORMED_NULLIFIER_HASH: Nullifier must be a 32-byte hex string',
      };
    }

    // Cryptographic ZK-SNARK proof verification against World ID API
    const zkVerifier = verifier || new RealWorldIdVerifier();
    if (zkVerifier instanceof RealWorldIdVerifier && !zkVerifier.isConfigured() && process.env.NODE_ENV !== 'production') {
      // Offline development / test mode without WORLDCOIN_APP_ID: bypass network verification
    } else {
      const zkResult = await zkVerifier.verifyProof(payload, campaignId);
      if (!zkResult.success) {
        return {
          isValid: false,
          nullifierHash: payload.nullifierHash,
          credentialType: payload.credentialType || 'orb',
          campaignId,
          reason: `INVALID_ZK_PROOF: ${zkResult.detail || zkResult.code || 'Cryptographic proof verification failed'}`,
        };
      }
    }

    // DB-persisted anti-replay check — survives process/server restart
    const alreadyUsed = await trustService.isNullifierUsed(
      payload.nullifierHash,
      'CAMPAIGN',
      campaignId
    );

    if (alreadyUsed) {
      return {
        isValid: false,
        nullifierHash: payload.nullifierHash,
        credentialType: payload.credentialType || 'orb',
        campaignId,
        reason: 'NULLIFIER_ALREADY_USED: World ID already redeemed for this campaign (Anti-Sybil Replay Gate)',
      };
    }

    // Register nullifier in DB — concurrent duplicates handled by UNIQUE constraint
    const registered = await trustService.registerNullifier({
      nullifierHash: payload.nullifierHash,
      scopeType: 'CAMPAIGN',
      scopeId: campaignId,
      credentialType: payload.credentialType || 'orb',
      action: payload.action,
      signal: payload.signal,
    });

    if (!registered) {
      // UNIQUE constraint race — another concurrent request registered first
      return {
        isValid: false,
        nullifierHash: payload.nullifierHash,
        credentialType: payload.credentialType || 'orb',
        campaignId,
        reason: 'NULLIFIER_ALREADY_USED: World ID already redeemed for this campaign (concurrent duplicate rejected)',
      };
    }

    // Record trust evidence in PostgreSQL SSOT if subject user is provided
    if (subjectUserId) {
      try {
        await trustService.recordEvidence({
          subjectUserId,
          evidenceType: 'WORLD_ID_VERIFIED',
          sourceType: 'WORLD_ID',
          sourceId: payload.nullifierHash.toLowerCase(),
          direction: 'POSITIVE',
          campaignId,
          metadata: {
            credentialType: payload.credentialType || 'orb',
            action: payload.action || campaignId,
            verifiedAt: new Date().toISOString(),
          },
        });
      } catch (evidenceErr: any) {
        // Non-blocking for claim if evidence conflict or error, but logged
        console.warn(`[SybilResistance] Trust evidence recording warning for user ${subjectUserId}:`, evidenceErr?.message);
      }
    }

    return {
      isValid: true,
      nullifierHash: payload.nullifierHash,
      credentialType: payload.credentialType || 'orb',
      campaignId,
    };
  }

  /**
   * [BACKWARD COMPAT / TEST USE] Verifies World ID proof with in-memory anti-replay.
   *
   * WARNING: This method does NOT provide anti-replay protection that survives
   * process restart. Do NOT use in production code paths.
   * Use verifyWorldIdProofPersisted() for production.
   *
   * Retained for:
   *   - Existing tests that use mock adapters without DB
   *   - Backward compatibility with call sites that have not yet been migrated
   */
  static verifyWorldIdProof(
    payload: WorldIdProofPayload,
    campaignId: string
  ): WorldIdVerificationResult {
    if (!payload.merkleRoot || !payload.nullifierHash || !payload.proof) {
      return {
        isValid: false,
        nullifierHash: payload.nullifierHash || '',
        credentialType: payload.credentialType || 'orb',
        campaignId,
        reason: 'INVALID_PROOF_PAYLOAD: Missing required ZK-SNARK proof fields',
      };
    }

    // Validate 32-byte hex nullifier format
    if (!ethers.isHexString(payload.nullifierHash, 32)) {
      return {
        isValid: false,
        nullifierHash: payload.nullifierHash,
        credentialType: payload.credentialType || 'orb',
        campaignId,
        reason: 'MALFORMED_NULLIFIER_HASH: Nullifier must be a 32-byte hex string',
      };
    }

    // In-memory anti-replay (test/compat only — NOT restart-safe)
    const campaignNullifiers = SybilResistanceService.registeredNullifiers.get(campaignId) || new Set<string>();
    if (campaignNullifiers.has(payload.nullifierHash.toLowerCase())) {
      return {
        isValid: false,
        nullifierHash: payload.nullifierHash,
        credentialType: payload.credentialType || 'orb',
        campaignId,
        reason: 'NULLIFIER_ALREADY_USED: World ID already redeemed for this campaign (Anti-Sybil Replay Gate)',
      };
    }

    campaignNullifiers.add(payload.nullifierHash.toLowerCase());
    SybilResistanceService.registeredNullifiers.set(campaignId, campaignNullifiers);

    return {
      isValid: true,
      nullifierHash: payload.nullifierHash,
      credentialType: payload.credentialType || 'orb',
      campaignId,
    };
  }

  /**
   * Clears in-memory nullifier registry (for testing/reset).
   * Does NOT affect DB-persisted nullifiers.
   */
  static resetNullifiers(): void {
    SybilResistanceService.registeredNullifiers.clear();
  }
}
