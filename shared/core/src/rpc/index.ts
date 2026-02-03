/**
 * RPC Module
 *
 * Provides optimized RPC client utilities including:
 * - BatchProvider: JSON-RPC 2.0 batch request support
 * - Rate Limiter: Token bucket rate limiting for RPC providers
 *
 * @see RPC_DATA_OPTIMIZATION_IMPLEMENTATION_PLAN.md Phase 3
 * @see docs/reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md - R1, R3, R4
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
