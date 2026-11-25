/**
 * packages/auth/cron-auth.ts
 *
 * Single Source of Truth (SSOT) Timing-Safe Cron Authorization Guard (Phase EL).
 * - Deduplicates identical `isCronAuthorized()` checks across all `/api/cron/*` endpoints.
 * - Fail-closed: rejects missing or weak (< 16 chars) `CRON_SECRET`.
 * - Uses `crypto.timingSafeEqual` on SHA-256 digests to prevent timing side-channels.
 */

import crypto from 'crypto';

function digestSha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

export function isCronAuthorized(
  req: { headers: { get(name: string): string | null } },
  secretOverride?: string
): boolean {
  const cronSecret = (secretOverride ?? process.env.CRON_SECRET ?? '').trim();
  if (!cronSecret || cronSecret.length < 16) return false;
  const authHeader = (req.headers.get('authorization') || '').trim();
  if (!authHeader) return false;
  const expected = `Bearer ${cronSecret}`;
  return crypto.timingSafeEqual(digestSha256(authHeader), digestSha256(expected));
}
