/**
 * Rate Limiter Tests
 * @migrated from shared/security/src/rate-limiter.test.ts
 * @see ADR-009: Test Architecture
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RecordingLogger } from '@arbitrage/core';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// RecordingLogger instance that will be populated by the mock factory
// This must be declared before jest.mock() but populated inside the factory
let recordingLogger: RecordingLogger;

const mockRedis: Record<string, jest.Mock<any>> = {
  multi: jest.fn<any>(),
  zremrangebyscore: jest.fn<any>(),
  zadd: jest.fn<any>(),
  zcard: jest.fn<any>(),
  expire: jest.fn<any>(),
  exec: jest.fn<any>(),
  del: jest.fn<any>(),
  zrange: jest.fn<any>(),
  keys: jest.fn<any>(),
  scan: jest.fn<any>()
};

// Set up default mock implementations (these can be overridden in tests)
const setupMockDefaults = () => {
  // Multi returns self for chaining
  mockRedis.multi.mockReturnValue(mockRedis);
  mockRedis.zremrangebyscore.mockReturnValue(mockRedis);
  mockRedis.zadd.mockReturnValue(mockRedis);
  mockRedis.zcard.mockReturnValue(mockRedis);
  mockRedis.expire.mockReturnValue(mockRedis);
  mockRedis.exec.mockResolvedValue([]);
  mockRedis.del.mockResolvedValue(1);
  mockRedis.zrange.mockResolvedValue([]);
  mockRedis.keys.mockResolvedValue([]);
  mockRedis.scan.mockResolvedValue(['0', []]);
};

// Mock dependencies - use the actual import paths that RateLimiter uses
// From rate-limiter.ts: import { createLogger } from '../../core/src/logger';
// rate-limiter.ts is at shared/security/src/
// The test mocks need to use the actual resolved module path
jest.mock('../../../core/src/logger', () => {
  // Import RecordingLogger inside the factory to avoid hoisting issues
  // Using direct path to avoid circular dependency issues with barrel exports
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RecordingLogger: RL } = require('../../../core/src/logging/testing-logger');
  // Create a single instance that will be reused
  const logger = new RL();
  return {
    createLogger: () => {
      // Store reference so tests can access it
      recordingLogger = logger;
      return logger;
    }
  };
});

jest.mock('../../../core/src/redis', () => ({
  getRedisClient: () => Promise.resolve(mockRedis)
}));

import { RateLimiter } from '../../src/rate-limiter';

describe('RateLimiter', () => {
  // Helper to create RateLimiter with proper configuration
  const createRateLimiter = () => new RateLimiter({
    windowMs: 60000, // 1 minute
    maxRequests: 10,
    keyPrefix: 'test'
  });

  beforeEach(() => {
    // Reset all mocks first
    jest.resetAllMocks();
    // Clear recorded logs (recordingLogger is set when RateLimiter is created)
    if (recordingLogger) {
      recordingLogger.clear();
    }
    // Set up default implementations
    setupMockDefaults();
  });

  describe('checkLimit', () => {
    it('should allow requests within limit', async () => {
      // Mock Redis responses for within limit
      mockRedis.exec.mockResolvedValue([
        [null, 0], // zremrangebyscore
        [null, 1], // zadd
        [null, 5], // zcard (5 requests so far)
        [null, 1]  // expire
      ]);

      const rateLimiter = createRateLimiter();
      const result = await rateLimiter.checkLimit('user_123');

      expect(result.exceeded).toBe(false);
      expect(result.remaining).toBe(5); // 10 - 5 = 5
      expect(result.total).toBe(10);
      expect(recordingLogger.getLogs('warn').length).toBe(0);
    });

    it('should block requests over limit', async () => {
      // Mock Redis responses for over limit
      mockRedis.exec.mockResolvedValue([
        [null, 0], // zremrangebyscore
        [null, 1], // zadd
        [null, 12], // zcard (12 requests, over limit of 10)
        [null, 1]  // expire
      ]);

      const rateLimiter = createRateLimiter();
      const result = await rateLimiter.checkLimit('user_123');

      expect(result.exceeded).toBe(true);
      expect(result.remaining).toBe(0);
      expect(recordingLogger.hasLogMatching('warn', 'Rate limit exceeded')).toBe(true);
    });

    it('should handle Redis errors gracefully', async () => {
      mockRedis.exec.mockRejectedValue(new Error('Redis connection failed'));

      const rateLimiter = createRateLimiter();
      const result = await rateLimiter.checkLimit('user_123');

      // Should fail open (allow request) on Redis error
      expect(result.exceeded).toBe(false);
      expect(result.total).toBe(10);
      expect(recordingLogger.hasLogMatching('error', 'Rate limiter error')).toBe(true);
    });

    it('should calculate reset time correctly', async () => {
      const now = Date.now();
      const oldestTimestamp = now - 30000; // 30 seconds ago

      mockRedis.exec.mockResolvedValue([
        [null, 0], // zremrangebyscore
        [null, 1], // zadd
        [null, 5], // zcard
        [null, 1]  // expire
      ]);
      mockRedis.zrange.mockResolvedValue([oldestTimestamp.toString(), oldestTimestamp.toString()]);

      const rateLimiter = createRateLimiter();
      const result = await rateLimiter.checkLimit('user_123');

      // Reset time should be oldest timestamp + window duration
      expect(result.resetTime).toBe(oldestTimestamp + 60000);
    });
  });

  describe('middleware', () => {
    let mockReq: any;
    let mockRes: any;
    let mockNext: jest.Mock<any>;

    beforeEach(() => {
      mockReq = {
        ip: '127.0.0.1',
        headers: {},
        user: null
      };

      mockRes = {
        set: jest.fn<any>(),
        status: jest.fn<any>().mockReturnThis(),
        json: jest.fn<any>()
      };

      mockNext = jest.fn<any>();
    });

    it('should allow requests within limit', async () => {
      mockRedis.exec.mockResolvedValue([
        [null, 0], [null, 1], [null, 5], [null, 1]
      ]);

      const rateLimiter = createRateLimiter();
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
      mockRedis.exec.mockResolvedValue([
        [null, 0], [null, 1], [null, 12], [null, 1]
      ]);

      const rateLimiter = createRateLimiter();
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
      mockRedis.exec.mockResolvedValue([
        [null, 0], [null, 1], [null, 3], [null, 1]
      ]);

      const rateLimiter = createRateLimiter();
      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      expect(mockRedis.exec).toHaveBeenCalled();
    });

    it('should use user ID when authenticated', async () => {
      mockReq.user = { id: 'user_456' };
      mockRedis.exec.mockResolvedValue([
        [null, 0], [null, 1], [null, 3], [null, 1]
      ]);

      const rateLimiter = createRateLimiter();
      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should fallback to IP address', async () => {
      mockRedis.exec.mockResolvedValue([
        [null, 0], [null, 1], [null, 3], [null, 1]
      ]);

      const rateLimiter = createRateLimiter();
      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle middleware errors gracefully', async () => {
      mockRedis.exec.mockRejectedValue(new Error('Redis error'));

      const rateLimiter = createRateLimiter();
      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      // Should fail open
      expect(mockNext).toHaveBeenCalled();
      expect(recordingLogger.hasLogMatching('error', 'Rate limiter error')).toBe(true);
    });
  });

  describe('resetLimit', () => {
    it('should reset rate limit for identifier', async () => {
      mockRedis.del.mockResolvedValue(1);

      const rateLimiter = createRateLimiter();
      await rateLimiter.resetLimit('user_123');

      expect(mockRedis.del).toHaveBeenCalledWith('test:user_123');
      expect(recordingLogger.hasLogMatching('debug', 'Rate limit reset')).toBe(true);
      expect(recordingLogger.hasLogWithMeta('debug', { identifier: 'user_123' })).toBe(true);
    });
  });

  describe('getLimitStatus', () => {
    it('should return current limit status', async () => {
      // Mock the multi.exec() to return all 3 results
      mockRedis.exec.mockResolvedValue([
        [null, 0], // zremrangebyscore
        [null, 7], // zcard
        [null, ['timestamp', '1234567890']] // zrange with WITHSCORES returns [key, score]
      ]);

      const rateLimiter = createRateLimiter();
      const status = await rateLimiter.getLimitStatus('user_123');

      expect(status).toEqual({
        remaining: 3, // 10 - 7 = 3
        resetTime: 1234567890 + 60000, // oldest + window
        total: 10,
        exceeded: false
      });
    });

    it('should handle errors gracefully', async () => {
      mockRedis.exec.mockRejectedValue(new Error('Redis error'));

      const rateLimiter = createRateLimiter();
      const status = await rateLimiter.getLimitStatus('user_123');

      expect(status).toBeNull();
      expect(recordingLogger.getLogs('error').length).toBeGreaterThan(0);
    });
  });

  describe('cleanup', () => {
    // P1-3 FIX: Updated tests to use SCAN instead of KEYS
    it('should clean up old rate limit data', async () => {
      const oldKeys = ['test:user1', 'test:user2'];
      // SCAN returns [cursor, keys[]] - '0' cursor means done
      mockRedis.scan.mockResolvedValue(['0', oldKeys]);
      mockRedis.zcard.mockResolvedValue(0); // Empty sets

      const rateLimiter = createRateLimiter();
      await rateLimiter.cleanup();

      expect(mockRedis.scan).toHaveBeenCalledWith('0', 'MATCH', 'test:*', 'COUNT', 100);
      expect(mockRedis.del).toHaveBeenCalledTimes(oldKeys.length);
      expect(recordingLogger.hasLogMatching('info', 'Rate limiter cleanup completed')).toBe(true);
      expect(recordingLogger.hasLogWithMeta('info', { keysProcessed: 2 })).toBe(true);
    });

    it('should handle cleanup errors gracefully', async () => {
      mockRedis.scan.mockRejectedValue(new Error('Redis error'));

      const rateLimiter = createRateLimiter();
      await rateLimiter.cleanup();

      expect(recordingLogger.hasLogMatching('error', 'Rate limiter cleanup failed')).toBe(true);
    });
  });
});
