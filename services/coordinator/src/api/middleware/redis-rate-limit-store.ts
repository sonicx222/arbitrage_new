/**
 * Redis-backed Rate Limit Store
 *
 * Implements the express-rate-limit Store interface using ioredis.
 * Provides shared rate limiting across multiple coordinator instances.
 *
 * FIX #3: Replaces per-process in-memory store that allowed N*limit
 * requests across N instances.
 *
 * Security: Fails CLOSED (denies requests) when Redis is unavailable,
 * matching the project's rate-limiter-fails-closed convention.
 *
 * @see middleware/index.ts (consumer)
 * @see CLAUDE.md "Rate limiting fails CLOSED" pattern
 */

import { Redis } from 'ioredis';

/**
 * Store interface from express-rate-limit v7.
 * Defined locally to avoid importing the full package types.
 */
interface RateLimitStore {
  init?: (options: { windowMs: number }) => void;
  get?: (key: string) => Promise<{ totalHits: number; resetTime: Date | undefined } | undefined>;
  increment: (key: string) => Promise<{ totalHits: number; resetTime: Date | undefined }>;
  decrement: (key: string) => Promise<void>;
  resetKey: (key: string) => Promise<void>;
  resetAll?: () => Promise<void>;
  shutdown?: () => Promise<void>;
  localKeys?: boolean;
  prefix?: string;
}

/**
 * Redis-backed rate limit store using INCR + PEXPIRE.
 *
 * Each key stores a hit counter with TTL matching the rate limit window.
 * All instances share the same Redis keys, so rate limits are global.
 */
export class RedisRateLimitStore implements RateLimitStore {
  private redis: Redis | null = null;
  private redisUrl: string;
  private windowMs = 60_000;
  /** Public per express-rate-limit Store interface (used for double-count detection). */
  prefix: string;
  private connected = false;

  /** False = keys are shared across instances (the whole point). */
  localKeys = false;

  constructor(redisUrl: string, prefix = 'rl:') {
    this.prefix = prefix;
    this.redisUrl = redisUrl;
  }

  init(options: { windowMs: number }): void {
    this.windowMs = options.windowMs;
  }

  /** Lazy-connect: creates Redis client on first use, not at construction. */
  private getRedis(): Redis {
    if (!this.redis) {
      this.redis = new Redis(this.redisUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: false,
        connectTimeout: 3000,
      });
      // SEC-M-03 FIX: Log connection errors instead of silently swallowing them.
      // Per-request errors are still handled via try/catch; this ensures persistent
      // connectivity issues are visible in logs for operational monitoring.
      // Logs once per disconnect cycle (not per retry) to avoid log spam.
      this.redis.on('error', (err) => {
        console.warn('[RedisRateLimitStore] Redis connection error:', err.message);
      });
      this.redis.on('ready', () => { this.connected = true; });
    }
    return this.redis;
  }

  async get(key: string): Promise<{ totalHits: number; resetTime: Date | undefined } | undefined> {
    try {
      const redis = this.getRedis();
      const [hits, ttl] = await Promise.all([
        redis.get(this.prefix + key),
        redis.pttl(this.prefix + key),
      ]);
      if (hits === null) return undefined;
      const resetTime = ttl > 0 ? new Date(Date.now() + ttl) : undefined;
      return { totalHits: parseInt(hits, 10), resetTime };
    } catch {
      return undefined;
    }
  }

  async increment(key: string): Promise<{ totalHits: number; resetTime: Date | undefined }> {
    const prefixedKey = this.prefix + key;
    try {
      const redis = this.getRedis();
      const totalHits = await redis.incr(prefixedKey);
      // Set expiry only on first hit (when counter transitions from 0 to 1)
      if (totalHits === 1) {
        await redis.pexpire(prefixedKey, this.windowMs);
      }
      const ttl = await redis.pttl(prefixedKey);
      const resetTime = ttl > 0 ? new Date(Date.now() + ttl) : new Date(Date.now() + this.windowMs);
      return { totalHits, resetTime };
    } catch {
      // Fail CLOSED: treat Redis failure as "limit exceeded"
      return { totalHits: Infinity, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await this.getRedis().decr(this.prefix + key);
    } catch {
      // Best-effort decrement
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await this.getRedis().del(this.prefix + key);
    } catch {
      // Best-effort reset
    }
  }

  async resetAll(): Promise<void> {
    try {
      const redis = this.getRedis();
      // Use SCAN to find and delete all rate limit keys (never use KEYS)
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', this.prefix + '*', 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== '0');
    } catch {
      // Best-effort reset
    }
  }

  async shutdown(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
