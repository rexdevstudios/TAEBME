// ============================================================================
// SOCIALFI & KOL REPUTATION SERVICE
// ============================================================================

import { KolProfile } from '../shared/types/domain';
import { ArkhamIntelligenceService } from '../intelligence/arkham-enrichment';
import { FarcasterLensService } from './farcaster-lens-service';
import { ethers } from 'ethers';
import { randomBytes } from 'crypto';
import { upstashRedis } from '../shared/redis-client';

/** Nonce TTL: matches attestation window (10 minutes) */
const NONCE_TTL_SECONDS = 600;
/** Redis key prefix for single-use attestation nonces */
const NONCE_KEY_PREFIX = 'attest_nonce:';

export interface KolDbAdapter {
  upsertKolProfile(profile: Partial<KolProfile> & { userId: string }): Promise<KolProfile>;
  getKolProfile(userId: string): Promise<KolProfile | null>;
  createAuditLog(actorId: string, action: string, entityId?: string, reason?: string): Promise<void>;
}

export class KolService {
  constructor(
    private db: KolDbAdapter,
    private arkhamService: ArkhamIntelligenceService
  ) {}

  static isValidTwitterHandle(handle: string): boolean {
    if (!handle || typeof handle !== 'string') return false;
    const clean = handle.replace(/^@/, '').trim();
    return /^[A-Za-z0-9_]{1,15}$/.test(clean);
  }

  /**
   * SEC-01: Issue a single-use attestation nonce bound to walletAddress + twitterHandle.
   * Stored in Redis with NONCE_TTL_SECONDS TTL using SET NX (atomic; only one winner).
   * Returns the nonce string on success, or null if Redis is unavailable or a pending nonce
   * already exists for this wallet+handle pair.
   *
   * Callers MUST treat null as a service-unavailable / rate-limit error (fail-closed).
   * Clients should wait for the existing nonce to expire (600s) before requesting a new one.
   */
  static async generateAttestationNonce(walletAddress: string, twitterHandle: string): Promise<string | null> {
    const cleanHandle = twitterHandle.replace(/^@/, '').trim().toLowerCase();
    const cleanAddress = walletAddress.toLowerCase();
    // Nonce: 128-bit cryptographically random hex
    const nonce = randomBytes(16).toString('hex');
    const redisKey = `${NONCE_KEY_PREFIX}${cleanAddress}:${cleanHandle}`;
    // SET NX: only store if key does not exist — prevents pre-generated nonce stuffing
    const stored = await upstashRedis.setNx(redisKey, nonce, NONCE_TTL_SECONDS);
    if (!stored) {
      // Either Redis is down (returns false) or a valid nonce already exists.
      return null;
    }
    return nonce;
  }

  /**
   * SEC-01: Consume a single-use attestation nonce atomically via GETDEL.
   * Returns true if the nonce matched and was consumed (now deleted from Redis).
   * Returns false if the key does not exist (expired or already consumed) or value mismatch.
   *
   * Calling this twice for the same nonce → second call always returns false (replay protection).
   */
  static async consumeAttestationNonce(walletAddress: string, twitterHandle: string, nonce: string): Promise<boolean> {
    if (!nonce || typeof nonce !== 'string' || nonce.trim() === '') return false;
    const cleanHandle = twitterHandle.replace(/^@/, '').trim().toLowerCase();
    const cleanAddress = walletAddress.toLowerCase();
    const redisKey = `${NONCE_KEY_PREFIX}${cleanAddress}:${cleanHandle}`;
    const stored = await upstashRedis.getdel<string>(redisKey);
    return stored === nonce;
  }

  /**
   * SEC-01 HARDENED: timestamp and nonce are BOTH MANDATORY.
   *
   * The nonce is included in the signed message so that a captured signature
   * cannot be replayed with a freshly issued nonce — the wallet must sign a
   * message that commits to the specific server-issued nonce.
   *
   * Signed message format:
   *   RTrader SocialFi Identity Attestation:
   *   Wallet: <checksummed-address-lowercase>
   *   Twitter: @<handle-lowercase>
   *   Timestamp: <unix-ms>
   *   Nonce: <server-issued-128-bit-hex>
   */
  static getAttestationMessage(
    walletAddress: string,
    twitterHandle: string,
    timestamp: number,
    nonce: string
  ): string {
    const cleanHandle = twitterHandle.replace(/^@/, '').trim().toLowerCase();
    const cleanAddress = ethers.getAddress(walletAddress).toLowerCase();
    // SEC-01: nonce is part of the signed message — prevents replay even within timestamp window
    return `RTrader SocialFi Identity Attestation:\nWallet: ${cleanAddress}\nTwitter: @${cleanHandle}\nTimestamp: ${timestamp}\nNonce: ${nonce}`;
  }

  /**
   * SEC-01 HARDENED: timestamp AND nonce are MANDATORY.
   *
   * The nonce must match the server-issued nonce that was included in the signed message.
   * Any attempt to replay a valid (wallet, handle, timestamp) signature with a different
   * nonce will produce a SIGNATURE_MISMATCH because the reconstructed message differs.
   *
   * Validation order:
   *   1. Address format check
   *   2. Handle format check
   *   3. Timestamp presence / validity
   *   4. Nonce presence check
   *   5. Timestamp window check (expired / future)
   *   6. ECDSA signature recovery against the full message (wallet+handle+timestamp+nonce)
   *
   * NOTE: Nonce consumption (atomic GETDEL) must be performed by the route handler
   * BEFORE calling this method. This method is pure/synchronous and only verifies the signature.
   */
  static verifySocialAttestation(
    walletAddress: string,
    twitterHandle: string,
    signature: string,
    timestamp: number,
    nonce: string,           // SEC-01: nonce is now part of the signed message
    maxAgeMs: number = 600000 // 10 minutes maximum age
  ): { isValid: boolean; reason?: string } {
    if (!ethers.isAddress(walletAddress)) {
      return { isValid: false, reason: 'INVALID_WALLET_ADDRESS' };
    }
    if (!KolService.isValidTwitterHandle(twitterHandle)) {
      return { isValid: false, reason: 'INVALID_TWITTER_HANDLE' };
    }

    // SEC-01: Timestamp is mandatory
    if (timestamp === undefined || timestamp === null) {
      return { isValid: false, reason: 'TIMESTAMP_REQUIRED' };
    }
    if (isNaN(timestamp) || timestamp <= 0) {
      return { isValid: false, reason: 'INVALID_TIMESTAMP' };
    }

    // SEC-01: Nonce is mandatory
    if (!nonce || typeof nonce !== 'string' || nonce.trim() === '') {
      return { isValid: false, reason: 'NONCE_REQUIRED' };
    }

    const now = Date.now();
    if (now - timestamp > maxAgeMs) {
      return { isValid: false, reason: 'ATTESTATION_EXPIRED' };
    }
    if (timestamp - now > 60000) {
      return { isValid: false, reason: 'FUTURE_TIMESTAMP' };
    }

    try {
      // SEC-01: Reconstruct message with nonce — a replay with a different nonce will
      // produce a different message and the recovered address will NOT match.
      const message = KolService.getAttestationMessage(walletAddress, twitterHandle, timestamp, nonce);
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() === walletAddress.toLowerCase()) {
        return { isValid: true };
      }
      return { isValid: false, reason: 'SIGNATURE_MISMATCH' };
    } catch {
      return { isValid: false, reason: 'SIGNATURE_RECOVERY_FAILED' };
    }
  }

  static generateTwitterAuthUrl(state: string, redirectUri: string): string {
    const clientId = process.env.TWITTER_CLIENT_ID || 'mock_twitter_client_id';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'users.read tweet.read offline.access',
      state,
      code_challenge: 'challenge',
      code_challenge_method: 'plain',
    });
    return `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
  }

  async registerOrUpdateKol(
    userId: string,
    walletAddress: string,
    twitterHandle: string,
    followersCount: number,
    farcasterFid?: number,
    farcasterUsername?: string,
    lensHandle?: string,
    isWeb3Verified: boolean = false
  ): Promise<KolProfile> {
    if (!KolService.isValidTwitterHandle(twitterHandle)) {
      throw new Error('INVALID_TWITTER_HANDLE: Twitter handle must be 1-15 alphanumeric characters or underscores');
    }
    // SEC-03: Normalize handle to lowercase at the domain service boundary
    const cleanTwitter = twitterHandle.replace(/^@/, '').trim().toLowerCase();

    // 1. Ambil reputasi wallet dari Arkham yang sudah ada
    const arkhamProfile = await this.arkhamService.profileWallet(walletAddress, userId);

    // 2. Hitung Trust Score (kombinasi reputasi on-chain Arkham + metrik followers)
    let score = arkhamProfile.riskPassportScore;
    if (followersCount > 10000) score = Math.min(100, score + 10);
    if (followersCount < 500) score = Math.max(10, score - 20);

    // 3. Web3 Social Graph Bonus (Farcaster & Lens)
    // Security Hardening: Only award Web3 reputation bonus if identity has been cryptographically verified
    let web3SocialScore: number | undefined;
    if (isWeb3Verified && (farcasterFid || lensHandle)) {
      web3SocialScore = FarcasterLensService.calculateWeb3ReputationScore(
        !!farcasterFid,
        !!lensHandle,
        farcasterFid ? 350 : 0,
        lensHandle ? 200 : 0
      );
      score = Math.min(100, score + 10); // Reward KOL for verified Web3 native identity
    }

    const existing = await this.db.getKolProfile(userId);

    const profile = await this.db.upsertKolProfile({
      userId,
      twitterHandle: cleanTwitter,
      followersCount,
      farcasterFid: isWeb3Verified ? farcasterFid : existing?.farcasterFid,
      farcasterUsername: isWeb3Verified ? farcasterUsername : existing?.farcasterUsername,
      lensHandle: isWeb3Verified ? lensHandle : existing?.lensHandle,
      web3SocialScore: isWeb3Verified ? web3SocialScore : existing?.web3SocialScore,
      trustScore: score,
      // B-06 Hardening: Self-service profile updates cannot self-certify verified status.
      // Verified status is preserved if already granted, or remains false until verified.
      isVerified: existing?.isVerified ?? false,
    });

    await this.db.createAuditLog(
      userId,
      'KOL_PROFILE_UPDATED',
      profile.id,
      `Twitter: @${cleanTwitter} | FC: ${profile.farcasterUsername || 'none'} | Lens: ${profile.lensHandle || 'none'}`
    );
    return profile;
  }

  async getProfile(userId: string): Promise<KolProfile | null> {
    return this.db.getKolProfile(userId);
  }
}
