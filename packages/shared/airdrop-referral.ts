/**
 * packages/shared/airdrop-referral.ts
 *
 * Pure, deterministic Airdrop Referral (?ref=0x...) & Required Follow (@handle) utilities (Phase EX).
 * - Zero I/O, zero DDL migration: encodes optional [FOLLOW:@handle] cleanly in bounty_campaigns.description.
 * - Reuses EVM address validation & anti-self-referral semantics.
 */

export const AIRDROP_REFERRAL_BONUS_CREDITS = 15;
export const AIRDROP_REFERRAL_REFERENCE_PREFIX = 'bounty_ref:';

export interface AirdropReferralLedgerEntry {
  id?: string;
  amount: number;
  currency?: string;
  type?: string;
  referenceId: string | null | undefined;
  description?: string;
  createdAt?: string;
}

export interface AirdropReferralRecentItem {
  id: string;
  campaignId: string;
  claimId: string;
  amount: number;
  description: string;
  createdAt: string;
}

export interface AirdropReferralStatsSummary {
  totalReferrals: number;
  totalCreditsEarned: number;
  bonusPerReferral: number;
  recentReferrals: AirdropReferralRecentItem[];
}

/**
 * Builds canonical idempotent reference_id for ledger_entries airdrop referral credits.
 */
export function buildAirdropReferralReferenceId(campaignId: string, claimId: string): string {
  return `${AIRDROP_REFERRAL_REFERENCE_PREFIX}${campaignId.trim()}:${claimId.trim()}`;
}

/**
 * Parses a canonical `bounty_ref:<campaignId>:<claimId>` reference_id.
 */
export function parseAirdropReferralReferenceId(
  referenceId: string | null | undefined
): { campaignId: string; claimId: string } | null {
  if (!referenceId || typeof referenceId !== 'string') return null;
  if (!referenceId.startsWith(AIRDROP_REFERRAL_REFERENCE_PREFIX)) return null;
  const rest = referenceId.slice(AIRDROP_REFERRAL_REFERENCE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep >= rest.length - 1) return null;
  const campaignId = rest.slice(0, sep).trim();
  const claimId = rest.slice(sep + 1).trim();
  if (!campaignId || !claimId) return null;
  return { campaignId, claimId };
}

/**
 * Aggregates and deduplicates airdrop referral ledger entries by referenceId.
 */
export function summarizeAirdropReferralLedger(
  entries: AirdropReferralLedgerEntry[],
  maxRecent = 10
): AirdropReferralStatsSummary {
  const seenRefs = new Set<string>();
  const validRows: AirdropReferralRecentItem[] = [];
  let totalCreditsEarned = 0;

  for (const entry of entries || []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.currency && entry.currency.toUpperCase() !== 'CREDITS') continue;
    if (entry.type && entry.type.toUpperCase() !== 'CREDIT') continue;
    const refId = typeof entry.referenceId === 'string' ? entry.referenceId.trim() : '';
    const parsed = parseAirdropReferralReferenceId(refId);
    if (!parsed || seenRefs.has(refId)) continue;
    const amount = Number(entry.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    seenRefs.add(refId);
    totalCreditsEarned += amount;
    validRows.push({
      id: entry.id || refId,
      campaignId: parsed.campaignId,
      claimId: parsed.claimId,
      amount,
      description: entry.description || `Airdrop Referral Bonus (+${amount} cr)`,
      createdAt: entry.createdAt || '',
    });
  }

  validRows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  return {
    totalReferrals: validRows.length,
    totalCreditsEarned: Math.round(totalCreditsEarned * 100) / 100,
    bonusPerReferral: AIRDROP_REFERRAL_BONUS_CREDITS,
    recentReferrals: validRows.slice(0, Math.max(1, maxRecent)),
  };
}

export interface UnifiedCreatorEarningsSummary {
  airdropReferralCredits: number;
  signalMarketplaceCredits: number;
  signalSalesCount: number;
  totalCreatorCredits: number;
}

/**
 * Pure deterministic aggregator combining Airdrop Referral credits (+15 cr) and
 * Signal Marketplace 80% Creator Revenue Share into a single Creator Earnings summary (Phase FK).
 */
export function computeUnifiedCreatorEarnings(input: {
  airdropReferralCredits: number;
  signalMarketplaceCredits: number;
  signalSalesCount: number;
}): UnifiedCreatorEarningsSummary {
  const airdropReferralCredits = Math.max(0, Math.round((Number(input.airdropReferralCredits) || 0) * 100) / 100);
  const signalMarketplaceCredits = Math.max(0, Math.round((Number(input.signalMarketplaceCredits) || 0) * 100) / 100);
  const signalSalesCount = Math.max(0, Math.floor(Number(input.signalSalesCount) || 0));
  return {
    airdropReferralCredits,
    signalMarketplaceCredits,
    signalSalesCount,
    totalCreatorCredits: Math.round((airdropReferralCredits + signalMarketplaceCredits) * 100) / 100,
  };
}

const FOLLOW_TAG_REGEX = /\[FOLLOW:@([A-Za-z0-9_]{1,30})\]/i;

/**
 * Normalizes an X/Twitter handle into canonical `@handle` form, or returns null if empty/invalid.
 */
export function normalizeFollowHandle(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^@+/, '');
  if (!/^[A-Za-z0-9_]{1,30}$/.test(cleaned)) return null;
  return `@${cleaned}`;
}

/**
 * Encodes an optional required Follow @handle tag into campaign description without requiring DDL migration.
 */
export function encodeRequiredFollowInDescription(
  description: string | null | undefined,
  followHandle: string | null | undefined
): string {
  const base = (description || '').replace(FOLLOW_TAG_REGEX, '').trim();
  const normalized = normalizeFollowHandle(followHandle);
  if (!normalized) return base;
  return base ? `[FOLLOW:${normalized}] ${base}` : `[FOLLOW:${normalized}]`;
}

/**
 * Extracts normalized `@handle` from campaign description if present.
 */
export function parseRequiredFollowFromDescription(
  description: string | null | undefined
): string | null {
  if (!description || typeof description !== 'string') return null;
  const match = description.match(FOLLOW_TAG_REGEX);
  return match?.[1] ? `@${match[1]}` : null;
}

/**
 * Builds a shareable Airdrop Referral URL for a specific campaign.
 */
export function buildAirdropReferralShareUrl(params: {
  campaignId: string;
  referrerWallet?: string | null;
  siteOrigin?: string;
}): string {
  const origin = (params.siteOrigin || 'https://pndigi.site').replace(/\/+$/, '');
  const qs = new URLSearchParams({
    campaignId: params.campaignId,
    tab: 'CLAIM',
  });
  const ref = (params.referrerWallet || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(ref)) {
    qs.set('ref', ref);
  }
  return `${origin}/kol?${qs.toString()}`;
}
