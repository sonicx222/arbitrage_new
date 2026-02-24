/**
 * Hot Path Performance Monitor
 *
 * Monitors and tracks latency of critical hot path operations in the
 * arbitrage detection system. Provides warnings when operations exceed
 * defined thresholds.
 *
 * ## Usage
 *
 * ```typescript
 * import { measureHotPath, measureHotPathAsync, HotPathMonitor } from '@arbitrage/core';
 *
 * // Measure synchronous operation
 * const price = measureHotPath('price-calculation', () => {
 *   return calculatePriceFromReserves(reserve0, reserve1);
 * });
 *
 * // Measure async operation
 * const result = await measureHotPathAsync('opportunity-publish', async () => {
 *   return await publishOpportunity(opportunity);
 * });
 *
 * // Get statistics
 * const stats = HotPathMonitor.getInstance().getStats('price-calculation');
 * console.log(`p99: ${stats.p99}ms`);
 * ```
 *
 * @see Task 2.3: Hot Path Latency Monitoring
 */

import { createLogger } from '../logger';

const logger = createLogger('performance-monitor');

// =============================================================================
// Types
// =============================================================================

/**
 * Latency metric for a single measurement.
 */
export interface LatencyMetric {
  /** Operation name */
  operation: string;

  /** Latency in milliseconds */
  latencyMs: number;

  /** Timestamp of measurement */
  timestamp: number;
}

/**
 * Aggregated statistics for an operation.
 */
export interface LatencyStats {
  /** Average latency in ms */
  avg: number;

  /** 50th percentile (median) in ms */
  p50: number;

  /** 95th percentile in ms */
  p95: number;

  /** 99th percentile in ms */
  p99: number;

  /** Number of samples */
  count: number;
}

// =============================================================================
// Hot Path Monitor Implementation
// =============================================================================

export class HotPathMonitor {
  private static instance: HotPathMonitor | null = null;
  private metrics: LatencyMetric[] = [];
  private readonly maxMetrics = 10000;

  /**
   * Hot path thresholds in microseconds.
   * Operations exceeding these thresholds trigger warnings.
   */
  private thresholds: Record<string, number> = {
    'price-calculation': 100,      // 0.1ms - must be very fast
    'price-matrix-update': 1000,   // 1ms
    'arbitrage-detection': 5000,   // 5ms
    'opportunity-publish': 2000,   // 2ms
    'reserve-update': 500,         // 0.5ms
    'path-calculation': 3000,      // 3ms
    'profit-estimation': 1000,     // 1ms
    'gas-estimation': 2000,        // 2ms
    'slippage-calculation': 500,   // 0.5ms
  };

  private constructor() {}

  /**
   * Get the singleton instance.
   */
  static getInstance(): HotPathMonitor {
    if (!HotPathMonitor.instance) {
      HotPathMonitor.instance = new HotPathMonitor();
    }
    return HotPathMonitor.instance;
  }

  /**
   * Reset the singleton instance (for testing).
   */
  static resetInstance(): void {
    HotPathMonitor.instance = null;
  }

  // ===========================================================================
  // Recording
  // ===========================================================================

  /**
   * Record a latency measurement.
   *
   * @param operation - Operation name
   * @param latencyUs - Latency in microseconds
   */
  recordLatency(operation: string, latencyUs: number): void {
    const latencyMs = latencyUs / 1000;

    // Warn if exceeding threshold
    const threshold = this.thresholds[operation];
    if (threshold && latencyUs > threshold) {
      logger.warn(
        `Hot path slow: ${operation} took ${latencyMs.toFixed(2)}ms (threshold: ${threshold / 1000}ms)`
      );
    }

    this.metrics.push({
      operation,
      latencyMs,
      timestamp: Date.now()
    });

    // Trim old metrics if necessary
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics);
    }
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get statistics for an operation.
   *
   * @param operation - Operation name
   * @returns Aggregated statistics
   */
  getStats(operation: string): LatencyStats {
    const filtered = this.metrics
      .filter(m => m.operation === operation)
      .map(m => m.latencyMs)
      .sort((a, b) => a - b);

    if (filtered.length === 0) {
      return { avg: 0, p50: 0, p95: 0, p99: 0, count: 0 };
    }

    return {
      avg: filtered.reduce((a, b) => a + b, 0) / filtered.length,
      p50: filtered[Math.floor(filtered.length * 0.5)],
      p95: filtered[Math.floor(filtered.length * 0.95)],
      p99: filtered[Math.floor(filtered.length * 0.99)],
      count: filtered.length
    };
  }

  /**
   * Get statistics for all operations.
   *
   * @returns Map of operation names to statistics
   */
  getAllStats(): Map<string, LatencyStats> {
    // BUG-004 FIX: Single-pass grouping instead of O(n*k) repeated scans.
    // Previously called getStats() per operation, each scanning all metrics.
    const grouped = new Map<string, number[]>();
    for (const m of this.metrics) {
      let arr = grouped.get(m.operation);
      if (!arr) {
        arr = [];
        grouped.set(m.operation, arr);
      }
      arr.push(m.latencyMs);
    }

    const stats = new Map<string, LatencyStats>();
    for (const [operation, latencies] of grouped) {
      latencies.sort((a, b) => a - b);
      stats.set(operation, {
        avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
        p50: latencies[Math.floor(latencies.length * 0.5)],
        p95: latencies[Math.floor(latencies.length * 0.95)],
        p99: latencies[Math.floor(latencies.length * 0.99)],
        count: latencies.length
      });
    }

    return stats;
  }

  // ===========================================================================
  // Thresholds
  // ===========================================================================

  /**
   * Get all thresholds.
   */
  getThresholds(): Record<string, number> {
    return { ...this.thresholds };
  }

  /**
   * Set a custom threshold for an operation.
   *
   * @param operation - Operation name
   * @param thresholdUs - Threshold in microseconds
   */
  setThreshold(operation: string, thresholdUs: number): void {
    this.thresholds[operation] = thresholdUs;
  }

  // ===========================================================================
  // Maintenance
  // ===========================================================================

  /**
   * Clear all metrics.
   */
  clearMetrics(): void {
    this.metrics = [];
  }

  /**
   * Get recent metrics (for debugging/monitoring).
   *
   * @param limit - Maximum number of metrics to return
   * @returns Array of recent latency metrics
   */
  getRecentMetrics(limit: number = 100): LatencyMetric[] {
    return this.metrics.slice(-limit);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Measure execution time of a synchronous function.
 *
 * @param operation - Operation name for tracking
 * @param fn - Function to measure
 * @returns Return value of the function
 *
 * @example
 * const price = measureHotPath('price-calculation', () => {
 *   return calculatePriceFromReserves(reserve0, reserve1);
 * });
 */
export function measureHotPath<T>(operation: string, fn: () => T): T {
  const start = process.hrtime.bigint();
  try {
    const result = fn();
    const end = process.hrtime.bigint();
    const latencyUs = Number(end - start) / 1000;
    HotPathMonitor.getInstance().recordLatency(operation, latencyUs);
    return result;
  } catch (error) {
    const end = process.hrtime.bigint();
    const latencyUs = Number(end - start) / 1000;
    HotPathMonitor.getInstance().recordLatency(operation, latencyUs);
    throw error;
  }
}

/**
 * Measure execution time of an asynchronous function.
 *
 * @param operation - Operation name for tracking
 * @param fn - Async function to measure
 * @returns Promise resolving to the function's return value
 *
 * @example
 * const result = await measureHotPathAsync('opportunity-publish', async () => {
 *   return await publishOpportunity(opportunity);
 * });
 */
export async function measureHotPathAsync<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = process.hrtime.bigint();
  try {
    const result = await fn();
    const end = process.hrtime.bigint();
    const latencyUs = Number(end - start) / 1000;
    HotPathMonitor.getInstance().recordLatency(operation, latencyUs);
    return result;
  } catch (error) {
    const end = process.hrtime.bigint();
    const latencyUs = Number(end - start) / 1000;
    HotPathMonitor.getInstance().recordLatency(operation, latencyUs);
    throw error;
  }
}

// =============================================================================
// Singleton Export & Reset
// =============================================================================

/**
 * Reset function for testing.
 */
export function resetHotPathMonitor(): void {
  HotPathMonitor.resetInstance();
}

/**
 * BUG-010 FIX: Changed from const to getter function.
 * The previous `const hotPathMonitor = HotPathMonitor.getInstance()` captured
 * the singleton at module load time, so resetHotPathMonitor() didn't update it.
 * Now returns the live singleton on every call.
 *
 * @deprecated Unused — no external consumers. Remove in next major version.
 */
export function getHotPathMonitor(): HotPathMonitor {
  return HotPathMonitor.getInstance();
}

/**
 * @deprecated Use getHotPathMonitor() instead. This const captures the instance
 * at import time and doesn't reflect resets. Kept for backward compatibility.
 */
export const hotPathMonitor = HotPathMonitor.getInstance();
