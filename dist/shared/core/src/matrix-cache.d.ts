export interface PriceEntry {
    price: number;
    timestamp: number;
    age: number;
}
export interface CacheEntry {
    price: number;
    timestamp: number;
    ttl: number;
}
export declare class MatrixPriceCache {
    private prices;
    private timestamps;
    private liquidity;
    private pairToIndex;
    private dexToIndex;
    private indexToPair;
    private indexToDex;
    private maxPairs;
    private maxDexes;
    private ttlSeconds;
    private hitCount;
    private missCount;
    private warmupQueue;
    constructor(maxPairs?: number, maxDexes?: number, ttlSeconds?: number);
    setPrice(pairKey: string, dexName: string, price: number, liquidity?: number): boolean;
    getPrice(pairKey: string, dexName: string): PriceEntry | null;
    getAllPricesForPair(pairKey: string): {
        [dex: string]: PriceEntry;
    };
    getAllPricesForDex(dexName: string): {
        [pair: string]: PriceEntry;
    };
    batchSetPrices(updates: Array<{
        pairKey: string;
        dexName: string;
        price: number;
        liquidity?: number;
    }>): number;
    batchGetPrices(requests: Array<{
        pairKey: string;
        dexName: string;
    }>): Array<PriceEntry | null>;
    invalidatePair(pairKey: string): void;
    invalidateDex(dexName: string): void;
    clearExpired(): number;
    getCacheStats(): {
        hitRate: number;
        totalRequests: number;
        activeEntries: number;
        memoryUsage: number;
    };
    queueWarmup(pairKey: string, priority: number, expectedAccessTime: number): void;
    processWarmupQueue(maxItems?: number): number;
    private performWarmup;
    private getOrCreatePairIndex;
    private getOrCreateDexIndex;
    compact(): void;
    resize(newMaxPairs: number, newMaxDexes: number): void;
}
export declare function getMatrixPriceCache(): MatrixPriceCache;
//# sourceMappingURL=matrix-cache.d.ts.map