// Rate limiting implementation with Redis backend
// Protects against abuse and ensures fair resource usage
//
// P0-3 FIX: Added proper async initialization for Redis client
// P1-3 FIX: Replace KEYS with SCAN in cleanup()

import crypto from 'crypto';
import { createLogger } from '@arbitrage/core';
import { getRedisClient, RedisClient } from '@arbitrage/core';

const logger = createLogger('rate-limiter');

export interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  keyPrefix?: string; // Redis key prefix
  skipSuccessfulRequests?: boolean; // Don't count successful requests
  skipFailedRequests?: boolean; // Don't count failed requests
  /** S-4 FIX: Whether to fail open (allow requests) when Redis is unavailable.
   *  Default: false (fail closed - deny requests when rate limiting is unavailable).
   *  Set to true only for non-critical endpoints where availability > security. */
  failOpen?: boolean;
}

export interface RateLimitInfo {
  remaining: number;
  resetTime: number;
  total: number;
  exceeded: boolean;
}

/**
 * Fail-mode metrics for monitoring rate limiter behavior under Redis failures.
 * Queryable via RateLimiter.getFailModeMetrics().
 *
 * @see Task 2.4: FailOpen/FailClosed audit
 */
export interface FailModeMetrics {
  /** Times rate limiter failed OPEN (allowed request despite Redis being down) */
  failOpenCount: number;
  /** Times rate limiter failed CLOSED (denied request because Redis is down) */
  failClosedCount: number;
}

export class RateLimiter {
  // P0-3 FIX: Properly typed Redis client with async initialization
  private redis: RedisClient | null = null;
  private redisPromise: Promise<RedisClient> | null = null;
  private config: RateLimitConfig;
  private keyPrefix: string;
  // Task 2.4: Fail-mode tracking counters
  private failOpenCount = 0;
  private failClosedCount = 0;

  constructor(config: RateLimitConfig) {
    this.config = {
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      keyPrefix: 'ratelimit',
      failOpen: false, // S-4 FIX: Default to fail-closed for security
      ...config
    };
    this.keyPrefix = this.config.keyPrefix!;
    // P0-3 FIX: Start async initialization (don't block constructor)
    this.initializeRedis();
  }

  /**
   * P0-3 FIX: Async Redis initialization
   */
  private async initializeRedis(): Promise<RedisClient> {
    if (this.redis) {
      return this.redis;
    }

    if (this.redisPromise) {
      return this.redisPromise;
    }

    this.redisPromise = getRedisClient().then(client => {
      this.redis = client;
      return client;
    }).catch(err => {
      // Clear cached promise so next call retries instead of returning the same rejection
      this.redisPromise = null;
      throw err;
    });

    return this.redisPromise;
  }

  /**
   * P0-3 FIX: Get Redis client, waiting for initialization if needed
   */
  private async getRedis(): Promise<RedisClient> {
    if (this.redis) {
      return this.redis;
    }
    return this.initializeRedis();
  }

  async checkLimit(identifier: string, additionalConfig?: Partial<RateLimitConfig>): Promise<RateLimitInfo> {
    const config = { ...this.config, ...additionalConfig };
    const key = `${this.keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    try {
      // P0-3 FIX: Await Redis client initialization
      const redis = await this.getRedis();

      // Use Redis sorted set to track requests within the time window
      // Remove old entries and count current ones atomically
      const multi = redis.multi();

      // Remove entries older than the window
      multi.zremrangebyscore(key, 0, windowStart);

      // BUG-001 FIX: Use unique member to prevent under-count when two requests
      // arrive at the same millisecond. Previously used now.toString() which caused
      // duplicate ZADD members, silently dropping one request from the count.
      const uniqueMember = `${now}:${crypto.randomUUID()}`;
      multi.zadd(key, now, uniqueMember);

      // Count remaining requests in window
      multi.zcard(key);

      // Set expiry on the key (slightly longer than window to clean up)
      multi.expire(key, Math.ceil(config.windowMs / 1000) + 60);

      const results = await multi.exec();

      // Q-NEW-2 FIX: multi.exec() returns null when the transaction is aborted
      if (!results) {
        throw new Error('Redis transaction aborted');
      }

      // BUG-007 FIX: Check for individual MULTI command errors. If ZCARD fails,
      // results[2] could be [error, null], and null >= maxRequests evaluates to
      // false, silently allowing all requests (fail-open).
      const zcardResult = results[2];
      if (zcardResult[0]) {
        throw zcardResult[0] as Error;
      }
      const currentCount = zcardResult[1] as number;

      const remaining = Math.max(0, config.maxRequests - currentCount);
      // BUG-002 FIX: Use > instead of >= because currentCount includes the current
      // request (ZADD before ZCARD). With >=, a limit of 10 only allowed 9 requests.
      const exceeded = currentCount > config.maxRequests;

      // Calculate reset time (when oldest request expires)
      const oldestRequest = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const resetTime = oldestRequest.length > 0
        ? parseInt(oldestRequest[1]) + config.windowMs
        : now + config.windowMs;

      const info: RateLimitInfo = {
        remaining,
        resetTime,
        total: config.maxRequests,
        exceeded
      };

      if (exceeded) {
        logger.warn('Rate limit exceeded', {
          identifier,
          currentCount,
          maxRequests: config.maxRequests,
          windowMs: config.windowMs
        });
      }

      return info;
    } catch (error) {
      logger.error('Rate limiter error', { error, identifier, failOpen: config.failOpen });
      // S-4 FIX: Configurable fail-open/fail-closed behavior on Redis error
      // Default: fail CLOSED (deny requests) for security
      // Set failOpen: true for non-critical endpoints where availability > security
      if (config.failOpen) {
        this.failOpenCount++;
        logger.warn('Rate limiter failing OPEN - allowing request (Redis unavailable)', { identifier, failOpenCount: this.failOpenCount });
        return {
          remaining: config.maxRequests,
          resetTime: now + config.windowMs,
          total: config.maxRequests,
          exceeded: false
        };
      }
      // Fail CLOSED: deny request when rate limiting is unavailable
      this.failClosedCount++;
      return {
        remaining: 0,
        resetTime: now + config.windowMs,
        total: config.maxRequests,
        exceeded: true
      };
    }
  }

  /** Get fail-mode metrics for monitoring. @see Task 2.4 */
  getFailModeMetrics(): FailModeMetrics {
    return { failOpenCount: this.failOpenCount, failClosedCount: this.failClosedCount };
  }

  async resetLimit(identifier: string): Promise<void> {
    const key = `${this.keyPrefix}:${identifier}`;
    const redis = await this.getRedis();
    await redis.del(key);
    logger.debug('Rate limit reset', { identifier });
  }

  // Middleware for Express
  middleware(config?: Partial<RateLimitConfig>) {
    return async (req: any, res: any, next: any) => {
      try {
        const identifier = this.getIdentifier(req);
        const finalConfig = { ...this.config, ...config };

        const limitInfo = await this.checkLimit(identifier, finalConfig);

        // Set rate limit headers
        res.set({
          'X-RateLimit-Limit': limitInfo.total,
          'X-RateLimit-Remaining': limitInfo.remaining,
          'X-RateLimit-Reset': Math.ceil(limitInfo.resetTime / 1000),
          'X-RateLimit-Window': finalConfig.windowMs
        });

        if (limitInfo.exceeded) {
          const retryAfter = Math.ceil((limitInfo.resetTime - Date.now()) / 1000);

          return res.status(429).json({
            error: 'Too many requests',
            message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
            retryAfter,
            limit: limitInfo.total,
            remaining: limitInfo.remaining,
            resetTime: new Date(limitInfo.resetTime).toISOString()
          });
        }

        // Store limit info for use in response
        req.rateLimit = limitInfo;
        next();
      } catch (error) {
        logger.error('Rate limiter middleware error', { error, failOpen: this.config.failOpen });
        // S-4 FIX: Respect failOpen configuration
        if (this.config.failOpen) {
          logger.warn('Rate limiter middleware failing OPEN - allowing request');
          next();
        } else {
          return res.status(503).json({
            error: 'Rate limiting unavailable',
            message: 'Rate limiting service is temporarily unavailable. Please try again later.',
          });
        }
      }
    };
  }

  // Different identifier strategies
  private getIdentifier(req: any): string {
    // Primary: API key from header
    // S-NEW-1 FIX: Hash API key with SHA-256 to avoid exposing plaintext keys in Redis.
    // Anyone with Redis access could previously read raw API keys from rate-limit keys.
    if (req.headers['x-api-key']) {
      const hashedKey = crypto.createHash('sha256')
        .update(req.headers['x-api-key'])
        .digest('hex')
        .substring(0, 16);
      return `api_key:${hashedKey}`;
    }

    // Secondary: JWT token payload (if authenticated)
    if (req.user && req.user.id) {
      return `user:${req.user.id}`;
    }

    // Tertiary: IP address
    const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
    return `ip:${ip}`;
  }

  // Admin method to get rate limit status
  async getLimitStatus(identifier: string): Promise<RateLimitInfo | null> {
    const key = `${this.keyPrefix}:${identifier}`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    try {
      const redis = await this.getRedis();
      const multi = redis.multi();
      multi.zremrangebyscore(key, 0, windowStart);
      multi.zcard(key);
      multi.zrange(key, 0, 0, 'WITHSCORES');

      const results = await multi.exec();

      // Q-NEW-2 FIX: multi.exec() returns null when the transaction is aborted
      if (!results) {
        throw new Error('Redis transaction aborted');
      }

      const currentCount = results[1][1];
      const oldestRequest = results[2][1];

      const resetTime = oldestRequest.length > 0
        ? parseInt(oldestRequest[1]) + this.config.windowMs
        : now + this.config.windowMs;

      return {
        remaining: Math.max(0, this.config.maxRequests - currentCount),
        resetTime,
        total: this.config.maxRequests,
        exceeded: currentCount >= this.config.maxRequests
      };
    } catch (error) {
      logger.error('Error getting rate limit status', { error, identifier });
      return null;
    }
  }

  // Clean up old rate limit data (maintenance method)
  // P1-3 FIX: Use SCAN instead of KEYS to avoid blocking Redis
  async cleanup(maxAge: number = 24 * 60 * 60 * 1000): Promise<void> {
    try {
      const redis = await this.getRedis();
      const cutoff = Date.now() - maxAge;
      const pattern = `${this.keyPrefix}:*`;

      // P1-3 FIX: Use SCAN iterator instead of KEYS
      let keysProcessed = 0;
      let cursor = '0';

      do {
        // SCAN returns [cursor, keys[]]
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;

        for (const key of keys) {
          // Remove entries older than cutoff
          await redis.zremrangebyscore(key, 0, cutoff);

          // If set is empty, delete the key
          const count = await redis.zcard(key);
          if (count === 0) {
            await redis.del(key);
          }
          keysProcessed++;
        }
      } while (cursor !== '0');

      logger.info('Rate limiter cleanup completed', { keysProcessed });
    } catch (error) {
      logger.error('Rate limiter cleanup failed', { error });
    }
  }
}

// Factory functions for common rate limit configurations
export function createApiRateLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 100, // 100 requests per minute
    keyPrefix: 'api'
  });
}

export function createArbitrageRateLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 10 * 1000, // 10 seconds
    maxRequests: 50, // 50 arbitrage requests per 10 seconds
    keyPrefix: 'arbitrage'
  });
}

export function createAuthRateLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 5, // 5 login attempts per 15 minutes
    keyPrefix: 'auth'
  });
}

// Strict rate limiter for critical operations
export function createCriticalRateLimiter(): RateLimiter {
  return new RateLimiter({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10, // 10 critical operations per minute
    keyPrefix: 'critical'
  });
}