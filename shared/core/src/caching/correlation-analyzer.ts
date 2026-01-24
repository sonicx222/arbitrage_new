/**
 * Correlation Analyzer
 *
 * Tracks co-occurrence of price updates between trading pairs to enable
 * predictive cache warming. When a price update occurs for pair A, correlated
 * pairs (those that often update together) can be pre-warmed in the cache.
 *
 * Key Features:
 * - Co-occurrence tracking within configurable time windows
 * - Correlation scoring based on update frequency
 * - Periodic recalculation of correlations
 * - Memory-efficient with LRU eviction
 * - Provides recommendations for cache warming
 *
 * @see docs/reports/implementation_plan_v2.md - Task 2.2.1
 * @module caching
 */

import { createLogger } from '../logger';

const logger = createLogger('correlation-analyzer');

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for CorrelationAnalyzer
 */
export interface CorrelationAnalyzerConfig {
  /** Time window (ms) for detecting co-occurring updates (default: 1000ms = 1 second) */
  coOccurrenceWindowMs: number;

  /** Interval (ms) for automatic correlation recalculation (default: 3600000 = 1 hour) */
  correlationUpdateIntervalMs: number;

  /** Maximum number of pairs to track (prevents unbounded memory growth) */
  maxTrackedPairs: number;

  /** Minimum co-occurrences required to establish correlation */
  minCoOccurrences: number;

  /** Maximum number of correlated pairs to return per query */
  topCorrelatedLimit: number;

  /** How long to keep update history for correlation calculation (default: 1 hour) */
  correlationHistoryMs: number;

  /** Enable automatic periodic correlation updates */
  enablePeriodicUpdates: boolean;
}

/**
 * Represents a correlation between two pairs
 */
export interface PairCorrelation {
  /** The correlated pair address */
  pairAddress: string;

  /** Number of times the pairs updated together */
  coOccurrenceCount: number;

  /** Correlation score (0-1, higher = more correlated) */
  correlationScore: number;

  /** Last time a co-occurrence was observed */
  lastCoOccurrence: number;
}

/**
 * Statistics for the correlation analyzer
 */
export interface CorrelationStats {
  /** Number of pairs being tracked */
  trackedPairs: number;

  /** Total price updates processed */
  totalUpdates: number;

  /** Number of correlations computed */
  correlationsComputed: number;

  /** Timestamp of last correlation update */
  lastCorrelationUpdate: number;

  /** Average correlation score across all pairs */
  avgCorrelationScore: number;
}

/**
 * Internal state for tracking a pair's update history
 */
interface PairUpdateState {
  /** Timestamps of recent updates */
  updateTimestamps: number[];

  /** Last update time (for LRU eviction) */
  lastUpdateTime: number;

  /** Total updates for this pair */
  totalUpdates: number;
}

/**
 * Internal co-occurrence count between two pairs
 */
interface CoOccurrenceEntry {
  count: number;
  lastOccurrence: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: CorrelationAnalyzerConfig = {
  coOccurrenceWindowMs: 1000,           // 1 second window for co-occurrence
  correlationUpdateIntervalMs: 3600000, // 1 hour
  maxTrackedPairs: 5000,                // Max pairs to track
  minCoOccurrences: 3,                  // Need at least 3 co-occurrences
  topCorrelatedLimit: 3,                // Return top 3 correlated pairs
  correlationHistoryMs: 3600000,        // Keep 1 hour of history
  enablePeriodicUpdates: true           // Enable automatic updates
};

// Maximum number of timestamps to keep per pair
const MAX_TIMESTAMPS_PER_PAIR = 1000;

// =============================================================================
// Correlation Analyzer
// =============================================================================

/**
 * Correlation Analyzer
 *
 * Tracks price update patterns to identify pairs that frequently update together.
 * Used for predictive cache warming - when pair A updates, pre-warm cache for
 * correlated pairs B, C, D.
 *
 * Thread Safety:
 * This class is designed for single-threaded Node.js event loop usage.
 * All operations (recordPriceUpdate, getCorrelatedPairs, etc.) are synchronous
 * and safe to call from async code without additional locking. If used with
 * Worker Threads sharing this instance, external synchronization (AsyncMutex)
 * would be required on recordPriceUpdate() calls.
 */
export class CorrelationAnalyzer {
  private config: CorrelationAnalyzerConfig;

  /** Track update timestamps per pair */
  private pairUpdates: Map<string, PairUpdateState> = new Map();

  /** Co-occurrence matrix: pair -> (correlated pair -> count) */
  private coOccurrenceMatrix: Map<string, Map<string, CoOccurrenceEntry>> = new Map();

  /** Computed correlations: pair -> sorted list of correlations */
  private correlationCache: Map<string, PairCorrelation[]> = new Map();

  /**
   * Recently updated pairs for O(1) co-occurrence lookup.
   * Maps pair address -> last update timestamp.
   * Performance optimization: Instead of scanning all pairs O(n*m),
   * we only check pairs in this set O(k) where k << n.
   */
  private recentlyUpdatedPairs: Map<string, number> = new Map();

  /** Statistics */
  private totalUpdates: number = 0;
  private correlationsComputed: number = 0;
  private lastCorrelationUpdate: number = 0;

  /** Periodic update timer */
  private updateTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<CorrelationAnalyzerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Start periodic correlation updates if enabled
    if (this.config.enablePeriodicUpdates) {
      this.startPeriodicUpdates();
    }

    logger.info('CorrelationAnalyzer initialized', {
      coOccurrenceWindowMs: this.config.coOccurrenceWindowMs,
      correlationUpdateIntervalMs: this.config.correlationUpdateIntervalMs,
      maxTrackedPairs: this.config.maxTrackedPairs,
      minCoOccurrences: this.config.minCoOccurrences
    });
  }

  // ===========================================================================
  // Public API
  // ===========================================================================

  /**
   * Record a price update for a pair.
   * Call this whenever a Sync event is processed.
   *
   * @param pairAddress - The pair contract address
   * @param timestamp - Optional timestamp (defaults to now)
   */
  recordPriceUpdate(pairAddress: string, timestamp?: number): void {
    if (!pairAddress) return;

    const now = timestamp ?? Date.now();
    const normalizedAddress = pairAddress.toLowerCase();

    // Get or create pair state
    let state = this.pairUpdates.get(normalizedAddress);
    if (!state) {
      // Check capacity before adding
      this.evictLRUPairsIfNeeded();

      state = {
        updateTimestamps: [],
        lastUpdateTime: now,
        totalUpdates: 0
      };
      this.pairUpdates.set(normalizedAddress, state);
    }

    // Record timestamp
    state.updateTimestamps.push(now);
    state.lastUpdateTime = now;
    state.totalUpdates++;

    // Trim old timestamps to prevent memory growth
    if (state.updateTimestamps.length > MAX_TIMESTAMPS_PER_PAIR) {
      state.updateTimestamps = state.updateTimestamps.slice(-MAX_TIMESTAMPS_PER_PAIR);
    }

    this.totalUpdates++;

    // Track co-occurrences with other pairs that updated recently
    // Must be called BEFORE updating recentlyUpdatedPairs to avoid self-correlation
    this.trackCoOccurrences(normalizedAddress, now);

    // Add to recently updated set for future co-occurrence detection
    this.recentlyUpdatedPairs.set(normalizedAddress, now);
  }

  /**
   * Get correlated pairs for a given pair address.
   *
   * @param pairAddress - The pair to find correlations for
   * @returns Array of correlated pairs sorted by score (highest first)
   */
  getCorrelatedPairs(pairAddress: string): PairCorrelation[] {
    if (!pairAddress) return [];

    const normalizedAddress = pairAddress.toLowerCase();
    const cached = this.correlationCache.get(normalizedAddress);

    return cached ?? [];
  }

  /**
   * Get pair addresses to warm in cache when a pair updates.
   * Convenience method that returns just the addresses.
   *
   * @param pairAddress - The pair that just updated
   * @returns Array of pair addresses to pre-warm
   */
  getPairsToWarm(pairAddress: string): string[] {
    const correlations = this.getCorrelatedPairs(pairAddress);
    return correlations.map(c => c.pairAddress);
  }

  /**
   * Manually trigger correlation recalculation.
   * Normally called automatically on the configured interval.
   */
  updateCorrelations(): void {
    const startTime = Date.now();

    // Clean up stale data first
    this.cleanupStaleData();

    // Clear existing correlation cache
    this.correlationCache.clear();
    let totalCorrelations = 0;
    let totalScore = 0;

    // Calculate correlations for each pair
    for (const [pairAddress, coOccurrences] of this.coOccurrenceMatrix.entries()) {
      const correlations: PairCorrelation[] = [];

      // Get total updates for this pair (for normalization)
      const pairState = this.pairUpdates.get(pairAddress);
      const totalPairUpdates = pairState?.totalUpdates ?? 1;

      for (const [correlatedPair, entry] of coOccurrences.entries()) {
        // Skip if below minimum threshold
        if (entry.count < this.config.minCoOccurrences) {
          continue;
        }

        // Calculate correlation score
        // Score = co-occurrences / min(updates_A, updates_B)
        const correlatedState = this.pairUpdates.get(correlatedPair);
        const correlatedUpdates = correlatedState?.totalUpdates ?? 1;
        const minUpdates = Math.min(totalPairUpdates, correlatedUpdates);

        const score = Math.min(1, entry.count / Math.max(minUpdates, 1));

        correlations.push({
          pairAddress: correlatedPair,
          coOccurrenceCount: entry.count,
          correlationScore: score,
          lastCoOccurrence: entry.lastOccurrence
        });

        totalScore += score;
        totalCorrelations++;
      }

      // Sort by score (highest first) and limit
      correlations.sort((a, b) => b.correlationScore - a.correlationScore);
      const limitedCorrelations = correlations.slice(0, this.config.topCorrelatedLimit);

      if (limitedCorrelations.length > 0) {
        this.correlationCache.set(pairAddress, limitedCorrelations);
      }
    }

    this.correlationsComputed = totalCorrelations;
    this.lastCorrelationUpdate = Date.now();

    const duration = Date.now() - startTime;
    logger.debug('Correlation update completed', {
      duration,
      pairs: this.pairUpdates.size,
      correlations: totalCorrelations,
      avgScore: totalCorrelations > 0 ? (totalScore / totalCorrelations).toFixed(3) : 0
    });
  }

  /**
   * Get statistics about the correlation analyzer.
   */
  getStats(): CorrelationStats {
    let totalScore = 0;
    let scoreCount = 0;

    for (const correlations of this.correlationCache.values()) {
      for (const correlation of correlations) {
        totalScore += correlation.correlationScore;
        scoreCount++;
      }
    }

    return {
      trackedPairs: this.pairUpdates.size,
      totalUpdates: this.totalUpdates,
      correlationsComputed: this.correlationsComputed,
      lastCorrelationUpdate: this.lastCorrelationUpdate,
      avgCorrelationScore: scoreCount > 0 ? totalScore / scoreCount : 0
    };
  }

  /**
   * Reset all tracking data.
   */
  reset(): void {
    this.pairUpdates.clear();
    this.coOccurrenceMatrix.clear();
    this.correlationCache.clear();
    this.recentlyUpdatedPairs.clear();
    this.totalUpdates = 0;
    this.correlationsComputed = 0;
    this.lastCorrelationUpdate = 0;
  }

  /**
   * Stop the analyzer and clean up resources.
   */
  destroy(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    this.reset();
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Track co-occurrences with other pairs that updated within the time window.
   *
   * PERFORMANCE OPTIMIZATION (Hot Path):
   * Instead of scanning all pairs O(n * m), we only check pairs in the
   * recentlyUpdatedPairs set that updated within the window O(k) where k << n.
   * This reduces complexity from O(5000 * 1000) to O(k) where k is typically < 100.
   */
  private trackCoOccurrences(pairAddress: string, timestamp: number): void {
    const windowStart = timestamp - this.config.coOccurrenceWindowMs;

    // HOT PATH OPTIMIZATION: Delete stale entries inline to avoid array allocation
    // JavaScript Maps support deletion during for...of iteration
    // This eliminates GC pressure from temporary array creation on every call
    for (const [otherPair, lastUpdate] of this.recentlyUpdatedPairs.entries()) {
      if (lastUpdate < windowStart) {
        // Stale entry - delete and skip
        this.recentlyUpdatedPairs.delete(otherPair);
        continue;
      }

      // Skip self
      if (otherPair === pairAddress) continue;

      // The pair is in recentlyUpdatedPairs and within the window
      // Record bidirectional co-occurrence
      this.recordCoOccurrence(pairAddress, otherPair, timestamp);
      this.recordCoOccurrence(otherPair, pairAddress, timestamp);
    }
  }

  /**
   * Record a single co-occurrence between two pairs.
   */
  private recordCoOccurrence(pairA: string, pairB: string, timestamp: number): void {
    let pairCoOccurrences = this.coOccurrenceMatrix.get(pairA);
    if (!pairCoOccurrences) {
      pairCoOccurrences = new Map();
      this.coOccurrenceMatrix.set(pairA, pairCoOccurrences);
    }

    let entry = pairCoOccurrences.get(pairB);
    if (!entry) {
      entry = { count: 0, lastOccurrence: 0 };
      pairCoOccurrences.set(pairB, entry);
    }

    entry.count++;
    entry.lastOccurrence = timestamp;
  }

  /**
   * Clean up stale update records.
   */
  private cleanupStaleData(): void {
    const cutoff = Date.now() - this.config.correlationHistoryMs;
    const pairsToRemove: string[] = [];

    for (const [pairAddress, state] of this.pairUpdates.entries()) {
      // Remove old timestamps
      state.updateTimestamps = state.updateTimestamps.filter(ts => ts > cutoff);

      // If no recent updates, mark for removal
      if (state.updateTimestamps.length === 0) {
        pairsToRemove.push(pairAddress);
      }
    }

    // Remove stale pairs
    for (const pair of pairsToRemove) {
      this.pairUpdates.delete(pair);
      this.coOccurrenceMatrix.delete(pair);
    }

    if (pairsToRemove.length > 0) {
      logger.debug('Cleaned up stale pairs', {
        removed: pairsToRemove.length,
        remaining: this.pairUpdates.size
      });
    }
  }

  /**
   * Evict least recently used pairs if at max capacity.
   */
  private evictLRUPairsIfNeeded(): void {
    if (this.pairUpdates.size < this.config.maxTrackedPairs) {
      return;
    }

    // Find and remove the oldest 10% of pairs
    const toRemove = Math.max(1, Math.floor(this.config.maxTrackedPairs * 0.1));
    const pairsByTime = Array.from(this.pairUpdates.entries())
      .sort((a, b) => a[1].lastUpdateTime - b[1].lastUpdateTime);

    for (let i = 0; i < toRemove && i < pairsByTime.length; i++) {
      const pair = pairsByTime[i][0];
      this.pairUpdates.delete(pair);
      this.coOccurrenceMatrix.delete(pair);
    }

    logger.debug('Evicted LRU pairs', {
      evicted: toRemove,
      remaining: this.pairUpdates.size
    });
  }

  /**
   * Start the periodic correlation update timer.
   */
  private startPeriodicUpdates(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    this.updateTimer = setInterval(() => {
      try {
        this.updateCorrelations();
      } catch (error) {
        logger.error('Periodic correlation update failed', { error });
      }
    }, this.config.correlationUpdateIntervalMs);

    // Don't prevent process exit - use unref() to prevent timer from keeping
    // Node.js event loop alive during shutdown (consistent with PairActivityTracker)
    this.updateTimer.unref();
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let analyzerInstance: CorrelationAnalyzer | null = null;

/**
 * Get the singleton CorrelationAnalyzer instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton CorrelationAnalyzer instance
 */
export function getCorrelationAnalyzer(
  config?: Partial<CorrelationAnalyzerConfig>
): CorrelationAnalyzer {
  if (!analyzerInstance) {
    analyzerInstance = new CorrelationAnalyzer(config);
  }
  return analyzerInstance;
}

/**
 * Create a new CorrelationAnalyzer instance (not singleton).
 *
 * @param config - Optional configuration
 * @returns A new CorrelationAnalyzer instance
 */
export function createCorrelationAnalyzer(
  config?: Partial<CorrelationAnalyzerConfig>
): CorrelationAnalyzer {
  return new CorrelationAnalyzer(config);
}

/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export function resetCorrelationAnalyzer(): void {
  if (analyzerInstance) {
    analyzerInstance.destroy();
  }
  analyzerInstance = null;
}
