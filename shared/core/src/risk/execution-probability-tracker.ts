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
import { clearIntervalSafe } from '../lifecycle-utils';
import { hmacSign, hmacVerify, getHmacSigningKey, isSignedEnvelope } from '../hmac-utils';
import type { SignedEnvelope } from '../hmac-utils';
import type { RedisClient } from '../redis';
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

// FIX P2-6: Aligned DEFAULT_CONFIG with RISK_CONFIG.probability values to prevent
// divergent behavior when tracker is instantiated directly vs via config.
const DEFAULT_CONFIG: ExecutionProbabilityConfig = {
  minSamples: 10,
  defaultWinProbability: 0.5,
  maxOutcomesPerKey: 1000,
  cleanupIntervalMs: 3600000, // 1 hour — matches RISK_CONFIG.probability.cleanupIntervalMs
  outcomeRelevanceWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 days

  // Redis persistence configuration
  // Phase 0 Item 6: IMPLEMENTED — aggregates persist to Redis hash
  // Key: {redisKeyPrefix}aggregates (hash: {chain}:{dex}:{pathLength} → aggregate stats)
  // Batch persist every 10 outcomes, load on startup via loadFromRedis()
  redisKeyPrefix: 'risk:probabilities:', // matches RISK_CONFIG.probability.redisKeyPrefix
  persistToRedis: true, // Phase 0 Item 6: Enabled — persists aggregates every 10 outcomes
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
  /**
   * Sample count from Redis-persisted data. Individual outcome events are not
   * persisted, so outcomes[] is empty after loadFromRedis(). This field preserves
   * the original sample count so getWinProbability() and rebuildAggregates()
   * don't treat Redis-loaded entries as empty.
   * @see Fix 1: Probability tracker data model for Redis-loaded data
   */
  persistedSampleCount: number;
}

/**
 * Shape of the aggregate data persisted to Redis.
 * Used for HMAC signing/verification and schema validation.
 */
interface ProbabilityAggregate {
  wins: number;
  losses: number;
  totalProfit: string;   // BigInt serialized as string
  totalGasCost: string;  // BigInt serialized as string
  successfulCount: number;
  sampleCount: number;
  lastUpdate: number;
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

  // Phase 0 Item 6: Redis persistence
  private redis: RedisClient | null = null;
  private persistCounter = 0;
  private static readonly PERSIST_BATCH_SIZE = 10; // Persist every 10 outcomes

  // Global statistics
  private totalOutcomes = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private firstOutcomeTimestamp: number | null = null;
  private lastOutcomeTimestamp: number | null = null;

  constructor(config: Partial<ExecutionProbabilityConfig> = {}, redis?: RedisClient | null) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.redis = redis ?? null;
    this.logger = createLogger('execution-probability-tracker');

    // Start cleanup timer
    this.startCleanupTimer();

    this.logger.info('ExecutionProbabilityTracker initialized', {
      minSamples: this.config.minSamples,
      maxOutcomesPerKey: this.config.maxOutcomesPerKey,
      relevanceWindowMs: this.config.outcomeRelevanceWindowMs,
      persistToRedis: this.config.persistToRedis && this.redis !== null,
    });
  }

  // ---------------------------------------------------------------------------
  // Private: Sample Count Helper
  // ---------------------------------------------------------------------------

  /**
   * Returns the effective sample count for an entry, accounting for both
   * in-memory outcomes and Redis-persisted data (which has no individual events).
   *
   * @see Fix 1: Probability tracker data model for Redis-loaded data
   */
  private getSampleCount(entry: OutcomesByKey): number {
    return Math.max(entry.outcomes.length, entry.persistedSampleCount ?? 0);
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
        persistedSampleCount: 0,
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
      this.pruneOutcomes(entry, outcome.chain, outcome.dex);
    }

    this.logger.debug('Outcome recorded', {
      chain: outcome.chain,
      dex: outcome.dex,
      pathLength: outcome.pathLength,
      success: outcome.success,
      totalSamples: entry.outcomes.length,
    });

    // Phase 0 Item 6: Batch persist to Redis every N outcomes
    if (this.config.persistToRedis && this.redis) {
      this.persistCounter++;
      if (this.persistCounter >= ExecutionProbabilityTracker.PERSIST_BATCH_SIZE) {
        this.persistCounter = 0;
        this.persistToRedis().catch(err => {
          this.logger.warn('Failed to persist probability data to Redis', {
            error: (err as Error).message,
          });
        });
      }
    }
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

    if (!entry || this.getSampleCount(entry) === 0) {
      return {
        winProbability: this.config.defaultWinProbability,
        sampleCount: 0,
        isDefault: true,
        wins: 0,
        losses: 0,
      };
    }

    const sampleCount = this.getSampleCount(entry);

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
   *
   * Fix 9: Made async to await persistToRedis() before clear(),
   * preventing a race where clear() empties the map before persist iterates it.
   * @see docs/reports/DEEP_ENHANCEMENT_ANALYSIS_2026-02-22.md
   */
  async destroy(): Promise<void> {
    // Persist final state before destroying — must await to prevent race with clear()
    if (this.config.persistToRedis && this.redis && this.totalOutcomes > 0) {
      await this.persistToRedis().catch((err) => {
        this.logger.warn('Failed to persist on destroy', { error: (err as Error).message });
      });
    }

    this.stopCleanupTimer();
    this.clear();

    this.logger.info('ExecutionProbabilityTracker destroyed');
  }

  // ---------------------------------------------------------------------------
  // Public API: Redis Persistence (Phase 0 Item 6)
  // ---------------------------------------------------------------------------

  /**
   * Persists aggregate outcome data to Redis.
   *
   * Stores per-key aggregates (wins, losses, totalProfit, totalGasCost, successfulCount)
   * as a Redis hash. Individual outcome events are NOT persisted (too large) — only the
   * aggregated statistics needed to compute probabilities and averages.
   *
   * After restart, loadFromRedis() restores these aggregates so Kelly criterion sizing
   * starts from historical data instead of conservative defaults.
   */
  async persistToRedis(): Promise<void> {
    if (!this.redis) return;

    const hashKey = `${this.config.redisKeyPrefix}aggregates`;
    const signingKey = getHmacSigningKey();

    try {
      for (const [key, entry] of this.outcomesByKey) {
        const aggregate = {
          wins: entry.wins,
          losses: entry.losses,
          totalProfit: entry.totalProfit.toString(), // BigInt → string for JSON
          totalGasCost: entry.totalGasCost.toString(),
          successfulCount: entry.successfulCount,
          sampleCount: this.getSampleCount(entry),
          lastUpdate: Date.now(),
        };

        // Fix #8: HMAC-sign aggregate before writing to Redis
        // If no signing key, hmacSign returns envelope with empty sig (backward compatible)
        // P3-27: Include hash key + field as HMAC context to prevent cross-key replay
        const envelope = hmacSign(aggregate, signingKey, `${hashKey}:${key}`);
        await this.redis.hset(hashKey, key, envelope);
      }

      this.logger.debug('Persisted probability data to Redis', {
        keys: this.outcomesByKey.size,
        signed: signingKey !== null,
      });
    } catch (error) {
      this.logger.warn('Failed to persist probability data', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Loads aggregate outcome data from Redis.
   *
   * Restores per-key aggregates (wins, losses, profit, gas cost) so that
   * probability calculations and Kelly sizing resume from historical data
   * instead of conservative defaults after a restart.
   *
   * Note: Individual outcome events are NOT restored — only aggregates.
   * This means hourly breakdown and per-event pruning won't have historical data,
   * but the critical win probability and average profit/gas calculations will.
   */
  async loadFromRedis(): Promise<number> {
    if (!this.redis) return 0;

    const hashKey = `${this.config.redisKeyPrefix}aggregates`;
    const signingKey = getHmacSigningKey();

    try {
      // Fix #8: hgetall returns parsed JSON objects. Each field value may be either:
      // - A SignedEnvelope<ProbabilityAggregate> (signed data)
      // - A raw ProbabilityAggregate (legacy unsigned data)
      const allFields = await this.redis.hgetall<unknown>(hashKey);

      if (!allFields) {
        this.logger.debug('No persisted probability data found in Redis');
        return 0;
      }

      let loadedKeys = 0;
      let skippedKeys = 0;

      for (const [key, rawValue] of Object.entries(allFields)) {
        // Skip if we already have data for this key (in-memory data takes priority)
        if (this.outcomesByKey.has(key)) continue;

        // Fix #8: HMAC verification — matches bridge-recovery-manager pattern
        let aggregate: ProbabilityAggregate;

        if (isSignedEnvelope(rawValue)) {
          // Signed envelope: verify HMAC
          // P3-27: Include hash key + field as HMAC context to prevent cross-key replay
          let verified = hmacVerify<ProbabilityAggregate>(
            rawValue as SignedEnvelope<ProbabilityAggregate>,
            signingKey,
            `${hashKey}:${key}`,
          );
          if (!verified) {
            // Migration: try without context for pre-P3-27 signed data
            verified = hmacVerify<ProbabilityAggregate>(
              rawValue as SignedEnvelope<ProbabilityAggregate>,
              signingKey,
            );
            if (verified) {
              this.logger.info('Migrating probability aggregate to context-bound HMAC', { key });
            }
          }
          if (!verified) {
            this.logger.warn('Probability aggregate HMAC verification failed, skipping entry', {
              key,
            });
            skippedKeys++;
            continue;
          }
          aggregate = verified;
        } else if (signingKey) {
          // Unsigned data but signing is enabled — skip (potential tampering)
          this.logger.warn('Unsigned probability aggregate found with signing enabled, skipping entry', {
            key,
          });
          skippedKeys++;
          continue;
        } else {
          // No signing key, unsigned data — accept (backward compatible / dev mode)
          aggregate = rawValue as ProbabilityAggregate;
        }

        // Fix #8: Schema validation — reject malformed aggregates
        if (!this.validateAggregate(key, aggregate)) {
          skippedKeys++;
          continue;
        }

        const entry: OutcomesByKey = {
          outcomes: [], // Individual events are not persisted
          wins: aggregate.wins,
          losses: aggregate.losses,
          totalProfit: BigInt(aggregate.totalProfit),
          totalGasCost: BigInt(aggregate.totalGasCost),
          successfulCount: aggregate.successfulCount,
          // Fix 1: Preserve sample count from Redis so getWinProbability() and
          // rebuildAggregates() don't treat restored entries as empty.
          persistedSampleCount: aggregate.sampleCount ?? (aggregate.wins + aggregate.losses),
        };

        this.outcomesByKey.set(key, entry);

        // Update global stats
        const total = entry.wins + entry.losses;
        this.totalOutcomes += total;
        this.totalSuccesses += entry.wins;
        this.totalFailures += entry.losses;

        loadedKeys++;
      }

      // Rebuild aggregates from loaded data
      if (loadedKeys > 0) {
        this.rebuildAggregates();
      }

      this.logger.info('Loaded probability data from Redis', {
        loadedKeys,
        skippedKeys,
        totalOutcomes: this.totalOutcomes,
      });

      return loadedKeys;
    } catch (error) {
      this.logger.warn('Failed to load probability data from Redis', {
        error: (error as Error).message,
      });
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Schema Validation (Fix #8)
  // ---------------------------------------------------------------------------

  /**
   * Validates a probability aggregate loaded from Redis.
   * Rejects entries with invalid/negative counts or unparseable BigInt fields.
   *
   * @param key - The Redis hash field key (for logging)
   * @param aggregate - The aggregate to validate
   * @returns true if valid, false if validation fails
   */
  private validateAggregate(key: string, aggregate: ProbabilityAggregate): boolean {
    // Numeric fields must be non-negative
    if (
      typeof aggregate.wins !== 'number' || aggregate.wins < 0 ||
      typeof aggregate.losses !== 'number' || aggregate.losses < 0 ||
      typeof aggregate.sampleCount !== 'number' || aggregate.sampleCount < 0 ||
      typeof aggregate.successfulCount !== 'number' || aggregate.successfulCount < 0
    ) {
      this.logger.warn('Probability aggregate schema validation failed: invalid counts', {
        key,
        wins: aggregate.wins,
        losses: aggregate.losses,
        sampleCount: aggregate.sampleCount,
        successfulCount: aggregate.successfulCount,
      });
      return false;
    }

    // BigInt fields must be parseable
    try {
      BigInt(aggregate.totalProfit);
    } catch {
      this.logger.warn('Probability aggregate schema validation failed: unparseable totalProfit', {
        key,
        totalProfit: aggregate.totalProfit,
      });
      return false;
    }

    try {
      BigInt(aggregate.totalGasCost);
    } catch {
      this.logger.warn('Probability aggregate schema validation failed: unparseable totalGasCost', {
        key,
        totalGasCost: aggregate.totalGasCost,
      });
      return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Private: Key Building (P0-FIX 10.1: Hot path optimization)
  // ---------------------------------------------------------------------------

  /**
   * Builds a cache key for (chain, dex, pathLength) combination.
   * P0-FIX 10.1: Uses key caching to avoid repeated string allocations in hot path.
   */
  /**
   * FIX P3-16: Uses single delimiter format for both cache key and value.
   * Previously created TWO template literals per call (pipe-delimited for cache,
   * colon-delimited for actual key), negating caching benefit.
   */
  private buildKey(chain: string, dex: string, pathLength: number): string {
    const key = `${chain}:${dex}:${pathLength}`;
    if (this.keyCache.has(key)) {
      return key;
    }

    // Prevent unbounded cache growth
    if (this.keyCache.size >= ExecutionProbabilityTracker.KEY_CACHE_MAX_SIZE) {
      // P3-29: Evict oldest half using iterator + counter instead of
      // Array.from(keys).slice() which allocates a full intermediate array
      const evictCount = this.keyCache.size >> 1;
      let count = 0;
      for (const k of this.keyCache.keys()) {
        if (count >= evictCount) break;
        this.keyCache.delete(k);
        count++;
      }
    }

    this.keyCache.set(key, key);
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

  /**
   * FIX P2-9: Optimized pruneOutcomes with incremental aggregate updates.
   * Previously called rebuildAggregates() (O(K) full rebuild) on every prune.
   * Now decrements aggregates directly from removed values.
   */
  private pruneOutcomes(entry: OutcomesByKey, chain: string, dex: string): void {
    // Remove oldest 10% of outcomes
    const pruneCount = Math.floor(entry.outcomes.length * 0.1);
    const removed = entry.outcomes.splice(0, pruneCount);

    // Track removed values for incremental aggregate update
    let removedGasCost = 0n;
    let removedProfit = 0n;
    let removedSuccessCount = 0;

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
          removedProfit += outcome.profit;
          removedSuccessCount++;
        }
      } else {
        entry.losses--;
        this.totalFailures--;
      }
      entry.totalGasCost -= outcome.gasCost;
      removedGasCost += outcome.gasCost;
    }

    // Update timestamps incrementally: O(K) over unique keys instead of O(N) over all outcomes.
    // Only firstOutcomeTimestamp can change when pruning oldest entries.
    if (removed.length > 0) {
      this.recalculateFirstTimestamp();
    }

    // Incrementally update aggregates instead of full rebuild
    if (removed.length > 0) {
      const chainKey = this.buildChainPrefix(chain);
      const chainAgg = this.chainAggregates.get(chainKey);
      if (chainAgg) {
        chainAgg.totalGasCost -= removedGasCost;
        chainAgg.count -= removed.length;
      }

      if (removedSuccessCount > 0) {
        const chainDexKey = this.buildChainDexPrefix(chain, dex);
        const chainDexAgg = this.chainDexAggregates.get(chainDexKey);
        if (chainDexAgg) {
          chainDexAgg.totalProfit -= removedProfit;
          chainDexAgg.successCount -= removedSuccessCount;
        }
      }
    }
  }

  /**
   * FIX P2-9: Recalculates firstOutcomeTimestamp from first element of each entry.
   * O(K) where K = unique keys, vs previous O(N) over all outcomes.
   * Outcomes are stored chronologically (push to end), so entry.outcomes[0]
   * is always the oldest outcome for that key.
   */
  private recalculateFirstTimestamp(): void {
    this.firstOutcomeTimestamp = null;

    for (const entry of this.outcomesByKey.values()) {
      if (entry.outcomes.length > 0) {
        const entryFirst = entry.outcomes[0].timestamp;
        if (this.firstOutcomeTimestamp === null || entryFirst < this.firstOutcomeTimestamp) {
          this.firstOutcomeTimestamp = entryFirst;
        }
      }
    }
  }

  /**
   * Recalculates first/last timestamp bounds from all outcomes.
   * Called after stale outcome cleanup which removes from arbitrary positions.
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

      // Remove entries with no actual outcomes AND no persisted data
      if (entry.outcomes.length === 0 && (entry.persistedSampleCount ?? 0) === 0) {
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
      chainAgg.count += this.getSampleCount(entry);
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
    // Reset persisted count — entry now reflects only in-memory outcomes
    entry.persistedSampleCount = 0;

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
    this.cleanupTimer = clearIntervalSafe(this.cleanupTimer);
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
 * Note: config and redis are only used on first call. Passing different values on
 * subsequent calls will be ignored (singleton pattern).
 *
 * Phase 0 Item 6: Added optional redis parameter for persistence support.
 * When provided with persistToRedis: true in config, outcomes are batched to Redis
 * every 10 recordings. Call loadFromRedis() after creation to restore historical data.
 *
 * @param config - Optional configuration (only used on first call)
 * @param redis - Optional Redis client for persistence (only used on first call)
 * @returns The singleton tracker instance
 * @throws Error if called during initialization (race condition prevention)
 */
export function getExecutionProbabilityTracker(
  config?: Partial<ExecutionProbabilityConfig>,
  redis?: RedisClient | null,
): ExecutionProbabilityTracker {
  // P0-FIX 5.1: Prevent race condition during initialization
  if (initializingTracker) {
    throw new Error('ExecutionProbabilityTracker is being initialized. Avoid concurrent initialization.');
  }

  if (!trackerInstance) {
    initializingTracker = true;
    try {
      trackerInstance = new ExecutionProbabilityTracker(config, redis);
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
export async function resetExecutionProbabilityTracker(): Promise<void> {
  if (trackerInstance) {
    // P0-FIX 5.2: Capture reference and null out first to prevent race
    const instanceToDestroy = trackerInstance;
    trackerInstance = null;
    // Fix 9: Await destroy() to ensure Redis persist completes before reset returns
    await instanceToDestroy.destroy();
  }
}
