/**
 * RPC Rate Limiter Tests
 *
 * Tests for the token bucket rate limiter implementation including:
 * - TokenBucketRateLimiter: bucket initialization, tryAcquire, acquire, refill, stats
 * - isRateLimitExempt: method exemption checks
 * - getRateLimitConfig: provider config lookup
 * - RateLimiterManager: per-chain limiter management
 * - Singleton: getRateLimiterManager / resetRateLimiterManager
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../../src/logger');

import {
  TokenBucketRateLimiter,
  isRateLimitExempt,
  DEFAULT_RATE_LIMITS,
  getRateLimitConfig,
  RateLimiterManager,
  getRateLimiterManager,
  resetRateLimiterManager,
} from '../../../src/rpc/rate-limiter';

describe('RPC Rate Limiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetRateLimiterManager();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ==========================================================================
  // TokenBucketRateLimiter
  // ==========================================================================

  describe('TokenBucketRateLimiter', () => {
    describe('initialization', () => {
      it('should start with full bucket (maxBurst tokens available)', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 20,
        });
        expect(limiter.getAvailableTokens()).toBe(20);
      });

      it('should use default identifier when none provided', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 20,
        });
        const stats = limiter.getStats();
        expect(stats.allowedRequests).toBe(0);
        expect(stats.throttledRequests).toBe(0);
      });

      it('should use provided identifier', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 20,
          identifier: 'bsc-drpc',
        });
        // Identifier is stored internally; verify via getStats behavior
        expect(limiter.getAvailableTokens()).toBe(20);
      });
    });

    describe('tryAcquire', () => {
      it('should succeed when tokens are available', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 5,
        });
        expect(limiter.tryAcquire()).toBe(true);
      });

      it('should consume one token per call', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 3,
        });
        limiter.tryAcquire();
        limiter.tryAcquire();
        // Started with 3, consumed 2, should have ~1 left
        expect(limiter.getAvailableTokens()).toBeCloseTo(1, 0);
      });

      it('should fail when bucket is empty', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 2,
        });
        limiter.tryAcquire();
        limiter.tryAcquire();
        expect(limiter.tryAcquire()).toBe(false);
      });

      it('should track allowed requests in stats', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 5,
        });
        limiter.tryAcquire();
        limiter.tryAcquire();
        limiter.tryAcquire();
        const stats = limiter.getStats();
        expect(stats.allowedRequests).toBe(3);
      });

      it('should track throttled requests in stats', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 1,
        });
        limiter.tryAcquire(); // succeeds
        limiter.tryAcquire(); // throttled
        limiter.tryAcquire(); // throttled
        const stats = limiter.getStats();
        expect(stats.throttledRequests).toBe(2);
      });
    });

    describe('token refill', () => {
      it('should refill tokens over time', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 10,
        });
        // Drain all tokens
        for (let i = 0; i < 10; i++) {
          limiter.tryAcquire();
        }
        expect(limiter.tryAcquire()).toBe(false);

        // Advance 500ms => should refill 5 tokens (10 per second * 0.5s)
        jest.advanceTimersByTime(500);
        expect(limiter.getAvailableTokens()).toBeCloseTo(5, 0);
        expect(limiter.tryAcquire()).toBe(true);
      });

      it('should not refill beyond maxBurst', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 100,
          maxBurst: 10,
        });

        // Advance a long time, tokens should still cap at maxBurst
        jest.advanceTimersByTime(10000);
        expect(limiter.getAvailableTokens()).toBe(10);
      });

      it('should refill gradually for low-rate limiters', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 1,
          maxBurst: 5,
        });
        // Drain all tokens
        for (let i = 0; i < 5; i++) {
          limiter.tryAcquire();
        }
        expect(limiter.tryAcquire()).toBe(false);

        // Advance 1 second => should refill 1 token
        jest.advanceTimersByTime(1000);
        expect(limiter.getAvailableTokens()).toBeCloseTo(1, 0);
      });
    });

    describe('getStats', () => {
      it('should return zero throttle rate when no requests made', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 10,
        });
        const stats = limiter.getStats();
        expect(stats.throttleRate).toBe(0);
        expect(stats.allowedRequests).toBe(0);
        expect(stats.throttledRequests).toBe(0);
      });

      it('should return correct throttle rate', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 2,
        });
        limiter.tryAcquire(); // allowed
        limiter.tryAcquire(); // allowed
        limiter.tryAcquire(); // throttled
        limiter.tryAcquire(); // throttled
        const stats = limiter.getStats();
        expect(stats.allowedRequests).toBe(2);
        expect(stats.throttledRequests).toBe(2);
        expect(stats.throttleRate).toBe(0.5);
      });

      it('should return available tokens floored to integer', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 10,
        });
        limiter.tryAcquire(); // consume 1
        const stats = limiter.getStats();
        expect(stats.availableTokens).toBe(9);
        expect(Number.isInteger(stats.availableTokens)).toBe(true);
      });
    });

    describe('resetStats', () => {
      it('should clear allowed and throttled counters', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 1,
        });
        limiter.tryAcquire(); // allowed
        limiter.tryAcquire(); // throttled
        limiter.resetStats();
        const stats = limiter.getStats();
        expect(stats.allowedRequests).toBe(0);
        expect(stats.throttledRequests).toBe(0);
        expect(stats.throttleRate).toBe(0);
      });

      it('should not affect token count', () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 5,
        });
        limiter.tryAcquire();
        limiter.tryAcquire();
        const tokensBefore = limiter.getAvailableTokens();
        limiter.resetStats();
        const tokensAfter = limiter.getAvailableTokens();
        expect(tokensAfter).toBeCloseTo(tokensBefore, 0);
      });
    });

    describe('acquire', () => {
      it('should succeed immediately when tokens are available', async () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 5,
        });
        const result = await limiter.acquire(1000);
        expect(result).toBe(true);
        const stats = limiter.getStats();
        expect(stats.allowedRequests).toBe(1);
      });

      it('should succeed after waiting for refill', async () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 1,
        });
        limiter.tryAcquire(); // drain bucket

        // Start acquire and let timers progress
        const acquirePromise = limiter.acquire(5000);

        // Advance time enough for tokens to refill
        // 10 tokens/sec means 100ms per token, but the sleep is max(10, 1000/10) = 100ms
        jest.advanceTimersByTime(200);

        const result = await acquirePromise;
        expect(result).toBe(true);
      });

      it('should time out when no tokens become available', async () => {
        // Use tokensPerSecond that produces a manageable sleep interval:
        // waitMs = max(10, 1000/10) = 100ms per iteration.
        // With timeout=50ms, the first sleep(100ms) resolution will push
        // Date.now() past the timeout, causing acquire to return false.
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 1,
        });
        limiter.tryAcquire(); // drain bucket

        const acquirePromise = limiter.acquire(50);

        // Advance past the sleep interval (100ms) so the while-loop can
        // re-check its condition and see Date.now() - startTime >= 50.
        await jest.advanceTimersByTimeAsync(150);

        const result = await acquirePromise;
        expect(result).toBe(false);
      });

      it('should count timed-out acquire as single throttled request', async () => {
        const limiter = new TokenBucketRateLimiter({
          tokensPerSecond: 10,
          maxBurst: 1,
        });
        limiter.tryAcquire(); // drain
        limiter.resetStats(); // clear the allowed count

        const acquirePromise = limiter.acquire(50);
        await jest.advanceTimersByTimeAsync(150);
        await acquirePromise;

        const stats = limiter.getStats();
        // P2-001 fix: acquire timeout counts as single throttled request
        expect(stats.throttledRequests).toBe(1);
      });
    });
  });

  // ==========================================================================
  // isRateLimitExempt
  // ==========================================================================

  describe('isRateLimitExempt', () => {
    it('should return true for eth_sendRawTransaction', () => {
      expect(isRateLimitExempt('eth_sendRawTransaction')).toBe(true);
    });

    it('should return true for eth_sendTransaction', () => {
      expect(isRateLimitExempt('eth_sendTransaction')).toBe(true);
    });

    it('should return false for eth_call', () => {
      expect(isRateLimitExempt('eth_call')).toBe(false);
    });

    it('should return false for eth_getBalance', () => {
      expect(isRateLimitExempt('eth_getBalance')).toBe(false);
    });

    it('should return false for eth_blockNumber', () => {
      expect(isRateLimitExempt('eth_blockNumber')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isRateLimitExempt('')).toBe(false);
    });
  });

  // ==========================================================================
  // DEFAULT_RATE_LIMITS
  // ==========================================================================

  describe('DEFAULT_RATE_LIMITS', () => {
    it('should have config for drpc', () => {
      expect(DEFAULT_RATE_LIMITS.drpc).toBeDefined();
      expect(DEFAULT_RATE_LIMITS.drpc.tokensPerSecond).toBe(40);
      expect(DEFAULT_RATE_LIMITS.drpc.maxBurst).toBe(80);
    });

    it('should have config for ankr', () => {
      expect(DEFAULT_RATE_LIMITS.ankr).toBeDefined();
      expect(DEFAULT_RATE_LIMITS.ankr.tokensPerSecond).toBe(30);
    });

    it('should have config for publicnode', () => {
      expect(DEFAULT_RATE_LIMITS.publicnode).toBeDefined();
      expect(DEFAULT_RATE_LIMITS.publicnode.tokensPerSecond).toBe(100);
    });

    it('should have a default fallback config', () => {
      expect(DEFAULT_RATE_LIMITS.default).toBeDefined();
      expect(DEFAULT_RATE_LIMITS.default.tokensPerSecond).toBe(20);
      expect(DEFAULT_RATE_LIMITS.default.maxBurst).toBe(40);
    });
  });

  // ==========================================================================
  // getRateLimitConfig
  // ==========================================================================

  describe('getRateLimitConfig', () => {
    it('should return drpc config for "drpc" provider', () => {
      const config = getRateLimitConfig('drpc');
      expect(config.tokensPerSecond).toBe(40);
      expect(config.maxBurst).toBe(80);
      expect(config.identifier).toBe('drpc');
    });

    it('should return ankr config for provider containing "ankr"', () => {
      const config = getRateLimitConfig('bsc-ankr-provider');
      expect(config.tokensPerSecond).toBe(30);
      expect(config.maxBurst).toBe(60);
      expect(config.identifier).toBe('bsc-ankr-provider');
    });

    it('should return default for unknown provider', () => {
      const config = getRateLimitConfig('some-unknown-provider');
      expect(config.tokensPerSecond).toBe(DEFAULT_RATE_LIMITS.default.tokensPerSecond);
      expect(config.maxBurst).toBe(DEFAULT_RATE_LIMITS.default.maxBurst);
    });

    it('should add identifier from providerName', () => {
      const config = getRateLimitConfig('my-custom-drpc');
      expect(config.identifier).toBe('my-custom-drpc');
    });

    it('should be case-insensitive for provider matching', () => {
      const config = getRateLimitConfig('DRPC');
      expect(config.tokensPerSecond).toBe(40);
    });

    it('should match infura provider', () => {
      const config = getRateLimitConfig('eth-infura-mainnet');
      expect(config.tokensPerSecond).toBe(25);
      expect(config.maxBurst).toBe(50);
    });
  });

  // ==========================================================================
  // RateLimiterManager
  // ==========================================================================

  describe('RateLimiterManager', () => {
    let manager: RateLimiterManager;

    beforeEach(() => {
      manager = new RateLimiterManager();
    });

    describe('getLimiter', () => {
      it('should create a limiter on first call', () => {
        const limiter = manager.getLimiter('bsc');
        expect(limiter).toBeInstanceOf(TokenBucketRateLimiter);
      });

      it('should return same instance on subsequent calls', () => {
        const limiter1 = manager.getLimiter('bsc');
        const limiter2 = manager.getLimiter('bsc');
        expect(limiter1).toBe(limiter2);
      });

      it('should create separate limiters for different chains', () => {
        const limiterBsc = manager.getLimiter('bsc');
        const limiterEth = manager.getLimiter('ethereum');
        expect(limiterBsc).not.toBe(limiterEth);
      });
    });

    describe('tryAcquire', () => {
      it('should bypass rate limit for exempt methods', () => {
        const result = manager.tryAcquire('bsc', 'eth_sendRawTransaction');
        expect(result).toBe(true);
      });

      it('should bypass rate limit for eth_sendTransaction', () => {
        const result = manager.tryAcquire('bsc', 'eth_sendTransaction');
        expect(result).toBe(true);
      });

      it('should use limiter for non-exempt methods', () => {
        const result = manager.tryAcquire('bsc', 'eth_call');
        expect(result).toBe(true);
        // Verify a limiter was created
        const stats = manager.getAllStats();
        expect(stats.has('bsc')).toBe(true);
      });

      it('should throttle when limiter bucket is empty', () => {
        // Get the limiter and drain it
        const limiter = manager.getLimiter('bsc');
        const tokens = limiter.getAvailableTokens();
        for (let i = 0; i < tokens + 1; i++) {
          limiter.tryAcquire();
        }

        // Now tryAcquire through manager should fail
        const result = manager.tryAcquire('bsc', 'eth_call');
        expect(result).toBe(false);
      });

      it('should not create limiter for exempt method calls', () => {
        manager.tryAcquire('polygon', 'eth_sendRawTransaction');
        const stats = manager.getAllStats();
        // Exempt methods bypass the limiter entirely, so no limiter created
        expect(stats.has('polygon')).toBe(false);
      });
    });

    describe('getAllStats', () => {
      it('should return empty map when no limiters exist', () => {
        const stats = manager.getAllStats();
        expect(stats.size).toBe(0);
      });

      it('should return stats for all created limiters', () => {
        manager.getLimiter('bsc');
        manager.getLimiter('ethereum');
        manager.getLimiter('polygon');
        const stats = manager.getAllStats();
        expect(stats.size).toBe(3);
        expect(stats.has('bsc')).toBe(true);
        expect(stats.has('ethereum')).toBe(true);
        expect(stats.has('polygon')).toBe(true);
      });

      it('should contain valid stats objects', () => {
        manager.getLimiter('bsc');
        manager.tryAcquire('bsc', 'eth_call');
        const stats = manager.getAllStats();
        const bscStats = stats.get('bsc')!;
        expect(bscStats.allowedRequests).toBeGreaterThanOrEqual(1);
        expect(typeof bscStats.throttleRate).toBe('number');
        expect(typeof bscStats.availableTokens).toBe('number');
      });
    });

    describe('clear', () => {
      it('should remove all limiters', () => {
        manager.getLimiter('bsc');
        manager.getLimiter('ethereum');
        manager.clear();
        const stats = manager.getAllStats();
        expect(stats.size).toBe(0);
      });

      it('should create fresh limiters after clear', () => {
        const limiterBefore = manager.getLimiter('bsc');
        // Drain some tokens
        limiterBefore.tryAcquire();
        limiterBefore.tryAcquire();

        manager.clear();

        const limiterAfter = manager.getLimiter('bsc');
        expect(limiterAfter).not.toBe(limiterBefore);
        // Fresh limiter should have full bucket
        const config = getRateLimitConfig('bsc');
        expect(limiterAfter.getAvailableTokens()).toBe(config.maxBurst);
      });
    });
  });

  // ==========================================================================
  // Singleton
  // ==========================================================================

  describe('Singleton', () => {
    it('should return same instance from getRateLimiterManager', () => {
      const manager1 = getRateLimiterManager();
      const manager2 = getRateLimiterManager();
      expect(manager1).toBe(manager2);
    });

    it('should return RateLimiterManager instance', () => {
      const manager = getRateLimiterManager();
      expect(manager).toBeInstanceOf(RateLimiterManager);
    });

    it('should create new instance after resetRateLimiterManager', () => {
      const manager1 = getRateLimiterManager();
      resetRateLimiterManager();
      const manager2 = getRateLimiterManager();
      expect(manager1).not.toBe(manager2);
    });

    it('should clear limiters when resetting', () => {
      const manager = getRateLimiterManager();
      manager.getLimiter('bsc');
      manager.getLimiter('ethereum');

      resetRateLimiterManager();

      const newManager = getRateLimiterManager();
      const stats = newManager.getAllStats();
      expect(stats.size).toBe(0);
    });
  });
});
