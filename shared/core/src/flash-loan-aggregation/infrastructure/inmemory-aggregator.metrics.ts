/**
 * In-Memory Aggregator Metrics
 *
 * Tracks provider selection and execution metrics in-memory.
 * Implements IAggregatorMetrics following Observer Pattern.
 *
 * Features:
 * - In-memory storage (resets on process restart)
 * - Provider success/failure rates
 * - Selection latency tracking
 * - Reliability score calculation
 *
 * Performance Target:
 * - recordSelection(): <100μs
 * - recordOutcome(): <100μs
 * - getReliabilityScore(): <1ms
 *
 * @see docs/research/FLASHLOAN_MEV_IMPLEMENTATION_PLAN.md Phase 2 Task 2.3
 */

import type {
  IAggregatorMetrics,
  IAggregatedMetrics,
  IProviderInfo,
  ProviderOutcome,
} from '../domain';
import type { FlashLoanProtocol } from '../domain/models';

/**
 * Circular buffer for O(1) bounded latency tracking.
 * Replaces push/shift pattern (which is O(n) due to reindexing).
 */
class CircularBuffer {
  private readonly buffer: number[];
  private writeIndex = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buffer = new Array<number>(capacity);
  }

  push(value: number): void {
    this.buffer[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /** Return all stored samples (in insertion order) */
  toArray(): number[] {
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    // Buffer is full — oldest is at writeIndex, wrap around
    return [
      ...this.buffer.slice(this.writeIndex),
      ...this.buffer.slice(0, this.writeIndex),
    ];
  }

  get length(): number {
    return this.count;
  }

  reset(): void {
    this.writeIndex = 0;
    this.count = 0;
  }
}

/**
 * Provider-specific statistics
 */
interface ProviderStats {
  protocol: FlashLoanProtocol;
  timesSelected: number;
  successCount: number;
  failureCount: number;
  selectionLatencies: CircularBuffer;
  lastSelectedTime: number;
  lastSuccessTime: number;
  lastFailureTime: number;
}

/**
 * Metrics configuration
 */
export interface InMemoryAggregatorMetricsConfig {
  /** Maximum latency samples to keep (default: 100) */
  maxLatencySamples?: number;
  /** Minimum samples needed for reliable score (default: 10) */
  minSamplesForScore?: number;
}

/**
 * In-Memory Aggregator Metrics Tracker
 *
 * Tracks metrics for provider selection and execution outcomes.
 */
export class InMemoryAggregatorMetrics implements IAggregatorMetrics {
  private readonly config: Required<InMemoryAggregatorMetricsConfig>;
  private readonly providerStats = new Map<string, ProviderStats>();
  /** Secondary index: protocol → stats entries for O(1) lookup in recordOutcome() */
  private readonly protocolIndex = new Map<FlashLoanProtocol, ProviderStats[]>();

  // Global counters
  private totalSelections = 0;
  private selectionsWithLiquidityCheck = 0;
  private fallbacksTriggered = 0;
  private globalLatencies: CircularBuffer;

  constructor(config?: InMemoryAggregatorMetricsConfig) {
    this.config = {
      maxLatencySamples: config?.maxLatencySamples ?? 100,
      minSamplesForScore: config?.minSamplesForScore ?? 10,
    };
    this.globalLatencies = new CircularBuffer(this.config.maxLatencySamples);
  }

  /**
   * Record provider selection event
   */
  recordSelection(
    provider: IProviderInfo | null,
    reason: string,
    startTime: number
  ): void {
    const latencyMs = Date.now() - startTime;

    // Update global counters
    this.totalSelections++;
    this.globalLatencies.push(latencyMs);

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
    }
  }

  /**
   * Record provider execution outcome
   */
  recordOutcome(outcome: ProviderOutcome): void {
    // O(1) lookup via protocol index
    const statsEntries = this.protocolIndex.get(outcome.protocol);
    if (!statsEntries || statsEntries.length === 0) {
      return;
    }

    // Update all entries for this protocol (may span multiple chains)
    const now = Date.now();
    for (const stats of statsEntries) {
      if (outcome.success) {
        stats.successCount++;
        stats.lastSuccessTime = now;
      } else {
        stats.failureCount++;
        stats.lastFailureTime = now;
      }
    }
  }

  /**
   * Get reliability score for provider
   */
  async getReliabilityScore(provider: IProviderInfo): Promise<number> {
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
    return stats.successCount / total;
  }

  /**
   * Get provider health metrics
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
  } | null {
    const stats = this.providerStats.get(this.makeKey(provider));

    if (!stats) {
      return null;
    }

    return {
      timesSelected: stats.timesSelected,
      successCount: stats.successCount,
      failureCount: stats.failureCount,
      successRate: this.calculateSuccessRate(stats),
      avgLatencyMs: this.calculateAvgLatency(stats.selectionLatencies),
      lastSelectedTime: stats.lastSelectedTime,
      lastSuccessTime: stats.lastSuccessTime,
      lastFailureTime: stats.lastFailureTime,
    };
  }

  /**
   * Get aggregated metrics
   */
  getAggregatedMetrics(): IAggregatedMetrics {
    const byProvider = new Map<FlashLoanProtocol, {
      readonly timesSelected: number;
      readonly successRate: number;
      readonly avgLatencyMs: number;
    }>();

    for (const [_, stats] of this.providerStats) {
      byProvider.set(stats.protocol, {
        timesSelected: stats.timesSelected,
        successRate: this.calculateSuccessRate(stats),
        avgLatencyMs: this.calculateAvgLatency(stats.selectionLatencies),
      });
    }

    return {
      totalSelections: this.totalSelections,
      selectionsWithLiquidityCheck: this.selectionsWithLiquidityCheck,
      fallbacksTriggered: this.fallbacksTriggered,
      avgSelectionLatencyMs: this.calculateAvgLatency(this.globalLatencies),
      p95SelectionLatencyMs: this.calculateP95Latency(this.globalLatencies),
      byProvider,
    };
  }

  /**
   * Get metrics summary string
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

    for (const [protocol, stats] of metrics.byProvider) {
      lines.push(
        `  ${protocol}: selected ${stats.timesSelected}x, ` +
        `success rate ${(stats.successRate * 100).toFixed(1)}%, ` +
        `avg ${stats.avgLatencyMs.toFixed(1)}ms`
      );
    }

    return lines.join('\n');
  }

  /**
   * Reset all metrics
   */
  resetMetrics(): void {
    this.providerStats.clear();
    this.protocolIndex.clear();
    this.totalSelections = 0;
    this.selectionsWithLiquidityCheck = 0;
    this.fallbacksTriggered = 0;
    this.globalLatencies = new CircularBuffer(this.config.maxLatencySamples);
  }

  /**
   * Get or create stats for provider
   */
  private getOrCreateStats(provider: IProviderInfo): ProviderStats {
    const key = this.makeKey(provider);
    let stats = this.providerStats.get(key);

    if (!stats) {
      stats = {
        protocol: provider.protocol,
        timesSelected: 0,
        successCount: 0,
        failureCount: 0,
        selectionLatencies: new CircularBuffer(this.config.maxLatencySamples),
        lastSelectedTime: 0,
        lastSuccessTime: 0,
        lastFailureTime: 0,
      };
      this.providerStats.set(key, stats);

      // Maintain protocol index for O(1) lookup in recordOutcome()
      let entries = this.protocolIndex.get(provider.protocol);
      if (!entries) {
        entries = [];
        this.protocolIndex.set(provider.protocol, entries);
      }
      entries.push(stats);
    }

    return stats;
  }

  /**
   * Make unique key for provider
   */
  private makeKey(provider: IProviderInfo): string {
    return `${provider.protocol}-${provider.chain}`;
  }

  /**
   * Calculate success rate
   */
  private calculateSuccessRate(stats: ProviderStats): number {
    const total = stats.successCount + stats.failureCount;
    return total > 0 ? stats.successCount / total : 1.0;
  }

  /**
   * Calculate average latency
   */
  private calculateAvgLatency(buffer: CircularBuffer): number {
    if (buffer.length === 0) return 0;
    const samples = buffer.toArray();
    const sum = samples.reduce((a, b) => a + b, 0);
    return sum / samples.length;
  }

  /**
   * Calculate P95 latency
   */
  private calculateP95Latency(buffer: CircularBuffer): number {
    if (buffer.length === 0) return 0;
    const sorted = buffer.toArray().sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    return sorted[p95Index] || 0;
  }
}
