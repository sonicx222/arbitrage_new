/**
 * Warming Strategy Interface (Enhancement #2 - Predictive Warming)
 *
 * Defines the contract for different cache warming strategies.
 * Follows Strategy Pattern to allow pluggable algorithms for selecting pairs to warm.
 *
 * Design Principles:
 * - Open/Closed: Open for extension (new strategies), closed for modification
 * - Strategy Pattern: Encapsulate warming algorithms
 * - Single Responsibility: Each strategy focuses on one selection approach
 *
 * Available Strategies:
 * - TopNStrategy: Warm top N pairs by correlation score (default)
 * - ThresholdStrategy: Warm all pairs above threshold score
 * - AdaptiveStrategy: Adjust N based on cache hit rate
 * - TimeBasedStrategy: Warm based on recency + correlation
 *
 * @package @arbitrage/core
 * @module warming/domain
 */

import { PairCorrelation } from './correlation-tracker.interface';

/**
 * Candidate pair for warming with metadata
 */
export interface WarmingCandidate {
  /**
   * The pair identifier (e.g., "WETH_USDT")
   */
  readonly pair: string;

  /**
   * Correlation score with source pair (0.0-1.0)
   */
  readonly correlationScore: number;

  /**
   * Priority score for warming (0.0-1.0)
   *
   * Computed by strategy based on multiple factors:
   * - Correlation score
   * - Recency of access
   * - Cache hit/miss history
   * - Business priority (e.g., high-value pairs)
   */
  readonly priority: number;

  /**
   * Estimated benefit of warming (arbitrary units)
   *
   * Used to rank candidates when strategy selects top N.
   * Higher = more beneficial to warm.
   */
  readonly estimatedBenefit: number;

  /**
   * Additional metadata for debugging
   */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Context provided to warming strategy
 */
export interface WarmingContext {
  /**
   * The source pair that triggered warming
   */
  readonly sourcePair: string;

  /**
   * Current L1 cache size
   */
  readonly l1Size: number;

  /**
   * Maximum L1 cache capacity
   */
  readonly l1Capacity: number;

  /**
   * Current L1 hit rate (0.0-1.0)
   */
  readonly l1HitRate: number;

  /**
   * Available correlations from tracker
   */
  readonly correlations: PairCorrelation[];

  /**
   * Timestamp of warming trigger (Unix ms)
   */
  readonly timestamp: number;
}

/**
 * Result of strategy selection
 */
export interface SelectionResult {
  /**
   * Pairs selected for warming, ordered by priority descending
   */
  readonly selectedPairs: WarmingCandidate[];

  /**
   * Reason for selection decisions (for debugging)
   */
  readonly reason: string;

  /**
   * Strategy name that made the selection
   */
  readonly strategyName: string;
}

/**
 * Warming strategy for selecting pairs to warm
 *
 * Strategies determine:
 * - Which pairs to warm (selection)
 * - How many pairs to warm (count)
 * - In what order to warm them (priority)
 *
 * Implementation Notes:
 * - Strategies should be stateless (no instance state)
 * - All context provided via WarmingContext parameter
 * - Should complete in <1ms (not hot path, but avoid blocking)
 *
 * @example
 * ```typescript
 * // Top-N Strategy (default)
 * const strategy = new TopNStrategy({ topN: 5, minScore: 0.3 });
 *
 * const context: WarmingContext = {
 *   sourcePair: 'WETH_USDT',
 *   l1HitRate: 0.95,
 *   correlations: [...], // From correlation tracker
 * };
 *
 * const result = strategy.selectPairs(context);
 * // Returns: Top 5 pairs with score >= 0.3
 * ```
 */
export interface IWarmingStrategy {
  /**
   * Select pairs to warm based on strategy algorithm
   *
   * This is called by ICacheWarmer when warming is triggered.
   * Strategy analyzes context and correlations to make selection.
   *
   * Algorithm (varies by strategy):
   * 1. Filter correlations by minimum score
   * 2. Compute priority score for each candidate
   * 3. Sort by priority descending
   * 4. Select top N candidates
   * 5. Return selection result
   *
   * Performance: <1ms (background operation)
   *
   * @param context - Warming context with correlations and cache state
   * @returns Selection result with ordered candidates
   */
  selectPairs(context: WarmingContext): SelectionResult;

  /**
   * Get strategy name for logging and metrics
   *
   * @returns Human-readable strategy name
   */
  getName(): string;

  /**
   * Get strategy configuration
   *
   * Returns current strategy parameters.
   * Format varies by strategy implementation.
   *
   * @returns Strategy-specific configuration
   */
  getConfig(): Record<string, unknown>;
}

/**
 * Configuration for TopNStrategy
 */
export interface TopNStrategyConfig {
  /**
   * Number of top pairs to select (default: 5)
   */
  readonly topN: number;

  /**
   * Minimum correlation score threshold (default: 0.3)
   */
  readonly minScore: number;
}

/**
 * Configuration for ThresholdStrategy
 */
export interface ThresholdStrategyConfig {
  /**
   * Minimum correlation score threshold (default: 0.5)
   */
  readonly minScore: number;

  /**
   * Maximum pairs to warm (cap to prevent overload) (default: 10)
   */
  readonly maxPairs: number;
}

/**
 * Configuration for AdaptiveStrategy
 */
export interface AdaptiveStrategyConfig {
  /**
   * Target L1 hit rate (0.0-1.0) (default: 0.97)
   *
   * Strategy adjusts N dynamically to reach this target.
   */
  readonly targetHitRate: number;

  /**
   * Minimum pairs to warm (default: 3)
   */
  readonly minPairs: number;

  /**
   * Maximum pairs to warm (default: 10)
   */
  readonly maxPairs: number;

  /**
   * Minimum correlation score (default: 0.3)
   */
  readonly minScore: number;

  /**
   * Adjustment factor (0.0-1.0) (default: 0.1)
   *
   * Controls how aggressively to adjust N based on hit rate.
   */
  readonly adjustmentFactor: number;
}

/**
 * Configuration for TimeBasedStrategy
 */
export interface TimeBasedStrategyConfig {
  /**
   * Recency weight (0.0-1.0) (default: 0.3)
   *
   * How much to weight recency vs correlation score.
   */
  readonly recencyWeight: number;

  /**
   * Correlation weight (0.0-1.0) (default: 0.7)
   */
  readonly correlationWeight: number;

  /**
   * Recency window (milliseconds) (default: 60000 = 1 minute)
   *
   * Pairs accessed within this window get recency bonus.
   */
  readonly recencyWindowMs: number;

  /**
   * Top N pairs to select (default: 5)
   */
  readonly topN: number;

  /**
   * Minimum combined score (default: 0.3)
   */
  readonly minScore: number;
}
