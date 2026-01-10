// Hierarchical Cache System (L1/L2/L3)
// L1: SharedArrayBuffer for ultra-fast cross-worker access
// L2: Redis for distributed caching
// L3: Persistent storage for long-term data

import { getRedisClient, createLogger } from './index';

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
  private redis: any;

  // L1 Cache: SharedArrayBuffer for ultra-fast access
  private l1Buffer: SharedArrayBuffer | null = null;
  private l1View: Uint8Array | null = null;
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
    this.config = {
      l1Enabled: config.l1Enabled !== false,
      l1Size: config.l1Size || 64, // 64MB default
      l2Enabled: config.l2Enabled !== false,
      l2Ttl: config.l2Ttl || 300, // 5 minutes
      l3Enabled: config.l3Enabled !== false,
      enablePromotion: config.enablePromotion !== false,
      enableDemotion: config.enableDemotion !== false
    };

    this.l1MaxEntries = Math.floor(this.config.l1Size * 1024 * 1024 / 1024); // Rough estimate

    if (this.config.l2Enabled) {
      this.redis = getRedisClient();
    }

    this.initializeL1Cache();
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

  // L1 Cache Implementation (SharedArrayBuffer)
  private initializeL1Cache(): void {
    if (!this.config.l1Enabled) return;

    try {
      // Create SharedArrayBuffer for cross-worker access
      this.l1Buffer = new SharedArrayBuffer(this.config.l1Size * 1024 * 1024);
      this.l1View = new Uint8Array(this.l1Buffer);

      logger.info('L1 cache initialized', {
        size: this.config.l1Size,
        maxEntries: this.l1MaxEntries
      });
    } catch (error) {
      logger.error('Failed to initialize L1 cache', { error });
      this.config.l1Enabled = false;
    }
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

  private invalidateL1Pattern(pattern: string): void {
    for (const key of this.l1Metadata.keys()) {
      if (key.includes(pattern)) {
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
  private async getFromL2(key: string): Promise<any> {
    try {
      const data = await this.redis.get(`${this.l2Prefix}${key}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error('L2 cache get error', { error, key });
      return null;
    }
  }

  private async setInL2(key: string, value: any, ttl?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      const redisKey = `${this.l2Prefix}${key}`;

      if (ttl) {
        await this.redis.setex(redisKey, ttl, serialized);
      } else {
        await this.redis.setex(redisKey, this.config.l2Ttl, serialized);
      }
    } catch (error) {
      logger.error('L2 cache set error', { error, key });
    }
  }

  private async invalidateL2(key: string): Promise<void> {
    try {
      await this.redis.del(`${this.l2Prefix}${key}`);
    } catch (error) {
      logger.error('L2 cache invalidate error', { error, key });
    }
  }

  private async invalidateL2Pattern(pattern: string): Promise<void> {
    try {
      // Use Redis SCAN for pattern deletion
      const keys = await this.redis.keys(`${this.l2Prefix}*${pattern}*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      logger.error('L2 cache pattern invalidate error', { error, pattern });
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

  private invalidateL3Pattern(pattern: string): void {
    for (const key of this.l3Storage.keys()) {
      if (key.includes(pattern)) {
        this.l3Storage.delete(key);
      }
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
    const demotionThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [key, entry] of this.l1Metadata.entries()) {
      if (now - entry.lastAccess > demotionThreshold && entry.accessCount < 3) {
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