import { ethers } from 'ethers';
import { Web3SocialProfile } from '../shared/types/domain';

export interface FarcasterVerificationInput {
  walletAddress: string;
  fid?: number;
  username?: string;
  custodyAddress?: string;
  followersCount?: number;
}

export interface LensVerificationInput {
  walletAddress: string;
  handle: string;
  profileId?: string;
  followersCount?: number;
}

export interface FarcasterUserRecord {
  fid: number;
  username: string;
  custodyAddress: string;
  verifications: string[]; // verified Ethereum addresses
  followersCount: number;
  pfpUrl?: string;
  displayName?: string;
}

export interface FarcasterClient {
  isConfigured(): boolean;
  getUserByWalletAddress(walletAddress: string): Promise<FarcasterUserRecord | null>;
  getUserByFid(fid: number): Promise<FarcasterUserRecord | null>;
  getUserByUsername(username: string): Promise<FarcasterUserRecord | null>;
}

export interface LensProfileRecord {
  handle: string;
  profileId: string;
  ownedBy: string;
  followersCount: number;
}

export interface LensClient {
  isConfigured(): boolean;
  getProfileByHandle(handle: string): Promise<LensProfileRecord | null>;
  getDefaultProfileByWallet(walletAddress: string): Promise<LensProfileRecord | null>;
}

/**
 * Real Neynar Farcaster API v2 Client implementation.
 * Queries Neynar REST API if NEYNAR_API_KEY is configured.
 */
export class RealNeynarFarcasterClient implements FarcasterClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, baseUrl: string = 'https://api.neynar.com/v2/farcaster') {
    this.apiKey = apiKey || process.env.NEYNAR_API_KEY || '';
    this.baseUrl = baseUrl;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async getUserByWalletAddress(walletAddress: string): Promise<FarcasterUserRecord | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const checksummed = ethers.getAddress(walletAddress);
      const res = await fetch(`${this.baseUrl}/user/bulk-by-address?addresses=${checksummed.toLowerCase()}`, {
        headers: {
          api_key: this.apiKey,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return null;
      }

      const json = (await res.json()) as Record<string, any>;
      const userList = json[checksummed.toLowerCase()] || json[checksummed];
      if (!Array.isArray(userList) || userList.length === 0) {
        return null;
      }

      const user = userList[0];
      return {
        fid: user.fid,
        username: user.username,
        custodyAddress: user.custody_address,
        verifications: Array.isArray(user.verifications) ? user.verifications : [],
        followersCount: user.follower_count || 0,
        pfpUrl: user.pfp_url,
        displayName: user.display_name,
      };
    } catch {
      return null;
    }
  }

  async getUserByFid(fid: number): Promise<FarcasterUserRecord | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const res = await fetch(`${this.baseUrl}/user/bulk?fids=${fid}`, {
        headers: {
          api_key: this.apiKey,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return null;
      }

      const json = (await res.json()) as { users?: any[] };
      const users = json.users || [];
      if (users.length === 0) {
        return null;
      }

      const user = users[0];
      return {
        fid: user.fid,
        username: user.username,
        custodyAddress: user.custody_address,
        verifications: Array.isArray(user.verifications) ? user.verifications : [],
        followersCount: user.follower_count || 0,
        pfpUrl: user.pfp_url,
        displayName: user.display_name,
      };
    } catch {
      return null;
    }
  }

  async getUserByUsername(username: string): Promise<FarcasterUserRecord | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const clean = username.replace(/^@/, '').trim().toLowerCase();
      const res = await fetch(`${this.baseUrl}/user/by_username?username=${encodeURIComponent(clean)}`, {
        headers: {
          api_key: this.apiKey,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return null;
      }

      const json = (await res.json()) as { user?: any };
      const user = json.user;
      if (!user) {
        return null;
      }

      return {
        fid: user.fid,
        username: user.username,
        custodyAddress: user.custody_address,
        verifications: Array.isArray(user.verifications) ? user.verifications : [],
        followersCount: user.follower_count || 0,
        pfpUrl: user.pfp_url,
        displayName: user.display_name,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Real Lens Protocol API Client implementation.
 * Queries Lens GraphQL API if configured.
 */
export class RealLensProtocolClient implements LensClient {
  private apiUrl: string;

  constructor(apiUrl?: string) {
    this.apiUrl = apiUrl || process.env.LENS_API_URL || 'https://api-v2.lens.dev';
  }

  isConfigured(): boolean {
    // Only enabled if LENS_API_KEY or explicit LENS_API_URL is configured
    return Boolean(process.env.LENS_API_URL || process.env.LENS_API_KEY);
  }

  async getProfileByHandle(handle: string): Promise<LensProfileRecord | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      let clean = handle.trim().toLowerCase();
      if (!clean.endsWith('.lens')) {
        clean = `${clean}.lens`;
      }

      const query = `
        query Profile($request: ProfileRequest!) {
          profile(request: $request) {
            id
            handle {
              fullHandle
            }
            ownedBy {
              address
            }
            stats {
              followers
            }
          }
        }
      `;

      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { request: { forHandle: `lens/${clean.replace(/\.lens$/, '')}` } } }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return null;
      }

      const json = (await res.json()) as any;
      const profile = json?.data?.profile;
      if (!profile) {
        return null;
      }

      return {
        handle: clean,
        profileId: profile.id,
        ownedBy: profile.ownedBy?.address,
        followersCount: profile.stats?.followers || 0,
      };
    } catch {
      return null;
    }
  }

  async getDefaultProfileByWallet(walletAddress: string): Promise<LensProfileRecord | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const checksummed = ethers.getAddress(walletAddress);
      const query = `
        query DefaultProfile($request: DefaultProfileRequest!) {
          defaultProfile(request: $request) {
            id
            handle {
              fullHandle
            }
            ownedBy {
              address
            }
            stats {
              followers
            }
          }
        }
      `;

      const res = await fetch(this.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { request: { for: checksummed } } }),
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return null;
      }

      const json = (await res.json()) as any;
      const profile = json?.data?.defaultProfile;
      if (!profile) {
        return null;
      }

      return {
        handle: profile.handle?.fullHandle || `${profile.id}.lens`,
        profileId: profile.id,
        ownedBy: profile.ownedBy?.address,
        followersCount: profile.stats?.followers || 0,
      };
    } catch {
      return null;
    }
  }
}

export class FarcasterLensService {
  /**
   * Verifikasi identitas Farcaster (Fail-closed: requires authoritative external provider)
   * Enforces wallet binding to custody address or verified addresses.
   */
  static async verifyFarcasterAccount(
    input: FarcasterVerificationInput,
    client?: FarcasterClient
  ): Promise<{
    isValid: boolean;
    reason?: string;
    profile?: Partial<Web3SocialProfile>;
  }> {
    if (!ethers.isAddress(input.walletAddress)) {
      return { isValid: false, reason: 'INVALID_WALLET_ADDRESS' };
    }

    const targetWallet = ethers.getAddress(input.walletAddress).toLowerCase();
    const provider = client || new RealNeynarFarcasterClient();

    if (!provider.isConfigured()) {
      return {
        isValid: false,
        reason: 'FEATURE_UNAVAILABLE: Neynar API is unconfigured or unavailable',
      };
    }

    // Query external provider by wallet address, fid, or username
    let userRecord: FarcasterUserRecord | null = null;

    if (input.fid && input.fid > 0) {
      userRecord = await provider.getUserByFid(input.fid);
    } else if (input.username && input.username.trim().length >= 2) {
      userRecord = await provider.getUserByUsername(input.username);
    } else {
      userRecord = await provider.getUserByWalletAddress(targetWallet);
    }

    if (!userRecord) {
      return {
        isValid: false,
        reason: 'FARCASTER_USER_NOT_FOUND: No Farcaster account found for the specified identifier',
      };
    }

    // Verify caller-supplied FID matches provider record if provided
    if (input.fid && input.fid > 0 && input.fid !== userRecord.fid) {
      return {
        isValid: false,
        reason: `FARCASTER_FID_MISMATCH: Provided FID ${input.fid} does not match provider record FID ${userRecord.fid}`,
      };
    }

    // Verify caller-supplied username matches provider record if provided
    if (input.username) {
      const cleanUsername = input.username.replace(/^@/, '').trim().toLowerCase();
      if (cleanUsername !== userRecord.username.toLowerCase()) {
        return {
          isValid: false,
          reason: `FARCASTER_USERNAME_MISMATCH: Provided username @${cleanUsername} does not match provider record @${userRecord.username}`,
        };
      }
    }

    // Cryptographic Wallet Binding: Authenticated wallet MUST equal custody address OR be present in verified addresses
    const custodyMatch = userRecord.custodyAddress && ethers.isAddress(userRecord.custodyAddress)
      ? ethers.getAddress(userRecord.custodyAddress).toLowerCase() === targetWallet
      : false;

    const verificationMatch = Array.isArray(userRecord.verifications) && userRecord.verifications.some(
      (addr) => ethers.isAddress(addr) && ethers.getAddress(addr).toLowerCase() === targetWallet
    );

    if (!custodyMatch && !verificationMatch) {
      return {
        isValid: false,
        reason: `FARCASTER_WALLET_NOT_BOUND: Authenticated wallet ${ethers.getAddress(input.walletAddress)} is not the custody address or verified address for FID ${userRecord.fid} (@${userRecord.username})`,
      };
    }

    return {
      isValid: true,
      profile: {
        walletAddress: ethers.getAddress(input.walletAddress),
        farcasterFid: userRecord.fid,
        farcasterUsername: userRecord.username,
        farcasterFollowers: userRecord.followersCount,
      },
    };
  }

  /**
   * Verifikasi kepemilikan Lens Protocol Profile (Fail-closed: requires authoritative Lens provider)
   * Enforces wallet binding to profile ownership on-chain / provider.
   */
  static async verifyLensProfile(
    input: LensVerificationInput,
    client?: LensClient
  ): Promise<{
    isValid: boolean;
    reason?: string;
    profile?: Partial<Web3SocialProfile>;
  }> {
    if (!ethers.isAddress(input.walletAddress)) {
      return { isValid: false, reason: 'INVALID_WALLET_ADDRESS' };
    }

    const targetWallet = ethers.getAddress(input.walletAddress).toLowerCase();

    let cleanHandle = input.handle.trim().toLowerCase();
    if (!cleanHandle.endsWith('.lens')) {
      cleanHandle = `${cleanHandle}.lens`;
    }

    if (cleanHandle.length < 6) {
      return { isValid: false, reason: 'INVALID_LENS_HANDLE' };
    }

    const provider = client || new RealLensProtocolClient();

    if (!provider.isConfigured()) {
      return {
        isValid: false,
        reason: 'FEATURE_UNAVAILABLE: Lens Protocol API is unconfigured or unreachable',
      };
    }

    const profileRecord = await provider.getProfileByHandle(cleanHandle);
    if (!profileRecord) {
      return {
        isValid: false,
        reason: `LENS_PROFILE_NOT_FOUND: Lens handle ${cleanHandle} does not exist on Lens Protocol`,
      };
    }

    // Verify caller-supplied profileId if provided
    if (input.profileId && profileRecord.profileId && input.profileId !== profileRecord.profileId) {
      return {
        isValid: false,
        reason: `LENS_PROFILE_ID_MISMATCH: Provided profileId ${input.profileId} does not match provider record ${profileRecord.profileId}`,
      };
    }

    // Verify wallet ownership: profile.ownedBy must match authenticated wallet
    if (!profileRecord.ownedBy || !ethers.isAddress(profileRecord.ownedBy)) {
      return {
        isValid: false,
        reason: 'LENS_OWNERSHIP_UNVERIFIED: Provider did not return valid owner address for profile',
      };
    }

    if (ethers.getAddress(profileRecord.ownedBy).toLowerCase() !== targetWallet) {
      return {
        isValid: false,
        reason: `LENS_OWNERSHIP_MISMATCH: Lens profile ${cleanHandle} is owned by ${ethers.getAddress(profileRecord.ownedBy)}, not authenticated wallet ${ethers.getAddress(input.walletAddress)}`,
      };
    }

    return {
      isValid: true,
      profile: {
        walletAddress: ethers.getAddress(input.walletAddress),
        lensHandle: profileRecord.handle,
        lensProfileId: profileRecord.profileId,
        lensFollowers: profileRecord.followersCount,
      },
    };
  }

  /**
   * Hitung skor reputasi gabungan Web3 Social Score (0 - 100)
   */
  static calculateWeb3ReputationScore(
    farcasterVerified: boolean,
    lensVerified: boolean,
    farcasterFollowers: number = 0,
    lensFollowers: number = 0
  ): number {
    let score = 20; // Base baseline
    if (farcasterVerified) {
      score += 35;
      if (farcasterFollowers > 1000) score += 15;
      else if (farcasterFollowers > 200) score += 10;
    }

    if (lensVerified) {
      score += 30;
      if (lensFollowers > 500) score += 15;
      else if (lensFollowers > 100) score += 5;
    }

    return Math.min(100, score);
  }
}

