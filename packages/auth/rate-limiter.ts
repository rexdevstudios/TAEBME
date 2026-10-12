// ============================================================================
// RATE LIMITER — Ephemeral Sliding-Window Rate Limiting Helper
// ============================================================================
//
// INVARIANT (MASTER_PROMPT.md & SSOT.md):
//   - Rate-limiting disimpannya di Ephemeral Redis Tier (bukan PostgreSQL SSOT).
//   - 100% FAULT-ISOLATED & NON-BLOCKING:
//     Jika Redis unconfigured, network timeout, atau error:
//     Fungsi SELALU mengembalikan `allowed: true` agar user request TIDAK terblokir
//     hanya karena masalah cache/sidecar.
// ============================================================================

import { UpstashRedisClient, upstashRedis } from '../shared/redis-client';
import { formatRedisKey } from '../shared/env-config';

export type RateLimitPolicy = 'FAIL_OPEN' | 'FAIL_CLOSED';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  error?: 'RATE_LIMITER_UNAVAILABLE' | 'RATE_LIMIT_EXCEEDED';
}

export class SlidingWindowRateLimiter {
  constructor(private client: UpstashRedisClient = upstashRedis) {}

  /**
   * Pengecekan Rate Limit untuk API endpoint (e.g. SIWE login, trade intent creation).
   *
   * @param key            Identitas unik request (e.g. `ratelimit:siwe:${ip}`)
   * @param maxRequests    Batas kuota request (e.g. 5)
   * @param windowSeconds  Durasi window dalam detik (e.g. 60)
   * @param policy         Kegagalan sidecar: 'FAIL_OPEN' (default) atau 'FAIL_CLOSED'
   */
  async checkRateLimit(
    key: string,
    maxRequests: number = 10,
    windowSeconds: number = 60,
    policy: RateLimitPolicy = 'FAIL_OPEN'
  ): Promise<RateLimitResult> {
    const namespacedKey = formatRedisKey(key);

    if (!this.client.isConfigured()) {
      if (policy === 'FAIL_CLOSED') {
        return {
          allowed: false,
          remaining: 0,
          resetMs: 0,
          error: 'RATE_LIMITER_UNAVAILABLE',
        };
      }
      // Redis unconfigured: pass-through gracefully (FAIL_OPEN)
      return { allowed: true, remaining: maxRequests, resetMs: 0 };
    }

    try {
      const current = await this.client.incr(namespacedKey);

      if (current === null) {
        if (policy === 'FAIL_CLOSED') {
          return {
            allowed: false,
            remaining: 0,
            resetMs: 0,
            error: 'RATE_LIMITER_UNAVAILABLE',
          };
        }
        return { allowed: true, remaining: maxRequests, resetMs: 0 };
      }

      // Key baru dibuat -> pasang TTL window
      if (current === 1) {
        await this.client.set(namespacedKey, 1, windowSeconds);
      }

      const remaining = Math.max(0, maxRequests - current);
      const allowed = current <= maxRequests;

      if (!allowed) {
        console.warn(`[RateLimiter] Rate limit exceeded for key "${namespacedKey}" (${current}/${maxRequests})`);
      }

      return {
        allowed,
        remaining,
        resetMs: windowSeconds * 1000,
        error: !allowed ? 'RATE_LIMIT_EXCEEDED' : undefined,
      };
    } catch (err) {
      console.warn(`[RateLimiter] Exception on checkRateLimit for key "${namespacedKey}":`, (err as Error).message);
      if (policy === 'FAIL_CLOSED') {
        return {
          allowed: false,
          remaining: 0,
          resetMs: 0,
          error: 'RATE_LIMITER_UNAVAILABLE',
        };
      }
      return { allowed: true, remaining: maxRequests, resetMs: 0 };
    }
  }
}

// Export singleton instance
export const rateLimiter = new SlidingWindowRateLimiter();
