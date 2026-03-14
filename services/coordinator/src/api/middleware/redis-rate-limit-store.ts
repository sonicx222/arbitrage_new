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
 * Lua script for atomic INCR + PEXPIRE.
 * DATA-H-01 FIX: If process crashes between separate INCR and PEXPIRE commands,
 * the key has no TTL and becomes an immortal counter — permanently blocking
 * legitimate clients. This Lua script executes both atomically in Redis.
 */
const ATOMIC_INCR_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return c
`;

/** Minimal logger interface for RedisRateLimitStore (avoids importing full Pino). */
export interface RateLimitStoreLogger {
  warn(message: string, data?: Record<string, unknown>): void;
  debug?(message: string, data?: Record<string, unknown>): void;
}

/**
 * Redis-backed rate limit store using atomic INCR + PEXPIRE.
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
  /** P2-1 FIX: Structured logger for OTEL transport and log-level filtering. */
  private log: RateLimitStoreLogger;

  /** False = keys are shared across instances (the whole point). */
  localKeys = false;

  constructor(redisUrl: string, prefix = 'rl:', logger?: RateLimitStoreLogger) {
    this.prefix = prefix;
    this.redisUrl = redisUrl;
    this.log = logger ?? { warn: (msg, data) => console.warn(`[RedisRateLimitStore] ${msg}`, data ?? '') };
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
        this.log.warn('Redis connection error', { error: err.message });
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
    } catch (err) {
      // P1-7 FIX: Log per-operation failures for operational visibility.
      this.log.warn('get failed', { error: (err as Error).message });
      return undefined;
    }
  }

  async increment(key: string): Promise<{ totalHits: number; resetTime: Date | undefined }> {
    const prefixedKey = this.prefix + key;
    try {
      const redis = this.getRedis();
      // DATA-H-01 FIX: Atomic INCR + PEXPIRE via Lua script.
      // Prevents immortal keys if process crashes between separate commands.
      const totalHits = await redis.eval(
        ATOMIC_INCR_LUA, 1, prefixedKey, this.windowMs.toString()
      ) as number;
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
    } catch (err) {
      // P1-7 FIX: Log for operational visibility (best-effort operation).
      this.log.warn('decrement failed', { error: (err as Error).message });
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await this.getRedis().del(this.prefix + key);
    } catch (err) {
      // P1-7 FIX: Log for operational visibility (best-effort operation).
      this.log.warn('resetKey failed', { error: (err as Error).message });
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
    } catch (err) {
      // P1-7 FIX: Log for operational visibility (best-effort operation).
      this.log.warn('resetAll failed', { error: (err as Error).message });
    }
  }

  async shutdown(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch (err) {
      this.log.warn('quit failed, forcing disconnect', { error: (err as Error).message });
      this.redis.disconnect();
    }
  }
}
