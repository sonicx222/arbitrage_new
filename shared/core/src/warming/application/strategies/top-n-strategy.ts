/**
 * TopN Warming Strategy (Enhancement #2)
 *
 * Warms top N pairs by correlation score (default strategy).
 * Simple, predictable, and effective for most use cases.
 *
 * @see warming/domain/warming-strategy.interface.ts - IWarmingStrategy contract
 * @see docs/architecture/adr/ADR-005-hierarchical-cache.md - Predictive warming
 *
 * @package @arbitrage/core
 * @module warming/application/strategies
 */

import {
  IWarmingStrategy,
  WarmingCandidate,
  WarmingContext,
  SelectionResult,
  TopNStrategyConfig,
} from '../../domain';

/**
 * Top-N warming strategy (default)
 *
 * Algorithm:
 * 1. Filter correlations by minimum score threshold
 * 2. Sort by correlation score descending
 * 3. Select top N candidates
 * 4. Assign priority = correlation score (simple linear mapping)
 *
 * Characteristics:
 * - Simple and predictable
 * - Works well for stable correlation patterns
 * - Low computational overhead (<1ms)
 * - Recommended for production use
 *
 * Configuration:
 * - topN: Number of pairs to select (default: 5)
 * - minScore: Minimum correlation score (default: 0.3)
 *
 * @example
 * ```typescript
 * const strategy = new TopNStrategy({ topN: 5, minScore: 0.3 });
 *
 * const context: WarmingContext = {
 *   sourcePair: 'WETH_USDT',
 *   correlations: [...], // From correlation tracker
 *   l1HitRate: 0.95,
 * };
 *
 * const result = strategy.selectPairs(context);
 * // Returns: Top 5 pairs with score >= 0.3
 * ```
 */
export class TopNStrategy implements IWarmingStrategy {
  private readonly config: TopNStrategyConfig;

  constructor(config: Partial<TopNStrategyConfig> = {}) {
    this.config = {
      topN: config.topN ?? 5,
      minScore: config.minScore ?? 0.3,
    };
  }

  /**
   * Select top N pairs by correlation score
   *
   * @param context - Warming context with correlations
   * @returns Selection result with top N candidates
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

    // Sort by score descending (already sorted by correlation tracker, but ensure)
    const sorted = filtered.sort((a, b) => b.score - a.score);

    // Select top N
    const topN = sorted.slice(0, this.config.topN);

    // Map to warming candidates
    const candidates: WarmingCandidate[] = topN.map(correlation => ({
      pair: correlation.pair,
      correlationScore: correlation.score,
      priority: correlation.score, // Simple: priority = score
      estimatedBenefit: correlation.score * correlation.coOccurrences,
    }));

    return {
      selectedPairs: candidates,
      reason: `Selected top ${candidates.length} pairs by correlation score`,
      strategyName: this.getName(),
    };
  }

  /**
   * Get strategy name
   */
  getName(): string {
    return 'TopNStrategy';
  }

  /**
   * Get strategy configuration
   */
  getConfig(): Record<string, unknown> {
    return {
      topN: this.config.topN,
      minScore: this.config.minScore,
    };
  }
}
