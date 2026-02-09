/**
 * Adaptive Warming Strategy (Enhancement #2)
 *
 * Dynamically adjusts number of pairs to warm based on L1 cache hit rate.
 * Self-tuning strategy that optimizes for target hit rate.
 *
 * @see warming/domain/warming-strategy.interface.ts - IWarmingStrategy contract
 * @see docs/architecture/adr/ADR-005-hierarchical-cache.md - Target hit rate: 97-99%
 *
 * @package @arbitrage/core
 * @module warming/application/strategies
 */

import {
  IWarmingStrategy,
  WarmingCandidate,
  WarmingContext,
  SelectionResult,
  AdaptiveStrategyConfig,
} from '../../domain';

/**
 * Adaptive warming strategy (self-tuning)
 *
 * Algorithm:
 * 1. Calculate hit rate delta: current - target
 * 2. Adjust N based on delta:
 *    - If hit rate low: increase N (more aggressive warming)
 *    - If hit rate high: decrease N (less aggressive warming)
 * 3. Clamp N to [minPairs, maxPairs]
 * 4. Select top N by correlation score
 *
 * Characteristics:
 * - Self-tuning based on hit rate feedback
 * - Converges to optimal N over time
 * - Handles changing workload patterns
 * - Recommended for production with varying load
 *
 * Configuration:
 * - targetHitRate: Target L1 hit rate (default: 0.97 = 97%)
 * - minPairs: Minimum pairs to warm (default: 3)
 * - maxPairs: Maximum pairs to warm (default: 10)
 * - minScore: Minimum correlation score (default: 0.3)
 * - adjustmentFactor: How aggressively to adjust N (default: 0.1)
 *
 * Adjustment Formula:
 * ```
 * delta = targetHitRate - currentHitRate
 * adjustment = delta * adjustmentFactor * maxPairs
 * newN = currentN + adjustment
 * N = clamp(newN, minPairs, maxPairs)
 * ```
 *
 * @example
 * ```typescript
 * const strategy = new AdaptiveStrategy({
 *   targetHitRate: 0.97,
 *   minPairs: 3,
 *   maxPairs: 10,
 *   adjustmentFactor: 0.1
 * });
 *
 * const context: WarmingContext = {
 *   l1HitRate: 0.93, // Below target
 *   correlations: [...],
 * };
 *
 * const result = strategy.selectPairs(context);
 * // Will warm more pairs (increase N) to reach target
 * ```
 */
export class AdaptiveStrategy implements IWarmingStrategy {
  private readonly config: AdaptiveStrategyConfig;
  private currentN: number;

  constructor(config: Partial<AdaptiveStrategyConfig> = {}) {
    this.config = {
      targetHitRate: config.targetHitRate ?? 0.97,
      minPairs: config.minPairs ?? 3,
      maxPairs: config.maxPairs ?? 10,
      minScore: config.minScore ?? 0.3,
      adjustmentFactor: config.adjustmentFactor ?? 0.1,
    };

    // Start at midpoint
    this.currentN = Math.floor((this.config.minPairs + this.config.maxPairs) / 2);
  }

  /**
   * Select pairs with adaptive N adjustment
   *
   * @param context - Warming context with L1 hit rate
   * @returns Selection result with adaptively selected pairs
   */
  selectPairs(context: WarmingContext): SelectionResult {
    // Adjust N based on hit rate feedback
    const delta = this.config.targetHitRate - context.l1HitRate;
    const adjustment = delta * this.config.adjustmentFactor * this.config.maxPairs;

    this.currentN = Math.round(this.currentN + adjustment);

    // Clamp to [minPairs, maxPairs]
    this.currentN = Math.max(this.config.minPairs, Math.min(this.config.maxPairs, this.currentN));

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

    // Select top N (adaptive)
    const topN = sorted.slice(0, this.currentN);

    // Map to warming candidates
    const candidates: WarmingCandidate[] = topN.map(correlation => ({
      pair: correlation.pair,
      correlationScore: correlation.score,
      priority: correlation.score,
      estimatedBenefit: correlation.score * correlation.coOccurrences,
    }));

    const hitRateDelta = (delta * 100).toFixed(2);
    const adjustmentDir = adjustment > 0 ? 'increased' : 'decreased';
    const reason = `Hit rate ${context.l1HitRate.toFixed(3)} (target: ${this.config.targetHitRate.toFixed(3)}, delta: ${hitRateDelta}%). Adjusted N to ${this.currentN} (${adjustmentDir}).`;

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
    return 'AdaptiveStrategy';
  }

  /**
   * Get strategy configuration
   */
  getConfig(): Record<string, unknown> {
    return {
      targetHitRate: this.config.targetHitRate,
      minPairs: this.config.minPairs,
      maxPairs: this.config.maxPairs,
      minScore: this.config.minScore,
      adjustmentFactor: this.config.adjustmentFactor,
      currentN: this.currentN,
    };
  }

  /**
   * Reset adaptive state (for testing)
   */
  reset(): void {
    this.currentN = Math.floor((this.config.minPairs + this.config.maxPairs) / 2);
  }
}
