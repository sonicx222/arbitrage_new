/**
 * Rate Limiter Tests
 * @migrated from shared/security/src/rate-limiter.test.ts
 * @see ADR-009: Test Architecture
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RecordingLogger } from '@arbitrage/core/logging';

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

    it('should handle Redis errors gracefully (fail closed by default)', async () => {
      mockRedis.exec.mockRejectedValue(new Error('Redis connection failed'));

      const rateLimiter = createRateLimiter();
      const result = await rateLimiter.checkLimit('user_123');

      // Default failOpen: false — fail CLOSED (deny request) on Redis error
      expect(result.exceeded).toBe(true);
      expect(result.remaining).toBe(0);
      expect(result.total).toBe(10);
      expect(recordingLogger.hasLogMatching('error', 'Rate limiter error')).toBe(true);
    });

    // BUG-001 REGRESSION: ZADD member must be unique to prevent under-count at same ms
    it('should use unique member for ZADD to prevent duplicate-member under-count', async () => {
      mockRedis.exec.mockResolvedValue([
        [null, 0], // zremrangebyscore
        [null, 1], // zadd
        [null, 5], // zcard
        [null, 1]  // expire
      ]);

      const rateLimiter = createRateLimiter();
      await rateLimiter.checkLimit('user_123');

      // The zadd call receives (key, score, member). The member (index 2) should
      // contain a UUID to prevent duplicate members at the same millisecond.
      const zaddCall = mockRedis.zadd.mock.calls[0];
      if (zaddCall && zaddCall.length >= 3) {
        const member = zaddCall[2] as string;
        // Member should match pattern: <timestamp>:<uuid>
        expect(member).toMatch(/^\d+:[0-9a-f-]{36}$/);
      }
    });

    // BUG-002 REGRESSION: maxRequests=10, zcard=10 (10th request) must NOT exceed
    it('should allow exactly maxRequests requests (off-by-one fix)', async () => {
      mockRedis.exec.mockResolvedValue([
        [null, 0], // zremrangebyscore
        [null, 1], // zadd
        [null, 10], // zcard — this is the 10th request (current included)
        [null, 1]  // expire
      ]);

      const rateLimiter = createRateLimiter();
      const result = await rateLimiter.checkLimit('user_123');

      // With maxRequests=10, the 10th request (zcard=10) must be allowed
      expect(result.exceeded).toBe(false);
      expect(result.remaining).toBe(0);
    });

    // BUG-002 REGRESSION: maxRequests=10, zcard=11 (11th request) must exceed
    it('should exceed when requests are above maxRequests', async () => {
      mockRedis.exec.mockResolvedValue([
        [null, 0], // zremrangebyscore
        [null, 1], // zadd
        [null, 11], // zcard — this is the 11th request
        [null, 1]  // expire
      ]);

      const rateLimiter = createRateLimiter();
      const result = await rateLimiter.checkLimit('user_123');

      expect(result.exceeded).toBe(true);
      expect(result.remaining).toBe(0);
    });

    // BUG-007 REGRESSION: ZCARD command error must not silently allow requests
    it('should throw when ZCARD command fails within MULTI (not fail-open)', async () => {
      const zcardError = new Error('ZCARD command failed');
      mockRedis.exec.mockResolvedValue([
        [null, 0],        // zremrangebyscore OK
        [null, 1],        // zadd OK
        [zcardError, null], // zcard FAILED
        [null, 1]         // expire OK
      ]);

      const rateLimiter = createRateLimiter();
      const result = await rateLimiter.checkLimit('user_123');

      // Should fail closed (default), not silently allow
      expect(result.exceeded).toBe(true);
      expect(result.remaining).toBe(0);
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

    it('should handle middleware errors gracefully (fail closed by default)', async () => {
      mockRedis.exec.mockRejectedValue(new Error('Redis error'));

      const rateLimiter = createRateLimiter();
      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      // Default failOpen: false — checkLimit fail-closed returns exceeded:true,
      // middleware responds with 429 (not 503 from middleware catch, since checkLimit handles it)
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(429);
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

  describe('getIdentifier (via middleware)', () => {
    let mockReq: any;
    let mockRes: any;
    let mockNext: jest.Mock<any>;

    beforeEach(() => {
      mockReq = { ip: '127.0.0.1', headers: {}, user: null };
      mockRes = { set: jest.fn<any>(), status: jest.fn<any>().mockReturnThis(), json: jest.fn<any>() };
      mockNext = jest.fn<any>();
    });

    // S-NEW-1 REGRESSION: API keys must be hashed in Redis keys
    it('should hash API key in Redis key (not store plaintext)', async () => {
      mockReq.headers['x-api-key'] = 'my-secret-api-key-12345';
      mockRedis.exec.mockResolvedValue([
        [null, 0], [null, 1], [null, 3], [null, 1]
      ]);

      const rateLimiter = createRateLimiter();
      const middleware = rateLimiter.middleware();
      await middleware(mockReq, mockRes, mockNext);

      // The Redis key should NOT contain the raw API key
      const zaddCall = mockRedis.zadd.mock.calls[0];
      // zadd is called as part of multi chain: multi.zadd(key, score, member)
      // But since multi returns self (mock chaining), we need to check differently.
      // The key is passed to zremrangebyscore which is the first in the chain
      const zremCall = mockRedis.zremrangebyscore.mock.calls[0];
      if (zremCall && zremCall[0]) {
        const redisKey = zremCall[0] as string;
        // Key should NOT contain the raw API key
        expect(redisKey).not.toContain('my-secret-api-key-12345');
        // Key should contain the 'api_key:' prefix with a hash
        expect(redisKey).toMatch(/test:api_key:[a-f0-9]{16}/);
      }
    });
  });

  describe('multi.exec() null check', () => {
    // Q-NEW-2 REGRESSION: multi.exec() can return null on transaction abort
    it('should handle null multi.exec() result (transaction abort)', async () => {
      mockRedis.exec.mockResolvedValue(null);

      const rateLimiter = createRateLimiter();
      const result = await rateLimiter.checkLimit('user_123');

      // Should fail closed when transaction aborts
      expect(result.exceeded).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('should handle null multi.exec() in getLimitStatus', async () => {
      mockRedis.exec.mockResolvedValue(null);

      const rateLimiter = createRateLimiter();
      const status = await rateLimiter.getLimitStatus('user_123');

      // Should return null on transaction abort
      expect(status).toBeNull();
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
