/**
 * Unit Tests for StreamRateLimiter
 *
 * Tests the token bucket rate limiter from streaming/rate-limiter.ts.
 * Validates token consumption, refill behavior, per-stream isolation,
 * and management operations.
 *
 * @see rate-limiter.ts (source module)
 * @see stream-consumer-manager.ts (primary caller)
 */

import {
  StreamRateLimiter,
  DEFAULT_RATE_LIMITER_CONFIG,
  type RateLimiterConfig,
} from '../../../src/streaming/rate-limiter';

describe('StreamRateLimiter', () => {
  let limiter: StreamRateLimiter;

  beforeEach(() => {
    limiter = new StreamRateLimiter();
  });

  describe('checkRateLimit', () => {
    it('should allow the first N messages up to maxTokens', () => {
      const config: Partial<RateLimiterConfig> = { maxTokens: 5, tokensPerMessage: 1 };
      limiter = new StreamRateLimiter(config);

      for (let i = 0; i < 5; i++) {
        expect(limiter.checkRateLimit('stream-a')).toBe(true);
      }
    });

    it('should block after tokens are exhausted', () => {
      const config: Partial<RateLimiterConfig> = { maxTokens: 3, tokensPerMessage: 1, refillMs: 60000 };
      limiter = new StreamRateLimiter(config);

      // Consume all tokens
      expect(limiter.checkRateLimit('stream-a')).toBe(true);
      expect(limiter.checkRateLimit('stream-a')).toBe(true);
      expect(limiter.checkRateLimit('stream-a')).toBe(true);

      // Should be blocked
      expect(limiter.checkRateLimit('stream-a')).toBe(false);
      expect(limiter.checkRateLimit('stream-a')).toBe(false);
    });

    it('should refill tokens after refillMs period', () => {
      const config: Partial<RateLimiterConfig> = { maxTokens: 2, tokensPerMessage: 1, refillMs: 100 };
      limiter = new StreamRateLimiter(config);

      // Consume all tokens
      expect(limiter.checkRateLimit('stream-a')).toBe(true);
      expect(limiter.checkRateLimit('stream-a')).toBe(true);
      expect(limiter.checkRateLimit('stream-a')).toBe(false);

      // Advance time past refill period
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now + 150);

      // Should have tokens again
      expect(limiter.checkRateLimit('stream-a')).toBe(true);

      jest.restoreAllMocks();
    });

    it('should isolate rate limits per stream', () => {
      const config: Partial<RateLimiterConfig> = { maxTokens: 2, tokensPerMessage: 1, refillMs: 60000 };
      limiter = new StreamRateLimiter(config);

      // Exhaust stream-a
      expect(limiter.checkRateLimit('stream-a')).toBe(true);
      expect(limiter.checkRateLimit('stream-a')).toBe(true);
      expect(limiter.checkRateLimit('stream-a')).toBe(false);

      // stream-b should still have tokens
      expect(limiter.checkRateLimit('stream-b')).toBe(true);
      expect(limiter.checkRateLimit('stream-b')).toBe(true);
      expect(limiter.checkRateLimit('stream-b')).toBe(false);
    });

    it('should respect custom tokensPerMessage cost', () => {
      const config: Partial<RateLimiterConfig> = { maxTokens: 10, tokensPerMessage: 5, refillMs: 60000 };
      limiter = new StreamRateLimiter(config);

      // With cost=5 and max=10, only 2 messages fit
      expect(limiter.checkRateLimit('stream-a')).toBe(true);
      expect(limiter.checkRateLimit('stream-a')).toBe(true);
      expect(limiter.checkRateLimit('stream-a')).toBe(false);
    });

    it('should use default config when no config is provided', () => {
      limiter = new StreamRateLimiter();

      // Default is maxTokens=1000, tokensPerMessage=1
      // Should allow many messages
      for (let i = 0; i < 100; i++) {
        expect(limiter.checkRateLimit('stream-a')).toBe(true);
      }
    });
  });

  describe('getTokenCount', () => {
    it('should return maxTokens for an unknown stream', () => {
      expect(limiter.getTokenCount('never-seen')).toBe(DEFAULT_RATE_LIMITER_CONFIG.maxTokens);
    });

    it('should return decreasing count after consumption', () => {
      const config: Partial<RateLimiterConfig> = { maxTokens: 10, tokensPerMessage: 1, refillMs: 60000 };
      limiter = new StreamRateLimiter(config);

      limiter.checkRateLimit('stream-a');
      expect(limiter.getTokenCount('stream-a')).toBe(9);

      limiter.checkRateLimit('stream-a');
      expect(limiter.getTokenCount('stream-a')).toBe(8);
    });

    it('should return 0 when all tokens are exhausted', () => {
      const config: Partial<RateLimiterConfig> = { maxTokens: 2, tokensPerMessage: 1, refillMs: 60000 };
      limiter = new StreamRateLimiter(config);

      limiter.checkRateLimit('stream-a');
      limiter.checkRateLimit('stream-a');

      expect(limiter.getTokenCount('stream-a')).toBe(0);
    });
  });

  describe('reset', () => {
    it('should clear a single stream when streamName is provided', () => {
      const config: Partial<RateLimiterConfig> = { maxTokens: 2, tokensPerMessage: 1, refillMs: 60000 };
      limiter = new StreamRateLimiter(config);

      // Exhaust both streams
      limiter.checkRateLimit('stream-a');
      limiter.checkRateLimit('stream-a');
      limiter.checkRateLimit('stream-b');
      limiter.checkRateLimit('stream-b');

      // Reset only stream-a
      limiter.reset('stream-a');

      // stream-a should have full tokens again (next checkRateLimit initializes fresh)
      expect(limiter.getTokenCount('stream-a')).toBe(2); // Returns maxTokens for unknown
      expect(limiter.checkRateLimit('stream-a')).toBe(true);

      // stream-b should still be exhausted
      expect(limiter.checkRateLimit('stream-b')).toBe(false);
    });

    it('should clear all streams when no streamName is provided', () => {
      const config: Partial<RateLimiterConfig> = { maxTokens: 2, tokensPerMessage: 1, refillMs: 60000 };
      limiter = new StreamRateLimiter(config);

      // Exhaust both streams
      limiter.checkRateLimit('stream-a');
      limiter.checkRateLimit('stream-a');
      limiter.checkRateLimit('stream-b');
      limiter.checkRateLimit('stream-b');

      // Reset all
      limiter.reset();

      // Both should have full tokens again
      expect(limiter.checkRateLimit('stream-a')).toBe(true);
      expect(limiter.checkRateLimit('stream-b')).toBe(true);
    });
  });

  describe('getTrackedStreams', () => {
    it('should return empty array when no streams have been checked', () => {
      expect(limiter.getTrackedStreams()).toEqual([]);
    });

    it('should return tracked stream names after rate limit checks', () => {
      limiter.checkRateLimit('stream-a');
      limiter.checkRateLimit('stream-b');
      limiter.checkRateLimit('stream-c');

      const tracked = limiter.getTrackedStreams();
      expect(tracked).toHaveLength(3);
      expect(tracked).toContain('stream-a');
      expect(tracked).toContain('stream-b');
      expect(tracked).toContain('stream-c');
    });

    it('should not include reset streams', () => {
      limiter.checkRateLimit('stream-a');
      limiter.checkRateLimit('stream-b');

      limiter.reset('stream-a');

      const tracked = limiter.getTrackedStreams();
      expect(tracked).toHaveLength(1);
      expect(tracked).toContain('stream-b');
    });

    it('should return empty array after full reset', () => {
      limiter.checkRateLimit('stream-a');
      limiter.checkRateLimit('stream-b');

      limiter.reset();

      expect(limiter.getTrackedStreams()).toEqual([]);
    });
  });
});
