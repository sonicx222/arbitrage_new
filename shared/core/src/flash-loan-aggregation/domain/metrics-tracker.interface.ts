/**
 * Aggregator Metrics Tracker - Domain Interface
 *
 * Interface for tracking provider selection and execution metrics.
 * Follows Observer Pattern for decoupled metrics collection.
 *
 * Performance Target:
 * - recordSelection(): <100μs
 * - recordOutcome(): <100μs
 * - getReliabilityScore(): <1ms
 *
 * @see docs/CLEAN_ARCHITECTURE_DAY1_SUMMARY.md Observer Pattern
 */

import type { ProviderOutcome } from './models';
import type { IProviderInfo } from './provider-ranker.interface';
import type { FlashLoanProtocol } from '../../../../../services/execution-engine/src/strategies/flash-loan-providers/types';

/**
 * Aggregated Metrics Summary
 *
 * Read-only view of aggregator performance.
 */
export interface IAggregatedMetrics {
  /** Total provider selections */
  readonly totalSelections: number;

  /** Selections with liquidity checks performed */
  readonly selectionsWithLiquidityCheck: number;

  /** Times fallback was triggered */
  readonly fallbacksTriggered: number;

  /** Average selection latency (milliseconds) */
  readonly avgSelectionLatencyMs: number;

  /** P95 selection latency (milliseconds) */
  readonly p95SelectionLatencyMs: number;

  /** Per-provider metrics */
  readonly byProvider: ReadonlyMap<FlashLoanProtocol, {
    readonly timesSelected: number;
    readonly successRate: number;
    readonly avgLatencyMs: number;
  }>;
}

/**
 * Aggregator Metrics Tracker - Domain Interface
 *
 * Responsibilities:
 * - Track provider selection events
 * - Track execution outcomes (success/failure)
 * - Calculate reliability scores for ranking
 * - Provide aggregated metrics for monitoring
 *
 * Following Observer Pattern:
 * - Decoupled from aggregator business logic
 * - Multiple observers can track different metrics
 * - Hot-path operations are non-blocking
 *
 * Following SOLID Principles:
 * - **Single Responsibility**: Metrics tracking only
 * - **Open/Closed**: Open for extension (new metric types)
 * - **Interface Segregation**: Read and write operations separated
 * - **Dependency Inversion**: Depends on abstractions
 *
 * @example
 * ```typescript
 * const metrics: IAggregatorMetrics = createMetrics();
 *
 * // Record selection
 * metrics.recordSelection(provider, 'best_ranked', startTime);
 *
 * // Record outcome
 * const outcome = ProviderOutcome.success('aave_v3', 150);
 * metrics.recordOutcome(outcome);
 *
 * // Get reliability score for ranking
 * const score = await metrics.getReliabilityScore(provider);
 * ```
 */
export interface IAggregatorMetrics {
  /**
   * Record provider selection event
   *
   * Call this when aggregator selects (or fails to select) a provider.
   *
   * Performance: <100μs (hot-path safe)
   *
   * @param provider - Selected provider (null if selection failed)
   * @param reason - Selection/rejection reason
   * @param startTime - Selection start timestamp (from Date.now())
   */
  recordSelection(
    provider: IProviderInfo | null,
    reason: string,
    startTime: number
  ): void;

  /**
   * Record provider execution outcome
   *
   * Call this after attempting execution with a provider.
   *
   * Performance: <100μs (hot-path safe)
   *
   * @param outcome - Execution outcome (immutable)
   */
  recordOutcome(outcome: ProviderOutcome): void;

  /**
   * Get reliability score for provider
   *
   * Used by provider ranker for ranking (15% weight).
   * Returns 1.0 if insufficient samples (<10) for reliable score.
   *
   * Formula: successRate = successCount / (successCount + failureCount)
   *
   * Performance: <1ms
   *
   * @param provider - Provider to score
   * @returns Reliability score [0, 1]
   */
  getReliabilityScore(provider: IProviderInfo): Promise<number>;

  /**
   * Get provider-specific health metrics
   *
   * Returns detailed statistics for monitoring/debugging.
   *
   * @param provider - Provider to query
   * @returns Provider health stats or null if no data
   */
  getProviderHealth(provider: IProviderInfo): {
    readonly timesSelected: number;
    readonly successCount: number;
    readonly failureCount: number;
    readonly successRate: number;
    readonly avgLatencyMs: number;
    readonly lastSelectedTime: number;
    readonly lastSuccessTime: number;
    readonly lastFailureTime: number;
  } | null;

  /**
   * Get aggregated metrics across all providers
   *
   * Returns summary for monitoring dashboards.
   *
   * @returns Aggregated metrics (immutable)
   */
  getAggregatedMetrics(): IAggregatedMetrics;

  /**
   * Get human-readable metrics summary
   *
   * For logging/debugging.
   *
   * @returns Formatted metrics string
   */
  getMetricsSummary(): string;

  /**
   * Reset all metrics (for testing)
   */
  resetMetrics(): void;
}

/**
 * Metrics Tracker Factory
 */
export type AggregatorMetricsFactory = (
  config: {
    maxLatencySamples?: number;
    minSamplesForScore?: number;
  }
) => IAggregatorMetrics;
