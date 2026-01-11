// Rate Limiter Tests
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  info: jest.fn()
};

const mockRedis: Record<string, jest.Mock> = {
  multi: jest.fn().mockReturnThis(),
  zremrangebyscore: jest.fn().mockReturnThis(),
  zadd: jest.fn().mockReturnThis(),
  zcard: jest.fn(() => Promise.resolve(0)),
  expire: jest.fn().mockReturnThis(),
  exec: jest.fn(() => Promise.resolve([] as Array<[null, number]>)),
  del: jest.fn(() => Promise.resolve(1)),
  zrange: jest.fn(() => Promise.resolve([] as string[])),
  keys: jest.fn(() => Promise.resolve([] as string[]))
};

// Mock dependencies with factory functions (before import)
jest.mock('../../core/src/logger', () => ({
  createLogger: jest.fn(() => mockLogger)
}));

jest.mock('../../core/src/redis', () => ({
  getRedisClient: jest.fn(() => mockRedis)
}));

import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimiter = new RateLimiter({
      windowMs: 60000, // 1 minute
      maxRequests: 10,
      keyPrefix: 'test'
    });
  });

  describe('checkLimit', () => {
    it('should allow requests within limit', async () => {
      // Mock Redis responses for within limit
      mockRedis.exec.mockImplementation(() => Promise.resolve([
        [null, 0], // zremrangebyscore
        [null, 1], // zadd
        [null, 5], // zcard (5 requests so far)
        [null, 1]  // expire
      ]));

      const result = await rateLimiter.checkLimit('user_123');

      expect(result.exceeded).toBe(false);
      expect(result.remaining).toBe(5); // 10 - 5 = 5
      expect(result.total).toBe(10);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should block requests over limit', async () => {
      // Mock Redis responses for over limit
      mockRedis.exec.mockImplementation(() => Promise.resolve([
        [null, 0], // zremrangebyscore
        [null, 1], // zadd
        [null, 12], // zcard (12 requests, over limit of 10)
        [null, 1]  // expire
      ]));

      const result = await rateLimiter.checkLimit('user_123');

      expect(result.exceeded).toBe(true);
      expect(result.remaining).toBe(0);
      expect(mockLogger.warn).toHaveBeenCalledWith('Rate limit exceeded', expect.any(Object));
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedis.exec.mockImplementation(() => Promise.reject(new Error('Redis connection failed')));

      const result = await rateLimiter.checkLimit('user_123');

      // Should fail open (allow request) on Redis error
      expect(result.exceeded).toBe(false);
      expect(result.total).toBe(10);
      expect(mockLogger.error).toHaveBeenCalledWith('Rate limiter error', expect.any(Object));
    });

    it('should calculate reset time correctly', async () => {
      const now = Date.now();
      const oldestTimestamp = now - 30000; // 30 seconds ago

      mockRedis.exec.mockImplementation(() => Promise.resolve([
        [null, 0], // zremrangebyscore
        [null, 1], // zadd
        [null, 5], // zcard
        [null, 1]  // expire
      ]));

      mockRedis.zrange.mockImplementation(() => Promise.resolve([oldestTimestamp.toString(), oldestTimestamp.toString()]));

      const result = await rateLimiter.checkLimit('user_123');

      // Reset time should be oldest timestamp + window duration
      expect(result.resetTime).toBe(oldestTimestamp + 60000);
    });
  });

  describe('middleware', () => {
    let mockReq: any;
    let mockRes: any;
    let mockNext: jest.Mock;

    beforeEach(() => {
      mockReq = {
        ip: '127.0.0.1',
        headers: {},
        user: null
      };

      mockRes = {
        set: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      mockNext = jest.fn();
    });

    it('should allow requests within limit', async () => {
      mockRedis.exec.mockImplementation(() => Promise.resolve([
        [null, 0], [null, 1], [null, 5], [null, 1]
      ]));

      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.set).toHaveBeenCalledWith({
        'X-RateLimit-Limit': 10,
        'X-RateLimit-Remaining': 5,
        'X-RateLimit-Reset': expect.any(Number),
        'X-RateLimit-Window': 60000
      });
      expect(mockReq.rateLimit).toBeDefined();
    });

    it('should block requests over limit', async () => {
      mockRedis.exec.mockImplementation(() => Promise.resolve([
        [null, 0], [null, 1], [null, 12], [null, 1]
      ]));

      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(429);
      expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Too many requests',
        retryAfter: expect.any(Number)
      }));
    });

    it('should use API key for identification', async () => {
      mockReq.headers['x-api-key'] = 'test-api-key';
      mockRedis.exec.mockImplementation(() => Promise.resolve([
        [null, 0], [null, 1], [null, 3], [null, 1]
      ]));

      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      expect(mockRedis.exec).toHaveBeenCalled();
      // The key should be based on API key
    });

    it('should use user ID when authenticated', async () => {
      mockReq.user = { id: 'user_456' };
      mockRedis.exec.mockImplementation(() => Promise.resolve([
        [null, 0], [null, 1], [null, 3], [null, 1]
      ]));

      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should fallback to IP address', async () => {
      mockRedis.exec.mockImplementation(() => Promise.resolve([
        [null, 0], [null, 1], [null, 3], [null, 1]
      ]));

      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle middleware errors gracefully', async () => {
      mockRedis.exec.mockImplementation(() => Promise.reject(new Error('Redis error')));

      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      // Should fail open
      expect(mockNext).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith('Rate limiter error', expect.any(Object));
    });
  });

  describe('resetLimit', () => {
    it('should reset rate limit for identifier', async () => {
      mockRedis.del.mockImplementation(() => Promise.resolve(1));

      await rateLimiter.resetLimit('user_123');

      expect(mockRedis.del).toHaveBeenCalledWith('test:user_123');
      expect(mockLogger.debug).toHaveBeenCalledWith('Rate limit reset', { identifier: 'user_123' });
    });
  });

  describe('getLimitStatus', () => {
    it('should return current limit status', async () => {
      // Mock the multi.exec() to return all 3 results
      mockRedis.exec.mockImplementation(() => Promise.resolve([
        [null, 0], // zremrangebyscore
        [null, 7], // zcard
        [null, ['timestamp', '1234567890']] // zrange with WITHSCORES returns [key, score]
      ]));

      const status = await rateLimiter.getLimitStatus('user_123');

      expect(status).toEqual({
        remaining: 3, // 10 - 7 = 3
        resetTime: 1234567890 + 60000, // oldest + window
        total: 10,
        exceeded: false
      });
    });

    it('should handle errors gracefully', async () => {
      mockRedis.exec.mockImplementation(() => Promise.reject(new Error('Redis error')));

      const status = await rateLimiter.getLimitStatus('user_123');

      expect(status).toBeNull();
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should clean up old rate limit data', async () => {
      const oldKeys = ['test:user1', 'test:user2'];
      mockRedis.keys.mockImplementation(() => Promise.resolve(oldKeys));
      mockRedis.zcard.mockImplementation(() => Promise.resolve(0)); // Empty sets

      await rateLimiter.cleanup();

      expect(mockRedis.keys).toHaveBeenCalledWith('test:*');
      expect(mockRedis.del).toHaveBeenCalledTimes(oldKeys.length);
      expect(mockLogger.info).toHaveBeenCalledWith('Rate limiter cleanup completed', { keysProcessed: 2 });
    });

    it('should handle cleanup errors gracefully', async () => {
      mockRedis.keys.mockImplementation(() => Promise.reject(new Error('Redis error')));

      await rateLimiter.cleanup();

      expect(mockLogger.error).toHaveBeenCalledWith('Rate limiter cleanup failed', expect.any(Object));
    });
  });
});