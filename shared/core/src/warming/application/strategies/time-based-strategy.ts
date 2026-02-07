/**
 * TimeBased Warming Strategy (Enhancement #2)
 *
 * Combines correlation score with recency of access.
 * Prioritizes recently accessed pairs with high correlation.
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
  TimeBasedStrategyConfig,
} from '../../domain';

/**
 * Time-based warming strategy
 *
 * Algorithm:
 * 1. For each correlation, compute combined score:
 *    combinedScore = (recencyWeight * recencyScore) + (correlationWeight * correlationScore)
 * 2. Recency score = 1.0 if within recency window, else exponential decay
 * 3. Sort by combined score descending
 * 4. Select top N
 *
 * Characteristics:
 * - Favors recently active pairs
 * - Balances correlation strength with temporal locality
 * - Good for workloads with temporal patterns
 * - More complex than TopN, but more context-aware
 *
 * Configuration:
 * - recencyWeight: Weight for recency component (default: 0.3)
 * - correlationWeight: Weight for correlation component (default: 0.7)
 * - recencyWindowMs: Time window for recency bonus (default: 60000 = 1 min)
 * - topN: Number of pairs to select (default: 5)
 * - minScore: Minimum combined score (default: 0.3)
 *
 * @example
 * ```typescript
 * const strategy = new TimeBasedStrategy({
 *   recencyWeight: 0.3,
 *   correlationWeight: 0.7,
 *   recencyWindowMs: 60000
 * });
 *
 * const result = strategy.selectPairs(context);
 * // Returns: Pairs ranked by combined score (recency + correlation)
 * ```
 */
export class TimeBasedStrategy implements IWarmingStrategy {
  private readonly config: TimeBasedStrategyConfig;

  constructor(config: Partial<TimeBasedStrategyConfig> = {}) {
    this.config = {
      recencyWeight: config.recencyWeight ?? 0.3,
      correlationWeight: config.correlationWeight ?? 0.7,
      recencyWindowMs: config.recencyWindowMs ?? 60000,
      topN: config.topN ?? 5,
      minScore: config.minScore ?? 0.3,
    };
  }

  /**
   * Select pairs by combined recency + correlation score
   *
   * @param context - Warming context with correlations and timestamp
   * @returns Selection result with time-aware ranking
   */
  selectPairs(context: WarmingContext): SelectionResult {
    const now = context.timestamp || Date.now();

    // Compute combined scores
    const scored = context.correlations.map(correlation => {
      // Recency score (1.0 within window, exponential decay after)
      const ageMs = now - correlation.lastSeenTimestamp;
      const recencyScore =
        ageMs < this.config.recencyWindowMs
          ? 1.0
          : Math.exp(-ageMs / this.config.recencyWindowMs);

      // Combined score (weighted sum)
      const combinedScore =
        this.config.recencyWeight * recencyScore +
        this.config.correlationWeight * correlation.score;

      return {
        correlation,
        recencyScore,
        combinedScore,
      };
    });

    // Filter by minimum combined score
    const filtered = scored.filter(s => s.combinedScore >= this.config.minScore);

    if (filtered.length === 0) {
      return {
        selectedPairs: [],
        reason: `No correlations found with combined score >= ${this.config.minScore}`,
        strategyName: this.getName(),
      };
    }

    // Sort by combined score descending
    const sorted = filtered.sort((a, b) => b.combinedScore - a.combinedScore);

    // Select top N
    const topN = sorted.slice(0, this.config.topN);

    // Map to warming candidates
    const candidates: WarmingCandidate[] = topN.map(item => ({
      pair: item.correlation.pair,
      correlationScore: item.correlation.score,
      priority: item.combinedScore,
      estimatedBenefit: item.combinedScore * item.correlation.coOccurrences,
      metadata: {
        recencyScore: item.recencyScore,
        combinedScore: item.combinedScore,
        ageMs: now - item.correlation.lastSeenTimestamp,
      },
    }));

    return {
      selectedPairs: candidates,
      reason: `Selected top ${candidates.length} pairs by combined score (${this.config.correlationWeight * 100}% correlation + ${this.config.recencyWeight * 100}% recency)`,
      strategyName: this.getName(),
    };
  }

  /**
   * Get strategy name
   */
  getName(): string {
    return 'TimeBasedStrategy';
  }

  /**
   * Get strategy configuration
   */
  getConfig(): Record<string, unknown> {
    return {
      recencyWeight: this.config.recencyWeight,
      correlationWeight: this.config.correlationWeight,
      recencyWindowMs: this.config.recencyWindowMs,
      topN: this.config.topN,
      minScore: this.config.minScore,
    };
  }
}
