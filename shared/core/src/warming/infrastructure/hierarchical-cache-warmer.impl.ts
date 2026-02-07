/**
 * HierarchicalCacheWarmer - Infrastructure Layer (Enhancement #2)
 *
 * Implements predictive cache warming using HierarchicalCache infrastructure.
 * Coordinates between correlation tracker, warming strategy, and cache layers.
 *
 * @see warming/domain/cache-warmer.interface.ts - ICacheWarmer contract
 * @see caching/hierarchical-cache.ts - Target cache implementation
 * @see warming/domain/warming-strategy.interface.ts - Strategy interface
 *
 * @package @arbitrage/core
 * @module warming/infrastructure
 */

import {
  ICacheWarmer,
  WarmingResult,
  WarmingConfig,
  WarmingStats,
} from '../domain/cache-warmer.interface';
import {
  ICorrelationTracker,
  PairCorrelation,
} from '../domain/correlation-tracker.interface';
import {
  IWarmingStrategy,
  WarmingContext,
  WarmingCandidate,
} from '../domain/warming-strategy.interface';
import { HierarchicalCache } from '../../caching/hierarchical-cache';

/**
 * Default warming configuration
 */
const DEFAULT_CONFIG: WarmingConfig = {
  maxPairsPerWarm: 5,
  minCorrelationScore: 0.3,
  asyncWarming: true,
  timeoutMs: 50,
  enabled: true,
};

/**
 * Hierarchical cache warmer implementation
 *
 * Architecture:
 * - Uses ICorrelationTracker to discover related pairs
 * - Uses IWarmingStrategy to select which pairs to warm
 * - Uses HierarchicalCache to promote L2 → L1
 *
 * Warming Algorithm:
 * 1. Query correlation tracker for correlated pairs
 * 2. Build warming context (L1 size, hit rate, etc.)
 * 3. Delegate to strategy for pair selection
 * 4. For each selected pair:
 *    a. Check if already in L1 (skip if yes)
 *    b. Fetch from L2 (Redis)
 *    c. Promote to L1 (SharedArrayBuffer)
 * 5. Track statistics and return result
 *
 * Performance:
 * - warmForPair(): <10ms target for 5 pairs
 * - Async mode: Non-blocking, runs in background
 * - Sync mode: Waits for completion (testing only)
 * - Timeout: Cancels if exceeds timeoutMs
 *
 * @example
 * ```typescript
 * const cache = new HierarchicalCache({...});
 * const tracker = new CorrelationTrackerImpl(analyzer);
 * const strategy = new TopNStrategy({ topN: 5, minScore: 0.3 });
 *
 * const warmer = new HierarchicalCacheWarmer(
 *   cache,
 *   tracker,
 *   strategy,
 *   { asyncWarming: true, timeoutMs: 50 }
 * );
 *
 * // Trigger warming (async)
 * const result = await warmer.warmForPair('WETH_USDT');
 * console.log(`Warmed ${result.pairsWarmed} pairs in ${result.durationMs}ms`);
 * ```
 */
export class HierarchicalCacheWarmer implements ICacheWarmer {
  private config: WarmingConfig;
  private stats: InternalWarmingStats = {
    totalWarmingOps: 0,
    successfulOps: 0,
    failedOps: 0,
    totalPairsAttempted: 0,
    totalPairsWarmed: 0,
    totalTimeMs: 0,
    hitRateBeforeWarming: 0,
    hitRateAfterWarming: 0,
  };

  constructor(
    private readonly cache: HierarchicalCache,
    private readonly correlationTracker: ICorrelationTracker,
    private readonly strategy: IWarmingStrategy,
    config: Partial<WarmingConfig> = {}
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Warm cache for correlated pairs (PRIMARY METHOD)
   *
   * This is the main entry point for predictive warming.
   * Called from chain-instance.ts after price update events.
   *
   * Algorithm:
   * 1. Check if warming is enabled
   * 2. Get correlated pairs from tracker
   * 3. Build warming context for strategy
   * 4. Delegate to strategy for pair selection
   * 5. Warm selected pairs (L2 → L1 promotion)
   * 6. Track statistics and return result
   *
   * Performance: <10ms target for 5 pairs
   *
   * @param sourcePair - The pair that triggered warming
   * @returns Warming result with metrics
   */
  async warmForPair(sourcePair: string): Promise<WarmingResult> {
    const startTime = performance.now();
    const timestamp = Date.now();

    // Check if warming is enabled
    if (!this.config.enabled) {
      return {
        success: true,
        pairsAttempted: 0,
        pairsWarmed: 0,
        pairsAlreadyInL1: 0,
        pairsNotFound: 0,
        durationMs: 0,
        sourcePair,
        timestamp,
      };
    }

    this.stats.totalWarmingOps++;

    try {
      // 1. Get correlated pairs from tracker
      const correlations = this.correlationTracker.getPairsToWarm(
        sourcePair,
        this.config.maxPairsPerWarm,
        this.config.minCorrelationScore
      );

      // Early exit if no correlations
      if (correlations.length === 0) {
        const durationMs = performance.now() - startTime;
        this.stats.successfulOps++;
        this.stats.totalTimeMs += durationMs;

        return {
          success: true,
          pairsAttempted: 0,
          pairsWarmed: 0,
          pairsAlreadyInL1: 0,
          pairsNotFound: 0,
          durationMs,
          sourcePair,
          timestamp,
        };
      }

      // 2. Build warming context for strategy
      const context = this.buildWarmingContext(
        sourcePair,
        correlations,
        timestamp
      );

      // 3. Delegate to strategy for pair selection
      const selection = this.strategy.selectPairs(context);

      // 4. Warm selected pairs (with timeout)
      const warmingPromise = this.warmSelectedPairs(
        selection.selectedPairs,
        sourcePair,
        timestamp
      );

      // Apply timeout if specified
      const result = await this.withTimeout(
        warmingPromise,
        this.config.timeoutMs
      );

      // 5. Update statistics
      this.stats.successfulOps++;
      this.stats.totalPairsAttempted += result.pairsAttempted;
      this.stats.totalPairsWarmed += result.pairsWarmed;
      this.stats.totalTimeMs += result.durationMs;

      return result;
    } catch (error) {
      // Handle failure
      this.stats.failedOps++;
      const durationMs = performance.now() - startTime;
      this.stats.totalTimeMs += durationMs;

      return {
        success: false,
        pairsAttempted: 0,
        pairsWarmed: 0,
        pairsAlreadyInL1: 0,
        pairsNotFound: 0,
        durationMs,
        sourcePair,
        timestamp,
      };
    }
  }

  /**
   * Warm specific pairs (manual warming)
   *
   * Useful for:
   * - Startup cache warming
   * - Scheduled warming of hot pairs
   * - Testing and debugging
   *
   * Unlike warmForPair(), this doesn't use correlation data.
   *
   * @param pairs - Array of pair identifiers to warm
   * @returns Warming result with metrics
   */
  async warmPairs(pairs: string[]): Promise<WarmingResult> {
    const startTime = performance.now();
    const timestamp = Date.now();

    if (!this.config.enabled || pairs.length === 0) {
      return {
        success: true,
        pairsAttempted: 0,
        pairsWarmed: 0,
        pairsAlreadyInL1: 0,
        pairsNotFound: 0,
        durationMs: 0,
        sourcePair: 'manual',
        timestamp,
      };
    }

    this.stats.totalWarmingOps++;

    try {
      // Convert pairs to warming candidates
      const candidates: WarmingCandidate[] = pairs.map(pair => ({
        pair,
        correlationScore: 1.0, // Manual warming = max priority
        priority: 1.0,
        estimatedBenefit: 1.0,
      }));

      // Warm the pairs
      const warmingPromise = this.warmSelectedPairs(
        candidates,
        'manual',
        timestamp
      );

      const result = await this.withTimeout(
        warmingPromise,
        this.config.timeoutMs
      );

      // Update statistics
      this.stats.successfulOps++;
      this.stats.totalPairsAttempted += result.pairsAttempted;
      this.stats.totalPairsWarmed += result.pairsWarmed;
      this.stats.totalTimeMs += result.durationMs;

      return result;
    } catch (error) {
      this.stats.failedOps++;
      const durationMs = performance.now() - startTime;
      this.stats.totalTimeMs += durationMs;

      return {
        success: false,
        pairsAttempted: 0,
        pairsWarmed: 0,
        pairsAlreadyInL1: 0,
        pairsNotFound: 0,
        durationMs,
        sourcePair: 'manual',
        timestamp,
      };
    }
  }

  /**
   * Update warming configuration
   *
   * Allows runtime adjustment of warming behavior.
   *
   * @param config - New configuration (partial update)
   */
  updateConfig(config: Partial<WarmingConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current warming configuration
   *
   * @returns Current config
   */
  getConfig(): WarmingConfig {
    return { ...this.config };
  }

  /**
   * Get warming statistics
   *
   * @returns Statistics for monitoring
   */
  getStats(): WarmingStats {
    const avgPairsPerOp =
      this.stats.totalWarmingOps > 0
        ? this.stats.totalPairsWarmed / this.stats.totalWarmingOps
        : 0;

    const avgDurationMs =
      this.stats.totalWarmingOps > 0
        ? this.stats.totalTimeMs / this.stats.totalWarmingOps
        : 0;

    const successRate =
      this.stats.totalWarmingOps > 0
        ? (this.stats.successfulOps / this.stats.totalWarmingOps) * 100
        : 0;

    // Calculate hit rate improvement
    // This is an estimate based on L1 hit rate before/after warming
    const hitRateImprovement =
      this.stats.hitRateAfterWarming - this.stats.hitRateBeforeWarming;

    return {
      totalWarmingOps: this.stats.totalWarmingOps,
      successfulOps: this.stats.successfulOps,
      failedOps: this.stats.failedOps,
      successRate,
      totalPairsAttempted: this.stats.totalPairsAttempted,
      totalPairsWarmed: this.stats.totalPairsWarmed,
      avgPairsPerOp,
      avgDurationMs,
      hitRateImprovement,
      totalTimeMs: this.stats.totalTimeMs,
    };
  }

  /**
   * Reset warming statistics
   */
  resetStats(): void {
    this.stats = {
      totalWarmingOps: 0,
      successfulOps: 0,
      failedOps: 0,
      totalPairsAttempted: 0,
      totalPairsWarmed: 0,
      totalTimeMs: 0,
      hitRateBeforeWarming: 0,
      hitRateAfterWarming: 0,
    };
  }

  /**
   * Build warming context for strategy
   *
   * Collects current cache state and provides it to the strategy.
   *
   * @param sourcePair - Source pair
   * @param correlations - Correlated pairs from tracker
   * @param timestamp - Current timestamp
   * @returns Warming context
   */
  private buildWarmingContext(
    sourcePair: string,
    correlations: PairCorrelation[],
    timestamp: number
  ): WarmingContext {
    const cacheStats = this.cache.getStats();

    // Calculate L1 hit rate
    const l1Total = cacheStats.l1.hits + cacheStats.l1.misses;
    const l1HitRate = l1Total > 0 ? cacheStats.l1.hits / l1Total : 0;

    return {
      sourcePair,
      l1Size: cacheStats.l1.size,
      l1Capacity: this.getL1Capacity(),
      l1HitRate,
      correlations,
      timestamp,
    };
  }

  /**
   * Get L1 capacity from cache config
   *
   * @returns L1 capacity in number of entries
   */
  private getL1Capacity(): number {
    // HierarchicalCache calculates capacity as:
    // l1MaxEntries = Math.floor(l1Size * 1024 * 1024 / averageEntrySize)
    // We'll use a similar calculation with 1KB average
    const config = (this.cache as any).config;
    const l1SizeMb = config?.l1Size || 64;
    return Math.floor((l1SizeMb * 1024 * 1024) / 1024);
  }

  /**
   * Warm selected pairs by promoting from L2 to L1
   *
   * Core warming logic:
   * 1. For each candidate pair:
   *    a. Check if already in L1 (skip if yes)
   *    b. Fetch from L2 (Redis)
   *    c. If found, promote to L1
   * 2. Track metrics (attempted, warmed, already in L1, not found)
   *
   * Performance: <10ms for 5 pairs (target)
   *
   * @param candidates - Selected pairs to warm
   * @param sourcePair - Source pair that triggered warming
   * @param timestamp - Timestamp of warming operation
   * @returns Warming result
   */
  private async warmSelectedPairs(
    candidates: WarmingCandidate[],
    sourcePair: string,
    timestamp: number
  ): Promise<WarmingResult> {
    const startTime = performance.now();

    let pairsWarmed = 0;
    let pairsAlreadyInL1 = 0;
    let pairsNotFound = 0;

    // Warm each pair
    for (const candidate of candidates) {
      try {
        // Check if already in L1 (use cache.get which checks L1 first)
        const l1Value = await this.checkL1(candidate.pair);
        if (l1Value !== null) {
          pairsAlreadyInL1++;
          continue;
        }

        // Fetch from L2
        const l2Value = await this.fetchFromL2(candidate.pair);
        if (l2Value === null) {
          pairsNotFound++;
          continue;
        }

        // Promote to L1
        await this.promoteToL1(candidate.pair, l2Value);
        pairsWarmed++;
      } catch (error) {
        // Log error but continue warming other pairs
        pairsNotFound++;
      }
    }

    const durationMs = performance.now() - startTime;

    return {
      success: true,
      pairsAttempted: candidates.length,
      pairsWarmed,
      pairsAlreadyInL1,
      pairsNotFound,
      durationMs,
      sourcePair,
      timestamp,
    };
  }

  /**
   * Check if pair is in L1 cache
   *
   * Uses cache's internal getFromL1 method (if accessible) or
   * falls back to regular get which checks L1 first.
   *
   * @param pair - Pair to check
   * @returns Value if in L1, null otherwise
   */
  private async checkL1(pair: string): Promise<any> {
    // HierarchicalCache.get() checks L1 first, but we want ONLY L1
    // Access the private method via casting (internal infrastructure access)
    const cacheInternal = this.cache as any;
    if (typeof cacheInternal.getFromL1 === 'function') {
      return cacheInternal.getFromL1(pair);
    }

    // Fallback: Use regular get (checks L1 first anyway)
    return this.cache.get(pair);
  }

  /**
   * Fetch value from L2 cache (Redis)
   *
   * Bypasses L1 to fetch directly from L2.
   *
   * @param pair - Pair to fetch
   * @returns Value if found in L2, null otherwise
   */
  private async fetchFromL2(pair: string): Promise<any> {
    // Access the private getFromL2 method (internal infrastructure access)
    const cacheInternal = this.cache as any;
    if (typeof cacheInternal.getFromL2 === 'function') {
      return cacheInternal.getFromL2(pair);
    }

    // Fallback: This shouldn't happen, but return null if method unavailable
    return null;
  }

  /**
   * Promote value from L2 to L1
   *
   * Uses cache's internal setInL1 method for direct L1 promotion.
   *
   * @param pair - Pair to promote
   * @param value - Value to set
   */
  private async promoteToL1(pair: string, value: any): Promise<void> {
    // Access the private setInL1 method (internal infrastructure access)
    const cacheInternal = this.cache as any;
    if (typeof cacheInternal.setInL1 === 'function') {
      cacheInternal.setInL1(pair, value);
      return;
    }

    // Fallback: Use regular set (writes to all layers, less efficient)
    await this.cache.set(pair, value);
  }

  /**
   * Apply timeout to a promise
   *
   * Rejects if promise doesn't resolve within timeoutMs.
   *
   * @param promise - Promise to wrap
   * @param timeoutMs - Timeout in milliseconds
   * @returns Promise that resolves or times out
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Warming timeout after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
  }
}

/**
 * Internal statistics tracking
 */
interface InternalWarmingStats {
  totalWarmingOps: number;
  successfulOps: number;
  failedOps: number;
  totalPairsAttempted: number;
  totalPairsWarmed: number;
  totalTimeMs: number;
  hitRateBeforeWarming: number;
  hitRateAfterWarming: number;
}
