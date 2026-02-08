/**
 * Flash Loan Aggregator - Domain Interface
 *
 * Core domain interface for flash loan provider aggregation.
 * Follows Interface Segregation Principle - single responsibility for provider selection.
 *
 * Performance Target:
 * - selectProvider(): <10ms (cold path - not hot path)
 * - Caching should reduce typical latency to <1ms
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

import type { ProviderSelection, AggregatorConfig } from './models';
import type { ArbitrageOpportunity } from '@arbitrage/types';

/**
 * Opportunity Context for Provider Selection
 *
 * Subset of StrategyContext needed for provider selection.
 * Follows Dependency Inversion: depend on abstractions, not concrete implementations.
 */
export interface IOpportunityContext {
  /** Chain identifier */
  readonly chain: string;

  /** RPC providers per chain (for liquidity checks) */
  readonly rpcProviders?: ReadonlyMap<string, unknown>; // ethers.JsonRpcProvider

  /** Opportunity value in USD (for threshold checks) */
  readonly estimatedValueUsd: number;
}

/**
 * Flash Loan Aggregator - Main Domain Interface
 *
 * Responsibilities:
 * - Select optimal flash loan provider for an opportunity
 * - Coordinate ranking, validation, and caching
 * - Track metrics for reliability scoring
 *
 * Following SOLID Principles:
 * - **Single Responsibility**: Provider selection orchestration only
 * - **Open/Closed**: Open for extension (new ranking strategies), closed for modification
 * - **Liskov Substitution**: All implementations must honor this contract
 * - **Interface Segregation**: Minimal interface, no client forced to depend on unused methods
 * - **Dependency Inversion**: Depends on IProviderRanker, ILiquidityValidator abstractions
 *
 * @example
 * ```typescript
 * const aggregator: IFlashLoanAggregator = createAggregator(config);
 * const selection = await aggregator.selectProvider(opportunity, context);
 *
 * if (selection.isSuccess) {
 *   console.log('Selected:', selection.protocol, 'Score:', selection.score);
 * } else {
 *   console.log('No provider available:', selection.selectionReason);
 * }
 * ```
 */
export interface IFlashLoanAggregator {
  /**
   * Select optimal flash loan provider for an opportunity
   *
   * Process:
   * 1. Get ranked providers (from cache or fresh ranking)
   * 2. Filter by availability
   * 3. Validate liquidity for large amounts
   * 4. Return top provider that passes all checks
   *
   * Caching:
   * - Rankings cached per chain (default 30s TTL)
   * - Liquidity checks cached per provider/asset (default 5min TTL)
   *
   * Performance:
   * - Cache hit: <1ms
   * - Cache miss (with liquidity check): <10ms
   * - Cache miss (no liquidity check): <2ms
   *
   * @param opportunity - Arbitrage opportunity requiring flash loan
   * @param context - Opportunity context (chain, RPC providers, value)
   * @returns ProviderSelection (immutable result with metadata)
   *
   * @throws Never throws - returns failure selection on error
   */
  selectProvider(
    opportunity: ArbitrageOpportunity,
    context: IOpportunityContext
  ): Promise<ProviderSelection>;

  /**
   * Handle fallback when provider execution fails
   *
   * Analyzes error type and decides whether to retry with next provider.
   *
   * Decision Tree:
   * - INSUFFICIENT_LIQUIDITY → Try next provider
   * - HIGH_FEES → Try next provider
   * - TRANSIENT → Can retry same provider (future enhancement)
   * - PERMANENT → Abort (validation error, no retry)
   * - UNKNOWN → Try next provider
   *
   * @param failedProtocol - Provider that failed
   * @param error - Error from execution attempt
   * @param remainingProviders - Other providers available
   * @returns Fallback decision (retry, next provider, abort)
   */
  decideFallback(
    failedProtocol: string,
    error: Error,
    remainingProviders: ReadonlyArray<{ protocol: string; score: number }>
  ): Promise<{
    shouldRetry: boolean;
    nextProtocol: string | null;
    reason: string;
    errorType: 'insufficient_liquidity' | 'high_fees' | 'transient' | 'permanent' | 'unknown';
  }>;

  /**
   * Get current aggregator configuration
   *
   * Returns immutable configuration (frozen object).
   *
   * @returns AggregatorConfig (immutable)
   */
  getConfig(): AggregatorConfig;

  /**
   * Clear all caches (for testing/debugging)
   *
   * Clears:
   * - Provider ranking cache
   * - Liquidity check cache
   *
   * Should rarely be needed in production.
   */
  clearCaches(): void;
}

/**
 * Factory function signature for creating aggregators
 *
 * Follows Factory Pattern for flexible instantiation.
 */
export type FlashLoanAggregatorFactory = (
  config: AggregatorConfig
) => IFlashLoanAggregator;
