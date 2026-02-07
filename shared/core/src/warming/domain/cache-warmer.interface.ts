/**
 * Cache Warmer Interface (Enhancement #2 - Predictive Warming)
 *
 * Defines the contract for warming cache layers with predicted data.
 * Coordinates between correlation tracker and cache to pre-fetch data before needed.
 *
 * @see ADR-005 - Hierarchical Cache Architecture
 * @see shared/core/src/caching/hierarchical-cache.ts - Target cache implementation
 *
 * Design Principles:
 * - Single Responsibility: Only performs cache warming, doesn't track correlations
 * - Dependency Inversion: Depends on ICorrelationTracker and ICache abstractions
 * - Strategy Pattern: Pluggable warming strategies (TopN, Threshold-based, etc.)
 *
 * Performance Targets:
 * - Warming latency: <10ms for 5 pairs
 * - L1 hit rate improvement: +5-10% (from 95% to 97-99%)
 * - Background operation: No blocking of hot path
 *
 * @package @arbitrage/core
 * @module warming/domain
 */

/**
 * Result of a cache warming operation
 */
export interface WarmingResult {
  /**
   * Whether warming was triggered successfully
   */
  readonly success: boolean;

  /**
   * Number of pairs attempted to warm
   */
  readonly pairsAttempted: number;

  /**
   * Number of pairs successfully warmed into L1
   */
  readonly pairsWarmed: number;

  /**
   * Number of pairs that were already in L1 (cache hits during warming)
   */
  readonly pairsAlreadyInL1: number;

  /**
   * Number of pairs not found in L2 (couldn't warm)
   */
  readonly pairsNotFound: number;

  /**
   * Total duration of warming operation (milliseconds)
   */
  readonly durationMs: number;

  /**
   * Source pair that triggered warming
   */
  readonly sourcePair: string;

  /**
   * Timestamp when warming was triggered (Unix ms)
   */
  readonly timestamp: number;
}

/**
 * Configuration for cache warming behavior
 */
export interface WarmingConfig {
  /**
   * Maximum number of pairs to warm per trigger (default: 5)
   *
   * Trade-off:
   * - Higher: More comprehensive warming, higher latency
   * - Lower: Faster warming, less comprehensive
   */
  readonly maxPairsPerWarm: number;

  /**
   * Minimum correlation score to trigger warming (default: 0.3)
   *
   * Thresholds:
   * - 0.1-0.3: Aggressive warming (may waste bandwidth)
   * - 0.3-0.5: Balanced (recommended)
   * - 0.5-1.0: Conservative (only strong correlations)
   */
  readonly minCorrelationScore: number;

  /**
   * Whether to warm asynchronously (non-blocking) (default: true)
   *
   * - true: Background warming, no impact on hot path
   * - false: Synchronous warming, may increase latency
   */
  readonly asyncWarming: boolean;

  /**
   * Timeout for warming operation (milliseconds) (default: 50)
   *
   * If warming takes longer, it's cancelled to avoid blocking.
   */
  readonly timeoutMs: number;

  /**
   * Whether warming is enabled (default: true)
   *
   * Can be disabled for testing or troubleshooting.
   */
  readonly enabled: boolean;
}

/**
 * Cache warmer for predictive pre-fetching
 *
 * Responsibilities:
 * - Receive warming triggers from price update events
 * - Query correlation tracker for related pairs
 * - Fetch data from L2 and promote to L1
 * - Track warming effectiveness metrics
 *
 * Integration Point:
 * - Called from chain-instance.ts handleSyncEvent() after price update
 * - Runs asynchronously to avoid blocking event processing
 *
 * @example
 * ```typescript
 * const warmer = new HierarchicalCacheWarmer(cache, correlationTracker, config);
 *
 * // Trigger warming (background operation)
 * const result = await warmer.warmForPair('WETH_USDT');
 * // Fetches top 5 correlated pairs from L2 → L1
 *
 * console.log(result.pairsWarmed); // 4
 * console.log(result.durationMs);  // 8.3ms
 * ```
 */
export interface ICacheWarmer {
  /**
   * Warm cache for correlated pairs
   *
   * This is the PRIMARY method called from integration points.
   * Triggers predictive warming based on correlation data.
   *
   * Algorithm:
   * 1. Query correlation tracker for top N correlated pairs
   * 2. Filter by minimum score threshold
   * 3. For each pair:
   *    a. Check if already in L1 (skip if yes)
   *    b. Fetch from L2
   *    c. Promote to L1
   * 4. Return warming result with metrics
   *
   * Behavior:
   * - Async if config.asyncWarming = true
   * - Times out after config.timeoutMs
   * - Skips warming if config.enabled = false
   *
   * Performance: <10ms for 5 pairs (target)
   *
   * @param sourcePair - The pair that triggered warming (e.g., "WETH_USDT")
   * @returns Warming result with success flag and metrics
   */
  warmForPair(sourcePair: string): Promise<WarmingResult>;

  /**
   * Warm cache for specific pairs (manual warming)
   *
   * Useful for:
   * - Startup cache warming
   * - Scheduled warming of hot pairs
   * - Testing and debugging
   *
   * Unlike warmForPair(), this doesn't use correlation data.
   * It directly warms the specified pairs.
   *
   * @param pairs - Array of pair identifiers to warm
   * @returns Warming result with success flag and metrics
   */
  warmPairs(pairs: string[]): Promise<WarmingResult>;

  /**
   * Update warming configuration
   *
   * Allows runtime adjustment of warming behavior.
   * Changes take effect immediately.
   *
   * @param config - New configuration (partial update allowed)
   */
  updateConfig(config: Partial<WarmingConfig>): void;

  /**
   * Get current warming configuration
   *
   * @returns Current warming config
   */
  getConfig(): WarmingConfig;

  /**
   * Get warming statistics
   *
   * Metrics tracked:
   * - Total warming operations
   * - Success/failure rate
   * - Average pairs warmed per operation
   * - Average duration
   * - Hit rate improvement attribution
   *
   * @returns Warming statistics for monitoring
   */
  getStats(): WarmingStats;

  /**
   * Reset warming statistics
   *
   * Used for testing and benchmarking.
   */
  resetStats(): void;
}

/**
 * Cache warming statistics
 */
export interface WarmingStats {
  /**
   * Total warming operations triggered
   */
  readonly totalWarmingOps: number;

  /**
   * Number of successful warming operations
   */
  readonly successfulOps: number;

  /**
   * Number of failed warming operations (timeout, error, etc.)
   */
  readonly failedOps: number;

  /**
   * Success rate percentage (0-100)
   */
  readonly successRate: number;

  /**
   * Total pairs attempted to warm
   */
  readonly totalPairsAttempted: number;

  /**
   * Total pairs successfully warmed into L1
   */
  readonly totalPairsWarmed: number;

  /**
   * Average pairs warmed per operation
   */
  readonly avgPairsPerOp: number;

  /**
   * Average warming duration (milliseconds)
   */
  readonly avgDurationMs: number;

  /**
   * Hit rate improvement attributed to warming (percentage points)
   *
   * Calculated by comparing L1 hit rate before/after warming enabled.
   *
   * Target: +5-10% improvement (e.g., 95% → 97-99%)
   */
  readonly hitRateImprovement: number;

  /**
   * Total time spent warming (milliseconds)
   */
  readonly totalTimeMs: number;
}
