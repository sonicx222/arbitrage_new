/**
 * Metrics Collector for A/B Testing
 *
 * Collects and stores execution metrics for each experiment variant.
 * Uses Redis for persistent storage with TTL.
 *
 * RACE CONDITION FIX: Uses in-memory locking per key to prevent lost updates
 * when multiple concurrent recordResult calls arrive for the same experiment.
 *
 * @see FINAL_IMPLEMENTATION_PLAN.md Task 3: A/B Testing Framework
 */

import { clearTimeoutSafe } from '@arbitrage/core';
import type { RedisClient } from '@arbitrage/core';
import type {
  ExperimentMetrics,
  ComputedMetrics,
  ABTestExecutionResult,
  VariantAssignment,
  ABTestingConfig,
} from './types';

/** Logger interface for MetricsCollector DI */
interface MetricsLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
}

// =============================================================================
// Metrics Keys
// =============================================================================

function getMetricsKey(
  prefix: string,
  experimentId: string,
  variant: VariantAssignment
): string {
  return `${prefix}metrics:${experimentId}:${variant}`;
}

// =============================================================================
// Metrics Collector Implementation
// =============================================================================

/**
 * Metrics collector for A/B testing experiments.
 *
 * Responsibilities:
 * - Record execution results per variant
 * - Store metrics in Redis with TTL
 * - Compute aggregated metrics
 */
export class MetricsCollector {
  private readonly redis: RedisClient;
  private readonly config: ABTestingConfig;
  private readonly logger?: MetricsLogger;

  // In-memory buffer for batching Redis writes
  private readonly buffer: Map<string, ExperimentMetrics> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs = 5000; // Flush every 5 seconds

  // RACE CONDITION FIX: Per-key locks to serialize updates
  private readonly pendingUpdates: Map<string, Promise<void>> = new Map();

  constructor(redis: RedisClient, config: ABTestingConfig, logger?: MetricsLogger) {
    this.redis = redis;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Record an execution result for an experiment.
   *
   * RACE CONDITION FIX: Serializes updates per key to prevent lost updates.
   * When multiple concurrent calls arrive for the same key, they queue up
   * and execute sequentially, ensuring all increments are captured.
   *
   * @param result - The execution result with A/B testing metadata
   */
  async recordResult(result: ABTestExecutionResult): Promise<void> {
    const key = getMetricsKey(
      this.config.redisKeyPrefix,
      result.experimentId,
      result.variant
    );

    // RACE CONDITION FIX: Serialize updates to same key
    // Wait for any pending update to this key to complete
    const pending = this.pendingUpdates.get(key);
    if (pending) {
      await pending;
    }

    // Create new update promise
    const updatePromise = this.doRecordResult(key, result);
    this.pendingUpdates.set(key, updatePromise);

    try {
      await updatePromise;
    } finally {
      // Only clear if this is still our promise (not replaced by another caller)
      if (this.pendingUpdates.get(key) === updatePromise) {
        this.pendingUpdates.delete(key);
      }
    }
  }

  /**
   * Internal implementation of recordResult without locking.
   */
  private async doRecordResult(key: string, result: ABTestExecutionResult): Promise<void> {
    // Get or create buffer entry
    let metrics = this.buffer.get(key);
    if (!metrics) {
      // Try to load from Redis first
      metrics = await this.loadMetrics(result.experimentId, result.variant);
      if (!metrics) {
        // Initialize new metrics
        metrics = this.createEmptyMetrics(result.experimentId, result.variant);
      }
      this.buffer.set(key, metrics);
    }

    // Update metrics
    this.updateMetrics(metrics, result);

    // Schedule flush if not already scheduled
    this.scheduleFlush();
  }

  /**
   * Get computed metrics for an experiment variant.
   *
   * @param experimentId - The experiment ID
   * @param variant - The variant to get metrics for
   * @returns Computed metrics with calculated fields
   */
  async getMetrics(
    experimentId: string,
    variant: VariantAssignment
  ): Promise<ComputedMetrics | null> {
    // Flush buffer first to ensure we have latest data
    await this.flush();

    const metrics = await this.loadMetrics(experimentId, variant);
    if (!metrics) {
      return null;
    }

    return this.computeMetrics(metrics);
  }

  /**
   * Get computed metrics for both variants of an experiment.
   *
   * @param experimentId - The experiment ID
   * @returns Object with control and variant metrics
   */
  async getExperimentMetrics(
    experimentId: string
  ): Promise<{ control: ComputedMetrics | null; variant: ComputedMetrics | null }> {
    await this.flush();

    const [control, variant] = await Promise.all([
      this.loadMetrics(experimentId, 'control'),
      this.loadMetrics(experimentId, 'variant'),
    ]);

    return {
      control: control ? this.computeMetrics(control) : null,
      variant: variant ? this.computeMetrics(variant) : null,
    };
  }

  /**
   * Reset metrics for an experiment.
   *
   * @param experimentId - The experiment ID to reset
   */
  async resetMetrics(experimentId: string): Promise<void> {
    const controlKey = getMetricsKey(
      this.config.redisKeyPrefix,
      experimentId,
      'control'
    );
    const variantKey = getMetricsKey(
      this.config.redisKeyPrefix,
      experimentId,
      'variant'
    );

    // Remove from buffer
    this.buffer.delete(controlKey);
    this.buffer.delete(variantKey);

    // Remove from Redis
    await Promise.all([
      this.redis.del(controlKey),
      this.redis.del(variantKey),
    ]);
  }

  /**
   * Flush buffered metrics to Redis.
   */
  async flush(): Promise<void> {
    if (this.buffer.size === 0) {
      return;
    }

    const writePromises: Promise<void>[] = [];

    for (const [key, metrics] of this.buffer.entries()) {
      writePromises.push(this.saveMetrics(key, metrics));
    }

    await Promise.all(writePromises);

    // Clear flush timer
    this.flushTimer = clearTimeoutSafe(this.flushTimer);
  }

  /**
   * Stop the metrics collector and flush pending data.
   */
  async stop(): Promise<void> {
    this.flushTimer = clearTimeoutSafe(this.flushTimer);
    await this.flush();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private createEmptyMetrics(
    experimentId: string,
    variant: VariantAssignment
  ): ExperimentMetrics {
    return {
      experimentId,
      variant,
      successCount: 0,
      failureCount: 0,
      totalProfitWei: '0',
      totalGasCostWei: '0',
      totalLatencyMs: 0,
      mevFrontrunCount: 0,
    };
  }

  private updateMetrics(
    metrics: ExperimentMetrics,
    result: ABTestExecutionResult
  ): void {
    const now = result.timestamp;

    // Update execution counts
    if (result.result.success) {
      metrics.successCount++;
    } else {
      metrics.failureCount++;
    }

    // Update profit (bigint as string)
    // BUG FIX: actualProfit is a number, not string. Use Math.trunc to get integer safely.
    // For large values, we convert via string to avoid JS number precision loss.
    const currentProfit = BigInt(metrics.totalProfitWei);
    const profitValue = result.result.actualProfit ?? 0;
    const resultProfit = typeof profitValue === 'number'
      ? BigInt(Math.trunc(profitValue))
      : BigInt(profitValue || '0');
    metrics.totalProfitWei = (currentProfit + resultProfit).toString();

    // Update gas cost (bigint as string)
    // BUG FIX: gasCost is a number, not string. Use Math.trunc to get integer safely.
    const currentGas = BigInt(metrics.totalGasCostWei);
    const gasValue = result.result.gasCost ?? 0;
    const resultGas = typeof gasValue === 'number'
      ? BigInt(Math.trunc(gasValue))
      : BigInt(gasValue || '0');
    metrics.totalGasCostWei = (currentGas + resultGas).toString();

    // Update latency
    metrics.totalLatencyMs += result.latencyMs;

    // Update MEV frontrun count
    if (result.mevFrontrunDetected) {
      metrics.mevFrontrunCount++;
    }

    // Update timestamps
    if (!metrics.firstExecutionAt) {
      metrics.firstExecutionAt = now;
    }
    metrics.lastExecutionAt = now;
  }

  private computeMetrics(metrics: ExperimentMetrics): ComputedMetrics {
    const sampleSize = metrics.successCount + metrics.failureCount;
    const successRate = sampleSize > 0 ? metrics.successCount / sampleSize : 0;
    const mevFrontrunRate = sampleSize > 0 ? metrics.mevFrontrunCount / sampleSize : 0;
    const avgLatencyMs = sampleSize > 0 ? metrics.totalLatencyMs / sampleSize : 0;

    // Calculate average profit and gas
    const totalProfit = BigInt(metrics.totalProfitWei);
    const totalGas = BigInt(metrics.totalGasCostWei);
    const avgProfitWei = sampleSize > 0 ? (totalProfit / BigInt(sampleSize)).toString() : '0';
    const avgGasCostWei = sampleSize > 0 ? (totalGas / BigInt(sampleSize)).toString() : '0';

    return {
      ...metrics,
      successRate,
      avgProfitWei,
      avgGasCostWei,
      avgLatencyMs,
      mevFrontrunRate,
      sampleSize,
    };
  }

  private async loadMetrics(
    experimentId: string,
    variant: VariantAssignment
  ): Promise<ExperimentMetrics | undefined> {
    const key = getMetricsKey(
      this.config.redisKeyPrefix,
      experimentId,
      variant
    );

    // Check buffer first
    const buffered = this.buffer.get(key);
    if (buffered) {
      return buffered;
    }

    // Load from Redis
    try {
      const data = await this.redis.get(key);
      if (data && typeof data === 'object') {
        return data as ExperimentMetrics;
      }
    } catch {
      // Redis error - return undefined
    }

    return undefined;
  }

  private async saveMetrics(key: string, metrics: ExperimentMetrics): Promise<void> {
    try {
      await this.redis.set(key, metrics, this.config.metricsTtlSeconds);
    } catch (error) {
      // Log but don't throw - metrics are best effort
      if (this.logger) {
        this.logger.error('Failed to save A/B testing metrics', { key, error: String(error) });
      }
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return; // Already scheduled
    }

    this.flushTimer = setTimeout(() => {
      this.flush().catch((error) => {
        if (this.logger) {
          this.logger.error('Failed to flush A/B testing metrics', { error: String(error) });
        }
      });
    }, this.flushIntervalMs);
  }
}

/**
 * Factory function to create a metrics collector.
 *
 * @param redis - Redis client instance
 * @param config - A/B testing configuration
 * @returns MetricsCollector instance
 */
export function createMetricsCollector(
  redis: RedisClient,
  config: ABTestingConfig,
  logger?: MetricsLogger
): MetricsCollector {
  return new MetricsCollector(redis, config, logger);
}
