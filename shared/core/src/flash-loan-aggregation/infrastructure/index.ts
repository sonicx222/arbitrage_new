/**
 * Flash Loan Aggregation - Infrastructure Layer Exports
 *
 * Infrastructure Layer (Clean Architecture):
 * - Concrete implementations of domain interfaces
 * - External dependencies (RPC, caching)
 * - Performance optimizations
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md Infrastructure Layer
 */

// =============================================================================
// Strategy Implementations
// =============================================================================

export {
  WeightedRankingStrategy,
  createWeightedRankingStrategy,
} from './weighted-ranking.strategy';

// =============================================================================
// Validator Implementations
// =============================================================================

export {
  OnChainLiquidityValidator,
  createOnChainLiquidityValidator,
  type OnChainLiquidityValidatorConfig,
} from './onchain-liquidity.validator';

// =============================================================================
// Metrics Implementations
// =============================================================================

export {
  InMemoryAggregatorMetrics,
  createInMemoryAggregatorMetrics,
  type InMemoryAggregatorMetricsConfig,
} from './inmemory-aggregator.metrics';

// =============================================================================
// Aggregator Implementation
// =============================================================================

export {
  FlashLoanAggregatorImpl,
  createFlashLoanAggregator,
} from './flashloan-aggregator.impl';
