/**
 * MEV Metrics Manager
 *
 * REFACTOR: Extracted common metrics logic from BaseMevProvider and JitoProvider
 * to reduce code duplication and ensure consistent behavior across all providers.
 *
 * Thread-safe metrics management using AsyncMutex for concurrent submissions.
 *
 * @module mev-protection/metrics-manager
 */

import { MevMetrics } from './types';
import { AsyncMutex } from '../async/async-mutex';

// =============================================================================
// Metric Field Type
// =============================================================================

/**
 * Fields that can be incremented in metrics
 */
export type IncrementableMetricField =
  | 'totalSubmissions'
  | 'successfulSubmissions'
  | 'failedSubmissions'
  | 'fallbackSubmissions'
  | 'bundlesIncluded'
  | 'bundlesReverted'
  | 'mevShareRebatesReceived'
  | 'bloxrouteSubmissions'
  | 'fastlaneSubmissions';

// =============================================================================
// Metrics Manager
// =============================================================================

/**
 * Thread-safe metrics manager for MEV providers
 *
 * Consolidates metrics handling logic that was duplicated across:
 * - BaseMevProvider (EVM providers)
 * - JitoProvider (Solana)
 *
 * Usage:
 * ```typescript
 * class MyProvider {
 *   private readonly metricsManager = new MevMetricsManager();
 *
 *   async sendTransaction() {
 *     await this.metricsManager.increment('totalSubmissions');
 *     // ... do work ...
 *     await this.metricsManager.increment('successfulSubmissions');
 *     await this.metricsManager.updateLatency(startTime);
 *   }
 *
 *   getMetrics(): MevMetrics {
 *     return this.metricsManager.getMetrics();
 *   }
 * }
 * ```
 */
export class MevMetricsManager {
  private metrics: MevMetrics;

  /**
   * Mutex for thread-safe metrics updates.
   * All metric modifications must go through this mutex to prevent race conditions
   * during concurrent transaction submissions.
   */
  private readonly mutex = new AsyncMutex();

  constructor() {
    this.metrics = this.createEmptyMetrics();
  }

  // ===========================================================================
  // Metrics Access (Thread-Safe)
  // ===========================================================================

  /**
   * Get current metrics (thread-safe read)
   *
   * Returns a shallow copy to prevent external modification.
   * For read-heavy workloads, the shallow copy provides sufficient
   * isolation without mutex overhead on reads.
   */
  getMetrics(): MevMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics (thread-safe)
   *
   * Note: This is synchronous to match IMevProvider interface.
   * Object assignment is atomic in JS single-threaded execution,
   * so this is safe without mutex for the assignment itself.
   */
  resetMetrics(): void {
    this.metrics = this.createEmptyMetrics();
  }

  // ===========================================================================
  // Metrics Updates (Thread-Safe)
  // ===========================================================================

  /**
   * Thread-safe metric increment
   *
   * Uses mutex to prevent race conditions during concurrent submissions.
   * Essential for accurate metrics in high-throughput scenarios.
   *
   * @param field - The metric field to increment
   */
  async increment(field: IncrementableMetricField): Promise<void> {
    await this.mutex.runExclusive(async () => {
      this.metrics[field]++;
      this.metrics.lastUpdated = Date.now();
    });
  }

  /**
   * Thread-safe latency update
   *
   * Must complete atomically since it reads and writes multiple metrics fields.
   * Uses running average based on successful submissions only.
   *
   * SAFETY-FIX: Handles edge case where updateLatency is called with 0 submissions
   * (stores as first value) and guards against negative latency from clock skew.
   *
   * @param startTime - The timestamp when the operation started
   */
  async updateLatency(startTime: number): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const now = Date.now();
      const latency = now - startTime;

      // SAFETY: Guard against negative latency from clock skew
      if (latency < 0) {
        this.metrics.lastUpdated = now;
        return;
      }

      const total = this.metrics.successfulSubmissions;

      if (total <= 0) {
        // SAFETY-FIX: If no successful submissions yet, store this latency
        // as a baseline (will be averaged once successfulSubmissions > 0).
        // This handles out-of-order calls defensively.
        this.metrics.averageLatencyMs = latency;
      } else if (total === 1) {
        this.metrics.averageLatencyMs = latency;
      } else {
        // Running average: new_avg = (old_avg * (n-1) + new_value) / n
        this.metrics.averageLatencyMs =
          (this.metrics.averageLatencyMs * (total - 1) + latency) / total;
      }

      this.metrics.lastUpdated = now;
    });
  }

  /**
   * Batch update multiple metrics atomically
   *
   * Use this when you need to update multiple metrics in a single operation
   * to ensure consistency. More efficient than multiple individual updates.
   *
   * PERF-TIP: For hot paths, prefer batchUpdate over multiple increment() calls
   * to reduce mutex contention and improve throughput.
   *
   * @param updates - Object containing fields to increment
   * @param startTime - Optional start time for latency calculation
   */
  async batchUpdate(
    updates: Partial<Record<IncrementableMetricField, number>>,
    startTime?: number
  ): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const now = Date.now();

      // Apply all increments
      for (const [field, count] of Object.entries(updates)) {
        if (count && count > 0) {
          this.metrics[field as IncrementableMetricField] += count;
        }
      }

      // Update latency if startTime provided
      if (startTime !== undefined) {
        const latency = now - startTime;

        // SAFETY: Guard against negative latency from clock skew
        if (latency >= 0) {
          const total = this.metrics.successfulSubmissions;

          if (total <= 0) {
            // Store as baseline for edge cases
            this.metrics.averageLatencyMs = latency;
          } else if (total === 1) {
            this.metrics.averageLatencyMs = latency;
          } else {
            this.metrics.averageLatencyMs =
              (this.metrics.averageLatencyMs * (total - 1) + latency) / total;
          }
        }
      }

      this.metrics.lastUpdated = now;
    });
  }

  /**
   * Record MEV-Share rebate (thread-safe)
   *
   * Updates rebate counter, total amount, and running average percentage.
   * Must be called atomically to ensure consistency across metrics.
   *
   * @param rebateWei - Rebate amount in wei
   * @param transactionValue - Total transaction value for percentage calculation (optional)
   */
  async recordRebate(rebateWei: bigint, transactionValue?: bigint): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const now = Date.now();

      // Increment rebate counter
      this.metrics.mevShareRebatesReceived++;

      // Accumulate total rebate
      this.metrics.totalRebateWei += rebateWei;

      // Calculate and update running average percentage
      if (transactionValue && transactionValue > 0n) {
        const rebatePercent = Number((rebateWei * 10000n) / transactionValue) / 100;
        const count = this.metrics.mevShareRebatesReceived;

        if (count === 1) {
          this.metrics.averageRebatePercent = rebatePercent;
        } else {
          // Running average: (old_avg * (n-1) + new_value) / n
          this.metrics.averageRebatePercent =
            (this.metrics.averageRebatePercent * (count - 1) + rebatePercent) / count;
        }
      }

      this.metrics.lastUpdated = now;
    });
  }

  // ===========================================================================
  // Internal Helpers
  // ===========================================================================

  /**
   * Create empty metrics object with current timestamp
   */
  private createEmptyMetrics(): MevMetrics {
    return {
      totalSubmissions: 0,
      successfulSubmissions: 0,
      failedSubmissions: 0,
      fallbackSubmissions: 0,
      averageLatencyMs: 0,
      bundlesIncluded: 0,
      bundlesReverted: 0,
      mevShareRebatesReceived: 0,
      totalRebateWei: 0n,
      averageRebatePercent: 0,
      bloxrouteSubmissions: 0,
      fastlaneSubmissions: 0,
      lastUpdated: Date.now(),
    };
  }
}

/**
 * Factory function to create a metrics manager
 */
export function createMevMetricsManager(): MevMetricsManager {
  return new MevMetricsManager();
}
