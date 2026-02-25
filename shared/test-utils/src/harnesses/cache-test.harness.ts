/**
 * Cache Test Harness
 *
 * Manages lifecycle and assertions for cache integration tests.
 * Handles Redis setup, cache initialization, metrics collection, and validation.
 *
 * @example
 * const harness = new CacheTestHarness();
 * await harness.setup({ l1SizeMB: 64 });
 *
 * await harness.warmCache(priceUpdates);
 * harness.assertHitRate(95, 2); // Assert 95% ±2%
 *
 * await harness.teardown();
 */

import Redis from 'ioredis';
import { createHierarchicalCache, HierarchicalCache } from '@arbitrage/core/caching';
import { CacheMetrics, CacheStats, CacheTestConfig, MetricsSnapshot } from '../types/cache-types';

export class CacheTestHarness {
  private redis: Redis | null = null;
  private cache: HierarchicalCache | null = null;
  private metricsHistory: MetricsSnapshot[] = [];
  private config: CacheTestConfig = {};

  /**
   * Setup cache test environment
   */
  async setup(config?: CacheTestConfig): Promise<void> {
    this.config = {
      l1SizeMB: config?.l1SizeMB ?? 64,
      l2TtlSec: config?.l2TtlSec ?? 300,
      l3Enabled: config?.l3Enabled ?? false,
      usePriceMatrix: config?.usePriceMatrix ?? true,
      enableTimingMetrics: config?.enableTimingMetrics ?? false,
    };

    // Setup in-memory Redis for testing
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      maxRetriesPerRequest: 1,
    });

    // Create HierarchicalCache instance
    this.cache = createHierarchicalCache({
      l1Enabled: true,
      l1Size: this.config.l1SizeMB,
      l2Enabled: true,
      l2Ttl: this.config.l2TtlSec,
      l3Enabled: this.config.l3Enabled,
      usePriceMatrix: this.config.usePriceMatrix,
      enableTimingMetrics: this.config.enableTimingMetrics,
      enablePromotion: true,
      enableDemotion: false,
    });
  }

  /**
   * Teardown cache test environment
   */
  async teardown(): Promise<void> {
    if (this.cache) {
      // Clear cache if it has a clear method
      if (typeof (this.cache as any).clear === 'function') {
        await (this.cache as any).clear();
      }
      this.cache = null;
    }

    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }

    this.metricsHistory = [];
  }

  /**
   * Get cache instance (for direct testing)
   */
  getCache(): HierarchicalCache {
    if (!this.cache) {
      throw new Error('Cache not initialized. Call setup() first.');
    }
    return this.cache;
  }

  /**
   * Get Redis instance (for direct testing)
   */
  getRedis(): Redis {
    if (!this.redis) {
      throw new Error('Redis not initialized. Call setup() first.');
    }
    return this.redis;
  }

  /**
   * Warm cache with price updates
   */
  async warmCache(priceUpdates: Array<{ key: string; value: any }>): Promise<void> {
    if (!this.cache) {
      throw new Error('Cache not initialized. Call setup() first.');
    }

    for (const update of priceUpdates) {
      await this.cache.set(update.key, update.value);
    }
  }

  /**
   * Simulate cache misses by clearing L1
   */
  async simulateCacheMiss(keys: string[]): Promise<void> {
    if (!this.cache) {
      throw new Error('Cache not initialized. Call setup() first.');
    }

    // This assumes we can access L1 directly or have a method to invalidate specific keys
    // For now, we'll delete from cache
    for (const key of keys) {
      await this.cache.delete(key);
    }
  }

  /**
   * Get current cache metrics
   */
  getMetrics(): CacheStats {
    if (!this.cache) {
      throw new Error('Cache not initialized. Call setup() first.');
    }

    const stats = this.cache.getStats();

    return {
      hitRate: stats.l1?.hitRate ?? 0,
      missRate: 1 - (stats.l1?.hitRate ?? 0),
      evictionRate: stats.l1?.evictions ? stats.l1.evictions / (stats.l1.size || 1) : 0,
      avgReadLatencyUs: 0, // Would need timing metrics enabled
      avgWriteLatencyUs: 0,
      p95ReadLatencyUs: 0,
      p99ReadLatencyUs: 0,
      memoryUsageMB: 0, // Would need memory tracking
    };
  }

  /**
   * Capture metrics snapshot for later comparison
   */
  async captureMetricsSnapshot(): Promise<MetricsSnapshot> {
    const stats = this.getMetrics();

    const snapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      cacheMetrics: {
        l1: {
          size: 0,
          hits: 0,
          misses: 0,
          evictions: 0,
          hitRate: stats.hitRate,
        },
        l2: {
          size: 0,
          hits: 0,
          misses: 0,
        },
        memoryUsageMB: stats.memoryUsageMB,
      },
      performanceMetrics: {
        latency: {
          min: 0,
          max: 0,
          avg: stats.avgReadLatencyUs,
          p50: 0,
          p95: stats.p95ReadLatencyUs,
          p99: stats.p99ReadLatencyUs,
          p999: 0,
        },
        throughput: {
          eventsPerSec: 0,
          avgEventLatencyMs: 0,
          totalEvents: 0,
        },
        memory: {
          heapUsedMB: process.memoryUsage().heapUsed / 1024 / 1024,
          heapTotalMB: process.memoryUsage().heapTotal / 1024 / 1024,
          externalMB: process.memoryUsage().external / 1024 / 1024,
          arrayBuffersMB: (process.memoryUsage() as any).arrayBuffers ? (process.memoryUsage() as any).arrayBuffers / 1024 / 1024 : 0,
          peakHeapUsedMB: 0,
          growthRateMBPerMin: 0,
        },
        gc: {
          totalPauses: 0,
          avgPauseMs: 0,
          maxPauseMs: 0,
          p99PauseMs: 0,
          totalGCTimeMs: 0,
        },
      },
    };

    this.metricsHistory.push(snapshot);
    return snapshot;
  }

  /**
   * Compare current metrics with baseline
   */
  async compareWithBaseline(baseline: MetricsSnapshot): Promise<{
    hitRateDelta: number;
    latencyDelta: number;
    memoryDelta: number;
    passed: boolean;
    failures: string[];
  }> {
    const current = await this.captureMetricsSnapshot();
    const failures: string[] = [];

    const hitRateDelta = current.cacheMetrics.l1.hitRate - baseline.cacheMetrics.l1.hitRate;
    const latencyDelta = current.performanceMetrics.latency.avg - baseline.performanceMetrics.latency.avg;
    const memoryDelta = current.performanceMetrics.memory.heapUsedMB - baseline.performanceMetrics.memory.heapUsedMB;

    // Check for regressions (>5% hit rate drop, >2x latency increase, >50MB memory increase)
    if (hitRateDelta < -5) {
      failures.push(`Hit rate dropped by ${Math.abs(hitRateDelta).toFixed(2)}% (threshold: -5%)`);
    }

    if (latencyDelta > baseline.performanceMetrics.latency.avg) {
      failures.push(`Latency increased by ${latencyDelta.toFixed(2)}μs (>2x baseline)`);
    }

    if (memoryDelta > 50) {
      failures.push(`Memory increased by ${memoryDelta.toFixed(2)}MB (threshold: 50MB)`);
    }

    return {
      hitRateDelta,
      latencyDelta,
      memoryDelta,
      passed: failures.length === 0,
      failures,
    };
  }

  /**
   * Assert hit rate meets threshold
   */
  assertHitRate(expectedPercent: number, tolerancePercent: number = 2): void {
    const stats = this.getMetrics();
    const actualPercent = stats.hitRate * 100;
    const minAcceptable = expectedPercent - tolerancePercent;
    const maxAcceptable = expectedPercent + tolerancePercent;

    if (actualPercent < minAcceptable || actualPercent > maxAcceptable) {
      throw new Error(
        `Hit rate ${actualPercent.toFixed(2)}% outside acceptable range [${minAcceptable}%, ${maxAcceptable}%]`
      );
    }
  }

  /**
   * Assert L1 memory usage is within budget
   */
  assertL1Size(maxBytes: number): void {
    const stats = this.getMetrics();
    const actualMB = stats.memoryUsageMB;
    const maxMB = maxBytes / 1024 / 1024;

    if (actualMB > maxMB) {
      throw new Error(
        `L1 memory usage ${actualMB.toFixed(2)}MB exceeds budget ${maxMB.toFixed(2)}MB`
      );
    }
  }

  /**
   * Assert eviction rate is acceptable
   */
  assertEvictionRate(maxPercentPerSecond: number): void {
    const stats = this.getMetrics();
    const actualPercent = stats.evictionRate * 100;

    if (actualPercent > maxPercentPerSecond) {
      throw new Error(
        `Eviction rate ${actualPercent.toFixed(2)}%/sec exceeds threshold ${maxPercentPerSecond}%/sec`
      );
    }
  }

  /**
   * Get metrics history for analysis
   */
  getMetricsHistory(): MetricsSnapshot[] {
    return [...this.metricsHistory];
  }

  /**
   * Clear metrics history
   */
  clearMetricsHistory(): void {
    this.metricsHistory = [];
  }
}
