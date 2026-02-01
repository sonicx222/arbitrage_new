/**
 * Token Bucket Rate Limiter
 *
 * Provides rate limiting for stream message processing to prevent DoS attacks.
 * Uses the token bucket algorithm for smooth rate limiting.
 *
 * @see R2 - Coordinator Subsystems extraction
 * @see coordinator.ts (original implementation)
 */

/**
 * Configuration for the rate limiter
 */
export interface RateLimiterConfig {
  /** Maximum tokens in the bucket (max messages per refill period) */
  maxTokens: number;
  /** Refill period in milliseconds */
  refillMs: number;
  /** Cost per message (tokens consumed per message) */
  tokensPerMessage: number;
}

/**
 * Default rate limiter configuration
 */
export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  maxTokens: 1000,        // Max messages per refill period
  refillMs: 1000,         // Refill period (1 second)
  tokensPerMessage: 1,    // Cost per message
};

/**
 * Internal state for a single stream's rate limiter
 */
interface RateLimiterState {
  tokens: number;
  lastRefill: number;
}

/**
 * Token Bucket Rate Limiter
 *
 * Implements per-stream rate limiting using the token bucket algorithm.
 * Tokens are refilled proportionally based on elapsed time.
 */
export class StreamRateLimiter {
  private readonly config: RateLimiterConfig;
  private readonly limiters: Map<string, RateLimiterState> = new Map();

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITER_CONFIG, ...config };
  }

  /**
   * Check and consume rate limit tokens for a stream.
   * Returns true if message should be processed, false if rate limited.
   *
   * Uses token bucket algorithm for smooth rate limiting.
   * Tokens are refilled proportionally based on elapsed time.
   *
   * @param streamName - The name of the stream to check
   * @returns true if the message can be processed, false if rate limited
   */
  checkRateLimit(streamName: string): boolean {
    const now = Date.now();
    let limiter = this.limiters.get(streamName);

    if (!limiter) {
      // Initialize rate limiter for this stream
      limiter = { tokens: this.config.maxTokens, lastRefill: now };
      this.limiters.set(streamName, limiter);
    }

    // Refill tokens based on elapsed time (proportional refill, not multiplicative)
    const elapsed = now - limiter.lastRefill;
    if (elapsed >= this.config.refillMs) {
      // Calculate how many tokens to add based on elapsed time
      // Rate: maxTokens per refillMs
      const tokensToAdd = Math.floor(
        (elapsed / this.config.refillMs) * this.config.maxTokens
      );
      limiter.tokens = Math.min(
        this.config.maxTokens,
        limiter.tokens + tokensToAdd
      );
      limiter.lastRefill = now;
    }

    // Check if we have enough tokens
    if (limiter.tokens >= this.config.tokensPerMessage) {
      limiter.tokens -= this.config.tokensPerMessage;
      return true;
    }

    // Rate limited
    return false;
  }

  /**
   * Get current token count for a stream (for monitoring/debugging)
   */
  getTokenCount(streamName: string): number {
    return this.limiters.get(streamName)?.tokens ?? this.config.maxTokens;
  }

  /**
   * Reset rate limiter for a stream (for testing)
   */
  reset(streamName?: string): void {
    if (streamName) {
      this.limiters.delete(streamName);
    } else {
      this.limiters.clear();
    }
  }

  /**
   * Get all streams being rate limited (for monitoring)
   */
  getTrackedStreams(): string[] {
    return Array.from(this.limiters.keys());
  }
}
