export interface CacheConfig {
    l1Enabled: boolean;
    l1Size: number;
    l2Enabled: boolean;
    l2Ttl: number;
    l3Enabled: boolean;
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
    private redis;
    private l1Metadata;
    private l1MaxEntries;
    private l1EvictionQueue;
    private l2Prefix;
    private l3Storage;
    private l3Prefix;
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
    private setInL3;
    private invalidateL3;
    private invalidateL3Pattern;
    private estimateSize;
    private recordAccessTime;
    cleanup(): Promise<void>;
    private performAutoDemotion;
}
export declare function createHierarchicalCache(config?: Partial<CacheConfig>): HierarchicalCache;
export declare function getHierarchicalCache(): HierarchicalCache;
//# sourceMappingURL=hierarchical-cache.d.ts.map