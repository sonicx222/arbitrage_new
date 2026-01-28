/**
 * T4.3 Refactor 9.3: Synchronized Statistics Utility
 *
 * Provides thread-safe statistics tracking for ML models.
 * Fixes Race 5.2 where non-atomic stats updates could cause inconsistencies
 * in concurrent async scenarios.
 *
 * While JavaScript is single-threaded, async operations can interleave
 * in ways that cause read-modify-write races. This utility provides:
 * - Atomic increment operations
 * - Snapshot-based reads
 * - Rolling average calculations
 * - Bounded history tracking
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for SynchronizedStats.
 */
export interface SynchronizedStatsConfig {
  /** Maximum history size for rolling averages (default: 1000) */
  maxHistorySize?: number;
  /** Initial values for counters */
  initialCounters?: Record<string, number>;
  /** Initial values for accumulators */
  initialAccumulators?: Record<string, number>;
}

/**
 * Snapshot of current statistics.
 */
export interface StatsSnapshot {
  /** Counter values (integers) */
  counters: Record<string, number>;
  /** Accumulator values (floats) */
  accumulators: Record<string, number>;
  /** Calculated averages (accumulator / associated counter) */
  averages: Record<string, number>;
  /** Timestamp when snapshot was taken */
  timestamp: number;
}

// =============================================================================
// SynchronizedStats Class
// =============================================================================

/**
 * Thread-safe statistics tracker for ML models.
 *
 * Usage:
 * ```typescript
 * const stats = new SynchronizedStats({
 *   initialCounters: { predictions: 0, enhanced: 0 },
 *   initialAccumulators: { totalContribution: 0 }
 * });
 *
 * // Atomic updates
 * stats.increment('predictions');
 * stats.increment('enhanced');
 * stats.accumulate('totalContribution', 0.15);
 *
 * // Get snapshot
 * const snapshot = stats.getSnapshot();
 * console.log(snapshot.counters.predictions); // 1
 * console.log(stats.getAverage('totalContribution', 'enhanced')); // 0.15
 * ```
 */
export class SynchronizedStats {
  private counters: Map<string, number>;
  private accumulators: Map<string, number>;
  private readonly maxHistorySize: number;

  // Rolling history for per-key averages
  private history: Map<string, number[]>;

  // Version number for optimistic concurrency
  private version: number;

  constructor(config: SynchronizedStatsConfig = {}) {
    this.maxHistorySize = config.maxHistorySize ?? 1000;
    this.version = 0;

    // Initialize counters
    this.counters = new Map();
    if (config.initialCounters) {
      for (const [key, value] of Object.entries(config.initialCounters)) {
        this.counters.set(key, value);
      }
    }

    // Initialize accumulators
    this.accumulators = new Map();
    if (config.initialAccumulators) {
      for (const [key, value] of Object.entries(config.initialAccumulators)) {
        this.accumulators.set(key, value);
      }
    }

    // Initialize history
    this.history = new Map();
  }

  // ===========================================================================
  // Counter Operations (Atomic)
  // ===========================================================================

  /**
   * Atomically increment a counter by 1.
   * Creates the counter with value 1 if it doesn't exist.
   */
  increment(key: string): number {
    this.version++;
    const current = this.counters.get(key) ?? 0;
    const newValue = current + 1;
    this.counters.set(key, newValue);
    return newValue;
  }

  /**
   * Atomically increment a counter by a specified amount.
   */
  incrementBy(key: string, amount: number): number {
    this.version++;
    const current = this.counters.get(key) ?? 0;
    const newValue = current + amount;
    this.counters.set(key, newValue);
    return newValue;
  }

  /**
   * Get a counter value.
   * Returns 0 if the counter doesn't exist.
   */
  getCounter(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  /**
   * Set a counter to a specific value.
   */
  setCounter(key: string, value: number): void {
    this.version++;
    this.counters.set(key, value);
  }

  // ===========================================================================
  // Accumulator Operations (Atomic)
  // ===========================================================================

  /**
   * Atomically add to an accumulator.
   * Creates the accumulator with the value if it doesn't exist.
   *
   * @param key - Accumulator key
   * @param value - Value to add
   * @param trackHistory - Whether to track in rolling history (default: false)
   */
  accumulate(key: string, value: number, trackHistory = false): number {
    this.version++;

    // Protect against NaN/Infinity
    if (!Number.isFinite(value)) {
      return this.accumulators.get(key) ?? 0;
    }

    const current = this.accumulators.get(key) ?? 0;
    const newValue = current + value;
    this.accumulators.set(key, newValue);

    // Track in rolling history if requested
    if (trackHistory) {
      let historyArray = this.history.get(key);
      if (!historyArray) {
        historyArray = [];
        this.history.set(key, historyArray);
      }
      historyArray.push(value);

      // Maintain bounded history
      if (historyArray.length > this.maxHistorySize) {
        historyArray.shift();
      }
    }

    return newValue;
  }

  /**
   * Get an accumulator value.
   * Returns 0 if the accumulator doesn't exist.
   */
  getAccumulator(key: string): number {
    return this.accumulators.get(key) ?? 0;
  }

  /**
   * Set an accumulator to a specific value.
   */
  setAccumulator(key: string, value: number): void {
    this.version++;
    this.accumulators.set(key, value);
  }

  // ===========================================================================
  // Average Calculations
  // ===========================================================================

  /**
   * Calculate average: accumulator / counter.
   * Returns 0 if counter is 0 or if either key doesn't exist.
   *
   * @param accumulatorKey - Key of the accumulator (numerator)
   * @param counterKey - Key of the counter (denominator)
   */
  getAverage(accumulatorKey: string, counterKey: string): number {
    const accumulator = this.accumulators.get(accumulatorKey) ?? 0;
    const counter = this.counters.get(counterKey) ?? 0;

    if (counter === 0) return 0;

    const avg = accumulator / counter;
    return Number.isFinite(avg) ? avg : 0;
  }

  /**
   * Get rolling average from history.
   * Returns 0 if no history exists for the key.
   *
   * @param key - Key to get rolling average for
   * @param windowSize - Number of recent values to average (default: all)
   */
  getRollingAverage(key: string, windowSize?: number): number {
    const historyArray = this.history.get(key);
    if (!historyArray || historyArray.length === 0) return 0;

    const values = windowSize
      ? historyArray.slice(-windowSize)
      : historyArray;

    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
    }

    return sum / values.length;
  }

  /**
   * Get recent accuracy from history.
   * Counts values meeting a threshold condition.
   *
   * @param key - Key to check history for
   * @param predicate - Function to test each value
   * @param windowSize - Number of recent values to check
   */
  getRecentAccuracy(
    key: string,
    predicate: (value: number) => boolean,
    windowSize = 50
  ): number {
    const historyArray = this.history.get(key);
    if (!historyArray || historyArray.length === 0) return 0;

    const values = historyArray.slice(-windowSize);
    let matches = 0;

    for (let i = 0; i < values.length; i++) {
      if (predicate(values[i])) matches++;
    }

    return values.length > 0 ? matches / values.length : 0;
  }

  // ===========================================================================
  // Snapshot Operations
  // ===========================================================================

  /**
   * Get a snapshot of all statistics.
   * The snapshot is a consistent view at a point in time.
   */
  getSnapshot(): StatsSnapshot {
    const counters: Record<string, number> = {};
    const accumulators: Record<string, number> = {};
    const averages: Record<string, number> = {};

    // Copy counters
    for (const [key, value] of this.counters) {
      counters[key] = value;
    }

    // Copy accumulators
    for (const [key, value] of this.accumulators) {
      accumulators[key] = value;
    }

    // Calculate standard averages (accumulator named X_total / counter named X_count)
    for (const accKey of this.accumulators.keys()) {
      if (accKey.endsWith('_total')) {
        const baseKey = accKey.slice(0, -6); // Remove '_total'
        const countKey = `${baseKey}_count`;
        if (this.counters.has(countKey)) {
          averages[baseKey] = this.getAverage(accKey, countKey);
        }
      }
    }

    return {
      counters,
      accumulators,
      averages,
      timestamp: Date.now()
    };
  }

  /**
   * Get the current version number.
   * Useful for detecting changes between reads.
   */
  getVersion(): number {
    return this.version;
  }

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  /**
   * Atomically update multiple values at once.
   * This ensures all updates happen without interleaving.
   */
  batchUpdate(updates: {
    counters?: Record<string, number>;
    accumulators?: Record<string, number>;
  }): void {
    this.version++;

    if (updates.counters) {
      for (const [key, value] of Object.entries(updates.counters)) {
        const current = this.counters.get(key) ?? 0;
        this.counters.set(key, current + value);
      }
    }

    if (updates.accumulators) {
      for (const [key, value] of Object.entries(updates.accumulators)) {
        if (Number.isFinite(value)) {
          const current = this.accumulators.get(key) ?? 0;
          this.accumulators.set(key, current + value);
        }
      }
    }
  }

  // ===========================================================================
  // Reset Operations
  // ===========================================================================

  /**
   * Reset all statistics to initial state.
   */
  reset(): void {
    this.version = 0;
    this.counters.clear();
    this.accumulators.clear();
    this.history.clear();
  }

  /**
   * Reset a specific counter.
   */
  resetCounter(key: string): void {
    this.version++;
    this.counters.set(key, 0);
  }

  /**
   * Reset a specific accumulator.
   */
  resetAccumulator(key: string): void {
    this.version++;
    this.accumulators.set(key, 0);
  }

  /**
   * Clear history for a specific key.
   */
  clearHistory(key: string): void {
    this.history.delete(key);
  }

  /**
   * Clear all history.
   */
  clearAllHistory(): void {
    this.history.clear();
  }

  // ===========================================================================
  // History Operations
  // ===========================================================================

  /**
   * Add a value to history without accumulating.
   * Useful for tracking values that shouldn't be summed.
   */
  recordValue(key: string, value: number): void {
    if (!Number.isFinite(value)) return;

    let historyArray = this.history.get(key);
    if (!historyArray) {
      historyArray = [];
      this.history.set(key, historyArray);
    }

    historyArray.push(value);

    if (historyArray.length > this.maxHistorySize) {
      historyArray.shift();
    }
  }

  /**
   * Get history array for a key.
   * Returns a copy to prevent external modification.
   */
  getHistory(key: string): number[] {
    const historyArray = this.history.get(key);
    return historyArray ? [...historyArray] : [];
  }

  /**
   * Get history size for a key.
   */
  getHistorySize(key: string): number {
    return this.history.get(key)?.length ?? 0;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new SynchronizedStats instance.
 */
export function createSynchronizedStats(
  config?: SynchronizedStatsConfig
): SynchronizedStats {
  return new SynchronizedStats(config);
}
