/**
 * Provider Ranker - Domain Interface
 *
 * Strategy Pattern for provider ranking algorithms.
 * Allows pluggable ranking strategies (weighted, fee-optimized, reliability-first, etc.).
 *
 * Performance Target:
 * - rankProviders(): <2ms (ranks up to 5 providers)
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md Strategy Pattern
 */

import type { ProviderScore, AggregatorConfig } from './models';
import type { FlashLoanProtocol } from '../../../../../services/execution-engine/src/strategies/flash-loan-providers/types';

/**
 * Provider Information for Ranking
 *
 * Minimal data needed to rank a provider.
 */
export interface IProviderInfo {
  /** Flash loan protocol */
  readonly protocol: FlashLoanProtocol;

  /** Chain identifier */
  readonly chain: string;

  /** Fee in basis points (e.g., 9 = 0.09%) */
  readonly feeBps: number;

  /** Whether provider is currently available */
  readonly isAvailable: boolean;

  /** Pool address for liquidity checks */
  readonly poolAddress: string;
}

/**
 * Ranked Provider Result
 *
 * Provider with calculated score and breakdown.
 */
export interface IRankedProvider {
  /** Provider information */
  readonly provider: IProviderInfo;

  /** Calculated score (immutable) */
  readonly score: ProviderScore;

  /** Estimated available liquidity (if checked) */
  readonly estimatedLiquidity?: bigint;
}

/**
 * Provider Ranker - Strategy Interface
 *
 * Responsibilities:
 * - Calculate scores for providers based on:
 *   - Fees (lower is better)
 *   - Liquidity (sufficient + margin)
 *   - Reliability (historical success rate)
 *   - Latency (execution speed)
 * - Sort providers by total score (descending)
 * - Support different ranking strategies
 *
 * Following Strategy Pattern:
 * - Multiple ranking algorithms can be swapped at runtime
 * - Each strategy implements same interface
 * - Decoupled from aggregator logic
 *
 * Common Strategies:
 * - **WeightedRankingStrategy** (default): Fees 50%, Liquidity 30%, Reliability 15%, Latency 5%
 * - **FeeOptimizedStrategy**: Fees 80%, others 20%
 * - **ReliabilityFirstStrategy**: Reliability 60%, Fees 30%, others 10%
 * - **AdaptiveStrategy**: Adjusts weights based on market conditions
 *
 * @example
 * ```typescript
 * const ranker: IProviderRanker = new WeightedRankingStrategy(config);
 * const ranked = await ranker.rankProviders(providers, amount, ctx);
 *
 * console.log('Top provider:', ranked[0].provider.protocol);
 * console.log('Score:', ranked[0].score.totalScore);
 * console.log('Breakdown:', ranked[0].score.explain());
 * ```
 */
export interface IProviderRanker {
  /**
   * Rank providers for a specific opportunity
   *
   * Process:
   * 1. Calculate component scores (fee, liquidity, reliability, latency)
   * 2. Combine scores using strategy-specific weights
   * 3. Sort by total score (descending)
   * 4. Return top N providers
   *
   * @param providers - Available providers to rank
   * @param requestedAmount - Flash loan amount (for liquidity scoring)
   * @param context - Ranking context (historical data, market conditions)
   * @returns Ranked providers sorted by score (highest first)
   */
  rankProviders(
    providers: ReadonlyArray<IProviderInfo>,
    requestedAmount: bigint,
    context: IRankingContext
  ): Promise<ReadonlyArray<IRankedProvider>>;

  /**
   * Get strategy name for logging/debugging
   *
   * @returns Strategy name (e.g., "weighted", "fee-optimized", "reliability-first")
   */
  getStrategyName(): string;

  /**
   * Get current weights used by strategy
   *
   * @returns Weights object (immutable)
   */
  getWeights(): {
    readonly fees: number;
    readonly liquidity: number;
    readonly reliability: number;
    readonly latency: number;
  };
}

/**
 * Ranking Context
 *
 * Contextual information for provider ranking.
 * Allows strategies to adapt based on historical data and market conditions.
 */
export interface IRankingContext {
  /** Chain identifier */
  readonly chain: string;

  /** Historical reliability scores per protocol (0-1) */
  readonly reliabilityScores: ReadonlyMap<FlashLoanProtocol, number>;

  /** Recent execution latencies per protocol (milliseconds) */
  readonly latencyHistory: ReadonlyMap<FlashLoanProtocol, ReadonlyArray<number>>;

  /** Cached liquidity estimates per protocol (wei) */
  readonly liquidityEstimates: ReadonlyMap<FlashLoanProtocol, bigint>;

  /** Market volatility (for adaptive strategies) */
  readonly volatility?: number;

  /** Recent MEV activity (for adaptive strategies) */
  readonly mevActivity?: number;
}

/**
 * Ranking Strategy Factory
 *
 * Creates ranking strategies based on configuration.
 */
export interface IProviderRankerFactory {
  /**
   * Create ranking strategy
   *
   * @param strategyType - Strategy type ("weighted" | "fee-optimized" | "reliability-first" | "adaptive")
   * @param config - Aggregator configuration
   * @returns Provider ranker instance
   */
  createRanker(
    strategyType: 'weighted' | 'fee-optimized' | 'reliability-first' | 'adaptive',
    config: AggregatorConfig
  ): IProviderRanker;
}
