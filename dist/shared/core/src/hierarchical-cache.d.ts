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
    private l1Buffer;
    private l1View;
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
    invalidatePattern(pattern: string): Promise<void>;
    getStats(): any;
    private initializeL1Cache;
    private getFromL1;
    private setInL1;
    private invalidateL1;
    private invalidateL1Pattern;
    private evictL1;
    private getCurrentL1Size;
    private getFromL2;
    private setInL2;
    private invalidateL2;
    private invalidateL2Pattern;
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