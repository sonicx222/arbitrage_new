// Hierarchical Cache System (L1/L2/L3)
// L1: SharedArrayBuffer for ultra-fast cross-worker access
// L2: Redis for distributed caching
// L3: Persistent storage for long-term data
// Task 2.2.2: Predictive cache warming using CorrelationAnalyzer

import { getRedisClient } from '../redis/client';
import { createLogger } from '../logger';
import { getCorrelationAnalyzer } from './correlation-analyzer';
import type { CorrelationAnalyzer } from './correlation-analyzer';
import { PriceMatrix } from './price-matrix';
import type { PriceMatrixConfig } from './price-matrix';
import { LRUQueue } from './lru-queue';

// =============================================================================
// P2-FIX 3.1: Use pure static defaults instead of fragile require() pattern
// The old pattern used require() with try/catch which:
// - Mixed CommonJS and ES modules
// - Silently failed, causing inconsistent behavior
// - Made testing difficult
//
// New pattern: Static defaults that can be overridden via constructor config.
// This is more explicit, testable, and follows the dependency injection pattern.
// =============================================================================

// =============================================================================
// P1-PHASE1: Deployment Platform Detection for Resource-Constrained Hosts
// P3-FIX: Cache detection results at module load to avoid redundant env checks
// =============================================================================

/**
 * Cached result: Running on Fly.io (most constrained at 256MB).
 * Evaluated once at module load.
 */
const IS_FLY_IO = process.env.FLY_APP_NAME !== undefined;

/**
 * Cached result: Running on any memory-constrained free-tier platform.
 * Includes Fly.io, Railway, Render, or explicit CONSTRAINED_MEMORY flag.
 *
 * Phase 1 Fix: Fly.io memory optimization (Week 1)
 * @see docs/reports/ENHANCEMENT_OPTIMIZATION_RESEARCH.md Section 6.2
 */
const IS_CONSTRAINED_HOST = IS_FLY_IO ||
  process.env.RAILWAY_ENVIRONMENT !== undefined ||
  process.env.RENDER_SERVICE_NAME !== undefined ||
  process.env.CONSTRAINED_MEMORY === 'true';

// Legacy function wrappers for backward compatibility with constructor logging
const isConstrainedHost = (): boolean => IS_CONSTRAINED_HOST;
const isFlyIo = (): boolean => IS_FLY_IO;

// FIX #13: Allow env var override for local dev (reduces SharedArrayBuffer memory pressure)
// With 4 partitions + cross-chain, each allocating ~64MB, total can exceed ~670MB before Node heap.
const _envL1 = parseInt(process.env.CACHE_L1_SIZE_MB ?? '', 10);
const ENV_L1_SIZE_MB = Number.isInteger(_envL1) && _envL1 > 0 ? _envL1 : null;

/**
 * Cache default configuration values.
 * These can be overridden via the CacheConfig parameter in constructor.
 *
 * P2-FIX 3.1: Consolidated from fragile require() pattern to static defaults.
 * P1-PHASE1: Added adaptive defaults for constrained hosts.
 */
const CACHE_DEFAULTS = {
  /** Average size of cache entries in bytes for capacity calculation */
  averageEntrySize: 1024,
  /**
   * Default L1 cache size in MB.
   * P1-PHASE1: Reduced from 64MB to 16MB on Fly.io for ~48MB savings.
   * 16MB is sufficient for ~16,000 pairs with 1KB average entry size.
   * P3-FIX: Uses cached constants instead of function calls.
   * FIX #13: CACHE_L1_SIZE_MB env var takes precedence over platform detection.
   */
  defaultL1SizeMb: ENV_L1_SIZE_MB ?? (IS_FLY_IO ? 16 : IS_CONSTRAINED_HOST ? 32 : 64),
  /** Default L2 (Redis) TTL in seconds */
  defaultL2TtlSeconds: 300,
  /** Time in ms after which unused entries can be demoted */
  demotionThresholdMs: 5 * 60 * 1000, // 5 minutes
  /** Minimum access count before entry is eligible for demotion */
  minAccessCountBeforeDemotion: 3,
  /** Batch size for Redis SCAN operations */
  scanBatchSize: 100,
  /**
   * P1-PHASE1: Pattern cache max size.
   * Reduced from 100 to 25 on constrained hosts for ~24KB savings.
   */
  patternCacheMaxSize: IS_CONSTRAINED_HOST ? 25 : 100,
  /**
   * P1-PHASE1: L3 (persistent storage) enabled state.
   * Disabled on Fly.io for ~3MB savings as L2 (Redis) provides sufficient caching.
   */
  l3EnabledDefault: !IS_FLY_IO,
} as const;

const logger = createLogger('hierarchical-cache');

// Fix #29: LRUQueue extracted to ./lru-queue.ts for reuse.
// Re-exported here for backward compatibility with existing imports.
export { LRUQueue } from './lru-queue';

/**
 * Task 2.2.2: Predictive warming configuration
 * Controls how correlated pairs are pre-warmed when a price update occurs.
 */
export interface PredictiveWarmingConfig {
  /** Enable predictive warming (default: false) */
  enabled: boolean;
  /** Maximum number of correlated pairs to warm per update (default: 3) */
  maxPairsToWarm?: number;
  /** Optional callback invoked when pairs are warmed (useful for testing/monitoring) */
  onWarm?: (pairAddresses: string[]) => void;
}

export interface CacheConfig {
  l1Enabled: boolean;
  l1Size: number; // Size in MB for SharedArrayBuffer
  l2Enabled: boolean;
  l2Ttl: number; // TTL in seconds
  l3Enabled: boolean;
  /** T2.10: Maximum entries for L3 cache (0 = unlimited for backwards compatibility) */
  l3MaxSize: number;
  enablePromotion: boolean; // Auto-promote frequently accessed data
  enableDemotion: boolean; // Auto-demote rarely accessed data
  /** Task 2.2.2: Predictive cache warming configuration */
  predictiveWarming?: PredictiveWarmingConfig;
  /**
   * P2-FIX 10.2: Enable timing metrics collection.
   * When false (default), skips performance.now() calls in hot paths.
   * Set to true for debugging/profiling, false for production.
   */
  enableTimingMetrics?: boolean;
  /**
   * PHASE1-TASK30: Use PriceMatrix for L1 cache.
   * When true, L1 uses PriceMatrix (SharedArrayBuffer) for sub-microsecond access.
   * When false, L1 uses Map (legacy behavior).
   * Default: true
   */
  usePriceMatrix?: boolean;
}

/** Cache statistics for a single cache tier */
export interface CacheTierStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
  entries?: number;
  utilization?: number;
  hitRate?: number;
  priceMatrix?: unknown;
  implementation?: string;
  maxSize?: number;
  [key: string]: unknown;
}

/** Complete cache statistics across all tiers */
export interface HierarchicalCacheStats {
  l1: CacheTierStats;
  l2: CacheTierStats;
  l3?: CacheTierStats;
  promotions: number;
  demotions: number;
  predictiveWarming?: {
    enabled: boolean;
    maxPairsToWarm: number;
    warmingTriggeredCount: number;
    pairsWarmedCount: number;
    warmingHitCount: number;
    deduplicatedCount: number;
    totalWarmingLatencyMs: number;
    warmingLatencyCount: number;
    lastWarmingLatencyMs: number;
    noCorrelationsCount: number;
    avgWarmingLatencyMs: number;
    warmingHitRate: number;
    correlationStats: unknown;
    [key: string]: unknown;
  };
}

export interface CacheEntry {
  key: string;
  value: unknown;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
  size: number; // Size in bytes
  ttl?: number;
}

export class HierarchicalCache {
  private config: CacheConfig;
  /**
   * P0-FIX-3: Redis client is stored as a Promise (lazy initialization pattern).
   * getRedisClient() returns a Promise<RedisClient>, which we store and await
   * in all L2 operations. This allows the cache to be constructed synchronously
   * while deferring Redis connection until first use.
   *
   * Type is RedisClient | Promise<RedisClient> | null to be explicit about this pattern.
   */
  private redisPromise: Promise<import('../redis').RedisClient> | null = null;

  // ===========================================================================
  // L1 Cache: Dual Map + PriceMatrix Architecture (Fix #23 documentation)
  //
  // DESIGN RATIONALE: Both structures serve complementary purposes and are
  // intentionally maintained in parallel:
  //
  // - l1Metadata (Map<string, CacheEntry>): Stores full cache metadata including
  //   the actual value, TTL, access count, last access time, and size. This is
  //   the SOURCE OF TRUTH for cache reads (see getFromL1: `metadata?.value ?? null`).
  //   Required because PriceMatrix only stores numeric prices, not arbitrary
  //   values or metadata.
  //
  // - priceMatrix (PriceMatrix): Stores numeric prices in SharedArrayBuffer for
  //   sub-microsecond cross-worker thread access via Atomics. Used for the L1
  //   fast-path when `usePriceMatrix=true`. Worker threads can read prices
  //   directly without IPC overhead.
  //
  // The dual write (both Map and PriceMatrix) in setInL1() ensures:
  // 1. Workers get zero-copy price access via SharedArrayBuffer
  // 2. Main thread gets full metadata (TTL, access stats, non-price values)
  // 3. LRU eviction and size tracking operate on the Map
  //
  // DO NOT remove either structure — they serve different access patterns.
  // @see ADR-005: Hierarchical Cache Strategy
  // ===========================================================================

  /**
   * L1 metadata map: stores full CacheEntry including value, TTL, access stats.
   * Source of truth for cache reads. Used alongside PriceMatrix.
   */
  private l1Metadata: Map<string, CacheEntry> = new Map();
  private l1MaxEntries: number;
  // T1.4: O(1) LRU queue (replaces O(n) array-based implementation)
  private l1EvictionQueue: LRUQueue = new LRUQueue();
  // Fix #11: Incremental L1 size tracking (replaces O(n) iteration in getCurrentL1Size)
  private l1CurrentSize: number = 0;

  /**
   * L1 PriceMatrix: stores numeric prices in SharedArrayBuffer for zero-copy
   * cross-worker access. Complements l1Metadata for the fast-path.
   */
  private priceMatrix: PriceMatrix | null = null;
  private usePriceMatrix: boolean = false;

  // L2 Cache: Redis
  private l2Prefix = 'cache:l2:';

  // L3 Cache: Persistent storage simulation (would be DB in production)
  private l3Storage: Map<string, CacheEntry> = new Map();
  private l3Prefix = 'cache:l3:';
  // T2.10: L3 LRU eviction queue and max size
  private l3EvictionQueue: LRUQueue = new LRUQueue();
  private l3MaxSize: number = 0; // 0 = unlimited

  // Cache statistics
  private stats = {
    l1: { hits: 0, misses: 0, evictions: 0, size: 0 },
    l2: { hits: 0, misses: 0, evictions: 0, size: 0 },
    l3: { hits: 0, misses: 0, evictions: 0, size: 0 },
    promotions: 0,
    demotions: 0
  };

  // Task 2.2.2: Predictive warming state
  private predictiveWarmingConfig: PredictiveWarmingConfig | null = null;
  private correlationAnalyzer: CorrelationAnalyzer | null = null;
  private isClearing: boolean = false;
  private predictiveWarmingStats = {
    warmingTriggeredCount: 0,        // Times warming found correlated pairs to warm
    pairsWarmedCount: 0,             // Pairs successfully promoted from L2/L3 to L1
    warmingHitCount: 0,              // Pairs already in L1 when warming requested (cache was "warm")
    deduplicatedCount: 0,            // PERF-3: Warming requests skipped due to pending operation
    // Task 2.2.3: Measure Impact metrics
    totalWarmingLatencyMs: 0,        // Sum of all warming latencies
    warmingLatencyCount: 0,          // Count for calculating average
    lastWarmingLatencyMs: 0,         // Most recent warming latency
    noCorrelationsCount: 0           // FIX: Triggers with no correlated pairs (early exit)
  };
  // PERF-3: Track pairs with pending warming requests to avoid duplicate callbacks
  // When rapid updates occur for the same pair, only the first warming runs
  private pendingWarmingPairs: Set<string> = new Set();

  // P1-PERF: Cache compiled RegExp patterns to avoid repeated compilation
  // Pattern matching is called frequently during invalidation operations
  // Pre-compiled patterns provide significant performance improvement
  private patternCache: Map<string, RegExp> = new Map();
  // P1-PHASE1: Use adaptive pattern cache size based on deployment platform
  private readonly PATTERN_CACHE_MAX_SIZE = CACHE_DEFAULTS.patternCacheMaxSize;

  // P2-FIX 10.2: Track whether to collect timing metrics
  private enableTimingMetrics: boolean;

  constructor(config: Partial<CacheConfig> = {}) {
    // P2-2-FIX: Use configured constants instead of magic numbers
    // P1-PHASE1: L3 disabled by default on Fly.io for memory savings
    const l3Default = config.l3Enabled ?? CACHE_DEFAULTS.l3EnabledDefault;

    this.config = {
      l1Enabled: config.l1Enabled !== false,
      l1Size: config.l1Size ?? CACHE_DEFAULTS.defaultL1SizeMb,
      l2Enabled: config.l2Enabled !== false,
      l2Ttl: config.l2Ttl ?? CACHE_DEFAULTS.defaultL2TtlSeconds,
      l3Enabled: l3Default,
      // T2.10: L3 max size defaults to 10000 (0 = unlimited for backwards compat)
      l3MaxSize: config.l3MaxSize ?? 10000,
      enablePromotion: config.enablePromotion !== false,
      enableDemotion: config.enableDemotion !== false,
      // P2-FIX 10.2: Default to false to avoid performance overhead in production
      enableTimingMetrics: config.enableTimingMetrics ?? false,
      // PHASE1-TASK30: Default to true to enable PriceMatrix
      usePriceMatrix: config.usePriceMatrix ?? true
    };

    // PHASE1-TASK30: Store usePriceMatrix flag for fast access
    this.usePriceMatrix = this.config.usePriceMatrix ?? true;

    // P2-FIX 10.2: Cache the timing flag for fast access in hot paths
    this.enableTimingMetrics = this.config.enableTimingMetrics ?? false;

    // P2-2-FIX: Use configured average entry size for capacity calculation
    this.l1MaxEntries = Math.floor(
      this.config.l1Size * 1024 * 1024 / CACHE_DEFAULTS.averageEntrySize
    );

    // T2.10: Initialize L3 max size
    this.l3MaxSize = this.config.l3MaxSize;

    // PHASE1-TASK30: Initialize PriceMatrix if enabled
    if (this.usePriceMatrix && this.config.l1Enabled) {
      const priceMatrixConfig: Partial<PriceMatrixConfig> = {
        // Calculate max pairs based on L1 size (16 bytes per entry in PriceMatrix with sequence counter)
        maxPairs: Math.floor(this.config.l1Size * 1024 * 1024 / 16),
        // Reserve 10% for dynamic pairs
        reserveSlots: Math.floor(this.config.l1Size * 1024 * 1024 / 16 * 0.1),
        strictMode: false,
        enableAtomics: true
      };
      this.priceMatrix = new PriceMatrix(priceMatrixConfig);
      logger.debug('PriceMatrix initialized for L1 cache', {
        maxPairs: priceMatrixConfig.maxPairs,
        reserveSlots: priceMatrixConfig.reserveSlots
      });
    }

    // P0-FIX-3: Store the Promise from getRedisClient() for lazy initialization
    if (this.config.l2Enabled) {
      this.redisPromise = getRedisClient();
    }

    // Task 2.2.2: Initialize predictive warming if enabled
    if (config.predictiveWarming?.enabled) {
      this.predictiveWarmingConfig = {
        enabled: true,
        maxPairsToWarm: config.predictiveWarming.maxPairsToWarm ?? 3,
        onWarm: config.predictiveWarming.onWarm
      };
      this.correlationAnalyzer = getCorrelationAnalyzer();

      // FIX DOC-1: Populate correlation cache on startup so warming works immediately
      // Per implementation_plan_v2.md: "Consider calling updateCorrelations() on startup"
      // Without this, getPairsToWarm() returns empty for 1 hour (default interval)
      this.correlationAnalyzer.updateCorrelations();
    }

    // P1-PHASE1: Log memory optimization status for constrained hosts
    const isConstrained = isConstrainedHost();
    logger.info('Hierarchical cache initialized', {
      l1Enabled: this.config.l1Enabled,
      l2Enabled: this.config.l2Enabled,
      l3Enabled: this.config.l3Enabled,
      l1Size: this.config.l1Size,
      predictiveWarmingEnabled: !!this.predictiveWarmingConfig,
      // PHASE1-TASK30: Log PriceMatrix usage
      usePriceMatrix: this.usePriceMatrix,
      l1Implementation: this.usePriceMatrix ? 'PriceMatrix' : 'Map',
      // P1-PHASE1: Memory optimization indicators
      ...(isConstrained && {
        memoryOptimized: true,
        platform: isFlyIo() ? 'fly.io' : 'constrained',
        patternCacheSize: CACHE_DEFAULTS.patternCacheMaxSize
      })
    });
  }

  /**
   * Get a value from the hierarchical cache.
   * Checks L1 → L2 → L3 in order, promoting found values up the hierarchy.
   *
   * P2-FIX 10.2: Timing metrics are now optional via enableTimingMetrics config.
   * In production mode (enableTimingMetrics: false), performance.now() calls
   * are skipped to avoid the ~200ns overhead per cache access.
   */
  async get(key: string): Promise<unknown> {
    // P2-FIX 10.2: Only measure time if timing metrics are enabled
    const startTime = this.enableTimingMetrics ? performance.now() : 0;

    try {
      // Validate input
      if (!key || typeof key !== 'string') {
        logger.warn('Invalid cache key provided', { key });
        return null;
      }

      // Try L1 first (ultra-fast)
      if (this.config.l1Enabled) {
        try {
          const l1Result = this.getFromL1(key);
          if (l1Result !== null) {
            this.stats.l1.hits++;
            if (this.enableTimingMetrics) {
              this.recordAccessTime('l1_get', performance.now() - startTime);
            }
            return l1Result;
          }
          this.stats.l1.misses++;
        } catch (error) {
          logger.error('L1 cache error', { error, key });
          this.stats.l1.misses++;
        }
      }

      // Try L2 (Redis)
      if (this.config.l2Enabled) {
        try {
          const l2Result = await this.getFromL2(key);
          if (l2Result !== null) {
            this.stats.l2.hits++;
            // Promote to L1 if enabled
            if (this.config.enablePromotion) {
              try {
                this.setInL1(key, l2Result);
              } catch (promoError) {
                logger.warn('Failed to promote to L1', { error: promoError, key });
              }
            }
            if (this.enableTimingMetrics) {
              this.recordAccessTime('l2_get', performance.now() - startTime);
            }
            return l2Result;
          }
          this.stats.l2.misses++;
        } catch (error) {
          logger.error('L2 cache error', { error, key });
          this.stats.l2.misses++;
        }
      }

      // Try L3 (persistent)
      if (this.config.l3Enabled) {
        try {
          const l3Result = this.getFromL3(key);
          if (l3Result !== null) {
            this.stats.l3.hits++;
            // Promote through hierarchy if enabled
            if (this.config.enablePromotion) {
              if (this.config.l2Enabled) {
                try {
                  await this.setInL2(key, l3Result);
                } catch (l2Error) {
                  logger.warn('Failed to promote to L2', { error: l2Error, key });
                }
              }
              if (this.config.l1Enabled) {
                try {
                  this.setInL1(key, l3Result);
                } catch (l1Error) {
                  logger.warn('Failed to promote to L1', { error: l1Error, key });
                }
              }
            }
            if (this.enableTimingMetrics) {
              this.recordAccessTime('l3_get', performance.now() - startTime);
            }
            return l3Result;
          }
          this.stats.l3.misses++;
        } catch (error) {
          logger.error('L3 cache error', { error, key });
          this.stats.l3.misses++;
        }
      }

      if (this.enableTimingMetrics) {
        this.recordAccessTime('cache_miss', performance.now() - startTime);
      }
      return null;

    } catch (error) {
      logger.error('Unexpected error in hierarchical cache get', { error, key });
      if (this.enableTimingMetrics) {
        this.recordAccessTime('cache_error', performance.now() - startTime);
      }
      return null;
    }
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    // P2-FIX 10.2: Only measure time if timing metrics are enabled
    const startTime = this.enableTimingMetrics ? performance.now() : 0;

    const entry: CacheEntry = {
      key,
      value,
      timestamp: Date.now(),
      accessCount: 0,
      lastAccess: Date.now(),
      size: this.estimateSize(value),
      ttl
    };

    // Set in L1 (fastest)
    if (this.config.l1Enabled) {
      this.setInL1(key, value, ttl);
    }

    // Set in L2
    if (this.config.l2Enabled) {
      await this.setInL2(key, value, ttl);
    }

    // Set in L3 (persistent)
    if (this.config.l3Enabled) {
      this.setInL3(key, entry);
    }

    // Task 2.2.2: Trigger predictive warming for pair keys
    // Uses setImmediate for non-blocking operation
    if (this.predictiveWarmingConfig?.enabled && !this.isClearing) {
      const pairAddress = this.extractPairAddress(key);
      if (pairAddress) {
        setImmediate(() => this.triggerPredictiveWarming(pairAddress));
      }
    }

    if (this.enableTimingMetrics) {
      this.recordAccessTime('cache_set', performance.now() - startTime);
    }
  }

  async invalidate(key: string): Promise<void> {
    // Invalidate across all levels
    if (this.config.l1Enabled) {
      this.invalidateL1(key);
    }
    if (this.config.l2Enabled) {
      await this.invalidateL2(key);
    }
    if (this.config.l3Enabled) {
      this.invalidateL3(key);
    }
  }

  async delete(key: string): Promise<void> {
    return this.invalidate(key);
  }

  /**
   * PHASE1-TASK33: Clear all cache levels.
   */
  async clear(): Promise<void> {
    // Task 2.2.2: Prevent predictive warming during clear
    this.isClearing = true;
    try {
      if (this.config.l1Enabled) {
        this.l1Metadata.clear();
        // T1.4: Use LRUQueue.clear() instead of reassigning to empty array
        this.l1EvictionQueue.clear();
        // Fix #11: Reset incremental size tracking
        this.l1CurrentSize = 0;
        // PHASE1-TASK33: Clear PriceMatrix if enabled
        if (this.usePriceMatrix && this.priceMatrix) {
          this.priceMatrix.clear();
        }
      }
      if (this.config.l2Enabled) {
        await this.invalidateL2Pattern('*');
      }
      if (this.config.l3Enabled) {
        this.l3Storage.clear();
        // T2.10: Clear L3 eviction queue
        this.l3EvictionQueue.clear();
      }
    } finally {
      this.isClearing = false;
    }
  }

  async invalidatePattern(pattern: string): Promise<void> {
    // Invalidate pattern across all levels
    if (this.config.l1Enabled) {
      this.invalidateL1Pattern(pattern);
    }
    if (this.config.l2Enabled) {
      await this.invalidateL2Pattern(pattern);
    }
    if (this.config.l3Enabled) {
      this.invalidateL3Pattern(pattern);
    }
  }

  /**
   * Get L1 cache size configuration in MB
   *
   * Exposes the configured L1 cache size for external components that need to
   * calculate capacity or understand cache dimensions.
   *
   * @returns L1 cache size in megabytes
   *
   * P1-3 fix: Added public getter to avoid type casting in cache warmer
   */
  getL1SizeMb(): number {
    return this.config.l1Size;
  }

  /**
   * PHASE1-TASK33: Get cache statistics.
   * Includes PriceMatrix stats when enabled.
   */
  getStats(): HierarchicalCacheStats {
    // Calculate hit rates for each tier
    const l1Total = this.stats.l1.hits + this.stats.l1.misses;
    const l1HitRate = l1Total > 0 ? this.stats.l1.hits / l1Total : 0;

    const l2Total = this.stats.l2.hits + this.stats.l2.misses;
    const l2HitRate = l2Total > 0 ? this.stats.l2.hits / l2Total : 0;

    const l3Total = this.stats.l3.hits + this.stats.l3.misses;
    const l3HitRate = l3Total > 0 ? this.stats.l3.hits / l3Total : 0;

    return ({
      ...this.stats,
      l1: {
        ...this.stats.l1,
        hitRate: l1HitRate,
        entries: this.l1Metadata.size,
        utilization: this.l1Metadata.size / this.l1MaxEntries,
        // PHASE1-TASK33: Include PriceMatrix stats if enabled
        ...(this.usePriceMatrix && this.priceMatrix && {
          priceMatrix: this.priceMatrix.getStats(),
          implementation: 'PriceMatrix'
        }),
        ...(!this.usePriceMatrix && {
          implementation: 'Map'
        })
      },
      l2: {
        ...this.stats.l2,
        hitRate: l2HitRate,
        // Would need Redis INFO command for accurate stats
      },
      l3: {
        ...this.stats.l3,
        hitRate: l3HitRate,
        entries: this.l3Storage.size,
        // T2.10: Include L3 max size and utilization
        maxSize: this.l3MaxSize,
        utilization: this.l3MaxSize > 0
          ? this.l3Storage.size / this.l3MaxSize
          : 0 // 0 utilization for unlimited cache
      },
      // Task 2.2.2: Predictive warming stats
      predictiveWarming: this.predictiveWarmingConfig ? {
        enabled: this.predictiveWarmingConfig.enabled,
        maxPairsToWarm: this.predictiveWarmingConfig.maxPairsToWarm,
        ...this.predictiveWarmingStats,
        // Task 2.2.3: Computed metrics for measurement
        avgWarmingLatencyMs: this.predictiveWarmingStats.warmingLatencyCount > 0
          ? this.predictiveWarmingStats.totalWarmingLatencyMs / this.predictiveWarmingStats.warmingLatencyCount
          : 0,
        // warmingHitRate: Ratio of correlated pairs already in L1 vs warming attempts
        // High rate = cache is pre-warmed effectively (or pairs accessed directly)
        // Low rate = warming is actively promoting pairs from L2/L3
        warmingHitRate: this.predictiveWarmingStats.warmingTriggeredCount > 0
          ? this.predictiveWarmingStats.warmingHitCount / this.predictiveWarmingStats.warmingTriggeredCount
          : 0,
        // Include correlation analyzer stats for monitoring memory usage
        correlationStats: this.correlationAnalyzer?.getStats() ?? null
      } : undefined
    }) as HierarchicalCacheStats;
  }

  /**
   * PHASE3-TASK41: Get SharedArrayBuffer for worker thread access.
   * Returns null if PriceMatrix is disabled or not using shared memory.
   *
   * @returns The SharedArrayBuffer containing price data, or null
   */
  getSharedBuffer(): SharedArrayBuffer | null {
    if (!this.usePriceMatrix || !this.priceMatrix) {
      return null;
    }
    return this.priceMatrix.getSharedBuffer();
  }

  /**
   * PHASE3-TASK43: Get SharedArrayBuffer for key registry (key-to-index mapping).
   * Returns null if PriceMatrix is disabled or key registry not initialized.
   *
   * @returns The SharedArrayBuffer containing key registry data, or null
   */
  getKeyRegistryBuffer(): SharedArrayBuffer | null {
    if (!this.usePriceMatrix || !this.priceMatrix) {
      return null;
    }
    return this.priceMatrix.getKeyRegistryBuffer();
  }

  /**
   * PHASE1-TASK31: Get value from L1 cache.
   * Supports both Map-based and PriceMatrix-based implementations.
   */
  private getFromL1(key: string): unknown {
    // PHASE1-TASK31: Use PriceMatrix if enabled
    if (this.usePriceMatrix && this.priceMatrix) {
      const priceEntry = this.priceMatrix.getPrice(key);
      if (!priceEntry) return null;

      // Check TTL (PriceMatrix doesn't store TTL, so check against entry metadata)
      const metadata = this.l1Metadata.get(key);
      if (metadata?.ttl && Date.now() - priceEntry.timestamp > metadata.ttl * 1000) {
        this.invalidateL1(key);
        return null;
      }

      // Update access statistics in metadata
      if (metadata) {
        metadata.accessCount++;
        metadata.lastAccess = Date.now();
        this.l1EvictionQueue.touch(key);
      }

      // Return the value from PriceMatrix
      // Note: PriceMatrix stores price directly, but we need the full value
      // For now, we'll need to keep metadata in Map for non-price data
      return metadata?.value ?? null;
    }

    // Legacy Map-based implementation
    const entry = this.l1Metadata.get(key);
    if (!entry) return null;

    // Check TTL
    if (entry.ttl && Date.now() - entry.timestamp > entry.ttl * 1000) {
      this.invalidateL1(key);
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccess = Date.now();

    // T1.4: Move to end of LRU queue using O(1) touch operation
    // Previous: O(n) indexOf + O(n) splice + O(1) push
    // New: O(1) touch
    this.l1EvictionQueue.touch(key);

    return entry.value;
  }

  /**
   * PHASE1-TASK32: Set value in L1 cache.
   * Supports both Map-based and PriceMatrix-based implementations.
   */
  private setInL1(key: string, value: unknown, ttl?: number): void {
    const size = this.estimateSize(value);
    const timestamp = Date.now();

    // PHASE1-TASK32: Use PriceMatrix if enabled
    if (this.usePriceMatrix && this.priceMatrix) {
      // Evict if necessary (check metadata size since PriceMatrix handles its own capacity)
      while (this.l1Metadata.size >= this.l1MaxEntries ||
        this.getCurrentL1Size() + size > this.config.l1Size * 1024 * 1024) {
        this.evictL1();
      }

      // Extract price if value is a price object
      let price = 0;
      if (typeof value === 'object' && value !== null) {
        // Check common price fields
        const obj = value as Record<string, unknown>;
        price = (obj.price as number) ?? (obj.value as number) ?? (obj.amount as number) ?? 0;
      } else if (typeof value === 'number') {
        price = value;
      }

      // Store in PriceMatrix (fast path for price data)
      const success = this.priceMatrix.setPrice(key, price, timestamp);
      if (!success) {
        logger.warn('PriceMatrix setPrice failed, falling back to Map', { key });
      }

      // Store metadata in Map for TTL, access tracking, and full value
      const entry: CacheEntry = {
        key,
        value,
        timestamp,
        accessCount: 1,
        lastAccess: timestamp,
        size,
        ttl
      };

      // Fix #11: Adjust incremental size tracking (handle update vs new entry)
      const existingEntry = this.l1Metadata.get(key);
      if (existingEntry) {
        this.l1CurrentSize += size - existingEntry.size;
      } else {
        this.l1CurrentSize += size;
      }

      this.l1Metadata.set(key, entry);
      this.l1EvictionQueue.add(key);
      return;
    }

    // Legacy Map-based implementation
    // Evict if necessary
    while (this.l1Metadata.size >= this.l1MaxEntries ||
      this.getCurrentL1Size() + size > this.config.l1Size * 1024 * 1024) {
      this.evictL1();
    }

    const entry: CacheEntry = {
      key,
      value,
      timestamp,
      accessCount: 1,
      lastAccess: timestamp,
      size,
      ttl
    };

    // Fix #11: Adjust incremental size tracking (handle update vs new entry)
    const existingEntry = this.l1Metadata.get(key);
    if (existingEntry) {
      this.l1CurrentSize += size - existingEntry.size;
    } else {
      this.l1CurrentSize += size;
    }

    this.l1Metadata.set(key, entry);

    // T1.4: Add to LRU queue using O(1) add operation
    // Previous: O(n) indexOf + O(n) splice + O(1) push
    // New: O(1) add (handles both new keys and existing keys)
    this.l1EvictionQueue.add(key);
  }

  /**
   * PHASE1-TASK33: Invalidate entry in L1 cache.
   * Clears both Map metadata and PriceMatrix data.
   */
  private invalidateL1(key: string): void {
    // Fix #11: Read size BEFORE delete for incremental tracking
    const entry = this.l1Metadata.get(key);
    if (entry) {
      this.l1CurrentSize -= entry.size;
    }
    this.l1Metadata.delete(key);
    // T1.4: O(1) remove instead of O(n) indexOf + O(n) splice
    this.l1EvictionQueue.remove(key);

    // PHASE1-TASK33: Clear from PriceMatrix if enabled
    // Note: PriceMatrix doesn't have a delete method, but we don't need to
    // explicitly clear it since we use l1Metadata.has() to check validity
  }

  /**
   * P1-FIX-1: Use proper glob pattern matching instead of includes().
   * Pattern '*' now correctly matches all keys, not just keys containing '*'.
   */
  private invalidateL1Pattern(pattern: string): void {
    for (const key of this.l1Metadata.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.invalidateL1(key);
      }
    }
  }

  private evictL1(): void {
    // T1.4: O(1) eviction using evictOldest()
    // Previous: O(1) shift but required array reindexing
    // New: O(1) doubly-linked list removal
    const key = this.l1EvictionQueue.evictOldest();
    if (key) {
      // Fix #11: Read size BEFORE delete for incremental tracking
      const entry = this.l1Metadata.get(key);
      if (entry) {
        this.l1CurrentSize -= entry.size;
      }
      this.l1Metadata.delete(key);
      this.stats.l1.evictions++;
    }
  }

  /**
   * Fix #11: O(1) L1 size query using incremental tracking.
   * Previously iterated ALL entries O(n) on every call.
   */
  private getCurrentL1Size(): number {
    return this.l1CurrentSize;
  }

  // L2 Cache Implementation (Redis)
  // P0-FIX-3: All L2 methods now use explicit redisPromise with null check
  // P0-FIX (Double Serialization): Use redis.getRaw()/setex() to avoid double JSON serialization.
  // RedisClient.get()/set() already do JSON.parse/stringify internally, so we use raw methods
  // and handle serialization explicitly here for clarity and correctness.
  private async getFromL2(key: string): Promise<unknown> {
    if (!this.redisPromise) return null;
    try {
      const redis = await this.redisPromise;
      // P0-FIX: Use getRaw() to get the raw string, then parse ourselves.
      // This avoids double-parsing since redis.get() already does JSON.parse().
      const data = await redis.getRaw(`${this.l2Prefix}${key}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('L2 cache get error', { error, key });
      return null;
    }
  }

  private async setInL2(key: string, value: unknown, ttl?: number): Promise<void> {
    if (!this.redisPromise) return;
    try {
      const redis = await this.redisPromise;
      const redisKey = `${this.l2Prefix}${key}`;
      // P0-FIX: Use setex() with explicit serialization to match getRaw() usage.
      // This avoids the double-serialization bug where redis.set() would stringify
      // and then getFromL2() would try to parse the already-parsed object.
      const serialized = JSON.stringify(value);
      const ttlSeconds = ttl ?? this.config.l2Ttl;
      await redis.setex(redisKey, ttlSeconds, serialized);
    } catch (error) {
      logger.error('L2 cache set error', { error, key });
    }
  }

  private async invalidateL2(key: string): Promise<void> {
    if (!this.redisPromise) return;
    try {
      const redis = await this.redisPromise;
      await redis.del(`${this.l2Prefix}${key}`);
    } catch (error) {
      logger.error('L2 cache invalidate error', { error, key });
    }
  }

  /**
   * P0-FIX: Use SCAN instead of KEYS to prevent blocking Redis server.
   * KEYS command blocks the server for the duration of the scan, which can
   * cause performance issues in production with large keyspaces.
   * SCAN iterates incrementally and doesn't block.
   */
  private async invalidateL2Pattern(pattern: string): Promise<void> {
    if (!this.redisPromise) return;
    try {
      const redis = await this.redisPromise;
      // BUG FIX: Don't wrap pattern with extra wildcards - use pattern as-is with prefix
      // Pattern '*' should become 'cache:l2:*', not 'cache:l2:**'
      const searchPattern = pattern === '*'
        ? `${this.l2Prefix}*`
        : `${this.l2Prefix}${pattern}`;

      // P0-FIX: Use cursor-based SCAN iteration instead of KEYS
      let cursor = '0';
      let deletedCount = 0;
      // P2-2-FIX: Use configured constant instead of magic number
      const batchSize = CACHE_DEFAULTS.scanBatchSize;

      do {
        // SCAN returns [cursor, keys] - cursor is '0' when scan is complete
        const [nextCursor, keys] = await this.scanKeys(redis, cursor, searchPattern, batchSize);
        cursor = nextCursor;

        if (keys.length > 0) {
          await redis.del(...keys);
          deletedCount += keys.length;
        }
      } while (cursor !== '0');

      if (deletedCount > 0) {
        logger.debug('L2 cache pattern invalidation complete', {
          pattern,
          deletedCount
        });
      }
    } catch (error) {
      logger.error('L2 cache pattern invalidate error', { error, pattern });
    }
  }

  /**
   * P0-FIX: Helper method to perform SCAN operation.
   * Uses the underlying Redis client's scan capability.
   */
  private async scanKeys(
    redis: import('../redis').RedisClient,
    cursor: string,
    pattern: string,
    count: number
  ): Promise<[string, string[]]> {
    try {
      return await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    } catch (error) {
      logger.error('SCAN operation failed', { error, cursor, pattern });
      return ['0', []];
    }
  }

  // L3 Cache Implementation (Persistent Storage)
  private getFromL3(key: string): unknown {
    const l3Key = `${this.l3Prefix}${key}`;
    const entry = this.l3Storage.get(l3Key);
    if (!entry) return null;

    // Check TTL
    if (entry.ttl && Date.now() - entry.timestamp > entry.ttl * 1000) {
      this.invalidateL3(key);
      return null;
    }

    entry.accessCount++;
    entry.lastAccess = Date.now();

    // T2.10: Touch LRU queue to mark as recently used
    this.l3EvictionQueue.touch(l3Key);

    return entry.value;
  }

  /**
   * T2.10: Set value in L3 with LRU eviction support.
   * Evicts oldest entries when cache exceeds max size.
   */
  private setInL3(key: string, entry: CacheEntry): void {
    const l3Key = `${this.l3Prefix}${key}`;

    // Check if key already exists (update case)
    const existing = this.l3Storage.has(l3Key);

    // T2.10: Evict if necessary (only if max size > 0 and new entry)
    if (!existing && this.l3MaxSize > 0) {
      while (this.l3Storage.size >= this.l3MaxSize) {
        this.evictL3();
      }
    }

    this.l3Storage.set(l3Key, entry);

    // T2.10: Add to or touch LRU queue
    this.l3EvictionQueue.add(l3Key);
  }

  /**
   * T2.10: Evict the oldest L3 entry.
   */
  private evictL3(): void {
    const key = this.l3EvictionQueue.evictOldest();
    if (key) {
      this.l3Storage.delete(key);
      this.stats.l3.evictions++;
    }
  }

  private invalidateL3(key: string): void {
    const l3Key = `${this.l3Prefix}${key}`;
    this.l3Storage.delete(l3Key);
    // T2.10: Remove from LRU queue
    this.l3EvictionQueue.remove(l3Key);
  }

  /**
   * P1-FIX-1: Use proper glob pattern matching instead of includes().
   * T2.10: Also removes entries from LRU queue.
   */
  private invalidateL3Pattern(pattern: string): void {
    for (const key of this.l3Storage.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.l3Storage.delete(key);
        // T2.10: Remove from LRU queue
        this.l3EvictionQueue.remove(key);
      }
    }
  }

  /**
   * P1-FIX-1: Glob-like pattern matching for cache key invalidation.
   * P1-PERF: Now caches compiled RegExp patterns for performance.
   * Supports:
   * - '*' matches any sequence of characters
   * - '?' matches any single character
   * - Other characters match literally
   */
  private matchPattern(key: string, pattern: string): boolean {
    // Special case: '*' matches everything
    if (pattern === '*') return true;

    // P1-PERF: Check pattern cache first
    let regex = this.patternCache.get(pattern);

    if (!regex) {
      // Convert glob pattern to regex
      // Escape regex special chars except * and ?
      const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');

      regex = new RegExp(`^${escaped}$`);

      // P1-PERF: Cache the compiled pattern with size limit to prevent memory leak
      if (this.patternCache.size >= this.PATTERN_CACHE_MAX_SIZE) {
        // Remove oldest entry (first in iteration order)
        const oldestKey = this.patternCache.keys().next().value;
        if (oldestKey) {
          this.patternCache.delete(oldestKey);
        }
      }
      this.patternCache.set(pattern, regex);
    }

    return regex.test(key);
  }

  // ===========================================================================
  // Task 2.2.2: Predictive Warming Methods
  // ===========================================================================

  /** Cache key prefix for pair data */
  private static readonly PAIR_KEY_PREFIX = 'pair:';

  /**
   * Extract pair address from cache key.
   * Only recognizes keys in the format: pair:<address>
   * Normalizes address to lowercase for consistent correlation tracking.
   *
   * @param key - Cache key to extract from
   * @returns Pair address (lowercase) or null if not a pair key
   */
  private extractPairAddress(key: string): string | null {
    if (!key.startsWith(HierarchicalCache.PAIR_KEY_PREFIX)) {
      return null;
    }
    // FIX INCON-1: Normalize to lowercase for consistency with CorrelationAnalyzer
    return key.substring(HierarchicalCache.PAIR_KEY_PREFIX.length).toLowerCase();
  }

  /**
   * Trigger predictive warming for correlated pairs.
   * This method runs asynchronously via setImmediate to avoid blocking.
   *
   * Performance optimizations:
   * - Skips pairs already in L1 (no redundant warming)
   * - Uses Promise.allSettled for parallel warming (faster than sequential)
   * - Tracks warmingHitCount for pairs already in L1
   *
   * @param pairAddress - The pair that was just updated
   */
  private async triggerPredictiveWarming(pairAddress: string): Promise<void> {
    if (!this.correlationAnalyzer || !this.predictiveWarmingConfig) {
      return;
    }

    // PERF-3: Deduplication - skip if warming already pending for this pair
    // This prevents redundant warming when rapid updates occur for the same pair
    if (this.pendingWarmingPairs.has(pairAddress)) {
      this.predictiveWarmingStats.deduplicatedCount++;
      // Still record the price update for correlation tracking
      this.correlationAnalyzer.recordPriceUpdate(pairAddress);
      return;
    }

    // Mark as pending before any async operations
    this.pendingWarmingPairs.add(pairAddress);

    // Task 2.2.3: Track warming latency
    const warmingStartTime = performance.now();

    try {
      // Record the price update for correlation tracking
      this.correlationAnalyzer.recordPriceUpdate(pairAddress);

      // Get correlated pairs to warm
      const pairsToWarm = this.correlationAnalyzer.getPairsToWarm(pairAddress);

      if (pairsToWarm.length === 0) {
        // FIX: Track when no correlations exist (helps identify cold-start vs effective warming)
        this.predictiveWarmingStats.noCorrelationsCount++;
        return;
      }

      // Limit to configured maximum
      const limitedPairs = pairsToWarm.slice(0, this.predictiveWarmingConfig.maxPairsToWarm);

      // Track that warming was triggered
      this.predictiveWarmingStats.warmingTriggeredCount++;

      // FIX PERF-1 & PERF-2: Warm pairs in parallel, skip if already in L1
      const warmingPromises = limitedPairs.map(async (correlatedPair) => {
        const key = `${HierarchicalCache.PAIR_KEY_PREFIX}${correlatedPair}`;

        // FIX PERF-2: Check if already in L1 (already warmed)
        if (this.config.l1Enabled && this.l1Metadata.has(key)) {
          // Already in L1 - count as a warming hit (predictive warming was valuable)
          this.predictiveWarmingStats.warmingHitCount++;
          return { pair: correlatedPair, warmed: false, hit: true };
        }

        try {
          // Try to get from L2/L3 and promote to L1
          const value = await this.get(key);
          if (value !== null) {
            this.predictiveWarmingStats.pairsWarmedCount++;
            return { pair: correlatedPair, warmed: true, hit: false };
          }
          return { pair: correlatedPair, warmed: false, hit: false };
        } catch (error) {
          logger.error('Failed to warm correlated pair', { correlatedPair, error });
          return { pair: correlatedPair, warmed: false, hit: false, error };
        }
      });

      // FIX PERF-1: Run warming in parallel using Promise.allSettled
      const results = await Promise.allSettled(warmingPromises);

      // Collect successfully warmed pairs for callback
      const warmedPairs: string[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.warmed) {
          warmedPairs.push(result.value.pair);
        }
      }

      // Invoke callback if configured (useful for testing/monitoring)
      if (warmedPairs.length > 0 && this.predictiveWarmingConfig.onWarm) {
        this.predictiveWarmingConfig.onWarm(warmedPairs);
      }

      // Task 2.2.3: Record warming latency
      const warmingLatency = performance.now() - warmingStartTime;
      this.predictiveWarmingStats.totalWarmingLatencyMs += warmingLatency;
      this.predictiveWarmingStats.warmingLatencyCount++;
      this.predictiveWarmingStats.lastWarmingLatencyMs = warmingLatency;

      logger.debug('Predictive warming completed', {
        triggerPair: pairAddress,
        pairsRequested: limitedPairs.length,
        pairsWarmed: warmedPairs.length,
        latencyMs: warmingLatency.toFixed(2)
      });
    } catch (error) {
      logger.warn('Predictive warming failed', { pairAddress, error });
    } finally {
      // PERF-3: Always clear the pending flag when done
      this.pendingWarmingPairs.delete(pairAddress);
    }
  }

  // Utility methods

  /**
   * Estimate the memory size of an object without expensive serialization.
   *
   * P2-FIX 10.1: Replaced JSON.stringify() with fast type-based estimation.
   * JSON.stringify is called O(n) times on every cache write which is expensive.
   * This new approach uses heuristics based on type to estimate size in O(1).
   *
   * Accuracy trade-off: This is ~80% accurate vs JSON.stringify's exact size,
   * but is ~100x faster for typical cache objects.
   *
   * @param obj - Object to estimate size for
   * @returns Estimated size in bytes
   */
  private estimateSize(obj: unknown): number {
    return this.estimateSizeRecursive(obj, 0);
  }

  /**
   * Recursive size estimation with depth limit to prevent stack overflow.
   * @param obj - Object to estimate
   * @param depth - Current recursion depth
   * @returns Estimated size in bytes
   */
  private estimateSizeRecursive(obj: unknown, depth: number): number {
    // Prevent infinite recursion and limit computation
    const MAX_DEPTH = 5;
    if (depth > MAX_DEPTH) {
      return 64; // Default estimate for deeply nested objects
    }

    if (obj === null || obj === undefined) {
      return 8;
    }

    const type = typeof obj;

    switch (type) {
      case 'boolean':
        return 4;
      case 'number':
        return 8;
      case 'bigint':
        return 16;
      case 'string':
        // 2 bytes per char (UTF-16 in JS) + 16 byte overhead
        return (obj as string).length * 2 + 16;
      case 'symbol':
        return 32;
      case 'function':
        return 64; // Functions rarely cached, rough estimate
      case 'object': {
        if (Array.isArray(obj)) {
          // Array: 24 byte header + element sizes
          let size = 24;
          const arr = obj as unknown[];
          // Sample up to 10 elements to estimate average
          const sampleSize = Math.min(arr.length, 10);
          let sampleTotal = 0;
          for (let i = 0; i < sampleSize; i++) {
            sampleTotal += this.estimateSizeRecursive(arr[i], depth + 1);
          }
          if (sampleSize > 0) {
            size += (sampleTotal / sampleSize) * arr.length;
          }
          return size;
        }

        if (obj instanceof Date) {
          return 24;
        }

        if (obj instanceof Map || obj instanceof Set) {
          return 64 + (obj as Map<unknown, unknown>).size * 64;
        }

        // Plain object: 32 byte header + property sizes
        // Uses for...in instead of Object.entries() to avoid allocating a [key, value] tuple array
        // on every call (this runs on every L1 cache write, 500-1000/sec)
        const record = obj as Record<string, unknown>;
        let size = 32;
        let sampleCount = 0;
        let sampleTotal = 0;
        let totalKeys = 0;
        for (const key in record) {
          totalKeys++;
          if (sampleCount < 5) {
            sampleTotal += key.length * 2 + 16; // Key size
            sampleTotal += this.estimateSizeRecursive(record[key], depth + 1); // Value size
            sampleCount++;
          }
        }
        if (sampleCount > 0) {
          size += (sampleTotal / sampleCount) * totalKeys;
        }
        return size;
      }
      default:
        return 64; // Unknown types default estimate
    }
  }

  private recordAccessTime(operation: string, time: number): void {
    // Would integrate with performance monitoring
    logger.debug(`Cache operation: ${operation} took ${time.toFixed(3)}ms`);
  }

  // Cleanup and maintenance
  async cleanup(): Promise<void> {
    // Clean up expired entries
    const now = Date.now();

    // L1 cleanup
    if (this.config.l1Enabled) {
      for (const [key, entry] of this.l1Metadata.entries()) {
        if (entry.ttl && now - entry.timestamp > entry.ttl * 1000) {
          this.invalidateL1(key);
        }
      }
    }

    // L3 cleanup
    // BUG FIX: Also remove expired entries from LRU queue to prevent stale references
    if (this.config.l3Enabled) {
      for (const [key, entry] of this.l3Storage.entries()) {
        if (entry.ttl && now - entry.timestamp > entry.ttl * 1000) {
          this.l3Storage.delete(key);
          this.l3EvictionQueue.remove(key);
        }
      }
    }

    // Auto-demotion based on access patterns
    if (this.config.enableDemotion) {
      await this.performAutoDemotion();
    }
  }

  private async performAutoDemotion(): Promise<void> {
    // Demote rarely accessed L1 entries to L2
    if (!this.config.l1Enabled || !this.config.l2Enabled) return;

    const now = Date.now();
    // P2-2-FIX: Use configured constants instead of magic numbers
    const demotionThreshold = CACHE_DEFAULTS.demotionThresholdMs;
    const minAccessCount = CACHE_DEFAULTS.minAccessCountBeforeDemotion;

    for (const [key, entry] of this.l1Metadata.entries()) {
      if (now - entry.lastAccess > demotionThreshold && entry.accessCount < minAccessCount) {
        // Move to L2 only, keep in L3
        await this.setInL2(key, entry.value, entry.ttl);
        this.invalidateL1(key);
        this.stats.demotions++;
      }
    }
  }
}

// Factory function
export function createHierarchicalCache(config?: Partial<CacheConfig>): HierarchicalCache {
  return new HierarchicalCache(config);
}

// =============================================================================
// Singleton Factory (Issue 6.1: Standardized pattern)
// =============================================================================

let defaultCache: HierarchicalCache | null = null;
let defaultCacheConfig: Partial<CacheConfig> | undefined = undefined;

/**
 * Get the singleton HierarchicalCache instance.
 *
 * Note: The configuration is only used on first initialization. If called with
 * different config after the singleton exists, a warning is logged and the
 * existing instance is returned unchanged. Use resetHierarchicalCache() first
 * if you need to change configuration.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton HierarchicalCache instance
 */
export function getHierarchicalCache(config?: Partial<CacheConfig>): HierarchicalCache {
  if (!defaultCache) {
    // Use CACHE_DEFAULTS.defaultL1SizeMb which respects CACHE_L1_SIZE_MB env var
    // and platform detection (Fly.io=16MB, constrained=32MB, local=64MB).
    // Previously hardcoded 128MB, causing 563MB SharedArrayBuffer per partition.
    const defaultConfig: Partial<CacheConfig> = config ?? {
      l1Enabled: true,
      l1Size: CACHE_DEFAULTS.defaultL1SizeMb,
      l2Enabled: true,
      l2Ttl: 600, // 10 minutes
      l3Enabled: true,
      enablePromotion: true,
      enableDemotion: true
    };
    defaultCache = new HierarchicalCache(defaultConfig);
    defaultCacheConfig = config;
  } else if (config !== undefined && config !== defaultCacheConfig) {
    // Issue 4.3/6.1: Warn if config differs from initial
    logger.warn(
      'getHierarchicalCache called with different config after initialization. ' +
      'Config is ignored. Use resetHierarchicalCache() first if reconfiguration is needed.',
      { providedConfig: config, existingConfig: defaultCacheConfig }
    );
  }
  return defaultCache;
}

/**
 * Reset the singleton HierarchicalCache instance.
 * Use for testing or when reconfiguration is needed.
 *
 * Issue 6.1: Standardized reset pattern across all caching singletons.
 */
export async function resetHierarchicalCache(): Promise<void> {
  if (defaultCache) {
    await defaultCache.clear();
  }
  defaultCache = null;
  defaultCacheConfig = undefined;
}