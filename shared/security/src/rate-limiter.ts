// Rate limiting implementation with Redis backend
// Protects against abuse and ensures fair resource usage
//
// P0-3 FIX: Added proper async initialization for Redis client
// P1-3 FIX: Replace KEYS with SCAN in cleanup()

import { createLogger } from '../../core/src/logger';
import { getRedisClient, RedisClient } from '../../core/src/redis';

const logger = createLogger('rate-limiter');

export interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Maximum requests per window
  keyPrefix?: string; // Redis key prefix
  skipSuccessfulRequests?: boolean; // Don't count successful requests
  skipFailedRequests?: boolean; // Don't count failed requests
}

export interface RateLimitInfo {
  remaining: number;
  resetTime: number;
  total: number;
  exceeded: boolean;
}

export class RateLimiter {
  // P0-3 FIX: Properly typed Redis client with async initialization
  private redis: RedisClient | null = null;
  private redisPromise: Promise<RedisClient> | null = null;
  private config: RateLimitConfig;
  private keyPrefix: string;

  constructor(config: RateLimitConfig) {
    this.config = {
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      keyPrefix: 'ratelimit',
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

      // Add current request timestamp
      multi.zadd(key, now, now.toString());

      // Count remaining requests in window
      multi.zcard(key);

      // Set expiry on the key (slightly longer than window to clean up)
      multi.expire(key, Math.ceil(config.windowMs / 1000) + 60);

      const results = await multi.exec();
      const currentCount = results[2][1];

      const remaining = Math.max(0, config.maxRequests - currentCount);
      const exceeded = currentCount >= config.maxRequests;

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
      logger.error('Rate limiter error', { error, identifier });
      // FIX B10.6: Fail CLOSED on Redis error - block requests when rate limiting is unavailable
      // For DeFi/trading systems, allowing unlimited requests during outage is a security risk
      // that could enable DoS attacks or resource exhaustion
      return {
        remaining: 0,
        resetTime: now + config.windowMs,
        total: config.maxRequests,
        exceeded: true  // Block request when rate limiting unavailable
      };
    }
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
        logger.error('Rate limiter middleware error', { error });
        // FIX B10.6: Fail CLOSED - reject request when rate limiting is unavailable
        // Prevents abuse during Redis outages in DeFi/trading systems
        return res.status(503).json({
          error: 'Service temporarily unavailable',
          message: 'Rate limiting service unavailable. Please try again later.',
          retryAfter: 60
        });
      }
    };
  }

  // Different identifier strategies
  private getIdentifier(req: any): string {
    // Primary: API key from header
    if (req.headers['x-api-key']) {
      return `api_key:${req.headers['x-api-key']}`;
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