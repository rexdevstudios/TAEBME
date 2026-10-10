// ============================================================================
// UPSTASH REDIS REST CLIENT — Ephemeral Tier Sidecar (Zero Dependencies)
// ============================================================================
//
// INVARIANT (MASTER_PROMPT.md & SSOT.md):
//   - Redis BUKAN Operational SSOT (PostgreSQL adalah SSOT).
//   - Client ini 100% FAULT-ISOLATED: Jika env var tidak ada atau network error,
//     semua method mengembalikan fallback safe result (null/false/0) tanpa crash.
//   - Memakai native global fetch (Node 18+ & Vercel Edge compatible).
// ============================================================================

import { getAppEnvironment } from './env-config';

export interface RedisClientConfig {
  restUrl?: string;
  restToken?: string;
}

export class UpstashRedisClient {
  private configUrl?: string;
  private configToken?: string;

  constructor(config?: RedisClientConfig) {
    this.configUrl = config?.restUrl;
    this.configToken = config?.restToken;
  }

  get restUrl(): string {
    if (this.configUrl) return this.configUrl;
    const env = getAppEnvironment();

    if (env === 'testnet') {
      const testnetUrl = process.env.UPSTASH_REDIS_REST_URL_TESTNET?.trim();
      return testnetUrl || '';
    }

    if (env === 'production') {
      return process.env.UPSTASH_REDIS_REST_URL?.trim() || '';
    }

    // Dev / Test
    const customUrl = process.env.UPSTASH_REDIS_REST_URL_TESTNET?.trim() || process.env.UPSTASH_REDIS_REST_URL?.trim();
    return customUrl || '';
  }

  get restToken(): string {
    if (this.configToken) return this.configToken;
    const env = getAppEnvironment();

    if (env === 'testnet') {
      const testnetToken = process.env.UPSTASH_REDIS_REST_TOKEN_TESTNET?.trim();
      return testnetToken || '';
    }

    if (env === 'production') {
      return process.env.UPSTASH_REDIS_REST_TOKEN?.trim() || '';
    }

    // Dev / Test
    const customToken = process.env.UPSTASH_REDIS_REST_TOKEN_TESTNET?.trim() || process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
    return customToken || '';
  }

  /**
   * Cek apakah credentials Upstash Redis REST terpasang.
   */
  isConfigured(): boolean {
    return Boolean(this.restUrl && this.restToken);
  }

  /**
   * Safe HTTP POST helper ke Upstash REST endpoint.
   */
  private async executeCommand<T>(command: string[]): Promise<T | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      const res = await fetch(`${this.restUrl}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.restToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(2000),
      });

      if (!res.ok) {
        console.warn(`[Upstash Redis] Command [${command[0]}] returned status ${res.status}`);
        return null;
      }

      const json = (await res.json()) as { result?: T; error?: string };
      if (json.error) {
        console.warn(`[Upstash Redis] Command [${command[0]}] error:`, json.error);
        return null;
      }

      return json.result !== undefined ? json.result : null;
    } catch (err) {
      console.warn(`[Upstash Redis] Network/Client error:`, (err as Error).message);
      return null;
    }
  }

  /**
   * GET key value dari Redis cache.
   */
  async get<T = string>(key: string): Promise<T | null> {
    const res = await this.executeCommand<T>(['GET', key]);
    return res;
  }

  /**
   * GETDEL — atomically GET a key and DELETE it in a single command.
   * Use for one-time-consume semantics (e.g., SIWE nonce replay prevention).
   * Returns the previous value, or null if key did not exist.
   */
  async getdel<T = string>(key: string): Promise<T | null> {
    return this.executeCommand<T>(['GETDEL', key]);
  }

  /**
   * SET key value di Redis dengan optional TTL (dalam detik).
   */
  async set(key: string, value: string | number | object, ttlSeconds?: number): Promise<boolean> {
    const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const cmd = ttlSeconds && ttlSeconds > 0
      ? ['SET', key, strVal, 'EX', String(ttlSeconds)]
      : ['SET', key, strVal];
    
    const res = await this.executeCommand<string>(cmd);
    return res === 'OK';
  }

  /**
   * INCR counter key untuk sliding-window rate limiting.
   */
  async incr(key: string): Promise<number | null> {
    return this.executeCommand<number>(['INCR', key]);
  }

  /**
   * PUBLISH event message ke Pub/Sub channel.
   */
  async publish(channel: string, message: string): Promise<number> {
    const res = await this.executeCommand<number>(['PUBLISH', channel, message]);
    return res ?? 0;
  }

  /**
   * DELETE key dari Redis.
   */
  async del(key: string): Promise<boolean> {
    const res = await this.executeCommand<number>(['DEL', key]);
    return (res ?? 0) > 0;
  }
}

// Singleton export
export const upstashRedis = new UpstashRedisClient();
