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

export interface GenesisShareIntents {
  referralUrl: string;
  shareText: string;
  twitterIntentUrl: string;
  telegramShareUrl: string;
}

/**
 * Pure deterministic viral social share URL builder for POOLNET Genesis Sprint (Phase DM).
 */
export function buildGenesisShareIntents(
  origin: string,
  walletAddress: string,
  serialNumber?: number | null
): GenesisShareIntents {
  const referralUrl = buildGenesisReferralUrl(origin, walletAddress);
  const badge =
    typeof serialNumber === 'number' && serialNumber > 0
      ? `Genesis Pioneer #${serialNumber}`
      : 'Free-Mint Genesis Pioneer SBT';
  const shareText = `Just claimed my ${badge} on POOLNET (10,000 cap on Base) — +200 Welcome Credits, AI Multi-Rail Trading, and GoPlus Anti-Honeypot Guard. Claim yours free:`;

  const twitterIntentUrl = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(referralUrl)}`;
  const telegramShareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralUrl)}&text=${encodeURIComponent(shareText)}`;

  return {
    referralUrl,
    shareText,
    twitterIntentUrl,
    telegramShareUrl,
  };
}

export type GenesisWhitelistTier = 'PIONEER' | 'AMBASSADOR' | 'WHALE_REFERRER';

export interface GenesisWhitelistEntry {
  serialNumber: number;
  walletAddress: string;
  referralsCount: number;
  allocationWeight: number;
  tier: GenesisWhitelistTier;
  chain: string;
  mintedAt: string;
}

/**
 * Pure deterministic Merkle Whitelist aggregator for Post-Genesis TGE / Angel Deal Room (Phase DK).
 * Allocation weight = 1.00 base + 0.25 per valid referral (capped at +2.50 bonus -> max 3.50x).
 */
export function buildGenesisMerkleWhitelist(
  records: readonly GenesisSbtMintRecord[]
): GenesisWhitelistEntry[] {
  const refCounts = new Map<string, number>();
  for (const r of records || []) {
    if (!r?.referredBy) continue;
    const key = r.referredBy.trim().toLowerCase();
    refCounts.set(key, (refCounts.get(key) || 0) + 1);
  }

  return (records || [])
    .slice()
    .sort((a, b) => a.serialNumber - b.serialNumber)
    .map((r) => {
      const referralsCount = refCounts.get(r.walletAddress.trim().toLowerCase()) || 0;
      const allocationWeight = Number((1 + Math.min(referralsCount, 10) * 0.25).toFixed(2));
      const tier: GenesisWhitelistTier =
        referralsCount >= 5 ? 'WHALE_REFERRER' : referralsCount >= 1 ? 'AMBASSADOR' : 'PIONEER';
      return {
        serialNumber: r.serialNumber,
        walletAddress: r.walletAddress.trim(),
        referralsCount,
        allocationWeight,
        tier,
        chain: r.chain || 'base-mainnet',
        mintedAt: r.mintedAt,
      };
    });
}

function escapeCsvCell(raw: unknown): string {
  let str = String(raw ?? '');
  // Formula-injection neutralization (OWASP CSV injection guard)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function serializeGenesisSnapshotToCsv(records: readonly GenesisSbtMintRecord[]): string {
  const entries = buildGenesisMerkleWhitelist(records);
  const header = [
    'serial_number',
    'wallet_address',
    'tier',
    'allocation_weight',
    'referrals_count',
    'chain',
    'minted_at',
  ].join(',');
  const rows = entries.map((e) =>
    [
      escapeCsvCell(e.serialNumber),
      escapeCsvCell(e.walletAddress),
      escapeCsvCell(e.tier),
      escapeCsvCell(e.allocationWeight.toFixed(2)),
      escapeCsvCell(e.referralsCount),
      escapeCsvCell(e.chain),
      escapeCsvCell(e.mintedAt),
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

export interface WeeklyGenesisDigestParams {
  totalMinted: number;
  supplyCap?: number;
  leaderboard: readonly GenesisReferralLeaderRow[];
  verifiedPropTraders?: number;
  siteOrigin?: string;
}

function maskWalletShort(addr: string): string {
  const clean = String(addr || '').trim();
  if (clean.length < 12) return clean;
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

/**
 * Pure deterministic Weekly Genesis Referral & Prop Cup Digest formatter (Phase DN).
 */
export function formatWeeklyGenesisDigestMessage(params: WeeklyGenesisDigestParams): string {
  const cap = Math.max(1, Number(params.supplyCap ?? GENESIS_SBT_SUPPLY_CAP));
  const minted = Math.max(0, Number(params.totalMinted ?? 0));
  const pct = Math.min(100, Math.round((minted / cap) * 1000) / 10);
  const statusLabel = minted >= cap ? 'SOLD OUT (CAP LOCKED)' : 'FREE MINT LIVE';
  const origin = (params.siteOrigin || 'https://pndigi.site').replace(/\/+$/, '');
  const propCount = Math.max(0, Number(params.verifiedPropTraders ?? 0));

  const lines: string[] = [
    `POOLNET Weekly Genesis Sprint Digest`,
    `Status: ${statusLabel}`,
    `Genesis Pioneers Minted: ${minted.toLocaleString()} / ${cap.toLocaleString()} (${pct}%)`,
    `Verified Prop Cup Traders: ${propCount}`,
    ``,
    `Top Genesis Referrers:`,
  ];

  const top5 = (params.leaderboard || []).slice(0, 5);
  if (top5.length === 0) {
    lines.push(`- Be the first referrer to claim +50 Credits per verified mint.`);
  } else {
    top5.forEach((row, idx) => {
      lines.push(
        `${idx + 1}. ${maskWalletShort(row.walletAddress)} — ${row.referralsCount} invites (+${row.bonusCreditsEarned} cr)`
      );
    });
  }

  lines.push(``);
  lines.push(`Claim Free Genesis SBT (+200 Credits): ${origin}`);
  lines.push(`Live Transparency & Fee Proof: ${origin}/transparency`);

  return lines.join('\n');
}
