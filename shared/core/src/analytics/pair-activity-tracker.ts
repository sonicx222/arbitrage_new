/**
 * Pair Activity Tracker
 *
 * Tracks update frequency and activity levels for trading pairs to enable
 * volatility-based prioritization of arbitrage detection.
 *
 * Key Features:
 * - Sliding window activity tracking (updates per second)
 * - Activity scoring (0-1) based on update frequency
 * - "Hot pairs" identification for prioritized detection
 * - Memory-efficient circular buffer implementation
 * - LRU eviction for bounded memory usage
 *
 * Integration:
 * - Used by ChainDetectorInstance to bypass time-based throttling for hot pairs
 * - Pairs with high activity scores trigger immediate arbitrage detection
 *
 * @see docs/Optimization_report_gemini3Pro.md - Graph Pruning / Hot List Strategy
 */

import { createLogger } from '../logger';
import { clearIntervalSafe } from '../lifecycle-utils';
import { findKSmallest } from '../data-structures/min-heap';

const logger = createLogger('pair-activity-tracker');

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for PairActivityTracker
 */
export interface ActivityTrackerConfig {
  /** Window size in milliseconds for activity calculation (default: 10000 = 10 seconds) */
  windowMs: number;
  /** Minimum updates per second to be considered "hot" (default: 2) */
  hotThresholdUpdatesPerSecond: number;
  /** Maximum number of pairs to track (prevents unbounded memory growth) */
  maxPairs: number;
  /** Cleanup interval in milliseconds (default: 60000 = 1 minute) */
  cleanupIntervalMs: number;
}

/**
 * Activity state for a tracked pair
 */
interface PairActivityState {
  /** Timestamps of recent updates (circular buffer) */
  updateTimestamps: number[];
  /** Write index for circular buffer */
  writeIndex: number;
  /** Total updates recorded in buffer */
  updateCount: number;
  /** Last update timestamp (for LRU eviction) */
  lastUpdateTime: number;
  /** Cached activity score (recalculated on access) */
  cachedScore: number;
  /** Timestamp when score was last calculated */
  scoreCacheTime: number;
}

/**
 * Activity metrics for a pair
 */
export interface PairActivityMetrics {
  /** Pair address */
  pairAddress: string;
  /** Updates per second in the tracking window */
  updatesPerSecond: number;
  /** Activity score (0-1, higher = more active) */
  activityScore: number;
  /** Whether this pair is considered "hot" */
  isHot: boolean;
  /** Time since last update in milliseconds */
  timeSinceLastUpdate: number;
  /** Total updates in tracking window */
  updatesInWindow: number;
}

/**
 * Tracker statistics
 */
export interface ActivityTrackerStats {
  /** Number of pairs being tracked */
  trackedPairs: number;
  /** Number of hot pairs */
  hotPairs: number;
  /** Total updates processed */
  totalUpdates: number;
  /** Average updates per second across all pairs */
  averageUpdatesPerSecond: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: ActivityTrackerConfig = {
  windowMs: 10000,                    // 10 second window
  hotThresholdUpdatesPerSecond: 2,    // 2+ updates/sec = hot
  maxPairs: 5000,                     // Max pairs to track
  cleanupIntervalMs: 60000            // Cleanup every minute
};

// Buffer size for timestamps (enough for ~100 updates in window)
const TIMESTAMP_BUFFER_SIZE = 100;

// Score cache TTL in milliseconds
const SCORE_CACHE_TTL_MS = 100;

// =============================================================================
// Pair Activity Tracker
// =============================================================================

/**
 * Pair Activity Tracker
 *
 * Tracks update frequency for trading pairs and identifies "hot" pairs
 * that should trigger immediate arbitrage detection (bypassing throttling).
 */
export class PairActivityTracker {
  private config: ActivityTrackerConfig;
  private pairs: Map<string, PairActivityState> = new Map();
  private totalUpdates: number = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<ActivityTrackerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Start cleanup timer
    // Use unref() to prevent timer from keeping Node.js event loop alive during shutdown
    this.cleanupTimer = setInterval(() => {
      this.cleanupStalePairs();
    }, this.config.cleanupIntervalMs);
    this.cleanupTimer.unref();

    logger.info('PairActivityTracker initialized', {
      windowMs: this.config.windowMs,
      hotThreshold: this.config.hotThresholdUpdatesPerSecond,
      maxPairs: this.config.maxPairs
    });
  }

  /**
   * Record an update for a pair.
   * Call this whenever a Sync event is processed for a pair.
   *
   * @param pairAddress - The pair contract address
   * @param timestamp - Optional timestamp (defaults to now)
   */
  recordUpdate(pairAddress: string, timestamp?: number): void {
    const now = timestamp ?? Date.now();
    const normalizedAddress = pairAddress.toLowerCase();

    let state = this.pairs.get(normalizedAddress);
    if (!state) {
      // Check max pairs limit before adding new pair
      this.evictLRUPairsIfNeeded();

      // Initialize new pair state
      state = {
        updateTimestamps: new Array(TIMESTAMP_BUFFER_SIZE).fill(0),
        writeIndex: 0,
        updateCount: 0,
        lastUpdateTime: now,
        cachedScore: 0,
        scoreCacheTime: 0
      };
      this.pairs.set(normalizedAddress, state);
    }

    // Record timestamp in circular buffer
    state.updateTimestamps[state.writeIndex] = now;
    state.writeIndex = (state.writeIndex + 1) % TIMESTAMP_BUFFER_SIZE;
    state.updateCount = Math.min(state.updateCount + 1, TIMESTAMP_BUFFER_SIZE);
    state.lastUpdateTime = now;

    // Invalidate score cache
    state.scoreCacheTime = 0;

    this.totalUpdates++;
  }

  /**
   * Check if a pair is "hot" (high activity).
   * Hot pairs should bypass time-based throttling for arbitrage detection.
   *
   * @param pairAddress - The pair contract address
   * @returns true if the pair is hot
   */
  isHotPair(pairAddress: string): boolean {
    const normalizedAddress = pairAddress.toLowerCase();
    const state = this.pairs.get(normalizedAddress);
    if (!state) {
      return false;
    }

    const score = this.calculateActivityScore(state);
    const updatesPerSecond = score * this.getMaxUpdatesPerSecond();

    return updatesPerSecond >= this.config.hotThresholdUpdatesPerSecond;
  }

  /**
   * Get activity metrics for a specific pair.
   *
   * @param pairAddress - The pair contract address
   * @returns Activity metrics or null if not tracked
   */
  getMetrics(pairAddress: string): PairActivityMetrics | null {
    const normalizedAddress = pairAddress.toLowerCase();
    const state = this.pairs.get(normalizedAddress);
    if (!state) {
      return null;
    }

    const now = Date.now();
    const score = this.calculateActivityScore(state);
    const updatesPerSecond = score * this.getMaxUpdatesPerSecond();
    const updatesInWindow = this.countUpdatesInWindow(state, now);

    return {
      pairAddress: normalizedAddress,
      updatesPerSecond,
      activityScore: score,
      isHot: updatesPerSecond >= this.config.hotThresholdUpdatesPerSecond,
      timeSinceLastUpdate: now - state.lastUpdateTime,
      updatesInWindow
    };
  }

  /**
   * Get list of hot pairs (for debugging/monitoring).
   *
   * @returns Array of hot pair addresses
   */
  getHotPairs(): string[] {
    const hotPairs: string[] = [];

    for (const [address, state] of this.pairs) {
      const score = this.calculateActivityScore(state);
      const updatesPerSecond = score * this.getMaxUpdatesPerSecond();

      if (updatesPerSecond >= this.config.hotThresholdUpdatesPerSecond) {
        hotPairs.push(address);
      }
    }

    return hotPairs;
  }

  /**
   * Get top N most active pairs.
   *
   * @param limit - Maximum number of pairs to return
   * @returns Array of pair metrics sorted by activity score
   */
  getTopActivePairs(limit: number = 10): PairActivityMetrics[] {
    const metrics: PairActivityMetrics[] = [];
    const now = Date.now();

    for (const [address, state] of this.pairs) {
      const score = this.calculateActivityScore(state);
      const updatesPerSecond = score * this.getMaxUpdatesPerSecond();
      const updatesInWindow = this.countUpdatesInWindow(state, now);

      metrics.push({
        pairAddress: address,
        updatesPerSecond,
        activityScore: score,
        isHot: updatesPerSecond >= this.config.hotThresholdUpdatesPerSecond,
        timeSinceLastUpdate: now - state.lastUpdateTime,
        updatesInWindow
      });
    }

    // Sort by activity score descending
    metrics.sort((a, b) => b.activityScore - a.activityScore);

    return metrics.slice(0, limit);
  }

  /**
   * Get tracker statistics.
   */
  getStats(): ActivityTrackerStats {
    const hotPairs = this.getHotPairs();
    let totalUpdatesPerSecond = 0;

    for (const [, state] of this.pairs) {
      const score = this.calculateActivityScore(state);
      totalUpdatesPerSecond += score * this.getMaxUpdatesPerSecond();
    }

    const avgUpdatesPerSecond = this.pairs.size > 0
      ? totalUpdatesPerSecond / this.pairs.size
      : 0;

    return {
      trackedPairs: this.pairs.size,
      hotPairs: hotPairs.length,
      totalUpdates: this.totalUpdates,
      averageUpdatesPerSecond: avgUpdatesPerSecond
    };
  }

  /**
   * Reset tracking for a specific pair.
   */
  resetPair(pairAddress: string): void {
    this.pairs.delete(pairAddress.toLowerCase());
  }

  /**
   * Reset all tracking data.
   */
  resetAll(): void {
    this.pairs.clear();
    this.totalUpdates = 0;
  }

  /**
   * Stop the tracker and clean up resources.
   */
  destroy(): void {
    this.cleanupTimer = clearIntervalSafe(this.cleanupTimer);
    this.pairs.clear();
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Calculate activity score for a pair (0-1).
   * Uses cached value if still valid.
   */
  private calculateActivityScore(state: PairActivityState): number {
    const now = Date.now();

    // Return cached score if still valid
    if (now - state.scoreCacheTime < SCORE_CACHE_TTL_MS) {
      return state.cachedScore;
    }

    const updatesInWindow = this.countUpdatesInWindow(state, now);
    const maxUpdatesInWindow = this.getMaxUpdatesPerSecond() * (this.config.windowMs / 1000);

    // Score = ratio of actual updates to theoretical max
    const score = Math.min(1, updatesInWindow / maxUpdatesInWindow);

    // Cache the score
    state.cachedScore = score;
    state.scoreCacheTime = now;

    return score;
  }

  /**
   * Count updates within the tracking window.
   */
  private countUpdatesInWindow(state: PairActivityState, now: number): number {
    const windowStart = now - this.config.windowMs;
    let count = 0;

    for (let i = 0; i < state.updateCount; i++) {
      const idx = (state.writeIndex - 1 - i + TIMESTAMP_BUFFER_SIZE) % TIMESTAMP_BUFFER_SIZE;
      const ts = state.updateTimestamps[idx];

      if (ts >= windowStart) {
        count++;
      } else {
        // Timestamps are in order, so we can stop early
        break;
      }
    }

    return count;
  }

  /**
   * Get theoretical max updates per second for scoring.
   * This is used as the upper bound for activity score calculation.
   */
  private getMaxUpdatesPerSecond(): number {
    // Assume max ~10 updates/second for a very active pair
    return 10;
  }

  /**
   * Evict least recently used pairs if at max capacity.
   */
  private evictLRUPairsIfNeeded(): void {
    if (this.pairs.size < this.config.maxPairs) {
      return;
    }

    // Find and remove the oldest 10% of pairs
    // Uses O(N*k) partial selection instead of O(N log N) full sort
    const toRemove = Math.max(1, Math.floor(this.config.maxPairs * 0.1));
    const oldestEntries = findKSmallest(
      this.pairs.entries(),
      toRemove,
      ([, a], [, b]) => a.lastUpdateTime - b.lastUpdateTime
    );
    const oldest = oldestEntries.map(([key]) => key);

    for (const key of oldest) {
      this.pairs.delete(key);
    }

    logger.debug('Evicted LRU pairs', {
      evicted: toRemove,
      remaining: this.pairs.size
    });
  }

  /**
   * Clean up pairs that haven't been updated in a long time.
   */
  private cleanupStalePairs(): void {
    const now = Date.now();
    const staleThreshold = this.config.windowMs * 10; // 10x window = stale
    let removed = 0;

    for (const [address, state] of this.pairs) {
      if (now - state.lastUpdateTime > staleThreshold) {
        this.pairs.delete(address);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug('Cleaned up stale pairs', {
        removed,
        remaining: this.pairs.size
      });
    }
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let trackerInstance: PairActivityTracker | null = null;

/**
 * Get the singleton PairActivityTracker instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton PairActivityTracker instance
 */
export function getPairActivityTracker(config?: Partial<ActivityTrackerConfig>): PairActivityTracker {
  if (!trackerInstance) {
    trackerInstance = new PairActivityTracker(config);
  }
  return trackerInstance;
}

/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export function resetPairActivityTracker(): void {
  if (trackerInstance) {
    trackerInstance.destroy();
  }
  trackerInstance = null;
}
