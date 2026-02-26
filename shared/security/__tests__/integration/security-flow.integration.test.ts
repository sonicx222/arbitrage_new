/**
 * Security Integration Tests
 *
 * Tests AuthService and RateLimiter with REAL Redis (redis-memory-server).
 *
 * - AuthService: account lockout tracking, token blacklisting via Redis
 * - RateLimiter: rate counting, window expiry, failOpen/failClosed behavior
 * - Combined: rate-limited login flow
 *
 * Uses redis-memory-server (started by jest.globalSetup.ts) for real Redis behavior.
 *
 * @see ADR-009: Test Architecture
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import Redis from 'ioredis';
import {
  createTestRedisClient,
  getTestRedisUrl,
} from '@arbitrage/test-utils';
import { resetRedisInstance } from '@arbitrage/core/redis';
import {
  AuthService,
  resetAuthService,
} from '../../src/auth';
import type { AuthServiceRedis, AuthServiceLogger, User } from '../../src/auth';
import { RateLimiter } from '../../src/rate-limiter';
import type { RateLimitInfo } from '../../src/rate-limiter';

// =============================================================================
// Test Constants
// =============================================================================

const TEST_JWT_SECRET = 'integration-test-jwt-secret-32chars!';
const TEST_USER: User = {
  id: 'user_integration_001',
  username: 'testuser',
  email: 'test@example.com',
  roles: ['user'],
  permissions: ['read:opportunities', 'read:health'],
  isActive: true,
};

// =============================================================================
// Silent Logger (suppresses noise during tests)
// =============================================================================

const silentLogger: AuthServiceLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// =============================================================================
// Helper: Create an AuthServiceRedis adapter from raw ioredis client
// =============================================================================

/**
 * Wraps an ioredis Redis instance to satisfy the AuthServiceRedis interface.
 * The raw ioredis client has compatible methods, but TypeScript needs the
 * explicit adapter for type safety.
 */
function createAuthRedisAdapter(redis: Redis): AuthServiceRedis {
  return {
    get: (key: string) => redis.get(key),
    setex: (key: string, seconds: number, value: string) => redis.setex(key, seconds, value),
    del: (...keys: string[]) => redis.del(...keys),
    incr: (key: string) => redis.incr(key),
    expire: (key: string, seconds: number) => redis.expire(key, seconds),
  };
}

// =============================================================================
// Helper: Generate a JWT token for testing
// =============================================================================

function generateTestToken(
  user: User,
  secret: string = TEST_JWT_SECRET,
  expiresIn: string = '1h'
): string {
  const payload = {
    userId: user.id,
    username: user.username,
    roles: user.roles,
    permissions: user.permissions,
  };
  return jwt.sign(payload as object, secret as Secret, { expiresIn } as SignOptions);
}

// =============================================================================
// Test Suite
// =============================================================================

describe('[Integration] Security Flow — AuthService + RateLimiter with Real Redis', () => {
  let redis: Redis;
  let originalJwtSecret: string | undefined;
  let originalRedisUrl: string | undefined;

  beforeAll(async () => {
    // Save and set environment
    originalJwtSecret = process.env.JWT_SECRET;
    originalRedisUrl = process.env.REDIS_URL;
    process.env.JWT_SECRET = TEST_JWT_SECRET;

    // Set REDIS_URL to test Redis BEFORE creating client
    // (getTestRedisUrl reads from .redis-test-config.json written by globalSetup)
    const testRedisUrl = getTestRedisUrl();
    process.env.REDIS_URL = testRedisUrl;

    // Connect to test Redis
    redis = await createTestRedisClient();
  });

  afterAll(async () => {
    // Restore environment
    if (originalJwtSecret !== undefined) {
      process.env.JWT_SECRET = originalJwtSecret;
    } else {
      delete process.env.JWT_SECRET;
    }
    if (originalRedisUrl !== undefined) {
      process.env.REDIS_URL = originalRedisUrl;
    } else {
      delete process.env.REDIS_URL;
    }

    // Reset singletons
    resetAuthService();
    await resetRedisInstance();

    // Disconnect test Redis
    if (redis) {
      await redis.quit();
    }
  });

  beforeEach(async () => {
    // Clean only our own keys (not flushall) to avoid clobbering other workers' data
    // when integration tests run in parallel with shared Redis.
    if (redis?.status === 'ready') {
      const prefixes = ['auth:', 'test-ratelimit:', 'test-failclosed:', 'test-failopen:', 'test-short:', 'test-login-rate:'];
      for (const prefix of prefixes) {
        let cursor = '0';
        do {
          const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
          cursor = nextCursor;
          if (keys.length > 0) {
            await redis.del(...keys);
          }
        } while (cursor !== '0');
      }
    }

    // Reset the core RedisClient singleton so RateLimiter gets a fresh connection
    await resetRedisInstance();

    // Reset the AuthService singleton
    resetAuthService();
  });

  // ===========================================================================
  // 1. AuthService with real Redis — Account Lockout
  // ===========================================================================

  describe('AuthService — Account Lockout with real Redis', () => {
    let authService: AuthService;

    beforeEach(() => {
      authService = new AuthService({
        logger: silentLogger,
        redis: createAuthRedisAdapter(redis),
      });
    });

    it('should record failed login attempts in Redis', async () => {
      // Attempt login with a non-existent user (findUserByUsername returns null)
      // This triggers recordFailedAttempt which writes to Redis
      await expect(
        authService.login({ username: 'nonexistent', password: 'password123' })
      ).rejects.toThrow('Invalid username or password');

      // Verify the attempts key was created in Redis
      const attempts = await redis.get('auth:attempts:nonexistent');
      expect(attempts).toBe('1');
    });

    it('should lock account after maxLoginAttempts (5) failed attempts', async () => {
      const username = 'lockme';

      // Make 5 failed login attempts (maxLoginAttempts = 5)
      for (let i = 0; i < 5; i++) {
        await expect(
          authService.login({ username, password: 'wrongpass' })
        ).rejects.toThrow('Invalid username or password');
      }

      // Verify lockout key exists in Redis
      const lockoutValue = await redis.get(`auth:lockout:${username}`);
      expect(lockoutValue).not.toBeNull();

      // The lockout value is a future timestamp
      const lockoutTime = parseInt(lockoutValue!);
      expect(lockoutTime).toBeGreaterThan(Date.now());

      // Next login attempt should throw lockout error
      await expect(
        authService.login({ username, password: 'anypass' })
      ).rejects.toThrow(/Account locked/);
    });

    it('should clear lockout via unlockAccount', async () => {
      const username = 'locked_user';

      // Create a lockout by making 5 failed attempts
      for (let i = 0; i < 5; i++) {
        await expect(
          authService.login({ username, password: 'wrongpass' })
        ).rejects.toThrow('Invalid username or password');
      }

      // Verify lockout exists
      const lockoutBefore = await redis.get(`auth:lockout:${username}`);
      expect(lockoutBefore).not.toBeNull();

      // Unlock the account
      await authService.unlockAccount(username);

      // Verify lockout and attempts keys are cleared
      const lockoutAfter = await redis.get(`auth:lockout:${username}`);
      const attemptsAfter = await redis.get(`auth:attempts:${username}`);
      expect(lockoutAfter).toBeNull();
      expect(attemptsAfter).toBeNull();
    });

    it('should increment attempt counter correctly across multiple failures', async () => {
      const username = 'counter_user';

      // Make 3 failed attempts
      for (let i = 0; i < 3; i++) {
        await expect(
          authService.login({ username, password: 'wrong' })
        ).rejects.toThrow('Invalid username or password');
      }

      // Verify counter is at 3 (not yet locked out at maxLoginAttempts=5)
      const attempts = await redis.get(`auth:attempts:${username}`);
      expect(attempts).toBe('3');

      // Verify no lockout yet
      const lockout = await redis.get(`auth:lockout:${username}`);
      expect(lockout).toBeNull();
    });
  });

  // ===========================================================================
  // 2. AuthService with real Redis — Token Blacklisting
  // ===========================================================================

  describe('AuthService — Token Blacklisting with real Redis', () => {
    let authService: AuthService;

    beforeEach(() => {
      authService = new AuthService({
        logger: silentLogger,
        redis: createAuthRedisAdapter(redis),
      });
    });

    it('should blacklist a token on logout via Redis', async () => {
      const token = generateTestToken(TEST_USER);

      // Logout should blacklist the token in Redis
      await authService.logout(token);

      // Verify the blacklist key exists in Redis
      const blacklistValue = await redis.get(`auth:blacklist:${token}`);
      expect(blacklistValue).toBe('revoked');
    });

    it('should set correct TTL on blacklisted token', async () => {
      // Generate a token with known expiry
      const token = generateTestToken(TEST_USER, TEST_JWT_SECRET, '2h');

      await authService.logout(token);

      // Verify TTL is set (should be roughly 2 hours = 7200 seconds)
      const ttl = await redis.ttl(`auth:blacklist:${token}`);
      expect(ttl).toBeGreaterThan(7100); // Allow small tolerance
      expect(ttl).toBeLessThanOrEqual(7200);
    });

    it('should return null from validateToken when token is blacklisted', async () => {
      const token = generateTestToken(TEST_USER);

      // Blacklist the token
      await authService.logout(token);

      // validateToken should return null for blacklisted token
      // (Note: even without blacklisting, validateToken returns null because
      //  findUserById is a stub, but the blacklist check happens first)
      const result = await authService.validateToken(token);
      expect(result).toBeNull();
    });

    it('should not blacklist an already-expired token (TTL <= 0)', async () => {
      // Generate an expired token (expiresIn: '0s' creates a token that is immediately expired)
      // jwt.sign with expiresIn: '1s' and then we wait, but that's flaky.
      // Instead, create a token with exp in the past using manual payload:
      const payload = {
        userId: TEST_USER.id,
        username: TEST_USER.username,
        roles: TEST_USER.roles,
        permissions: TEST_USER.permissions,
        exp: Math.floor(Date.now() / 1000) - 60, // expired 1 minute ago
        iat: Math.floor(Date.now() / 1000) - 120,
      };
      const expiredToken = jwt.sign(payload as object, TEST_JWT_SECRET as Secret);

      await authService.logout(expiredToken);

      // TTL would be <= 0, so setex should NOT be called (code checks ttl > 0)
      const blacklistValue = await redis.get(`auth:blacklist:${expiredToken}`);
      expect(blacklistValue).toBeNull();
    });
  });

  // ===========================================================================
  // 3. RateLimiter with real Redis
  // ===========================================================================

  describe('RateLimiter — with real Redis', () => {
    let rateLimiter: RateLimiter;

    beforeEach(async () => {
      // Reset the core Redis singleton so RateLimiter gets a fresh connection
      // pointing to our test Redis (REDIS_URL already set in beforeAll)
      await resetRedisInstance();

      rateLimiter = new RateLimiter({
        windowMs: 60000, // 1 minute
        maxRequests: 5,
        keyPrefix: 'test-ratelimit',
      });
    });

    it('should allow requests under the limit', async () => {
      const result = await rateLimiter.checkLimit('user:test1');

      expect(result.exceeded).toBe(false);
      expect(result.remaining).toBe(4); // 5 max - 1 current = 4
      expect(result.total).toBe(5);
    });

    it('should count requests correctly', async () => {
      // Make 3 requests
      let result: RateLimitInfo;
      for (let i = 0; i < 3; i++) {
        result = await rateLimiter.checkLimit('user:counter');
      }

      expect(result!.remaining).toBe(2); // 5 max - 3 used = 2
      expect(result!.exceeded).toBe(false);
    });

    it('should return exceeded after maxRequests', async () => {
      // Make exactly maxRequests (5) requests
      for (let i = 0; i < 5; i++) {
        await rateLimiter.checkLimit('user:exceed');
      }

      // 6th request should be exceeded
      const result = await rateLimiter.checkLimit('user:exceed');
      expect(result.exceeded).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('should track separate identifiers independently', async () => {
      // User A makes 4 requests
      for (let i = 0; i < 4; i++) {
        await rateLimiter.checkLimit('user:A');
      }

      // User B should still have full allowance
      const resultB = await rateLimiter.checkLimit('user:B');
      expect(resultB.exceeded).toBe(false);
      expect(resultB.remaining).toBe(4); // First request for user B
    });

    it('should reset limit via resetLimit', async () => {
      // Use up some requests
      for (let i = 0; i < 4; i++) {
        await rateLimiter.checkLimit('user:reset');
      }

      // Reset the limit
      await rateLimiter.resetLimit('user:reset');

      // Should have full allowance again
      const result = await rateLimiter.checkLimit('user:reset');
      expect(result.exceeded).toBe(false);
      expect(result.remaining).toBe(4); // Fresh start
    });

    it('should respect a small window and expire old entries', async () => {
      // Create a rate limiter with a very short window
      const shortLimiter = new RateLimiter({
        windowMs: 500, // 500ms window
        maxRequests: 2,
        keyPrefix: 'test-short',
      });

      // Use up the limit
      await shortLimiter.checkLimit('user:window');
      await shortLimiter.checkLimit('user:window');
      const exceeded = await shortLimiter.checkLimit('user:window');
      expect(exceeded.exceeded).toBe(true);

      // Wait for the window to expire
      await new Promise(resolve => setTimeout(resolve, 600));

      // Should be allowed again (old entries expired)
      const afterWindow = await shortLimiter.checkLimit('user:window');
      expect(afterWindow.exceeded).toBe(false);
    }, 10000);

    it('should support additionalConfig overrides in checkLimit', async () => {
      // Base limiter has maxRequests=5, but override to maxRequests=2
      await rateLimiter.checkLimit('user:override', { maxRequests: 2 });
      await rateLimiter.checkLimit('user:override', { maxRequests: 2 });

      const result = await rateLimiter.checkLimit('user:override', { maxRequests: 2 });
      expect(result.exceeded).toBe(true);
    });
  });

  // ===========================================================================
  // 4. RateLimiter — failOpen vs failClosed
  // ===========================================================================

  describe('RateLimiter — failOpen vs failClosed behavior', () => {
    // Strategy: Create limiter with real test Redis (fast init), then disconnect
    // the underlying ioredis client to force errors on subsequent operations.
    // This avoids the 25s hang from ioredis retry on dead ports.

    it('should fail CLOSED by default when Redis errors occur', async () => {
      const badLimiter = new RateLimiter({
        windowMs: 60000,
        maxRequests: 10,
        keyPrefix: 'test-failclosed',
        failOpen: false,
      });

      // Let RateLimiter's background initializeRedis() complete
      await new Promise(resolve => setTimeout(resolve, 300));

      // Disconnect the Redis singleton (RateLimiter still holds a ref to the now-dead client)
      await resetRedisInstance();

      const result = await badLimiter.checkLimit('user:failclosed');

      // Fail-closed: exceeded=true, remaining=0
      expect(result.exceeded).toBe(true);
      expect(result.remaining).toBe(0);

      // Verify metrics
      const metrics = badLimiter.getFailModeMetrics();
      expect(metrics.failClosedCount).toBeGreaterThanOrEqual(1);
      expect(metrics.failOpenCount).toBe(0);
    }, 10000);

    it('should fail OPEN when configured and Redis errors occur', async () => {
      const openLimiter = new RateLimiter({
        windowMs: 60000,
        maxRequests: 10,
        keyPrefix: 'test-failopen',
        failOpen: true,
      });

      // Let RateLimiter's background initializeRedis() complete
      await new Promise(resolve => setTimeout(resolve, 300));

      // Disconnect the Redis singleton (RateLimiter still holds a ref to the now-dead client)
      await resetRedisInstance();

      const result = await openLimiter.checkLimit('user:failopen');

      // Fail-open: exceeded=false, remaining=maxRequests
      expect(result.exceeded).toBe(false);
      expect(result.remaining).toBe(10);

      // Verify metrics
      const metrics = openLimiter.getFailModeMetrics();
      expect(metrics.failOpenCount).toBeGreaterThanOrEqual(1);
      expect(metrics.failClosedCount).toBe(0);
    }, 10000);
  });

  // ===========================================================================
  // 5. Combined Flow — Auth + Rate Limiting
  // ===========================================================================

  describe('Combined Flow — Rate-limited login attempts', () => {
    let authService: AuthService;
    let loginLimiter: RateLimiter;

    beforeEach(async () => {
      await resetRedisInstance();

      authService = new AuthService({
        logger: silentLogger,
        redis: createAuthRedisAdapter(redis),
      });

      loginLimiter = new RateLimiter({
        windowMs: 60000,
        maxRequests: 3, // Only 3 login attempts per minute
        keyPrefix: 'test-login-rate',
      });
    });

    it('should rate-limit rapid login attempts', async () => {
      const username = 'ratelimited_user';

      // Simulate rate-limited login: check rate limit before each login attempt
      for (let i = 0; i < 3; i++) {
        const rateResult = await loginLimiter.checkLimit(`login:${username}`);
        expect(rateResult.exceeded).toBe(false);

        // Attempt login (will fail since user doesn't exist in stub DB)
        await expect(
          authService.login({ username, password: 'pass' })
        ).rejects.toThrow('Invalid username or password');
      }

      // 4th attempt should be rate-limited
      const rateResult = await loginLimiter.checkLimit(`login:${username}`);
      expect(rateResult.exceeded).toBe(true);
      expect(rateResult.remaining).toBe(0);
    });

    it('should track both rate limits and account lockout independently', async () => {
      const username = 'dual_track_user';

      // Make 3 attempts (hits rate limit at maxRequests=3)
      for (let i = 0; i < 3; i++) {
        await loginLimiter.checkLimit(`login:${username}`);
        await expect(
          authService.login({ username, password: 'wrong' })
        ).rejects.toThrow('Invalid username or password');
      }

      // Rate limiter should be exceeded
      const rateResult = await loginLimiter.checkLimit(`login:${username}`);
      expect(rateResult.exceeded).toBe(true);

      // But account is NOT yet locked (lockout is at 5 attempts)
      const lockoutKey = await redis.get(`auth:lockout:${username}`);
      expect(lockoutKey).toBeNull();

      // Attempts counter should be at 3
      const attempts = await redis.get(`auth:attempts:${username}`);
      expect(attempts).toBe('3');
    });
  });
});
