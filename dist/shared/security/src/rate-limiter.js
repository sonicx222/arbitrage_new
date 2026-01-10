"use strict";
// Rate limiting implementation with Redis backend
// Protects against abuse and ensures fair resource usage
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = void 0;
exports.createApiRateLimiter = createApiRateLimiter;
exports.createArbitrageRateLimiter = createArbitrageRateLimiter;
exports.createAuthRateLimiter = createAuthRateLimiter;
exports.createCriticalRateLimiter = createCriticalRateLimiter;
const logger_1 = require("../../core/src/logger");
const redis_1 = require("../../core/src/redis");
const logger = (0, logger_1.createLogger)('rate-limiter');
class RateLimiter {
    constructor(config) {
        this.config = {
            skipSuccessfulRequests: false,
            skipFailedRequests: false,
            keyPrefix: 'ratelimit',
            ...config
        };
        this.redis = (0, redis_1.getRedisClient)();
        this.keyPrefix = this.config.keyPrefix;
    }
    async checkLimit(identifier, additionalConfig) {
        const config = { ...this.config, ...additionalConfig };
        const key = `${this.keyPrefix}:${identifier}`;
        const now = Date.now();
        const windowStart = now - config.windowMs;
        try {
            // Use Redis sorted set to track requests within the time window
            // Remove old entries and count current ones atomically
            const multi = this.redis.multi();
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
            const oldestRequest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
            const resetTime = oldestRequest.length > 0
                ? parseInt(oldestRequest[1]) + config.windowMs
                : now + config.windowMs;
            const info = {
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
        }
        catch (error) {
            logger.error('Rate limiter error', { error, identifier });
            // On error, allow the request to proceed (fail open)
            return {
                remaining: config.maxRequests,
                resetTime: now + config.windowMs,
                total: config.maxRequests,
                exceeded: false
            };
        }
    }
    async resetLimit(identifier) {
        const key = `${this.keyPrefix}:${identifier}`;
        await this.redis.del(key);
        logger.debug('Rate limit reset', { identifier });
    }
    // Middleware for Express
    middleware(config) {
        return async (req, res, next) => {
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
            }
            catch (error) {
                logger.error('Rate limiter middleware error', { error });
                // Fail open - allow the request
                next();
            }
        };
    }
    // Different identifier strategies
    getIdentifier(req) {
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
    async getLimitStatus(identifier) {
        const key = `${this.keyPrefix}:${identifier}`;
        const now = Date.now();
        const windowStart = now - this.config.windowMs;
        try {
            const multi = this.redis.multi();
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
        }
        catch (error) {
            logger.error('Error getting rate limit status', { error, identifier });
            return null;
        }
    }
    // Clean up old rate limit data (maintenance method)
    async cleanup(maxAge = 24 * 60 * 60 * 1000) {
        try {
            const cutoff = Date.now() - maxAge;
            const pattern = `${this.keyPrefix}:*`;
            // Find all rate limit keys
            const keys = await this.redis.keys(pattern);
            for (const key of keys) {
                // Remove entries older than cutoff
                await this.redis.zremrangebyscore(key, 0, cutoff);
                // If set is empty, delete the key
                const count = await this.redis.zcard(key);
                if (count === 0) {
                    await this.redis.del(key);
                }
            }
            logger.info('Rate limiter cleanup completed', { keysProcessed: keys.length });
        }
        catch (error) {
            logger.error('Rate limiter cleanup failed', { error });
        }
    }
}
exports.RateLimiter = RateLimiter;
// Factory functions for common rate limit configurations
function createApiRateLimiter() {
    return new RateLimiter({
        windowMs: 60 * 1000, // 1 minute
        maxRequests: 100, // 100 requests per minute
        keyPrefix: 'api'
    });
}
function createArbitrageRateLimiter() {
    return new RateLimiter({
        windowMs: 10 * 1000, // 10 seconds
        maxRequests: 50, // 50 arbitrage requests per 10 seconds
        keyPrefix: 'arbitrage'
    });
}
function createAuthRateLimiter() {
    return new RateLimiter({
        windowMs: 15 * 60 * 1000, // 15 minutes
        maxRequests: 5, // 5 login attempts per 15 minutes
        keyPrefix: 'auth'
    });
}
// Strict rate limiter for critical operations
function createCriticalRateLimiter() {
    return new RateLimiter({
        windowMs: 60 * 1000, // 1 minute
        maxRequests: 10, // 10 critical operations per minute
        keyPrefix: 'critical'
    });
}
//# sourceMappingURL=rate-limiter.js.map