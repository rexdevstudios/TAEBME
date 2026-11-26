/**
 * packages/shared/airdrop-referral.ts
 *
 * Pure, deterministic Airdrop Referral (?ref=0x...) & Required Follow (@handle) utilities (Phase EX).
 * - Zero I/O, zero DDL migration: encodes optional [FOLLOW:@handle] cleanly in bounty_campaigns.description.
 * - Reuses EVM address validation & anti-self-referral semantics.
 */

export const AIRDROP_REFERRAL_BONUS_CREDITS = 15;

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
