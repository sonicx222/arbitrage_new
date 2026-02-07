/**
 * Threshold Warming Strategy (Enhancement #2)
 *
 * Warms ALL pairs above a correlation score threshold.
 * Useful for aggressive warming when cache capacity is not a concern.
 *
 * @see warming/domain/warming-strategy.interface.ts - IWarmingStrategy contract
 *
 * @package @arbitrage/core
 * @module warming/application/strategies
 */

import {
  IWarmingStrategy,
  WarmingCandidate,
  WarmingContext,
  SelectionResult,
  ThresholdStrategyConfig,
} from '../../domain';

/**
 * Threshold warming strategy
 *
 * Algorithm:
 * 1. Filter correlations by minimum score threshold
 * 2. Cap at maximum pairs (prevent overload)
 * 3. Sort by score descending
 * 4. Assign priority = correlation score
 *
 * Characteristics:
 * - More aggressive than TopN (can warm many pairs)
 * - Adapts to correlation strength automatically
 * - Risk: May warm too many pairs if threshold too low
 * - Recommended for large L1 cache sizes
 *
 * Configuration:
 * - minScore: Minimum correlation score (default: 0.5)
 * - maxPairs: Maximum pairs to warm (cap, default: 10)
 *
 * @example
 * ```typescript
 * const strategy = new ThresholdStrategy({ minScore: 0.5, maxPairs: 10 });
 *
 * const result = strategy.selectPairs(context);
 * // Returns: All pairs with score >= 0.5 (max 10)
 * ```
 */
export class ThresholdStrategy implements IWarmingStrategy {
  private readonly config: ThresholdStrategyConfig;

  constructor(config: Partial<ThresholdStrategyConfig> = {}) {
    this.config = {
      minScore: config.minScore ?? 0.5,
      maxPairs: config.maxPairs ?? 10,
    };
  }

  /**
   * Select all pairs above threshold score
   *
   * @param context - Warming context with correlations
   * @returns Selection result with all qualifying pairs
   */
  selectPairs(context: WarmingContext): SelectionResult {
    // Filter by minimum score
    const filtered = context.correlations.filter(
      c => c.score >= this.config.minScore
    );

    if (filtered.length === 0) {
      return {
        selectedPairs: [],
        reason: `No correlations found with score >= ${this.config.minScore}`,
        strategyName: this.getName(),
      };
    }

    // Sort by score descending
    const sorted = filtered.sort((a, b) => b.score - a.score);

    // Cap at max pairs (prevent overload)
    const capped = sorted.slice(0, this.config.maxPairs);

    // Map to warming candidates
    const candidates: WarmingCandidate[] = capped.map(correlation => ({
      pair: correlation.pair,
      correlationScore: correlation.score,
      priority: correlation.score,
      estimatedBenefit: correlation.score * correlation.coOccurrences,
    }));

    const reason =
      filtered.length > this.config.maxPairs
        ? `Selected ${candidates.length}/${filtered.length} pairs above threshold (capped at max)`
        : `Selected all ${candidates.length} pairs above threshold`;

    return {
      selectedPairs: candidates,
      reason,
      strategyName: this.getName(),
    };
  }

  /**
   * Get strategy name
   */
  getName(): string {
    return 'ThresholdStrategy';
  }

  /**
   * Get strategy configuration
   */
  getConfig(): Record<string, unknown> {
    return {
      minScore: this.config.minScore,
      maxPairs: this.config.maxPairs,
    };
  }
}
