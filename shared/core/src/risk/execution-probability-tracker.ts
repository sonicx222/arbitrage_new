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
  redisKeyPrefix: 'risk:probability:',
  // TODO: Redis persistence is deferred. When implemented:
  // - On recordOutcome(): persist to Redis hash at {redisKeyPrefix}{chain}:{dex}:{pathLength}
  // - On startup: load historical data from Redis
  // - Format: { wins: number, losses: number, avgProfit: string, avgGas: string }
  // See implementation_plan_v3.md Section 3.4.1 for schema details
  persistToRedis: false, // Disabled until Redis persistence is implemented
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
  // NOTE: Previously had outcomesByChain and outcomesByChainDex maps, but these
  // caused 3x memory duplication. Removed in favor of using pre-computed aggregates
  // from outcomesByKey with prefix matching. See getAverageProfit/getAverageGasCost.
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
      }
    } else {
      entry.losses++;
      this.totalFailures++;
    }

    entry.totalGasCost += outcome.gasCost;
    this.totalOutcomes++;

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
  // Public API: Query Average Profit
  // ---------------------------------------------------------------------------

  /**
   * Gets the average profit for successful trades on a chain/DEX combination.
   *
   * Aggregates across all path lengths within the same chain/DEX.
   * Uses pre-computed aggregates for O(k) performance where k = unique path lengths.
   *
   * @param params - Query parameters
   * @returns Average profit result
   */
  getAverageProfit(params: ProfitQueryParams): ProfitResult {
    // Optimization: Use pre-computed aggregates from outcomesByKey
    // instead of iterating through all outcomes in outcomesByChainDex
    const chainDexPrefix = `${params.chain}:${params.dex}:`;

    let totalProfit = 0n;
    let successCount = 0;

    // Iterate through outcomesByKey entries matching this chain/dex
    // This is O(k) where k = unique path lengths, not O(n) where n = all outcomes
    for (const [key, entry] of this.outcomesByKey) {
      if (key.startsWith(chainDexPrefix)) {
        totalProfit += entry.totalProfit;
        successCount += entry.successfulCount;
      }
    }

    if (successCount === 0) {
      return {
        averageProfit: 0n,
        sampleCount: 0,
        totalProfit: 0n,
      };
    }

    return {
      averageProfit: totalProfit / BigInt(successCount),
      sampleCount: successCount,
      totalProfit,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API: Query Average Gas Cost
  // ---------------------------------------------------------------------------

  /**
   * Gets the average gas cost for all transactions on a chain.
   *
   * Includes both successful and failed transactions.
   * Uses pre-computed aggregates for O(k) performance where k = unique (dex, pathLength) combos.
   *
   * @param params - Query parameters
   * @returns Average gas cost result
   */
  getAverageGasCost(params: GasCostQueryParams): GasCostResult {
    // Optimization: Use pre-computed aggregates from outcomesByKey
    // instead of iterating through all outcomes in outcomesByChain
    const chainPrefix = `${params.chain}:`;

    let totalGasCost = 0n;
    let totalCount = 0;

    // Iterate through outcomesByKey entries matching this chain
    // This is O(k) where k = unique (dex, pathLength) combos, not O(n)
    for (const [key, entry] of this.outcomesByKey) {
      if (key.startsWith(chainPrefix)) {
        totalGasCost += entry.totalGasCost;
        totalCount += entry.outcomes.length;
      }
    }

    if (totalCount === 0) {
      return {
        averageGasCost: 0n,
        sampleCount: 0,
        totalGasCost: 0n,
      };
    }

    return {
      averageGasCost: totalGasCost / BigInt(totalCount),
      sampleCount: totalCount,
      totalGasCost,
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
  // Private: Key Building
  // ---------------------------------------------------------------------------

  private buildKey(chain: string, dex: string, pathLength: number): string {
    return `${chain}:${dex}:${pathLength}`;
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
   */
  private cleanupStaleOutcomes(): void {
    const cutoffTime = Date.now() - this.config.outcomeRelevanceWindowMs;
    let totalRemoved = 0;

    // Cleanup outcomesByKey
    for (const [key, entry] of this.outcomesByKey) {
      const initialLength = entry.outcomes.length;

      entry.outcomes = entry.outcomes.filter(o => o.timestamp >= cutoffTime);

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

    // Recalculate global stats
    this.recalculateGlobalStats();

    if (totalRemoved > 0) {
      this.logger.debug('Stale outcomes cleaned up', { removed: totalRemoved });
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

/**
 * Gets the singleton ExecutionProbabilityTracker instance.
 *
 * Creates a new instance on first call. Subsequent calls return the same instance.
 *
 * @param config - Optional configuration (only used on first call)
 * @returns The singleton tracker instance
 */
export function getExecutionProbabilityTracker(
  config?: Partial<ExecutionProbabilityConfig>
): ExecutionProbabilityTracker {
  if (!trackerInstance) {
    trackerInstance = new ExecutionProbabilityTracker(config);
  }
  return trackerInstance;
}

/**
 * Resets the singleton instance.
 *
 * Destroys the existing instance if present. A new instance will be created
 * on the next call to getExecutionProbabilityTracker().
 */
export function resetExecutionProbabilityTracker(): void {
  if (trackerInstance) {
    trackerInstance.destroy();
    trackerInstance = null;
  }
}
