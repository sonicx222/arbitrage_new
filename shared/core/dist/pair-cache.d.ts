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
export type CacheLookupResult = {
    status: 'hit';
    data: CachedPairData;
} | {
    status: 'miss';
} | {
    status: 'null';
    reason: 'pair_not_exists';
};
export declare class PairCacheService extends EventEmitter {
    private logger;
    private config;
    private redis;
    private initialized;
    private stats;
    constructor(config?: Partial<PairCacheConfig>);
    /**
     * Initialize Redis connection
     */
    initialize(): Promise<void>;
    /**
     * Check if service is initialized
     */
    isInitialized(): boolean;
    /**
     * Generate consistent cache key for a pair
     * Tokens are sorted for deterministic key generation
     */
    generateCacheKey(chain: string, dex: string, token0: string, token1: string): string;
    /**
     * Generate pattern key for bulk operations
     */
    generatePatternKey(chain: string, dex?: string): string;
    /**
     * Sort token addresses for deterministic ordering
     */
    private sortTokens;
    /**
     * Get pair data from cache
     */
    get(chain: string, dex: string, token0: string, token1: string): Promise<CacheLookupResult>;
    /**
     * Set pair data in cache
     */
    set(chain: string, dex: string, token0: string, token1: string, data: CachedPairData, ttlSec?: number): Promise<boolean>;
    /**
     * Set null marker for non-existent pair
     */
    setNull(chain: string, dex: string, token0: string, token1: string): Promise<boolean>;
    /**
     * Delete pair from cache
     */
    delete(chain: string, dex: string, token0: string, token1: string): Promise<boolean>;
    /**
     * Get multiple pairs from cache
     * Uses parallel get calls since RedisClient doesn't expose mget
     */
    getMany(requests: Array<{
        chain: string;
        dex: string;
        token0: string;
        token1: string;
    }>): Promise<Map<string, CacheLookupResult>>;
    /**
     * Set multiple pairs in cache
     */
    setMany(entries: Array<{
        chain: string;
        dex: string;
        token0: string;
        token1: string;
        data: CachedPairData;
    }>): Promise<number>;
    /**
     * Invalidate all cached pairs for a chain
     */
    invalidateChain(chain: string): Promise<number>;
    /**
     * Invalidate all cached pairs for a DEX on a chain
     */
    invalidateDex(chain: string, dex: string): Promise<number>;
    getStats(): PairCacheStats;
    /**
     * Get cache hit ratio
     */
    getHitRatio(): number;
    /**
     * Get Prometheus-format metrics
     */
    getPrometheusMetrics(): string;
    /**
     * Reset statistics
     */
    resetStats(): void;
}
export declare function getPairCacheService(config?: Partial<PairCacheConfig>): Promise<PairCacheService>;
export declare function resetPairCacheService(): void;
//# sourceMappingURL=pair-cache.d.ts.map