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
export declare class LRUQueue {
    /** Map from key to node for O(1) lookup */
    private nodeMap;
    /** Sentinel head node (oldest) */
    private head;
    /** Sentinel tail node (newest) */
    private tail;
    constructor();
    /**
     * Get current queue size.
     */
    get size(): number;
    /**
     * Check if key exists in queue.
     */
    has(key: string): boolean;
    /**
     * Add new key to end of queue (most recently used).
     * If key already exists, moves it to end.
     */
    add(key: string): void;
    /**
     * Move existing key to end of queue (most recently used).
     * O(1) operation.
     */
    touch(key: string): void;
    /**
     * Remove and return the oldest key (from head).
     * Returns null if queue is empty.
     */
    evictOldest(): string | null;
    /**
     * Remove a specific key from queue.
     */
    remove(key: string): boolean;
    /**
     * Clear all entries.
     */
    clear(): void;
    /**
     * Get all keys in order (oldest first).
     * Mainly for debugging/testing.
     */
    keys(): string[];
    private removeNode;
    private insertBeforeTail;
}
export interface CacheConfig {
    l1Enabled: boolean;
    l1Size: number;
    l2Enabled: boolean;
    l2Ttl: number;
    l3Enabled: boolean;
    /** T2.10: Maximum entries for L3 cache (0 = unlimited for backwards compatibility) */
    l3MaxSize: number;
    enablePromotion: boolean;
    enableDemotion: boolean;
}
export interface CacheEntry {
    key: string;
    value: any;
    timestamp: number;
    accessCount: number;
    lastAccess: number;
    size: number;
    ttl?: number;
}
export declare class HierarchicalCache {
    private config;
    /**
     * P0-FIX-3: Redis client is stored as a Promise (lazy initialization pattern).
     * getRedisClient() returns a Promise<RedisClient>, which we store and await
     * in all L2 operations. This allows the cache to be constructed synchronously
     * while deferring Redis connection until first use.
     *
     * Type is RedisClient | Promise<RedisClient> | null to be explicit about this pattern.
     */
    private redisPromise;
    private l1Metadata;
    private l1MaxEntries;
    private l1EvictionQueue;
    private l2Prefix;
    private l3Storage;
    private l3Prefix;
    private l3EvictionQueue;
    private l3MaxSize;
    private stats;
    constructor(config?: Partial<CacheConfig>);
    get(key: string): Promise<any>;
    set(key: string, value: any, ttl?: number): Promise<void>;
    invalidate(key: string): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
    invalidatePattern(pattern: string): Promise<void>;
    getStats(): any;
    private getFromL1;
    private setInL1;
    private invalidateL1;
    /**
     * P1-FIX-1: Use proper glob pattern matching instead of includes().
     * Pattern '*' now correctly matches all keys, not just keys containing '*'.
     */
    private invalidateL1Pattern;
    private evictL1;
    private getCurrentL1Size;
    private getFromL2;
    private setInL2;
    private invalidateL2;
    /**
     * P0-FIX: Use SCAN instead of KEYS to prevent blocking Redis server.
     * KEYS command blocks the server for the duration of the scan, which can
     * cause performance issues in production with large keyspaces.
     * SCAN iterates incrementally and doesn't block.
     */
    private invalidateL2Pattern;
    /**
     * P0-FIX: Helper method to perform SCAN operation.
     * Uses the underlying Redis client's scan capability.
     */
    private scanKeys;
    private getFromL3;
    /**
     * T2.10: Set value in L3 with LRU eviction support.
     * Evicts oldest entries when cache exceeds max size.
     */
    private setInL3;
    /**
     * T2.10: Evict the oldest L3 entry.
     */
    private evictL3;
    private invalidateL3;
    /**
     * P1-FIX-1: Use proper glob pattern matching instead of includes().
     * T2.10: Also removes entries from LRU queue.
     */
    private invalidateL3Pattern;
    /**
     * P1-FIX-1: Glob-like pattern matching for cache key invalidation.
     * Supports:
     * - '*' matches any sequence of characters
     * - '?' matches any single character
     * - Other characters match literally
     */
    private matchPattern;
    private estimateSize;
    private recordAccessTime;
    cleanup(): Promise<void>;
    private performAutoDemotion;
}
export declare function createHierarchicalCache(config?: Partial<CacheConfig>): HierarchicalCache;
export declare function getHierarchicalCache(): HierarchicalCache;
//# sourceMappingURL=hierarchical-cache.d.ts.map