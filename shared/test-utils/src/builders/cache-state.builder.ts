/**
 * Cache State Builder
 *
 * Fluent builder for constructing cache states for testing.
 * Supports method chaining for readable test setup.
 *
 * @example
 * const cacheState = new CacheStateBuilder()
 *   .withL1Entries(1000)
 *   .withHitRate(95)
 *   .withHighEvictionRate()
 *   .build();
 */

import { CacheMetrics } from '../types/cache-types';
import { CacheFixtures } from '../fixtures/cache-fixtures';

export interface CacheState {
  l1Entries: number;
  l2Entries: number;
  hitRate: number;
  evictionRate: number;
  memoryUsageMB: number;
  metrics: CacheMetrics;
}

export class CacheStateBuilder {
  private state: Partial<CacheState> = {
    l1Entries: 0,
    l2Entries: 0,
    hitRate: 0,
    evictionRate: 0,
    memoryUsageMB: 0,
  };

  /**
   * Set number of L1 cache entries
   */
  withL1Entries(count: number): this {
    this.state.l1Entries = count;
    return this;
  }

  /**
   * Set number of L2 cache entries
   */
  withL2Entries(count: number): this {
    this.state.l2Entries = count;
    return this;
  }

  /**
   * Set cache hit rate (percentage)
   */
  withHitRate(percent: number): this {
    this.state.hitRate = percent;
    return this;
  }

  /**
   * Set eviction rate (percentage)
   */
  withEvictionRate(percent: number): this {
    this.state.evictionRate = percent;
    return this;
  }

  /**
   * Set memory usage in MB
   */
  withMemoryUsage(mb: number): this {
    this.state.memoryUsageMB = mb;
    return this;
  }

  /**
   * Configure as cold cache (empty, no history)
   */
  asColdCache(): this {
    const coldState = CacheFixtures.coldCache();
    this.state = { ...this.state, ...coldState };
    return this;
  }

  /**
   * Configure as warm cache (partially populated)
   */
  asWarmCache(): this {
    const warmState = CacheFixtures.warmCache();
    this.state = { ...this.state, ...warmState };
    return this;
  }

  /**
   * Configure as hot cache (well-populated, high hit rate)
   */
  asHotCache(): this {
    const hotState = CacheFixtures.hotCache();
    this.state = { ...this.state, ...hotState };
    return this;
  }

  /**
   * Configure as full L1 cache (at capacity)
   */
  asFullL1Cache(): this {
    const fullState = CacheFixtures.fullL1Cache();
    this.state = { ...this.state, ...fullState };
    return this;
  }

  /**
   * Configure with high eviction rate (thrashing)
   */
  withHighEvictionRate(): this {
    const highEvictionState = CacheFixtures.highEvictionRate();
    this.state = { ...this.state, ...highEvictionState };
    return this;
  }

  /**
   * Configure with optimal production settings
   */
  asProductionOptimal(): this {
    this.state = {
      l1Entries: 1000,
      l2Entries: 5000,
      hitRate: 97,
      evictionRate: 0.5,
      memoryUsageMB: 16,
    };
    return this;
  }

  /**
   * Configure with degraded performance
   */
  asDegraded(): this {
    this.state = {
      l1Entries: 800,
      l2Entries: 3000,
      hitRate: 70,
      evictionRate: 10,
      memoryUsageMB: 50,
    };
    return this;
  }

  /**
   * Build the cache state
   */
  build(): CacheState {
    const finalState: CacheState = {
      l1Entries: this.state.l1Entries ?? 0,
      l2Entries: this.state.l2Entries ?? 0,
      hitRate: this.state.hitRate ?? 0,
      evictionRate: this.state.evictionRate ?? 0,
      memoryUsageMB: this.state.memoryUsageMB ?? 0,
      metrics: this.buildMetrics(),
    };

    return finalState;
  }

  /**
   * Build metrics from current state
   */
  private buildMetrics(): CacheMetrics {
    const l1Entries = this.state.l1Entries ?? 0;
    const hitRate = (this.state.hitRate ?? 0) / 100;
    const evictionRate = (this.state.evictionRate ?? 0) / 100;

    const totalRequests = l1Entries > 0 ? l1Entries * 10 : 100; // Simulate requests
    const hits = Math.floor(totalRequests * hitRate);
    const misses = totalRequests - hits;
    const evictions = Math.floor(l1Entries * evictionRate);

    return {
      l1: {
        size: l1Entries,
        hits,
        misses,
        evictions,
        hitRate,
      },
      l2: {
        size: this.state.l2Entries ?? 0,
        hits: Math.floor(misses * 0.5), // 50% of L1 misses hit L2
        misses: Math.floor(misses * 0.5),
      },
      memoryUsageMB: this.state.memoryUsageMB ?? 0,
    };
  }

  /**
   * Clone this builder
   */
  clone(): CacheStateBuilder {
    const cloned = new CacheStateBuilder();
    cloned.state = { ...this.state };
    return cloned;
  }

  /**
   * Reset to initial state
   */
  reset(): this {
    this.state = {
      l1Entries: 0,
      l2Entries: 0,
      hitRate: 0,
      evictionRate: 0,
      memoryUsageMB: 0,
    };
    return this;
  }
}

/**
 * Factory function for creating cache state builders
 */
export function createCacheStateBuilder(): CacheStateBuilder {
  return new CacheStateBuilder();
}
