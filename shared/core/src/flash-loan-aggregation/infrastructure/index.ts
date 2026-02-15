/**
 * Flash Loan Aggregation - Infrastructure Layer Exports
 *
 * Infrastructure Layer (Clean Architecture):
 * - Concrete implementations of domain interfaces
 * - External dependencies (RPC, caching)
 * - Performance optimizations
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

// =============================================================================
// Strategy Implementations
// =============================================================================

export {
  WeightedRankingStrategy,
} from './weighted-ranking.strategy';

// =============================================================================
// Validator Implementations
// =============================================================================

export {
  OnChainLiquidityValidator,
  type OnChainLiquidityValidatorConfig,
} from './onchain-liquidity.validator';

// =============================================================================
// Metrics Implementations
// =============================================================================

export {
  InMemoryAggregatorMetrics,
  type InMemoryAggregatorMetricsConfig,
} from './inmemory-aggregator.metrics';

// =============================================================================
// Aggregator Implementation
// =============================================================================

export {
  FlashLoanAggregatorImpl,
} from './flashloan-aggregator.impl';

// =============================================================================
// Shared Utilities
// =============================================================================

export {
  calculateLiquidityScore,
  DEFAULT_LIQUIDITY_SCORE,
} from './liquidity-scoring';
