/**
 * Pair Cache Service
 *
 * S2.2.5: Redis-based pair address caching with TTL
 *
 * Features:
 * - Consistent cache key generation with token sorting
 * - Configurable TTL for different data types
 * - Batch cache operations for efficiency
 * - Cache miss vs non-existent pair differentiation
 * - Integration with PairDiscoveryService
 *
 * @see ADR-002: Redis Streams for event publishing
 */

import { EventEmitter } from 'events';
import { createLogger } from './logger';
import { getRedisClient, RedisClient } from './redis';

// =============================================================================
// Types
// =============================================================================

export interface PairCacheConfig {
  /** TTL for pair addresses in seconds (default: 24 hours) */
  pairAddressTtlSec: number;
  /**
   * TTL for pair metadata in seconds (default: 1 hour)
   * @reserved Reserved for future use - separate metadata caching not yet implemented.
   * Currently all pair data uses pairAddressTtlSec.
   */
  pairMetadataTtlSec: number;
  /** TTL for null/non-existent pair results (default: 1 hour) */
  nullResultTtlSec: number;
  /** Maximum batch size for Redis operations */
  maxBatchSize: number;
  /**
   * Use Redis pipeline for batch operations
   * @reserved Reserved for future use - pipeline optimization not yet implemented.
   * Current implementation uses Promise.all for parallelism.
   */
  usePipeline: boolean;
  /** Key prefix for pair cache */
  keyPrefix: string;
}

export interface CachedPairData {
  address: string;
  token0: string;
  token1: string;
  dex: string;
  chain: string;
  factoryAddress: string;
  fee?: number;
  discoveredAt: number;
  lastVerified: number;
  discoveryMethod: 'factory_query' | 'create2_compute' | 'cache';
}

export interface PairCacheStats {
  totalLookups: number;
  cacheHits: number;
  cacheMisses: number;
  nullHits: number;
  setOperations: number;
  deleteOperations: number;
  batchOperations: number;
  errors: number;
}

export type CacheLookupResult =
  | { status: 'hit'; data: CachedPairData }
  | { status: 'miss' }
  | { status: 'null'; reason: 'pair_not_exists' };

// Special marker for non-existent pairs
const NULL_PAIR_MARKER = 'NULL_PAIR';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// =============================================================================
// Pair Cache Service
// =============================================================================

export class PairCacheService extends EventEmitter {
  private logger = createLogger('pair-cache');
  private config: PairCacheConfig;
  private redis: RedisClient | null = null;
  private initialized = false;

  // Statistics
  private stats: PairCacheStats = {
    totalLookups: 0,
    cacheHits: 0,
    cacheMisses: 0,
    nullHits: 0,
    setOperations: 0,
    deleteOperations: 0,
    batchOperations: 0,
    errors: 0
  };

  constructor(config?: Partial<PairCacheConfig>) {
    super();

    this.config = {
      pairAddressTtlSec: 24 * 60 * 60, // 24 hours
      pairMetadataTtlSec: 60 * 60,     // 1 hour
      nullResultTtlSec: 60 * 60,       // 1 hour
      maxBatchSize: 100,
      usePipeline: true,
      keyPrefix: 'pair:',
      ...config
    };
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize Redis connection
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.redis = await getRedisClient();
      this.initialized = true;
      this.logger.info('PairCacheService initialized');
    } catch (error) {
      this.logger.error('Failed to initialize PairCacheService', { error });
      throw error;
    }
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.redis !== null;
  }

  // ===========================================================================
  // Cache Key Generation
  // ===========================================================================

  /**
   * Generate consistent cache key for a pair
   * Tokens are sorted for deterministic key generation
   */
  generateCacheKey(chain: string, dex: string, token0: string, token1: string): string {
    const [sortedToken0, sortedToken1] = this.sortTokens(token0, token1);
    return `${this.config.keyPrefix}${chain}:${dex}:${sortedToken0.toLowerCase()}:${sortedToken1.toLowerCase()}`;
  }

  /**
   * Generate pattern key for bulk operations
   */
  generatePatternKey(chain: string, dex?: string): string {
    if (dex) {
      return `${this.config.keyPrefix}${chain}:${dex}:*`;
    }
    return `${this.config.keyPrefix}${chain}:*`;
  }

  /**
   * Sort token addresses for deterministic ordering
   */
  private sortTokens(tokenA: string, tokenB: string): [string, string] {
    return tokenA.toLowerCase() < tokenB.toLowerCase()
      ? [tokenA, tokenB]
      : [tokenB, tokenA];
  }

  // ===========================================================================
  // Cache Operations
  // ===========================================================================

  /**
   * Get pair data from cache
   */
  async get(
    chain: string,
    dex: string,
    token0: string,
    token1: string
  ): Promise<CacheLookupResult> {
    this.stats.totalLookups++;

    if (!this.redis) {
      this.stats.errors++;
      this.emit('cache:error', { reason: 'not_initialized' });
      return { status: 'miss' };
    }

    const key = this.generateCacheKey(chain, dex, token0, token1);

    try {
      // RedisClient.get() already parses JSON - returns object or string marker
      const value = await this.redis.get<CachedPairData | string>(key);

      if (value === null) {
        this.stats.cacheMisses++;
        this.emit('cache:miss', { chain, dex, token0, token1 });
        return { status: 'miss' };
      }

      // Check for null pair markers (stored as strings)
      if (value === NULL_PAIR_MARKER || value === ZERO_ADDRESS) {
        this.stats.nullHits++;
        this.emit('cache:null_hit', { chain, dex, token0, token1 });
        return { status: 'null', reason: 'pair_not_exists' };
      }

      // Value is already parsed as CachedPairData object by RedisClient
      // No need for JSON.parse - that would cause double-parse error
      if (typeof value === 'object' && value !== null) {
        this.stats.cacheHits++;
        this.emit('cache:hit', { chain, dex, token0, token1 });
        return { status: 'hit', data: value as CachedPairData };
      }

      // Unexpected string value (not a marker) - treat as miss
      this.stats.cacheMisses++;
      this.emit('cache:miss', { chain, dex, token0, token1 });
      return { status: 'miss' };

    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache get error', { key, error });
      this.emit('cache:error', { key, error });
      return { status: 'miss' };
    }
  }

  /**
   * Set pair data in cache
   */
  async set(
    chain: string,
    dex: string,
    token0: string,
    token1: string,
    data: CachedPairData,
    ttlSec?: number
  ): Promise<boolean> {
    if (!this.redis) {
      this.stats.errors++;
      return false;
    }

    const key = this.generateCacheKey(chain, dex, token0, token1);
    const ttl = ttlSec ?? this.config.pairAddressTtlSec;

    try {
      // RedisClient.set() handles JSON serialization internally
      await this.redis.set(key, data, ttl);
      this.stats.setOperations++;
      this.emit('cache:set', { chain, dex, token0, token1 });
      return true;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache set error', { key, error });
      return false;
    }
  }

  /**
   * Set null marker for non-existent pair
   */
  async setNull(
    chain: string,
    dex: string,
    token0: string,
    token1: string
  ): Promise<boolean> {
    if (!this.redis) {
      this.stats.errors++;
      return false;
    }

    const key = this.generateCacheKey(chain, dex, token0, token1);

    try {
      // Store null marker as a string value
      await this.redis.set(key, NULL_PAIR_MARKER, this.config.nullResultTtlSec);
      this.stats.setOperations++;
      this.emit('cache:set_null', { chain, dex, token0, token1 });
      return true;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache setNull error', { key, error });
      return false;
    }
  }

  /**
   * Delete pair from cache
   */
  async delete(
    chain: string,
    dex: string,
    token0: string,
    token1: string
  ): Promise<boolean> {
    if (!this.redis) {
      this.stats.errors++;
      return false;
    }

    const key = this.generateCacheKey(chain, dex, token0, token1);

    try {
      await this.redis.del(key);
      this.stats.deleteOperations++;
      this.emit('cache:delete', { chain, dex, token0, token1 });
      return true;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Cache delete error', { key, error });
      return false;
    }
  }

  // ===========================================================================
  // Batch Operations
  // ===========================================================================

  /**
   * Get multiple pairs from cache
   * Uses parallel get calls since RedisClient doesn't expose mget
   */
  async getMany(
    requests: Array<{ chain: string; dex: string; token0: string; token1: string }>
  ): Promise<Map<string, CacheLookupResult>> {
    const results = new Map<string, CacheLookupResult>();

    if (!this.redis || requests.length === 0) {
      return results;
    }

    this.stats.totalLookups += requests.length;
    this.stats.batchOperations++;

    try {
      // Parallel get calls
      const getPromises = requests.map(async r => {
        const key = this.generateCacheKey(r.chain, r.dex, r.token0, r.token1);
        const value = await this.redis!.get<CachedPairData | string>(key);
        return { key, value };
      });

      const fetchResults = await Promise.all(getPromises);

      fetchResults.forEach(({ key, value }) => {
        if (value === null) {
          this.stats.cacheMisses++;
          results.set(key, { status: 'miss' });
        } else if (value === NULL_PAIR_MARKER || value === ZERO_ADDRESS) {
          this.stats.nullHits++;
          results.set(key, { status: 'null', reason: 'pair_not_exists' });
        } else if (typeof value === 'object') {
          // RedisClient.get() already parses JSON
          this.stats.cacheHits++;
          results.set(key, { status: 'hit', data: value as CachedPairData });
        } else {
          this.stats.cacheMisses++;
          results.set(key, { status: 'miss' });
        }
      });

    } catch (error) {
      this.stats.errors++;
      this.logger.error('Batch get error', { error });

      // Return all misses on error
      requests.forEach(r => {
        const key = this.generateCacheKey(r.chain, r.dex, r.token0, r.token1);
        results.set(key, { status: 'miss' });
      });
    }

    return results;
  }

  /**
   * Set multiple pairs in cache
   */
  async setMany(
    entries: Array<{
      chain: string;
      dex: string;
      token0: string;
      token1: string;
      data: CachedPairData;
    }>
  ): Promise<number> {
    if (!this.redis || entries.length === 0) {
      return 0;
    }

    this.stats.batchOperations++;
    let successCount = 0;

    // Process in batches
    for (let i = 0; i < entries.length; i += this.config.maxBatchSize) {
      const batch = entries.slice(i, i + this.config.maxBatchSize);

      try {
        // Use parallel set calls
        const promises = batch.map(entry => {
          const key = this.generateCacheKey(entry.chain, entry.dex, entry.token0, entry.token1);
          // RedisClient.set() handles JSON serialization internally
          return this.redis!.set(key, entry.data, this.config.pairAddressTtlSec);
        });

        await Promise.all(promises);
        successCount += batch.length;
        this.stats.setOperations += batch.length;
      } catch (error) {
        this.stats.errors++;
        this.logger.error('Batch set error', { error, batchIndex: i });
      }
    }

    return successCount;
  }

  // ===========================================================================
  // Invalidation
  // ===========================================================================

  /**
   * Invalidate all cached pairs for a chain
   */
  async invalidateChain(chain: string): Promise<number> {
    if (!this.redis) {
      return 0;
    }

    const pattern = this.generatePatternKey(chain);

    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length === 0) return 0;

      // Delete in parallel batches for better performance
      const batchSize = this.config.maxBatchSize;
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        await Promise.all(batch.map(key => this.redis!.del(key)));
      }

      this.stats.deleteOperations += keys.length;
      this.logger.info(`Invalidated ${keys.length} cached pairs for chain: ${chain}`);
      this.emit('cache:invalidate_chain', { chain, count: keys.length });
      return keys.length;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('Chain invalidation error', { chain, error });
      return 0;
    }
  }

  /**
   * Invalidate all cached pairs for a DEX on a chain
   */
  async invalidateDex(chain: string, dex: string): Promise<number> {
    if (!this.redis) {
      return 0;
    }

    const pattern = this.generatePatternKey(chain, dex);

    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length === 0) return 0;

      // Delete in parallel batches for better performance
      const batchSize = this.config.maxBatchSize;
      for (let i = 0; i < keys.length; i += batchSize) {
        const batch = keys.slice(i, i + batchSize);
        await Promise.all(batch.map(key => this.redis!.del(key)));
      }

      this.stats.deleteOperations += keys.length;
      this.logger.info(`Invalidated ${keys.length} cached pairs for ${dex} on ${chain}`);
      this.emit('cache:invalidate_dex', { chain, dex, count: keys.length });
      return keys.length;
    } catch (error) {
      this.stats.errors++;
      this.logger.error('DEX invalidation error', { chain, dex, error });
      return 0;
    }
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  getStats(): PairCacheStats {
    return { ...this.stats };
  }

  /**
   * Get cache hit ratio
   */
  getHitRatio(): number {
    if (this.stats.totalLookups === 0) return 0;
    return (this.stats.cacheHits + this.stats.nullHits) / this.stats.totalLookups;
  }

  /**
   * Get Prometheus-format metrics
   */
  getPrometheusMetrics(): string {
    const hitRatio = this.getHitRatio();

    return [
      `# HELP pair_cache_lookups_total Total cache lookups`,
      `# TYPE pair_cache_lookups_total counter`,
      `pair_cache_lookups_total ${this.stats.totalLookups}`,
      ``,
      `# HELP pair_cache_hits_total Cache hits`,
      `# TYPE pair_cache_hits_total counter`,
      `pair_cache_hits_total ${this.stats.cacheHits}`,
      ``,
      `# HELP pair_cache_misses_total Cache misses`,
      `# TYPE pair_cache_misses_total counter`,
      `pair_cache_misses_total ${this.stats.cacheMisses}`,
      ``,
      `# HELP pair_cache_null_hits_total Null pair cache hits`,
      `# TYPE pair_cache_null_hits_total counter`,
      `pair_cache_null_hits_total ${this.stats.nullHits}`,
      ``,
      `# HELP pair_cache_set_operations_total Set operations`,
      `# TYPE pair_cache_set_operations_total counter`,
      `pair_cache_set_operations_total ${this.stats.setOperations}`,
      ``,
      `# HELP pair_cache_errors_total Cache errors`,
      `# TYPE pair_cache_errors_total counter`,
      `pair_cache_errors_total ${this.stats.errors}`,
      ``,
      `# HELP pair_cache_hit_ratio Cache hit ratio`,
      `# TYPE pair_cache_hit_ratio gauge`,
      `pair_cache_hit_ratio ${hitRatio.toFixed(4)}`
    ].join('\n');
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalLookups: 0,
      cacheHits: 0,
      cacheMisses: 0,
      nullHits: 0,
      setOperations: 0,
      deleteOperations: 0,
      batchOperations: 0,
      errors: 0
    };
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let pairCacheInstance: PairCacheService | null = null;
let pairCacheInitPromise: Promise<PairCacheService> | null = null;

const logger = createLogger('pair-cache-singleton');

export async function getPairCacheService(
  config?: Partial<PairCacheConfig>
): Promise<PairCacheService> {
  // Return existing initialized instance
  if (pairCacheInstance?.isInitialized()) {
    if (config) {
      logger.warn('getPairCacheService called with config but instance already exists. Config ignored.');
    }
    return pairCacheInstance;
  }

  // Return pending initialization promise to avoid race conditions
  if (pairCacheInitPromise) {
    return pairCacheInitPromise;
  }

  // Create new initialization promise
  pairCacheInitPromise = (async () => {
    try {
      const instance = new PairCacheService(config);
      await instance.initialize();
      pairCacheInstance = instance;
      return instance;
    } catch (error) {
      // Reset on failure so next call can retry
      pairCacheInitPromise = null;
      throw error;
    }
  })();

  return pairCacheInitPromise;
}

export function resetPairCacheService(): void {
  pairCacheInstance = null;
  pairCacheInitPromise = null;
}
