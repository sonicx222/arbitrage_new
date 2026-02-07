/**
 * Correlation Tracker Interface (Enhancement #2 - Predictive Warming)
 *
 * Defines the contract for tracking co-occurrence patterns between trading pairs.
 * Enables predictive cache warming by identifying which pairs are frequently accessed together.
 *
 * @see ADR-005 - Hierarchical Cache Architecture (lines 178-200)
 * @see shared/core/src/caching/correlation-analyzer.ts - Existing implementation
 *
 * Design Principles:
 * - Single Responsibility: Only tracks correlations, doesn't perform warming
 * - Interface Segregation: Separate read (getPairsToWarm) from write (recordPriceUpdate)
 * - Dependency Inversion: Domain logic depends on interface, not implementation
 *
 * Performance Targets:
 * - recordPriceUpdate: <50μs (hot path)
 * - getPairsToWarm: <1ms (background operation)
 * - Memory overhead: <10MB for 10K pairs
 *
 * @package @arbitrage/core
 * @module warming/domain
 */

/**
 * Correlation data for a trading pair
 */
export interface PairCorrelation {
  /**
   * The correlated pair identifier (e.g., "WETH_USDC")
   */
  readonly pair: string;

  /**
   * Co-occurrence score (0.0 - 1.0)
   *
   * Calculation: P(pair2 | pair1) = count(pair1, pair2) / count(pair1)
   *
   * Thresholds:
   * - 0.0-0.3: Weak correlation (don't warm)
   * - 0.3-0.7: Moderate correlation (consider warming)
   * - 0.7-1.0: Strong correlation (definitely warm)
   */
  readonly score: number;

  /**
   * Total co-occurrences observed
   */
  readonly coOccurrences: number;

  /**
   * Last time this pair was seen together (Unix timestamp ms)
   */
  readonly lastSeenTimestamp: number;
}

/**
 * Result of a correlation tracking operation
 */
export interface TrackingResult {
  /**
   * Whether the update was recorded successfully
   */
  readonly success: boolean;

  /**
   * Number of correlations updated for this pair
   */
  readonly correlationsUpdated: number;

  /**
   * Time taken for the operation (microseconds)
   */
  readonly durationUs: number;
}

/**
 * Correlation tracker for predictive cache warming
 *
 * Responsibilities:
 * - Track which pairs are accessed together
 * - Compute co-occurrence scores
 * - Provide ranked list of pairs to warm
 * - Maintain temporal decay (recent correlations more important)
 *
 * Implementation Notes:
 * - Use sliding window (e.g., last 1000 updates)
 * - Decay older correlations exponentially
 * - Thread-safe for concurrent updates
 *
 * @example
 * ```typescript
 * const tracker = new CorrelationTrackerImpl();
 *
 * // Record price updates (hot path)
 * tracker.recordPriceUpdate('WETH_USDT', Date.now());
 * tracker.recordPriceUpdate('WETH_USDC', Date.now());
 * tracker.recordPriceUpdate('WBTC_USDT', Date.now());
 *
 * // Get pairs to warm (background operation)
 * const toWarm = tracker.getPairsToWarm('WETH_USDT', 5);
 * // Returns: ['WETH_USDC', 'WBTC_USDT', ...] (top 5 by score)
 * ```
 */
export interface ICorrelationTracker {
  /**
   * Record a price update for correlation tracking
   *
   * This is a HOT PATH operation called on every price update (100-500/sec).
   * Must complete in <50μs to avoid blocking event processing.
   *
   * Behavior:
   * - Update co-occurrence counts for all recently seen pairs
   * - Apply temporal decay to older correlations
   * - Evict oldest entries if sliding window full
   *
   * Thread Safety: Must be thread-safe for concurrent calls
   *
   * @param pair - The trading pair (e.g., "WETH_USDT")
   * @param timestamp - Unix timestamp in milliseconds
   * @returns Tracking result with success flag and duration
   */
  recordPriceUpdate(pair: string, timestamp: number): TrackingResult;

  /**
   * Get top N correlated pairs to warm into cache
   *
   * This is a BACKGROUND operation, not hot path.
   * Called when triggering predictive warming (~1-10/sec).
   *
   * Algorithm:
   * 1. Lookup all pairs correlated with target pair
   * 2. Sort by score descending
   * 3. Filter by minimum score threshold (e.g., 0.3)
   * 4. Return top N pairs
   *
   * Performance: <1ms for 10K pairs in registry
   *
   * @param pair - The source pair that triggered warming
   * @param topN - Maximum number of pairs to return (default: 5)
   * @param minScore - Minimum correlation score threshold (default: 0.3)
   * @returns Array of correlated pairs sorted by score descending
   */
  getPairsToWarm(
    pair: string,
    topN?: number,
    minScore?: number
  ): PairCorrelation[];

  /**
   * Get correlation score between two specific pairs
   *
   * Useful for debugging and testing.
   *
   * @param pair1 - First pair
   * @param pair2 - Second pair
   * @returns Correlation score (0.0-1.0) or undefined if no correlation
   */
  getCorrelationScore(pair1: string, pair2: string): number | undefined;

  /**
   * Get all pairs currently being tracked
   *
   * Used for diagnostics and monitoring.
   *
   * @returns Array of all tracked pair identifiers
   */
  getTrackedPairs(): string[];

  /**
   * Reset all correlation data
   *
   * Used for testing and when correlation patterns change significantly.
   */
  reset(): void;

  /**
   * Get correlation tracking statistics
   *
   * Metrics:
   * - Total pairs tracked
   * - Total co-occurrences recorded
   * - Average correlation score
   * - Oldest/newest timestamp in window
   *
   * @returns Statistics for monitoring
   */
  getStats(): CorrelationStats;
}

/**
 * Correlation tracking statistics
 */
export interface CorrelationStats {
  /**
   * Total number of pairs being tracked
   */
  readonly totalPairs: number;

  /**
   * Total co-occurrences recorded
   */
  readonly totalCoOccurrences: number;

  /**
   * Average correlation score across all pairs
   */
  readonly avgCorrelationScore: number;

  /**
   * Oldest timestamp in sliding window (Unix ms)
   */
  readonly oldestTimestamp: number;

  /**
   * Newest timestamp in sliding window (Unix ms)
   */
  readonly newestTimestamp: number;

  /**
   * Window size (number of updates tracked)
   */
  readonly windowSize: number;

  /**
   * Memory usage estimate (bytes)
   */
  readonly memoryUsageBytes: number;
}
