/**
 * Flash Loan Aggregator Metrics
 *
 * Tracks provider selection events, execution outcomes, and calculates reliability scores
 * for intelligent provider ranking.
 *
 * Features:
 * - In-memory metrics tracking (process lifetime)
 * - Provider success/failure rates
 * - Selection latency tracking
 * - Reliability score calculation (15% weight in aggregator)
 * - Aggregated metrics for monitoring
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

import type { IFlashLoanProvider, FlashLoanProtocol } from './flash-loan-providers/types';
import type { Logger } from '../types';

/**
 * Provider-specific statistics
 */
interface ProviderStats {
  /** Protocol identifier */
  protocol: FlashLoanProtocol;
  /** Number of times selected */
  timesSelected: number;
  /** Number of successful executions */
  successCount: number;
  /** Number of failed executions */
  failureCount: number;
  /** Selection latencies (last 100) */
  selectionLatencies: number[];
  /** Timestamp of last selection */
  lastSelectedTime: number;
  /** Timestamp of last successful execution */
  lastSuccessTime: number;
  /** Timestamp of last failure */
  lastFailureTime: number;
}

/**
 * Aggregated metrics across all providers
 */
export interface AggregatedMetrics {
  /** Total number of selections */
  totalSelections: number;
  /** Selections that performed liquidity checks */
  selectionsWithLiquidityCheck: number;
  /** Number of times fallback was triggered */
  fallbacksTriggered: number;
  /** Average selection latency in ms */
  avgSelectionLatencyMs: number;
  /** P95 selection latency in ms */
  p95SelectionLatencyMs: number;
  /** Provider-specific metrics */
  byProvider: Record<FlashLoanProtocol, {
    timesSelected: number;
    successRate: number;
    avgLatencyMs: number;
  }>;
}

/**
 * Configuration for metrics tracking
 */
export interface MetricsConfig {
  /** Maximum latency samples to keep (default: 100) */
  maxLatencySamples?: number;
  /** Minimum samples needed for reliable score (default: 10) */
  minSamplesForScore?: number;
}

/**
 * Flash Loan Aggregator Metrics Tracker
 *
 * Tracks provider selection and execution metrics for intelligent provider ranking.
 * Uses in-memory storage (resets on process restart).
 *
 * Usage:
 * ```typescript
 * const metrics = new FlashLoanAggregatorMetrics(logger);
 *
 * // Record selection
 * metrics.recordSelection(provider, 'best_ranked', Date.now());
 *
 * // Record execution outcome
 * metrics.recordAttempt(provider, true, 150);
 *
 * // Get reliability score for ranking
 * const score = await metrics.getReliabilityScore(provider);
 * ```
 */
export class FlashLoanAggregatorMetrics {
  private readonly config: Required<MetricsConfig>;
  private readonly providerStats = new Map<string, ProviderStats>();

  // Global counters
  private totalSelections = 0;
  private selectionsWithLiquidityCheck = 0;
  private fallbacksTriggered = 0;
  private globalLatencies: number[] = [];

  constructor(
    private readonly logger: Logger,
    config?: MetricsConfig
  ) {
    this.config = {
      maxLatencySamples: config?.maxLatencySamples ?? 100,
      minSamplesForScore: config?.minSamplesForScore ?? 10,
    };
  }

  /**
   * Record provider selection event.
   *
   * Call this when aggregator selects a provider (or fails to select one).
   *
   * @param provider - Selected provider (null if none selected)
   * @param reason - Selection/rejection reason
   * @param startTime - Selection start timestamp (from Date.now())
   */
  recordSelection(
    provider: IFlashLoanProvider | null,
    reason: string,
    startTime: number
  ): void {
    const latencyMs = Date.now() - startTime;

    // Update global counters
    this.totalSelections++;
    this.globalLatencies.push(latencyMs);
    if (this.globalLatencies.length > this.config.maxLatencySamples) {
      this.globalLatencies.shift();
    }

    // Track liquidity checks
    if (reason.includes('liquidity')) {
      this.selectionsWithLiquidityCheck++;
    }

    // Track fallbacks
    if (provider === null || reason.includes('fallback') || reason.includes('failed')) {
      this.fallbacksTriggered++;
    }

    // Update provider stats
    if (provider) {
      const stats = this.getOrCreateStats(provider);
      stats.timesSelected++;
      stats.lastSelectedTime = Date.now();
      stats.selectionLatencies.push(latencyMs);
      if (stats.selectionLatencies.length > this.config.maxLatencySamples) {
        stats.selectionLatencies.shift();
      }

      this.logger.debug('[AggregatorMetrics] Selection recorded', {
        protocol: provider.protocol,
        reason,
        latencyMs,
        totalSelections: this.totalSelections,
      });
    }
  }

  /**
   * Record provider execution attempt.
   *
   * Call this after attempting to execute with a provider.
   *
   * @param provider - Provider that was used
   * @param success - Whether execution succeeded
   * @param latencyMs - Execution latency
   * @param error - Error if failed
   */
  recordAttempt(
    provider: IFlashLoanProvider,
    success: boolean,
    latencyMs: number,
    error?: Error
  ): void {
    const stats = this.getOrCreateStats(provider);

    if (success) {
      stats.successCount++;
      stats.lastSuccessTime = Date.now();

      this.logger.debug('[AggregatorMetrics] Success recorded', {
        protocol: provider.protocol,
        latencyMs,
        successRate: this.calculateSuccessRate(stats),
      });
    } else {
      stats.failureCount++;
      stats.lastFailureTime = Date.now();

      this.logger.debug('[AggregatorMetrics] Failure recorded', {
        protocol: provider.protocol,
        error: error?.message,
        successRate: this.calculateSuccessRate(stats),
      });
    }
  }

  /**
   * Get reliability score (0-1) for a provider.
   *
   * Used by aggregator for provider ranking (15% weight).
   * Returns 1.0 if insufficient samples for meaningful score.
   *
   * @param provider - Provider to score
   * @returns Reliability score (0-1)
   */
  async getReliabilityScore(provider: IFlashLoanProvider): Promise<number> {
    const key = this.makeKey(provider);
    const stats = this.providerStats.get(key);

    if (!stats) {
      // No data - assume perfect reliability
      return 1.0;
    }

    const total = stats.successCount + stats.failureCount;

    if (total < this.config.minSamplesForScore) {
      // Not enough data for reliable score
      return 1.0;
    }

    // Calculate success rate
    const successRate = stats.successCount / total;

    this.logger.debug('[AggregatorMetrics] Reliability score calculated', {
      protocol: provider.protocol,
      successRate,
      samples: total,
    });

    return successRate;
  }

  /**
   * Get provider-specific health metrics
   *
   * @param provider - Provider to query
   * @returns Provider statistics or null if no data
   */
  getProviderHealth(provider: IFlashLoanProvider): ProviderStats | null {
    const stats = this.providerStats.get(this.makeKey(provider));
    return stats ? { ...stats } : null;
  }

  /**
   * Get aggregated metrics across all providers
   *
   * @returns Aggregated metrics summary
   */
  getAggregatedMetrics(): AggregatedMetrics {
    const byProvider: Record<string, {
      timesSelected: number;
      successRate: number;
      avgLatencyMs: number;
    }> = {};

    for (const [_, stats] of this.providerStats) {
      byProvider[stats.protocol] = {
        timesSelected: stats.timesSelected,
        successRate: this.calculateSuccessRate(stats),
        avgLatencyMs: this.calculateAvgLatency(stats.selectionLatencies),
      };
    }

    return {
      totalSelections: this.totalSelections,
      selectionsWithLiquidityCheck: this.selectionsWithLiquidityCheck,
      fallbacksTriggered: this.fallbacksTriggered,
      avgSelectionLatencyMs: this.calculateAvgLatency(this.globalLatencies),
      p95SelectionLatencyMs: this.calculateP95Latency(this.globalLatencies),
      byProvider: byProvider as Record<FlashLoanProtocol, {
        timesSelected: number;
        successRate: number;
        avgLatencyMs: number;
      }>,
    };
  }

  /**
   * Get summary for logging/debugging
   *
   * @returns Human-readable metrics summary
   */
  getMetricsSummary(): string {
    const metrics = this.getAggregatedMetrics();
    const lines: string[] = [
      `Total selections: ${metrics.totalSelections}`,
      `With liquidity check: ${metrics.selectionsWithLiquidityCheck}`,
      `Fallbacks triggered: ${metrics.fallbacksTriggered}`,
      `Avg selection latency: ${metrics.avgSelectionLatencyMs.toFixed(1)}ms`,
      `P95 selection latency: ${metrics.p95SelectionLatencyMs.toFixed(1)}ms`,
    ];

    for (const [protocol, stats] of Object.entries(metrics.byProvider)) {
      lines.push(
        `  ${protocol}: selected ${stats.timesSelected}x, ` +
        `success rate ${(stats.successRate * 100).toFixed(1)}%, ` +
        `avg ${stats.avgLatencyMs.toFixed(1)}ms`
      );
    }

    return lines.join('\n');
  }

  /**
   * Reset all metrics (for testing)
   */
  resetMetrics(): void {
    this.providerStats.clear();
    this.totalSelections = 0;
    this.selectionsWithLiquidityCheck = 0;
    this.fallbacksTriggered = 0;
    this.globalLatencies = [];

    this.logger.debug('[AggregatorMetrics] Metrics reset');
  }

  /**
   * Get or create stats for a provider
   */
  private getOrCreateStats(provider: IFlashLoanProvider): ProviderStats {
    const key = this.makeKey(provider);
    let stats = this.providerStats.get(key);

    if (!stats) {
      stats = {
        protocol: provider.protocol,
        timesSelected: 0,
        successCount: 0,
        failureCount: 0,
        selectionLatencies: [],
        lastSelectedTime: 0,
        lastSuccessTime: 0,
        lastFailureTime: 0,
      };
      this.providerStats.set(key, stats);
    }

    return stats;
  }

  /**
   * Make unique key for provider
   */
  private makeKey(provider: IFlashLoanProvider): string {
    return `${provider.protocol}-${provider.chain}`;
  }

  /**
   * Calculate success rate for provider stats
   */
  private calculateSuccessRate(stats: ProviderStats): number {
    const total = stats.successCount + stats.failureCount;
    return total > 0 ? stats.successCount / total : 1.0;
  }

  /**
   * Calculate average latency from samples
   */
  private calculateAvgLatency(samples: number[]): number {
    if (samples.length === 0) return 0;
    const sum = samples.reduce((a, b) => a + b, 0);
    return sum / samples.length;
  }

  /**
   * Calculate P95 latency from samples
   */
  private calculateP95Latency(samples: number[]): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    return sorted[p95Index] || 0;
  }
}

/**
 * Factory function to create metrics tracker
 */
export function createFlashLoanAggregatorMetrics(
  logger: Logger,
  config?: MetricsConfig
): FlashLoanAggregatorMetrics {
  return new FlashLoanAggregatorMetrics(logger, config);
}
