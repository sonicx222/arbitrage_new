/**
 * Execution Probability Tracker
 *
 * Phase 3: Capital & Risk Controls (P0)
 * Task 3.4.1: Execution Probability Tracker
 *
 * Tracks historical execution outcomes to calculate win probabilities
 * for arbitrage trades based on (chain, DEX, pathLength) combinations.
 *
 * Used by the EV Calculator (Task 3.4.2) to determine expected value
 * of potential opportunities before execution.
 *
 * @see docs/reports/implementation_plan_v3.md Section 3.4.1
 */

import { createLogger, Logger } from '../logger';
import type {
  ExecutionOutcome,
  ExecutionProbabilityConfig,
  ExecutionTrackerStats,
  GasCostQueryParams,
  GasCostResult,
  HourlyStats,
  ProbabilityQueryParams,
  ProbabilityResult,
  ProfitQueryParams,
  ProfitResult,
} from './types';

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: ExecutionProbabilityConfig = {
  minSamples: 10,
  defaultWinProbability: 0.5,
  maxOutcomesPerKey: 1000,
  cleanupIntervalMs: 60000, // 1 minute
  outcomeRelevanceWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 days

  // Redis persistence configuration
  // STATUS: DEFERRED - In-memory tracking is sufficient for initial deployment.
  // The redisKeyPrefix is reserved for future use when Redis persistence is needed.
  // Implementation plan when required:
  // - On recordOutcome(): persist to Redis hash at {redisKeyPrefix}{chain}:{dex}:{pathLength}
  // - On startup: load historical data from Redis
  // - Format: { wins: number, losses: number, avgProfit: string, avgGas: string }
  // See implementation_plan_v3.md Section 3.4.1 for schema details
  redisKeyPrefix: 'risk:probability:',
  persistToRedis: false,
};

// =============================================================================
// Internal State Types
// =============================================================================

interface OutcomesByKey {
  outcomes: ExecutionOutcome[];
  wins: number;
  losses: number;
  totalProfit: bigint;
  totalGasCost: bigint;
  successfulCount: number; // Count of successful outcomes (for profit averaging)
}

// =============================================================================
// ExecutionProbabilityTracker Implementation
// =============================================================================

/**
 * Tracks execution outcomes and provides probability calculations
 * for arbitrage trading decisions.
 *
 * Key features:
 * - O(1) probability lookups via Map-based storage
 * - Automatic pruning of old data to bound memory usage
 * - Hourly breakdown for time-of-day analysis
 * - Thread-safe design (single-threaded Node.js)
 */
export class ExecutionProbabilityTracker {
  private config: ExecutionProbabilityConfig;
  private outcomesByKey: Map<string, OutcomesByKey> = new Map();

  // P0-FIX 10.1: Key cache for hot path optimization
  // Avoids repeated string template allocation in buildKey()
  private keyCache: Map<string, string> = new Map();
  private static readonly KEY_CACHE_MAX_SIZE = 1000;

  // P0-FIX 10.3: Pre-computed aggregates for O(1) chain/dex lookups
  // Instead of O(k) iteration in getAverageProfit/getAverageGasCost
  private chainAggregates: Map<string, { totalGasCost: bigint; count: number }> = new Map();
  private chainDexAggregates: Map<string, { totalProfit: bigint; successCount: number }> = new Map();

  private cleanupTimer: NodeJS.Timeout | null = null;
  private logger: Logger;

  // Global statistics
  private totalOutcomes = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private firstOutcomeTimestamp: number | null = null;
  private lastOutcomeTimestamp: number | null = null;

  constructor(config: Partial<ExecutionProbabilityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger('execution-probability-tracker');

    // Start cleanup timer
    this.startCleanupTimer();

    this.logger.info('ExecutionProbabilityTracker initialized', {
      minSamples: this.config.minSamples,
      maxOutcomesPerKey: this.config.maxOutcomesPerKey,
      relevanceWindowMs: this.config.outcomeRelevanceWindowMs,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API: Record Outcome
  // ---------------------------------------------------------------------------

  /**
   * Records an execution outcome for probability tracking.
   *
   * @param outcome - The execution outcome to record
   */
  recordOutcome(outcome: ExecutionOutcome): void {
    const key = this.buildKey(outcome.chain, outcome.dex, outcome.pathLength);

    // Get or create entry for this key
    let entry = this.outcomesByKey.get(key);
    if (!entry) {
      entry = {
        outcomes: [],
        wins: 0,
        losses: 0,
        totalProfit: 0n,
        totalGasCost: 0n,
        successfulCount: 0,
      };
      this.outcomesByKey.set(key, entry);
    }

    // Add outcome
    entry.outcomes.push(outcome);

    // Update statistics
    if (outcome.success) {
      entry.wins++;
      this.totalSuccesses++;
      if (outcome.profit !== undefined) {
        entry.totalProfit += outcome.profit;
        entry.successfulCount++;

        // P0-FIX 10.3: Update chain:dex aggregate for O(1) profit lookups
        const chainDexKey = this.buildChainDexPrefix(outcome.chain, outcome.dex);
        const chainDexAgg = this.chainDexAggregates.get(chainDexKey) || { totalProfit: 0n, successCount: 0 };
        chainDexAgg.totalProfit += outcome.profit;
        chainDexAgg.successCount++;
        this.chainDexAggregates.set(chainDexKey, chainDexAgg);
      }
    } else {
      entry.losses++;
      this.totalFailures++;
    }

    entry.totalGasCost += outcome.gasCost;
    this.totalOutcomes++;

    // P0-FIX 10.3: Update chain aggregate for O(1) gas cost lookups
    const chainKey = this.buildChainPrefix(outcome.chain);
    const chainAgg = this.chainAggregates.get(chainKey) || { totalGasCost: 0n, count: 0 };
    chainAgg.totalGasCost += outcome.gasCost;
    chainAgg.count++;
    this.chainAggregates.set(chainKey, chainAgg);

    // Update timestamps
    if (this.firstOutcomeTimestamp === null || outcome.timestamp < this.firstOutcomeTimestamp) {
      this.firstOutcomeTimestamp = outcome.timestamp;
    }
    if (this.lastOutcomeTimestamp === null || outcome.timestamp > this.lastOutcomeTimestamp) {
      this.lastOutcomeTimestamp = outcome.timestamp;
    }

    // Prune if necessary
    if (entry.outcomes.length > this.config.maxOutcomesPerKey) {
      this.pruneOutcomes(entry);
    }

    this.logger.debug('Outcome recorded', {
      chain: outcome.chain,
      dex: outcome.dex,
      pathLength: outcome.pathLength,
      success: outcome.success,
      totalSamples: entry.outcomes.length,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API: Query Probability
  // ---------------------------------------------------------------------------

  /**
   * Gets the win probability for a specific (chain, dex, pathLength) combination.
   *
   * Returns the default probability if insufficient samples are available.
   *
   * @param params - Query parameters
   * @returns Probability result with metadata
   */
  getWinProbability(params: ProbabilityQueryParams): ProbabilityResult {
    const key = this.buildKey(params.chain, params.dex, params.pathLength);
    const entry = this.outcomesByKey.get(key);

    if (!entry || entry.outcomes.length === 0) {
      return {
        winProbability: this.config.defaultWinProbability,
        sampleCount: 0,
        isDefault: true,
        wins: 0,
        losses: 0,
      };
    }

    const sampleCount = entry.outcomes.length;

    if (sampleCount < this.config.minSamples) {
      return {
        winProbability: this.config.defaultWinProbability,
        sampleCount,
        isDefault: true,
        wins: entry.wins,
        losses: entry.losses,
      };
    }

    const winProbability = entry.wins / sampleCount;

    return {
      winProbability,
      sampleCount,
      isDefault: false,
      wins: entry.wins,
      losses: entry.losses,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API: Query Average Profit (P0-FIX 10.3: O(1) using pre-computed aggregates)
  // ---------------------------------------------------------------------------

  /**
   * Gets the average profit for successful trades on a chain/DEX combination.
   *
   * P0-FIX 10.3: Now uses pre-computed aggregates for O(1) performance instead
   * of O(k) iteration where k = unique path lengths.
   *
   * @param params - Query parameters
   * @returns Average profit result
   */
  getAverageProfit(params: ProfitQueryParams): ProfitResult {
    // P0-FIX 10.3: Use pre-computed aggregate for O(1) lookup
    const chainDexKey = this.buildChainDexPrefix(params.chain, params.dex);
    const aggregate = this.chainDexAggregates.get(chainDexKey);

    if (!aggregate || aggregate.successCount === 0) {
      return {
        averageProfit: 0n,
        sampleCount: 0,
        totalProfit: 0n,
      };
    }

    return {
      averageProfit: aggregate.totalProfit / BigInt(aggregate.successCount),
      sampleCount: aggregate.successCount,
      totalProfit: aggregate.totalProfit,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API: Query Average Gas Cost (P0-FIX 10.3: O(1) using pre-computed aggregates)
  // ---------------------------------------------------------------------------

  /**
   * Gets the average gas cost for all transactions on a chain.
   *
   * Includes both successful and failed transactions.
   * P0-FIX 10.3: Now uses pre-computed aggregates for O(1) performance instead
   * of O(k) iteration where k = unique (dex, pathLength) combos.
   *
   * @param params - Query parameters
   * @returns Average gas cost result
   */
  getAverageGasCost(params: GasCostQueryParams): GasCostResult {
    // P0-FIX 10.3: Use pre-computed aggregate for O(1) lookup
    const chainKey = this.buildChainPrefix(params.chain);
    const aggregate = this.chainAggregates.get(chainKey);

    if (!aggregate || aggregate.count === 0) {
      return {
        averageGasCost: 0n,
        sampleCount: 0,
        totalGasCost: 0n,
      };
    }

    return {
      averageGasCost: aggregate.totalGasCost / BigInt(aggregate.count),
      sampleCount: aggregate.count,
      totalGasCost: aggregate.totalGasCost,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API: Hourly Stats
  // ---------------------------------------------------------------------------

  /**
   * Gets hourly win rate breakdown for time-of-day analysis.
   *
   * @param params - Query parameters
   * @returns Array of hourly statistics
   */
  getHourlyStats(params: ProbabilityQueryParams): HourlyStats[] {
    const key = this.buildKey(params.chain, params.dex, params.pathLength);
    const entry = this.outcomesByKey.get(key);

    if (!entry || entry.outcomes.length === 0) {
      return [];
    }

    // Group by hour
    const hourlyMap = new Map<number, { wins: number; total: number }>();

    for (const outcome of entry.outcomes) {
      const hour = outcome.hourOfDay;
      let hourData = hourlyMap.get(hour);

      if (!hourData) {
        hourData = { wins: 0, total: 0 };
        hourlyMap.set(hour, hourData);
      }

      hourData.total++;
      if (outcome.success) {
        hourData.wins++;
      }
    }

    // Convert to array
    const stats: HourlyStats[] = [];

    for (const [hour, data] of hourlyMap) {
      stats.push({
        hour,
        winRate: data.total > 0 ? data.wins / data.total : 0,
        sampleCount: data.total,
      });
    }

    return stats.sort((a, b) => a.hour - b.hour);
  }

  // ---------------------------------------------------------------------------
  // Public API: Statistics
  // ---------------------------------------------------------------------------

  /**
   * Gets aggregated statistics from the tracker.
   *
   * @returns Tracker statistics
   */
  getStats(): ExecutionTrackerStats {
    return {
      totalOutcomes: this.totalOutcomes,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      overallWinRate: this.totalOutcomes > 0 ? this.totalSuccesses / this.totalOutcomes : 0,
      uniqueKeys: this.outcomesByKey.size,
      firstOutcomeTimestamp: this.firstOutcomeTimestamp,
      lastOutcomeTimestamp: this.lastOutcomeTimestamp,
      estimatedMemoryBytes: this.estimateMemoryUsage(),
    };
  }

  // ---------------------------------------------------------------------------
  // Public API: Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Clears all tracked data without destroying the tracker.
   */
  clear(): void {
    this.outcomesByKey.clear();
    this.totalOutcomes = 0;
    this.totalSuccesses = 0;
    this.totalFailures = 0;
    this.firstOutcomeTimestamp = null;
    this.lastOutcomeTimestamp = null;

    // P0-FIX 10.1, 10.3: Clear caches and aggregates
    this.keyCache.clear();
    this.chainAggregates.clear();
    this.chainDexAggregates.clear();

    this.logger.info('ExecutionProbabilityTracker cleared');
  }

  /**
   * Destroys the tracker and releases resources.
   */
  destroy(): void {
    this.stopCleanupTimer();
    this.clear();

    this.logger.info('ExecutionProbabilityTracker destroyed');
  }

  // ---------------------------------------------------------------------------
  // Private: Key Building (P0-FIX 10.1: Hot path optimization)
  // ---------------------------------------------------------------------------

  /**
   * Builds a cache key for (chain, dex, pathLength) combination.
   * P0-FIX 10.1: Uses key caching to avoid repeated string allocations in hot path.
   */
  private buildKey(chain: string, dex: string, pathLength: number): string {
    // Use array join with delimiter that's unlikely to appear in chain/dex names
    const cacheKey = `${chain}|${dex}|${pathLength}`;
    let key = this.keyCache.get(cacheKey);

    if (!key) {
      key = `${chain}:${dex}:${pathLength}`;

      // Prevent unbounded cache growth
      if (this.keyCache.size >= ExecutionProbabilityTracker.KEY_CACHE_MAX_SIZE) {
        // Simple LRU: clear oldest half when full
        const keysToDelete = Array.from(this.keyCache.keys()).slice(0, this.keyCache.size / 2);
        for (const k of keysToDelete) {
          this.keyCache.delete(k);
        }
      }

      this.keyCache.set(cacheKey, key);
    }

    return key;
  }

  /**
   * Builds chain:dex: prefix for aggregate lookups.
   */
  private buildChainDexPrefix(chain: string, dex: string): string {
    return `${chain}:${dex}:`;
  }

  /**
   * Builds chain: prefix for aggregate lookups.
   */
  private buildChainPrefix(chain: string): string {
    return `${chain}:`;
  }

  // ---------------------------------------------------------------------------
  // Private: Pruning and Cleanup
  // ---------------------------------------------------------------------------

  private pruneOutcomes(entry: OutcomesByKey): void {
    // Remove oldest 10% of outcomes
    const pruneCount = Math.floor(entry.outcomes.length * 0.1);
    const removed = entry.outcomes.splice(0, pruneCount);

    // Recalculate statistics (both entry-level AND global)
    for (const outcome of removed) {
      // Update global counters
      this.totalOutcomes--;

      if (outcome.success) {
        entry.wins--;
        this.totalSuccesses--;
        if (outcome.profit !== undefined) {
          entry.totalProfit -= outcome.profit;
          entry.successfulCount--;
        }
      } else {
        entry.losses--;
        this.totalFailures--;
      }
      entry.totalGasCost -= outcome.gasCost;
    }

    // Update timestamps if needed (first outcome may have been pruned)
    if (entry.outcomes.length > 0 && removed.length > 0) {
      // Recalculate first timestamp from remaining outcomes
      this.recalculateTimestampBounds();
    }
  }

  /**
   * Recalculates first/last timestamp bounds from all outcomes.
   * Called after pruning to ensure timestamp accuracy.
   */
  private recalculateTimestampBounds(): void {
    this.firstOutcomeTimestamp = null;
    this.lastOutcomeTimestamp = null;

    for (const entry of this.outcomesByKey.values()) {
      for (const outcome of entry.outcomes) {
        if (this.firstOutcomeTimestamp === null || outcome.timestamp < this.firstOutcomeTimestamp) {
          this.firstOutcomeTimestamp = outcome.timestamp;
        }
        if (this.lastOutcomeTimestamp === null || outcome.timestamp > this.lastOutcomeTimestamp) {
          this.lastOutcomeTimestamp = outcome.timestamp;
        }
      }
    }
  }

  /**
   * Removes outcomes older than the relevance window.
   * Called periodically by the cleanup timer.
   *
   * P0-FIX 10.2: Uses in-place array mutation instead of filter() to reduce
   * memory allocation in the cleanup hot path.
   */
  private cleanupStaleOutcomes(): void {
    const cutoffTime = Date.now() - this.config.outcomeRelevanceWindowMs;
    let totalRemoved = 0;

    // Cleanup outcomesByKey
    for (const [key, entry] of this.outcomesByKey) {
      const initialLength = entry.outcomes.length;

      // P0-FIX 10.2: In-place array mutation instead of filter()
      // This avoids allocating a new array on each cleanup cycle
      let writeIndex = 0;
      for (let i = 0; i < entry.outcomes.length; i++) {
        if (entry.outcomes[i].timestamp >= cutoffTime) {
          entry.outcomes[writeIndex++] = entry.outcomes[i];
        }
      }
      entry.outcomes.length = writeIndex;

      const removed = initialLength - entry.outcomes.length;
      if (removed > 0) {
        totalRemoved += removed;

        // Recalculate statistics for this entry
        this.recalculateEntryStats(entry);
      }

      // Remove empty entries
      if (entry.outcomes.length === 0) {
        this.outcomesByKey.delete(key);
      }
    }

    // Recalculate global stats and aggregates
    this.recalculateGlobalStats();
    this.rebuildAggregates();

    if (totalRemoved > 0) {
      this.logger.debug('Stale outcomes cleaned up', { removed: totalRemoved });
    }
  }

  /**
   * Rebuilds the pre-computed aggregates from outcomesByKey.
   * Called after cleanup to maintain consistency.
   */
  private rebuildAggregates(): void {
    this.chainAggregates.clear();
    this.chainDexAggregates.clear();

    for (const [key, entry] of this.outcomesByKey) {
      // Parse chain and dex from key (format: chain:dex:pathLength)
      const parts = key.split(':');
      if (parts.length < 3) continue;

      const chain = parts[0];
      const dex = parts[1];

      // Update chain aggregate
      const chainKey = this.buildChainPrefix(chain);
      const chainAgg = this.chainAggregates.get(chainKey) || { totalGasCost: 0n, count: 0 };
      chainAgg.totalGasCost += entry.totalGasCost;
      chainAgg.count += entry.outcomes.length;
      this.chainAggregates.set(chainKey, chainAgg);

      // Update chain:dex aggregate
      const chainDexKey = this.buildChainDexPrefix(chain, dex);
      const chainDexAgg = this.chainDexAggregates.get(chainDexKey) || { totalProfit: 0n, successCount: 0 };
      chainDexAgg.totalProfit += entry.totalProfit;
      chainDexAgg.successCount += entry.successfulCount;
      this.chainDexAggregates.set(chainDexKey, chainDexAgg);
    }
  }

  private recalculateEntryStats(entry: OutcomesByKey): void {
    entry.wins = 0;
    entry.losses = 0;
    entry.totalProfit = 0n;
    entry.totalGasCost = 0n;
    entry.successfulCount = 0;

    for (const outcome of entry.outcomes) {
      if (outcome.success) {
        entry.wins++;
        if (outcome.profit !== undefined) {
          entry.totalProfit += outcome.profit;
          entry.successfulCount++;
        }
      } else {
        entry.losses++;
      }
      entry.totalGasCost += outcome.gasCost;
    }
  }

  private recalculateGlobalStats(): void {
    this.totalOutcomes = 0;
    this.totalSuccesses = 0;
    this.totalFailures = 0;
    this.firstOutcomeTimestamp = null;
    this.lastOutcomeTimestamp = null;

    for (const entry of this.outcomesByKey.values()) {
      for (const outcome of entry.outcomes) {
        this.totalOutcomes++;

        if (outcome.success) {
          this.totalSuccesses++;
        } else {
          this.totalFailures++;
        }

        if (this.firstOutcomeTimestamp === null || outcome.timestamp < this.firstOutcomeTimestamp) {
          this.firstOutcomeTimestamp = outcome.timestamp;
        }
        if (this.lastOutcomeTimestamp === null || outcome.timestamp > this.lastOutcomeTimestamp) {
          this.lastOutcomeTimestamp = outcome.timestamp;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Timer Management
  // ---------------------------------------------------------------------------

  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleOutcomes();
    }, this.config.cleanupIntervalMs);

    // Prevent timer from blocking Node.js shutdown
    this.cleanupTimer.unref();
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Memory Estimation
  // ---------------------------------------------------------------------------

  private estimateMemoryUsage(): number {
    // Rough estimation: ~200 bytes per outcome
    const BYTES_PER_OUTCOME = 200;
    return this.totalOutcomes * BYTES_PER_OUTCOME;
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let trackerInstance: ExecutionProbabilityTracker | null = null;
let initializingTracker = false;

/**
 * Gets the singleton ExecutionProbabilityTracker instance.
 *
 * Creates a new instance on first call. Subsequent calls return the same instance.
 * Note: config is only used on first call. Passing different values on subsequent
 * calls will be ignored (singleton pattern).
 *
 * @param config - Optional configuration (only used on first call)
 * @returns The singleton tracker instance
 * @throws Error if called during initialization (race condition prevention)
 */
export function getExecutionProbabilityTracker(
  config?: Partial<ExecutionProbabilityConfig>
): ExecutionProbabilityTracker {
  // P0-FIX 5.1: Prevent race condition during initialization
  if (initializingTracker) {
    throw new Error('ExecutionProbabilityTracker is being initialized. Avoid concurrent initialization.');
  }

  if (!trackerInstance) {
    initializingTracker = true;
    try {
      trackerInstance = new ExecutionProbabilityTracker(config);
    } finally {
      initializingTracker = false;
    }
  }
  return trackerInstance;
}

/**
 * Resets the singleton instance.
 *
 * Destroys the existing instance if present. A new instance will be created
 * on the next call to getExecutionProbabilityTracker().
 *
 * P0-FIX 5.2: Set instance to null BEFORE destroy to prevent race condition
 * where getExecutionProbabilityTracker() could return the destroyed instance.
 */
export function resetExecutionProbabilityTracker(): void {
  if (trackerInstance) {
    // P0-FIX 5.2: Capture reference and null out first to prevent race
    const instanceToDestroy = trackerInstance;
    trackerInstance = null;
    instanceToDestroy.destroy();
  }
}
