// Hierarchical Cache System (L1/L2/L3)
// L1: SharedArrayBuffer for ultra-fast cross-worker access
// L2: Redis for distributed caching
// L3: Persistent storage for long-term data

import { getRedisClient } from './redis';
import { createLogger } from './logger';

// P2-2-FIX: Import config with fallback for test environment
let SYSTEM_CONSTANTS: typeof import('../../config/src').SYSTEM_CONSTANTS | undefined;
try {
  SYSTEM_CONSTANTS = require('../../config/src').SYSTEM_CONSTANTS;
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

export interface CacheConfig {
  l1Enabled: boolean;
  l1Size: number; // Size in MB for SharedArrayBuffer
  l2Enabled: boolean;
  l2Ttl: number; // TTL in seconds
  l3Enabled: boolean;
  enablePromotion: boolean; // Auto-promote frequently accessed data
  enableDemotion: boolean; // Auto-demote rarely accessed data
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
  private redisPromise: Promise<import('./redis').RedisClient> | null = null;

  // L1 Cache: SharedArrayBuffer for ultra-fast access
  private l1Metadata: Map<string, CacheEntry> = new Map();
  private l1MaxEntries: number;
  private l1EvictionQueue: string[] = []; // LRU eviction

  // L2 Cache: Redis
  private l2Prefix = 'cache:l2:';

  // L3 Cache: Persistent storage simulation (would be DB in production)
  private l3Storage: Map<string, CacheEntry> = new Map();
  private l3Prefix = 'cache:l3:';

  // Cache statistics
  private stats = {
    l1: { hits: 0, misses: 0, evictions: 0, size: 0 },
    l2: { hits: 0, misses: 0, evictions: 0, size: 0 },
    l3: { hits: 0, misses: 0, evictions: 0, size: 0 },
    promotions: 0,
    demotions: 0
  };

  constructor(config: Partial<CacheConfig> = {}) {
    // P2-2-FIX: Use configured constants instead of magic numbers
    this.config = {
      l1Enabled: config.l1Enabled !== false,
      l1Size: config.l1Size || CACHE_DEFAULTS.defaultL1SizeMb,
      l2Enabled: config.l2Enabled !== false,
      l2Ttl: config.l2Ttl || CACHE_DEFAULTS.defaultL2TtlSeconds,
      l3Enabled: config.l3Enabled !== false,
      enablePromotion: config.enablePromotion !== false,
      enableDemotion: config.enableDemotion !== false
    };

    // P2-2-FIX: Use configured average entry size for capacity calculation
    this.l1MaxEntries = Math.floor(
      this.config.l1Size * 1024 * 1024 / CACHE_DEFAULTS.averageEntrySize
    );

    // P0-FIX-3: Store the Promise from getRedisClient() for lazy initialization
    if (this.config.l2Enabled) {
      this.redisPromise = getRedisClient();
    }

    logger.info('Hierarchical cache initialized', {
      l1Enabled: this.config.l1Enabled,
      l2Enabled: this.config.l2Enabled,
      l3Enabled: this.config.l3Enabled,
      l1Size: this.config.l1Size
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
    if (this.config.l1Enabled) {
      this.l1Metadata.clear();
      this.l1EvictionQueue = [];
    }
    if (this.config.l2Enabled) {
      await this.invalidateL2Pattern('*');
    }
    if (this.config.l3Enabled) {
      this.l3Storage.clear();
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
        entries: this.l3Storage.size
      }
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

    // Move to end of LRU queue (most recently used)
    const index = this.l1EvictionQueue.indexOf(key);
    if (index > -1) {
      this.l1EvictionQueue.splice(index, 1);
    }
    this.l1EvictionQueue.push(key);

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

    // Add to LRU queue
    const index = this.l1EvictionQueue.indexOf(key);
    if (index > -1) {
      this.l1EvictionQueue.splice(index, 1);
    }
    this.l1EvictionQueue.push(key);
  }

  private invalidateL1(key: string): void {
    this.l1Metadata.delete(key);
    const index = this.l1EvictionQueue.indexOf(key);
    if (index > -1) {
      this.l1EvictionQueue.splice(index, 1);
    }
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
    if (this.l1EvictionQueue.length === 0) return;

    const key = this.l1EvictionQueue.shift();
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
  private async getFromL2(key: string): Promise<any> {
    if (!this.redisPromise) return null;
    try {
      const redis = await this.redisPromise;
      const data = await redis.get(`${this.l2Prefix}${key}`);
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
      // P0-FIX-3: Use RedisClient.set() which handles serialization and TTL internally
      await redis.set(redisKey, value, ttl || this.config.l2Ttl);
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
      const searchPattern = `${this.l2Prefix}*${pattern}*`;

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
    const entry = this.l3Storage.get(`${this.l3Prefix}${key}`);
    if (!entry) return null;

    // Check TTL
    if (entry.ttl && Date.now() - entry.timestamp > entry.ttl * 1000) {
      this.invalidateL3(key);
      return null;
    }

    entry.accessCount++;
    entry.lastAccess = Date.now();

    return entry.value;
  }

  private setInL3(key: string, entry: CacheEntry): void {
    this.l3Storage.set(`${this.l3Prefix}${key}`, entry);
  }

  private invalidateL3(key: string): void {
    this.l3Storage.delete(`${this.l3Prefix}${key}`);
  }

  /**
   * P1-FIX-1: Use proper glob pattern matching instead of includes().
   */
  private invalidateL3Pattern(pattern: string): void {
    for (const key of this.l3Storage.keys()) {
      if (this.matchPattern(key, pattern)) {
        this.l3Storage.delete(key);
      }
    }
  }

  /**
   * P1-FIX-1: Glob-like pattern matching for cache key invalidation.
   * Supports:
   * - '*' matches any sequence of characters
   * - '?' matches any single character
   * - Other characters match literally
   */
  private matchPattern(key: string, pattern: string): boolean {
    // Special case: '*' matches everything
    if (pattern === '*') return true;

    // Convert glob pattern to regex
    // Escape regex special chars except * and ?
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${escaped}$`);
    return regex.test(key);
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
    if (this.config.l3Enabled) {
      for (const [key, entry] of this.l3Storage.entries()) {
        if (entry.ttl && now - entry.timestamp > entry.ttl * 1000) {
          this.l3Storage.delete(key);
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

// Default instance
let defaultCache: HierarchicalCache | null = null;

export function getHierarchicalCache(): HierarchicalCache {
  if (!defaultCache) {
    defaultCache = new HierarchicalCache({
      l1Enabled: true,
      l1Size: 128, // 128MB L1 cache
      l2Enabled: true,
      l2Ttl: 600, // 10 minutes
      l3Enabled: true,
      enablePromotion: true,
      enableDemotion: true
    });
  }
  return defaultCache;
}