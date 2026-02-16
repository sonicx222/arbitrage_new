/**
 * R3 Optimization: Per-chain rate limiter using token bucket algorithm.
 *
 * Prevents 429 errors by tracking and throttling requests per provider/chain.
 * Uses token bucket algorithm for efficient burst handling while respecting limits.
 *
 * Design decisions:
 * - Token bucket allows burst traffic while enforcing average rate
 * - Hot-path exempt: `eth_sendRawTransaction` bypasses rate limiting
 * - Non-blocking: Returns immediately with availability status
 *
 * @see docs/architecture/adr/ADR-024-rpc-rate-limiting.md
 */

import { createLogger } from '../logger';

const logger = createLogger('rate-limiter');

/**
 * Configuration for a rate limiter instance.
 */
export interface RateLimiterConfig {
  /** Maximum tokens (requests) per second */
  tokensPerSecond: number;
  /** Maximum burst size (tokens can accumulate up to this) */
  maxBurst: number;
  /** Optional chain/provider identifier for logging */
  identifier?: string;
}

/**
 * Statistics for rate limiter monitoring.
 */
export interface RateLimiterStats {
  /** Total requests that were allowed */
  allowedRequests: number;
  /** Total requests that were throttled */
  throttledRequests: number;
  /** Current available tokens */
  availableTokens: number;
  /** Throttle rate as percentage */
  throttleRate: number;
}

/**
 * Token bucket rate limiter for RPC request throttling.
 *
 * Algorithm:
 * - Tokens refill at `tokensPerSecond` rate
 * - Tokens cap at `maxBurst` (prevents unbounded accumulation)
 * - Each request consumes one token
 * - If no tokens available, request is throttled
 */
export class TokenBucketRateLimiter {
  private readonly config: Required<RateLimiterConfig>;
  private tokens: number;
  private lastRefillTime: number;
  private allowedRequests = 0;
  private throttledRequests = 0;

  constructor(config: RateLimiterConfig) {
    this.config = {
      tokensPerSecond: config.tokensPerSecond,
      maxBurst: config.maxBurst,
      identifier: config.identifier ?? 'default',
    };

    // Start with full bucket
    this.tokens = this.config.maxBurst;
    this.lastRefillTime = Date.now();
  }

  /**
   * Check if a request can proceed (non-blocking).
   * Consumes a token if available.
   *
   * @returns true if request allowed, false if throttled
   */
  tryAcquire(): boolean {
    this.refillTokens();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.allowedRequests++;
      return true;
    }

    this.throttledRequests++;

    // FIX P3-002: Add debug logging for throttle events (useful for tuning rate limits)
    // Log every 100th throttle to avoid log spam while still providing visibility
    if (this.throttledRequests % 100 === 0) {
      logger.debug('Rate limit throttling active', {
        identifier: this.config.identifier,
        throttledCount: this.throttledRequests,
        availableTokens: Math.floor(this.tokens),
        tokensPerSecond: this.config.tokensPerSecond,
      });
    }

    return false;
  }

  /**
   * Wait until a token is available (blocking).
   * Use sparingly - prefer tryAcquire() for hot paths.
   *
   * @param timeoutMs Maximum time to wait (default: 5000ms)
   * @returns true if acquired within timeout, false otherwise
   */
  async acquire(timeoutMs = 5000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      // FIX P2-001: Use non-counting token check to avoid stats inflation
      // Previously, each failed tryAcquire() incremented throttledRequests,
      // causing a single acquire() timeout to add 100+ throttled counts.
      // Now we only count once at the end if we fail to acquire.
      this.refillTokens();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        this.allowedRequests++;
        return true;
      }

      // Calculate wait time for next token
      const waitMs = Math.max(10, 1000 / this.config.tokensPerSecond);
      await this.sleep(waitMs);
    }

    // Timeout - count as single throttled request for the entire acquire attempt
    this.throttledRequests++;
    return false;
  }

  /**
   * Get current available tokens (for monitoring).
   */
  getAvailableTokens(): number {
    this.refillTokens();
    return this.tokens;
  }

  /**
   * Get rate limiter statistics.
   */
  getStats(): RateLimiterStats {
    const total = this.allowedRequests + this.throttledRequests;
    return {
      allowedRequests: this.allowedRequests,
      throttledRequests: this.throttledRequests,
      availableTokens: Math.floor(this.tokens),
      throttleRate: total > 0 ? this.throttledRequests / total : 0,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.allowedRequests = 0;
    this.throttledRequests = 0;
  }

  /**
   * Refill tokens based on elapsed time.
   */
  private refillTokens(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefillTime;

    if (elapsedMs > 0) {
      // Add tokens based on elapsed time
      const tokensToAdd = (elapsedMs / 1000) * this.config.tokensPerSecond;
      this.tokens = Math.min(this.config.maxBurst, this.tokens + tokensToAdd);
      this.lastRefillTime = now;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Methods exempt from rate limiting (hot-path critical).
 * These methods are too latency-sensitive to be throttled.
 */
const RATE_LIMIT_EXEMPT_METHODS = new Set([
  'eth_sendRawTransaction', // Trade execution - must not be delayed
  'eth_sendTransaction',    // Trade execution - must not be delayed
]);

/**
 * Check if a method is exempt from rate limiting.
 */
export function isRateLimitExempt(method: string): boolean {
  return RATE_LIMIT_EXEMPT_METHODS.has(method);
}

/**
 * Default rate limits by provider tier.
 * Based on documented provider limits.
 * @see docs/architecture/adr/ADR-024-rpc-rate-limiting.md
 */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimiterConfig> = {
  // Primary: dRPC (40-100 RPS)
  drpc: { tokensPerSecond: 40, maxBurst: 80 },
  // Secondary: Ankr (30 RPS)
  ankr: { tokensPerSecond: 30, maxBurst: 60 },
  // Tertiary: PublicNode (100-200 RPS, no key needed)
  publicnode: { tokensPerSecond: 100, maxBurst: 200 },
  // Fallbacks (conservative limits)
  infura: { tokensPerSecond: 25, maxBurst: 50 },
  alchemy: { tokensPerSecond: 25, maxBurst: 50 },
  quicknode: { tokensPerSecond: 25, maxBurst: 50 },
  // Default for unknown providers
  default: { tokensPerSecond: 20, maxBurst: 40 },
};

/**
 * Get rate limit config for a provider.
 *
 * @param providerName Provider name (lowercase)
 * @returns Rate limiter configuration
 */
export function getRateLimitConfig(providerName: string): RateLimiterConfig {
  const normalizedName = providerName.toLowerCase();

  // Check for known providers (skip 'default' — it's the fallback below)
  for (const [key, config] of Object.entries(DEFAULT_RATE_LIMITS)) {
    if (key === 'default') continue;
    if (normalizedName.includes(key)) {
      return { ...config, identifier: providerName };
    }
  }

  // Return default config for unknown providers
  return { ...DEFAULT_RATE_LIMITS.default, identifier: providerName };
}

/**
 * Manager for multiple rate limiters (one per chain/provider).
 */
export class RateLimiterManager {
  private limiters = new Map<string, TokenBucketRateLimiter>();

  /**
   * Get or create a rate limiter for a chain/provider.
   */
  getLimiter(chainOrProvider: string): TokenBucketRateLimiter {
    let limiter = this.limiters.get(chainOrProvider);
    if (!limiter) {
      const config = getRateLimitConfig(chainOrProvider);
      limiter = new TokenBucketRateLimiter(config);
      this.limiters.set(chainOrProvider, limiter);
    }
    return limiter;
  }

  /**
   * Try to acquire a token for a request.
   * Bypasses rate limiting for exempt methods.
   *
   * @param chainOrProvider Chain or provider identifier
   * @param method RPC method name
   * @returns true if allowed, false if throttled
   */
  tryAcquire(chainOrProvider: string, method: string): boolean {
    // Hot-path exempt methods bypass rate limiting
    if (isRateLimitExempt(method)) {
      return true;
    }
    return this.getLimiter(chainOrProvider).tryAcquire();
  }

  /**
   * Get aggregated statistics across all limiters.
   */
  getAllStats(): Map<string, RateLimiterStats> {
    const stats = new Map<string, RateLimiterStats>();
    for (const [key, limiter] of this.limiters) {
      stats.set(key, limiter.getStats());
    }
    return stats;
  }

  /**
   * Reset all limiters.
   */
  clear(): void {
    this.limiters.clear();
  }
}

// Export singleton factory
let rateLimiterManager: RateLimiterManager | null = null;

/**
 * Get the singleton rate limiter manager.
 */
export function getRateLimiterManager(): RateLimiterManager {
  if (!rateLimiterManager) {
    rateLimiterManager = new RateLimiterManager();
  }
  return rateLimiterManager;
}

/**
 * Reset the rate limiter manager (for testing).
 */
export function resetRateLimiterManager(): void {
  rateLimiterManager?.clear();
  rateLimiterManager = null;
}
