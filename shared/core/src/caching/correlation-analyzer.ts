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
import { clearIntervalSafe } from '../lifecycle-utils';

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

  /** Task 2.2.3: Estimated memory usage in bytes */
  estimatedMemoryBytes: number;

  /** Task 2.2.3: Number of co-occurrence matrix entries */
  coOccurrenceEntries: number;

  /** Task 2.2.3: Number of correlation cache entries */
  correlationCacheEntries: number;
}

/**
 * Internal state for tracking a pair's update history
 */
interface PairUpdateState {
  /**
   * Timestamps of recent updates.
   * Issue 10.4: Changed from number[] to CircularTimestampBuffer for O(1) insertion.
   */
  updateTimestamps: CircularTimestampBuffer;

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
// CircularTimestampBuffer - Issue 10.4 Performance Optimization
// =============================================================================

/**
 * Circular buffer for storing timestamps with O(1) insertion.
 *
 * Replaces array-based storage with slice() which allocates O(n) memory
 * on every trim operation. This buffer:
 * - Uses fixed-size array with wrap-around indexing
 * - O(1) push (overwrites oldest when full)
 * - Supports iteration in chronological order
 * - Supports in-place filtering for cleanup
 *
 * @see Issue 10.4: Performance optimization for hot path
 */
class CircularTimestampBuffer {
  private buffer: number[];
  private head: number = 0;    // Next write position
  private count: number = 0;   // Current number of elements
  private readonly capacity: number;

  constructor(capacity: number = MAX_TIMESTAMPS_PER_PAIR) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /**
   * Add a timestamp to the buffer.
   * O(1) operation - overwrites oldest if at capacity.
   */
  push(timestamp: number): void {
    this.buffer[this.head] = timestamp;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /**
   * Get the current number of timestamps in the buffer.
   */
  get length(): number {
    return this.count;
  }

  /**
   * Check if buffer is empty.
   */
  isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Clear all timestamps.
   */
  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /**
   * Iterate through all timestamps in chronological order.
   * Returns timestamps from oldest to newest.
   */
  *[Symbol.iterator](): IterableIterator<number> {
    if (this.count === 0) return;

    // Start position is (head - count) wrapped to positive
    const start = (this.head - this.count + this.capacity) % this.capacity;

    for (let i = 0; i < this.count; i++) {
      const index = (start + i) % this.capacity;
      yield this.buffer[index];
    }
  }

  /**
   * Convert to array (for compatibility with existing code).
   * O(n) operation - use sparingly, prefer iteration.
   */
  toArray(): number[] {
    return Array.from(this);
  }

  /**
   * Filter timestamps in place, keeping only those matching predicate.
   * O(n) operation but doesn't allocate new array.
   *
   * @param predicate - Function that returns true for timestamps to keep
   * @returns Number of timestamps retained
   */
  filterInPlace(predicate: (timestamp: number) => boolean): number {
    if (this.count === 0) return 0;

    // Collect matching timestamps
    const kept: number[] = [];
    for (const ts of this) {
      if (predicate(ts)) {
        kept.push(ts);
      }
    }

    // Rebuild buffer with kept timestamps
    this.clear();
    for (const ts of kept) {
      this.push(ts);
    }

    return this.count;
  }
}

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
 * ## Thread Safety
 *
 * This class is designed for single-threaded Node.js event loop usage.
 * All operations (recordPriceUpdate, getCorrelatedPairs, etc.) are synchronous
 * and safe to call from async code without additional locking.
 *
 * ### Worker Thread Usage (Issue 2.1 Documentation)
 *
 * If sharing this instance across Worker Threads, external synchronization is required.
 * Use AsyncMutex from @arbitrage/core for thread-safe access:
 *
 * @example
 * ```typescript
 * import { namedMutex, CorrelationAnalyzer } from '@arbitrage/core';
 *
 * // Create analyzer in main thread
 * const analyzer = new CorrelationAnalyzer();
 *
 * // In worker thread - wrap mutating operations with mutex
 * async function recordUpdateSafe(pairAddress: string): Promise<void> {
 *   await namedMutex('correlation-analyzer').runExclusive(() => {
 *     analyzer.recordPriceUpdate(pairAddress);
 *   });
 * }
 *
 * // Read operations are safe without mutex (snapshot semantics)
 * function getPairsToWarmSafe(pairAddress: string): string[] {
 *   return analyzer.getPairsToWarm(pairAddress);
 * }
 * ```
 *
 * Methods requiring synchronization when used with Worker Threads:
 * - recordPriceUpdate() - modifies internal state
 * - updateCorrelations() - modifies correlation cache
 * - reset() / destroy() - clears all state
 * - beginBatch() / endBatch() - batch mode state
 *
 * Read-only methods (safe without synchronization):
 * - getCorrelatedPairs() - reads cached correlations
 * - getPairsToWarm() - reads cached correlations
 * - getStats() - reads statistics snapshot
 * - isBatchMode() - reads boolean flag
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

  /** Task 2.2.3: Cached memory estimate for performance */
  private memoryEstimateCache: {
    totalBytes: number;
    coOccurrenceEntries: number;
    correlationCacheEntries: number;
  } | null = null;
  private memoryEstimateDirty: boolean = true;

  /**
   * Issue 10.5: Batch mode state for burst update processing.
   * When batch mode is active, co-occurrence tracking is deferred until endBatch().
   * This is more efficient for processing multiple updates from a single block.
   */
  private batchMode: boolean = false;
  private batchUpdates: Array<{ pairAddress: string; timestamp: number }> = [];

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
   * In batch mode (beginBatch() called), updates are collected but co-occurrence
   * tracking is deferred until endBatch() for better performance during bursts.
   *
   * @param pairAddress - The pair contract address
   * @param timestamp - Optional timestamp (defaults to now)
   */
  recordPriceUpdate(pairAddress: string, timestamp?: number): void {
    if (!pairAddress) return;

    const now = timestamp ?? Date.now();
    const normalizedAddress = pairAddress.toLowerCase();

    // Issue 10.5: In batch mode, collect updates for deferred processing
    if (this.batchMode) {
      this.batchUpdates.push({ pairAddress: normalizedAddress, timestamp: now });
      return;
    }

    this.recordPriceUpdateInternal(normalizedAddress, now, true);
  }

  /**
   * Internal implementation of recordPriceUpdate.
   * @param normalizedAddress - Lowercase pair address
   * @param timestamp - Update timestamp
   * @param trackCoOccurrences - Whether to track co-occurrences (false in batch mode)
   */
  private recordPriceUpdateInternal(
    normalizedAddress: string,
    timestamp: number,
    trackCoOccurrencesNow: boolean
  ): void {
    // Get or create pair state
    let state = this.pairUpdates.get(normalizedAddress);
    if (!state) {
      // Check capacity before adding
      this.evictLRUPairsIfNeeded();

      state = {
        // Issue 10.4: Use CircularTimestampBuffer for O(1) insertion without GC pressure
        updateTimestamps: new CircularTimestampBuffer(MAX_TIMESTAMPS_PER_PAIR),
        lastUpdateTime: timestamp,
        totalUpdates: 0
      };
      this.pairUpdates.set(normalizedAddress, state);
    }

    // Record timestamp - O(1) operation, automatically evicts oldest if at capacity
    // Issue 10.4: Removed slice() call that was O(n) and created GC pressure
    state.updateTimestamps.push(timestamp);
    state.lastUpdateTime = timestamp;
    state.totalUpdates++;

    this.totalUpdates++;

    // Track co-occurrences (skipped in batch mode - done in endBatch())
    if (trackCoOccurrencesNow) {
      // Track co-occurrences with other pairs that updated recently
      // Must be called BEFORE updating recentlyUpdatedPairs to avoid self-correlation
      this.trackCoOccurrences(normalizedAddress, timestamp);

      // Add to recently updated set for future co-occurrence detection
      this.recentlyUpdatedPairs.set(normalizedAddress, timestamp);
    }

    // Mark memory estimate as dirty since data structures changed
    this.memoryEstimateDirty = true;
  }

  // ===========================================================================
  // Issue 10.5: Batch Mode API for Burst Processing
  // ===========================================================================

  /**
   * Start batch mode for collecting multiple updates.
   * Use this when processing a block with multiple Sync events.
   *
   * Performance benefit: Instead of O(k) co-occurrence checks per update
   * (where k = recently updated pairs), batch mode computes co-occurrences
   * once at the end, reducing total work for burst updates.
   *
   * @example
   * ```typescript
   * analyzer.beginBatch();
   * for (const event of blockEvents) {
   *   analyzer.recordPriceUpdate(event.pairAddress, event.timestamp);
   * }
   * analyzer.endBatch();
   * ```
   */
  beginBatch(): void {
    if (this.batchMode) {
      logger.warn('beginBatch called while already in batch mode');
      return;
    }
    this.batchMode = true;
    this.batchUpdates = [];
  }

  /**
   * End batch mode and process all collected updates.
   * Co-occurrences are computed efficiently in a single pass.
   *
   * @returns Number of updates processed
   */
  endBatch(): number {
    if (!this.batchMode) {
      logger.warn('endBatch called while not in batch mode');
      return 0;
    }

    const updates = this.batchUpdates;
    this.batchMode = false;
    this.batchUpdates = [];

    if (updates.length === 0) {
      return 0;
    }

    // First pass: Record all updates without co-occurrence tracking
    for (const { pairAddress, timestamp } of updates) {
      this.recordPriceUpdateInternal(pairAddress, timestamp, false);
    }

    // Second pass: Compute co-occurrences for all pairs in the batch
    // All pairs in the same batch are considered co-occurring
    const batchPairs = new Set(updates.map(u => u.pairAddress));
    const batchTime = Math.max(...updates.map(u => u.timestamp));

    // Track co-occurrences between all pairs in the batch
    // All pairs that updated together in the same batch are considered co-occurring
    for (const pairA of batchPairs) {
      for (const pairB of batchPairs) {
        if (pairA !== pairB) {
          // Record bidirectional co-occurrence using existing private method
          this.recordCoOccurrence(pairA, pairB, batchTime);
        }
      }
      // Add to recently updated for future correlation tracking
      this.recentlyUpdatedPairs.set(pairA, batchTime);
    }

    logger.debug('Batch processing completed', {
      updatesProcessed: updates.length,
      uniquePairs: batchPairs.size
    });

    return updates.length;
  }

  /**
   * Check if batch mode is currently active.
   */
  isBatchMode(): boolean {
    return this.batchMode;
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
    // Mark memory estimate as dirty since cache structure changed
    this.memoryEstimateDirty = true;
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

    // Task 2.2.3: Calculate memory usage estimation
    const memoryEstimate = this.estimateMemoryUsage();

    return {
      trackedPairs: this.pairUpdates.size,
      totalUpdates: this.totalUpdates,
      correlationsComputed: this.correlationsComputed,
      lastCorrelationUpdate: this.lastCorrelationUpdate,
      avgCorrelationScore: scoreCount > 0 ? totalScore / scoreCount : 0,
      // Task 2.2.3: Memory tracking
      estimatedMemoryBytes: memoryEstimate.totalBytes,
      coOccurrenceEntries: memoryEstimate.coOccurrenceEntries,
      correlationCacheEntries: memoryEstimate.correlationCacheEntries
    };
  }

  /**
   * Task 2.2.3: Estimate memory usage of the analyzer.
   * Provides rough estimates for monitoring memory consumption.
   * PERF: Caches result to avoid O(n) iteration on every getStats() call.
   */
  private estimateMemoryUsage(): {
    totalBytes: number;
    coOccurrenceEntries: number;
    correlationCacheEntries: number;
  } {
    // Return cached estimate if available and not dirty
    if (!this.memoryEstimateDirty && this.memoryEstimateCache) {
      return this.memoryEstimateCache;
    }

    // Estimate bytes per entry (rough approximations):
    // - String (address): ~42 bytes (40 hex chars + overhead)
    // - Number: 8 bytes
    // - Object overhead: ~16 bytes

    const ADDRESS_SIZE = 42;
    const NUMBER_SIZE = 8;
    const OBJECT_OVERHEAD = 16;

    // pairUpdates: Map<string, PairUpdateState>
    // PairUpdateState = { updateTimestamps: CircularTimestampBuffer, lastUpdateTime: number, totalUpdates: number }
    // Issue 10.4: CircularTimestampBuffer has fixed capacity but variable count
    const CIRCULAR_BUFFER_OVERHEAD = 24; // head, count, capacity (3 numbers)
    let pairUpdatesBytes = 0;
    for (const [key, state] of this.pairUpdates.entries()) {
      pairUpdatesBytes += ADDRESS_SIZE; // key
      // CircularTimestampBuffer: fixed capacity array + overhead
      pairUpdatesBytes += MAX_TIMESTAMPS_PER_PAIR * NUMBER_SIZE; // fixed-size buffer
      pairUpdatesBytes += CIRCULAR_BUFFER_OVERHEAD; // buffer instance overhead
      pairUpdatesBytes += NUMBER_SIZE * 2; // lastUpdateTime + totalUpdates
      pairUpdatesBytes += OBJECT_OVERHEAD;
    }

    // coOccurrenceMatrix: Map<string, Map<string, CoOccurrenceEntry>>
    // CoOccurrenceEntry = { count: number, lastOccurrence: number }
    let coOccurrenceBytes = 0;
    let coOccurrenceEntries = 0;
    for (const [key, innerMap] of this.coOccurrenceMatrix.entries()) {
      coOccurrenceBytes += ADDRESS_SIZE; // outer key
      for (const [innerKey] of innerMap.entries()) {
        coOccurrenceBytes += ADDRESS_SIZE; // inner key
        coOccurrenceBytes += NUMBER_SIZE * 2; // count + lastOccurrence
        coOccurrenceBytes += OBJECT_OVERHEAD;
        coOccurrenceEntries++;
      }
    }

    // correlationCache: Map<string, PairCorrelation[]>
    // PairCorrelation = { pairAddress, coOccurrenceCount, correlationScore, lastCoOccurrence }
    let correlationCacheBytes = 0;
    let correlationCacheEntries = 0;
    for (const [key, correlations] of this.correlationCache.entries()) {
      correlationCacheBytes += ADDRESS_SIZE; // key
      for (const correlation of correlations) {
        correlationCacheBytes += ADDRESS_SIZE; // pairAddress
        correlationCacheBytes += NUMBER_SIZE * 3; // count + score + lastOccurrence
        correlationCacheBytes += OBJECT_OVERHEAD;
        correlationCacheEntries++;
      }
    }

    // recentlyUpdatedPairs: Map<string, number>
    const recentlyUpdatedBytes = this.recentlyUpdatedPairs.size * (ADDRESS_SIZE + NUMBER_SIZE);

    // Cache the result and mark as clean
    this.memoryEstimateCache = {
      totalBytes: pairUpdatesBytes + coOccurrenceBytes + correlationCacheBytes + recentlyUpdatedBytes,
      coOccurrenceEntries,
      correlationCacheEntries
    };
    this.memoryEstimateDirty = false;

    return this.memoryEstimateCache;
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
    // Mark memory estimate as dirty since all data was cleared
    this.memoryEstimateDirty = true;
  }

  /**
   * Stop the analyzer and clean up resources.
   */
  destroy(): void {
    this.updateTimer = clearIntervalSafe(this.updateTimer);
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
   * Issue 10.4: Uses filterInPlace() on CircularTimestampBuffer instead of array.filter()
   */
  private cleanupStaleData(): void {
    const cutoff = Date.now() - this.config.correlationHistoryMs;
    const pairsToRemove: string[] = [];

    for (const [pairAddress, state] of this.pairUpdates.entries()) {
      // Remove old timestamps using in-place filtering
      // Issue 10.4: filterInPlace avoids array allocation vs filter() which creates new array
      state.updateTimestamps.filterInPlace(ts => ts > cutoff);

      // If no recent updates, mark for removal
      if (state.updateTimestamps.isEmpty()) {
        pairsToRemove.push(pairAddress);
      }
    }

    // Remove stale pairs
    for (const pair of pairsToRemove) {
      this.pairUpdates.delete(pair);
      this.coOccurrenceMatrix.delete(pair);
    }

    if (pairsToRemove.length > 0) {
      // Mark memory estimate as dirty since pairs were removed
      this.memoryEstimateDirty = true;
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

    // Mark memory estimate as dirty since pairs were evicted
    this.memoryEstimateDirty = true;

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
let analyzerInstanceConfig: Partial<CorrelationAnalyzerConfig> | undefined = undefined;

/**
 * Get the singleton CorrelationAnalyzer instance.
 *
 * Note: The configuration is only used on first initialization. If called with
 * different config after the singleton exists, a warning is logged and the
 * existing instance is returned unchanged. Use resetCorrelationAnalyzer() first
 * if you need to change configuration.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton CorrelationAnalyzer instance
 */
export function getCorrelationAnalyzer(
  config?: Partial<CorrelationAnalyzerConfig>
): CorrelationAnalyzer {
  if (!analyzerInstance) {
    analyzerInstance = new CorrelationAnalyzer(config);
    analyzerInstanceConfig = config;
  } else if (config !== undefined && config !== analyzerInstanceConfig) {
    // P0-FIX Issue 4.3: Warn if config differs from initial
    // This prevents silent config being ignored which can cause subtle bugs
    logger.warn(
      'getCorrelationAnalyzer called with different config after initialization. ' +
      'Config is ignored. Use resetCorrelationAnalyzer() first if reconfiguration is needed.',
      { providedConfig: config, existingConfig: analyzerInstanceConfig }
    );
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
  analyzerInstanceConfig = undefined;
}
