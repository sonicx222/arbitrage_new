/**
 * RPC Module
 *
 * Provides optimized RPC client utilities including:
 * - BatchProvider: JSON-RPC 2.0 batch request support
 * - Rate Limiter: Token bucket rate limiting for RPC providers
 *
 * @see docs/architecture/adr/ADR-024-rpc-rate-limiting.md
 */

export {
  BatchProvider,
  createBatchProvider,
  BATCHABLE_METHODS,
  NON_BATCHABLE_METHODS,
} from './batch-provider';

export type {
  BatchProviderConfig,
  BatchProviderStats,
  JsonRpcRequest,
  JsonRpcResponse,
} from './batch-provider';

// R3 Optimization: Rate limiter exports
export {
  TokenBucketRateLimiter,
  RateLimiterManager,
  getRateLimiterManager,
  resetRateLimiterManager,
  getRateLimitConfig,
  isRateLimitExempt,
  DEFAULT_RATE_LIMITS,
} from './rate-limiter';

export type {
  RateLimiterConfig,
  RateLimiterStats,
} from './rate-limiter';
