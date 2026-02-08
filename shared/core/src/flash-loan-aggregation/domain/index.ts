/**
 * Flash Loan Aggregation - Domain Layer Exports
 *
 * Domain Layer (Clean Architecture):
 * - Interfaces (contracts for implementations)
 * - Value Objects (immutable domain concepts)
 * - Domain Events (for event sourcing)
 *
 * Following Dependency Inversion Principle:
 * - Higher layers depend on these abstractions
 * - Implementations are in infrastructure layer
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

// =============================================================================
// Domain Interfaces (Contracts)
// =============================================================================

export type {
  IFlashLoanAggregator,
  IOpportunityContext,
  FlashLoanAggregatorFactory,
} from './aggregator.interface';

export type {
  IProviderRanker,
  IProviderInfo,
  IRankedProvider,
  IRankingContext,
  IProviderRankerFactory,
} from './provider-ranker.interface';

export type {
  ILiquidityValidator,
  ILiquidityContext,
  LiquidityValidatorFactory,
} from './liquidity-validator.interface';

export type {
  IAggregatorMetrics,
  IAggregatedMetrics,
  AggregatorMetricsFactory,
} from './metrics-tracker.interface';

// =============================================================================
// Value Objects (Immutable Domain Concepts)
// =============================================================================

export {
  ProviderScore,
  LiquidityCheck,
  ProviderSelection,
  AggregatorConfig,
  ProviderOutcome,
} from './models';
