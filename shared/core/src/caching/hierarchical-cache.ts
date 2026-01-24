// Hierarchical Cache System (L1/L2/L3)
// L1: SharedArrayBuffer for ultra-fast cross-worker access
// L2: Redis for distributed caching
// L3: Persistent storage for long-term data
// Task 2.2.2: Predictive cache warming using CorrelationAnalyzer

import { getRedisClient } from '../redis';
import { createLogger } from '../logger';
import { getCorrelationAnalyzer } from './correlation-analyzer';
import type { CorrelationAnalyzer } from './correlation-analyzer';

// P2-2-FIX: Import config with fallback for test environment
let SYSTEM_CONSTANTS: typeof import('../../../config/src').SYSTEM_CONSTANTS | undefined;
try {
  SYSTEM_CONSTANTS = require('../../../config/src').SYSTEM_CONSTANTS;
} catch {
  // Config not available, will use defaults
}

// P2-2-FIX: Default values for when config is not available
const CACHE_DEFAULTS = {
  averageEntrySize: SYSTEM_CONSTANTS?.cache?.averageEntrySize ?? 1024,
  defaultL1SizeMb: SYSTEM_CONSTANTS?.cache?.defaultL1SizeMb ?? 64,
  defaultL2TtlSeconds: SYSTEM_CONSTANTS?.cache?.defaultL2TtlSeconds ?? 300,
  demotionThresholdMs: SYSTEM_CONSTANTS?.cache?.demotionThresholdMs ?? 5 * 60 * 1000,
  minAccessCountBeforeDemotion: SYSTEM_CONSTANTS?.cache?.minAccessCountBeforeDemotion ?? 3,
  scanBatchSize: SYSTEM_CONSTANTS?.redis?.scanBatchSize ?? 100,
};

const logger = createLogger('hierarchical-cache');

// ===========================================================================
// T1.4: O(1) LRU Queue Implementation using Doubly-Linked List
// ===========================================================================

/**
 * T1.4: Node in the doubly-linked list for LRU tracking.
 * Each node holds a key and pointers to prev/next nodes.
 */
interface LRUNode {
  key: string;
  prev: LRUNode | null;
  next: LRUNode | null;
}

/**
 * T1.4: O(1) LRU Queue using doubly-linked list + Map.
 *
 * Operations:
 * - touch(key): Move key to end (most recently used) - O(1)
 * - add(key): Add new key to end - O(1)
 * - evictOldest(): Remove and return oldest key - O(1)
 * - remove(key): Remove specific key - O(1)
 * - has(key): Check if key exists - O(1)
 * - size: Get current size - O(1)
 *
 * Previous array-based implementation:
 * - indexOf: O(n)
 * - splice: O(n)
 *
 * This implementation eliminates the O(n) overhead.
 */
export class LRUQueue {
  /** Map from key to node for O(1) lookup */
  private nodeMap: Map<string, LRUNode> = new Map();
  /** Sentinel head node (oldest) */
  private head: LRUNode;
  /** Sentinel tail node (newest) */
  private tail: LRUNode;

  constructor() {
    // Initialize sentinel nodes (simplifies edge case handling)
    this.head = { key: '__HEAD__', prev: null, next: null };
    this.tail = { key: '__TAIL__', prev: null, next: null };
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Get current queue size.
   */
  get size(): number {
    return this.nodeMap.size;
  }

  /**
   * Check if key exists in queue.
   */
  has(key: string): boolean {
    return this.nodeMap.has(key);
  }

  /**
   * Add new key to end of queue (most recently used).
   * If key already exists, moves it to end.
   */
  add(key: string): void {
    if (this.nodeMap.has(key)) {
      // Key exists, just touch it
      this.touch(key);
      return;
    }

    // Create new node
    const node: LRUNode = { key, prev: null, next: null };

    // Insert before tail (at the end)
    this.insertBeforeTail(node);

    // Add to map
    this.nodeMap.set(key, node);
  }

  /**
   * Move existing key to end of queue (most recently used).
   * O(1) operation.
   */
  touch(key: string): void {
    const node = this.nodeMap.get(key);
    if (!node) return;

    // Remove from current position
    this.removeNode(node);

    // Insert at end
    this.insertBeforeTail(node);
  }

  /**
   * Remove and return the oldest key (from head).
   * Returns null if queue is empty.
   */
  evictOldest(): string | null {
    // Oldest is the node after head sentinel
    const oldest = this.head.next;
    if (!oldest || oldest === this.tail) {
      return null; // Queue is empty
    }

    // Remove from list
    this.removeNode(oldest);

    // Remove from map
    this.nodeMap.delete(oldest.key);

    return oldest.key;
  }

  /**
   * Remove a specific key from queue.
   */
  remove(key: string): boolean {
    const node = this.nodeMap.get(key);
    if (!node) return false;

    this.removeNode(node);
    this.nodeMap.delete(key);
    return true;
  }

  /**
   * Clear all entries.
   */
  clear(): void {
    this.nodeMap.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Get all keys in order (oldest first).
   * Mainly for debugging/testing.
   */
  keys(): string[] {
    const result: string[] = [];
    let current = this.head.next;
    while (current && current !== this.tail) {
      result.push(current.key);
      current = current.next;
    }
    return result;
  }

  // Private helper: Remove node from its current position
  private removeNode(node: LRUNode): void {
    const prev = node.prev;
    const next = node.next;
    if (prev) prev.next = next;
    if (next) next.prev = prev;
    node.prev = null;
    node.next = null;
  }

  // Private helper: Insert node before tail (at the "newest" end)
  private insertBeforeTail(node: LRUNode): void {
    const prev = this.tail.prev;
    node.prev = prev;
    node.next = this.tail;
    if (prev) prev.next = node;
    this.tail.prev = node;
  }
}

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
}

export interface CacheEntry {
  key: string;
  value: any;
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

  // L1 Cache: SharedArrayBuffer for ultra-fast access
  private l1Metadata: Map<string, CacheEntry> = new Map();
  private l1MaxEntries: number;
  // T1.4: Replaced array-based LRU queue with O(1) LRU queue
  // Previous: private l1EvictionQueue: string[] = []; // O(n) indexOf/splice
  // New: O(1) operations for all LRU operations
  private l1EvictionQueue: LRUQueue = new LRUQueue();

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
  private readonly PATTERN_CACHE_MAX_SIZE = 100; // Limit to prevent memory leak

  constructor(config: Partial<CacheConfig> = {}) {
    // P2-2-FIX: Use configured constants instead of magic numbers
    this.config = {
      l1Enabled: config.l1Enabled !== false,
      l1Size: config.l1Size || CACHE_DEFAULTS.defaultL1SizeMb,
      l2Enabled: config.l2Enabled !== false,
      l2Ttl: config.l2Ttl || CACHE_DEFAULTS.defaultL2TtlSeconds,
      l3Enabled: config.l3Enabled !== false,
      // T2.10: L3 max size defaults to 10000 (0 = unlimited for backwards compat)
      l3MaxSize: config.l3MaxSize ?? 10000,
      enablePromotion: config.enablePromotion !== false,
      enableDemotion: config.enableDemotion !== false
    };

    // P2-2-FIX: Use configured average entry size for capacity calculation
    this.l1MaxEntries = Math.floor(
      this.config.l1Size * 1024 * 1024 / CACHE_DEFAULTS.averageEntrySize
    );

    // T2.10: Initialize L3 max size
    this.l3MaxSize = this.config.l3MaxSize;

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

    logger.info('Hierarchical cache initialized', {
      l1Enabled: this.config.l1Enabled,
      l2Enabled: this.config.l2Enabled,
      l3Enabled: this.config.l3Enabled,
      l1Size: this.config.l1Size,
      predictiveWarmingEnabled: !!this.predictiveWarmingConfig
    });
  }

  async get(key: string): Promise<any> {
    const startTime = performance.now();

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
            this.recordAccessTime('l1_get', performance.now() - startTime);
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
            this.recordAccessTime('l2_get', performance.now() - startTime);
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
            this.recordAccessTime('l3_get', performance.now() - startTime);
            return l3Result;
          }
          this.stats.l3.misses++;
        } catch (error) {
          logger.error('L3 cache error', { error, key });
          this.stats.l3.misses++;
        }
      }

      this.recordAccessTime('cache_miss', performance.now() - startTime);
      return null;

    } catch (error) {
      logger.error('Unexpected error in hierarchical cache get', { error, key });
      this.recordAccessTime('cache_error', performance.now() - startTime);
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    const startTime = performance.now();
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

    this.recordAccessTime('cache_set', performance.now() - startTime);
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

  async clear(): Promise<void> {
    // Task 2.2.2: Prevent predictive warming during clear
    this.isClearing = true;
    try {
      if (this.config.l1Enabled) {
        this.l1Metadata.clear();
        // T1.4: Use LRUQueue.clear() instead of reassigning to empty array
        this.l1EvictionQueue.clear();
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

  getStats(): any {
    return {
      ...this.stats,
      l1: {
        ...this.stats.l1,
        entries: this.l1Metadata.size,
        utilization: this.l1Metadata.size / this.l1MaxEntries
      },
      l2: {
        ...this.stats.l2,
        // Would need Redis INFO command for accurate stats
      },
      l3: {
        ...this.stats.l3,
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
    };
  }

  private getFromL1(key: string): any {
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

  private setInL1(key: string, value: any, ttl?: number): void {
    const size = this.estimateSize(value);

    // Evict if necessary
    while (this.l1Metadata.size >= this.l1MaxEntries ||
      this.getCurrentL1Size() + size > this.config.l1Size * 1024 * 1024) {
      this.evictL1();
    }

    const entry: CacheEntry = {
      key,
      value,
      timestamp: Date.now(),
      accessCount: 1,
      lastAccess: Date.now(),
      size,
      ttl
    };

    this.l1Metadata.set(key, entry);

    // T1.4: Add to LRU queue using O(1) add operation
    // Previous: O(n) indexOf + O(n) splice + O(1) push
    // New: O(1) add (handles both new keys and existing keys)
    this.l1EvictionQueue.add(key);
  }

  private invalidateL1(key: string): void {
    this.l1Metadata.delete(key);
    // T1.4: O(1) remove instead of O(n) indexOf + O(n) splice
    this.l1EvictionQueue.remove(key);
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
      this.l1Metadata.delete(key);
      this.stats.l1.evictions++;
    }
  }

  private getCurrentL1Size(): number {
    let total = 0;
    for (const entry of this.l1Metadata.values()) {
      total += entry.size;
    }
    return total;
  }

  // L2 Cache Implementation (Redis)
  // P0-FIX-3: All L2 methods now use explicit redisPromise with null check
  // P0-FIX (Double Serialization): Use redis.getRaw()/setex() to avoid double JSON serialization.
  // RedisClient.get()/set() already do JSON.parse/stringify internally, so we use raw methods
  // and handle serialization explicitly here for clarity and correctness.
  private async getFromL2(key: string): Promise<any> {
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

  private async setInL2(key: string, value: any, ttl?: number): Promise<void> {
    if (!this.redisPromise) return;
    try {
      const redis = await this.redisPromise;
      const redisKey = `${this.l2Prefix}${key}`;
      // P0-FIX: Use setex() with explicit serialization to match getRaw() usage.
      // This avoids the double-serialization bug where redis.set() would stringify
      // and then getFromL2() would try to parse the already-parsed object.
      const serialized = JSON.stringify(value);
      const ttlSeconds = ttl || this.config.l2Ttl;
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
    redis: any,
    cursor: string,
    pattern: string,
    count: number
  ): Promise<[string, string[]]> {
    try {
      // Try to use the native scan method if available
      if (typeof redis.scan === 'function') {
        const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', count);
        return result;
      }

      // Fallback: if scan is not available on the wrapper, try the underlying client
      if (redis.client && typeof redis.client.scan === 'function') {
        const result = await redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
        return result;
      }

      // Last resort fallback: use keys but with warning (should not happen in production)
      logger.warn('SCAN not available, falling back to KEYS command');
      const keys = await redis.keys(pattern);
      return ['0', keys];
    } catch (error) {
      logger.error('SCAN operation failed', { error, cursor, pattern });
      return ['0', []];
    }
  }

  // L3 Cache Implementation (Persistent Storage)
  private getFromL3(key: string): any {
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
  private estimateSize(obj: any): number {
    // Rough size estimation
    const str = JSON.stringify(obj);
    return str ? str.length * 2 : 100; // Rough estimate: 2 bytes per char + overhead
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
    const defaultConfig: Partial<CacheConfig> = config ?? {
      l1Enabled: true,
      l1Size: 128, // 128MB L1 cache
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