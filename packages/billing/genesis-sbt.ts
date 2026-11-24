/**
 * packages/billing/genesis-sbt.ts
 *
 * Pure, deterministic Free-Mint Genesis Pioneer SBT & Viral Referral Engine (Phase DF).
 *  - Mint Price: FREE (0 ETH) + low-friction Base L2 Protocol Mint Fee (0.00018 ETH ≈ $0.50) -> Treasury.
 *  - Strict 1 SBT per wallet, 10,000 cap, anti-replay txHash, and anti-self-referral guard.
 *  - Grants +200 Welcome Credits to minter & +50 Referral Bonus Credits to referrer.
 */

export const GENESIS_SBT_SUPPLY_CAP = 10_000;
export const GENESIS_SBT_MINT_PRICE_ETH = '0';
export const GENESIS_SBT_PROTOCOL_FEE_ETH = '0.00018'; // ~$0.50 Base L2 Protocol Mint Fee
export const GENESIS_SBT_PROTOCOL_FEE_WEI_HEX = '0xa3b5840f4000'; // 180000000000000 wei
export const GENESIS_SBT_WELCOME_CREDITS = 200;
export const GENESIS_SBT_REFERRAL_BONUS_CREDITS = 50;

export interface GenesisSbtMintRecord {
  serialNumber: number;
  walletAddress: string;
  txHash: string;
  chain: string;
  referredBy: string | null;
  mintedAt: string;
}

export interface GenesisReferralLeaderRow {
  walletAddress: string;
  referralsCount: number;
  bonusCreditsEarned: number;
}

export function normalizeReferrerWallet(
  rawReferrer: unknown,
  minterWallet: string
): string | null {
  if (typeof rawReferrer !== 'string') return null;
  const cleaned = rawReferrer.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(cleaned)) return null;
  if (cleaned.toLowerCase() === minterWallet.trim().toLowerCase()) {
    return null; // Strict anti-self-referral
  }
  return cleaned;
}

export function computeGenesisReferralLeaderboard(
  records: readonly GenesisSbtMintRecord[],
  limit: number = 10
): GenesisReferralLeaderRow[] {
  const counts = new Map<string, { display: string; count: number }>();
  for (const r of records || []) {
    if (!r?.referredBy) continue;
    const key = r.referredBy.trim().toLowerCase();
    const prev = counts.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      counts.set(key, { display: r.referredBy.trim(), count: 1 });
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, limit))
    .map((entry) => ({
      walletAddress: entry.display,
      referralsCount: entry.count,
      bonusCreditsEarned: entry.count * GENESIS_SBT_REFERRAL_BONUS_CREDITS,
    }));
}

export function buildGenesisReferralUrl(origin: string, walletAddress: string): string {
  const cleanOrigin = (origin || 'https://pndigi.site').replace(/\/+$/, '');
  return `${cleanOrigin}/?ref=${encodeURIComponent(walletAddress.trim())}`;
}
