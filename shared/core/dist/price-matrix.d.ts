/**
 * L1 Price Matrix
 *
 * High-performance price storage using SharedArrayBuffer for sub-microsecond lookups.
 * Implements S1.3 from IMPLEMENTATION_PLAN.md
 *
 * Hypothesis: SharedArrayBuffer price matrix reduces lookup time from 2ms to <1μs
 *
 * @see ADR-005: L1 Cache
 * @see S1.3.1-S1.3.5: Price Matrix Implementation Tasks
 *
 * Memory Layout (per pair):
 * - 8 bytes: price (Float64)
 * - 4 bytes: timestamp (Int32 - relative seconds from epoch, for Atomics compatibility)
 * Total: 12 bytes per pair
 * For 1000 pairs: ~12KB data + ~4KB index = ~16KB total
 *
 * Thread Safety Notes:
 * - Price and timestamp are NOT atomically updated together
 * - A reader may see new price with old timestamp or vice versa (torn read)
 * - This is acceptable for price feeds where slight inconsistency is tolerable
 * - For strict consistency, use version numbers or mutex locks
 */
export interface PriceMatrixConfig {
    maxPairs: number;
    reserveSlots: number;
    strictMode: boolean;
    enableAtomics: boolean;
}
export interface PriceEntry {
    price: number;
    timestamp: number;
}
export interface MemoryUsage {
    totalBytes: number;
    usedSlots: number;
    totalSlots: number;
    utilizationPercent: number;
    priceArrayBytes: number;
    timestampArrayBytes: number;
}
export interface PriceMatrixStats {
    reads: number;
    writes: number;
    hits: number;
    misses: number;
    batchReads: number;
    batchWrites: number;
}
export interface BatchUpdate {
    key: string;
    price: number;
    timestamp: number;
}
/**
 * Maps string keys ("chain:dex:pair") to array offsets with O(1) complexity.
 * Uses a hash-based approach for fast lookups.
 */
export declare class PriceIndexMapper {
    private keyToIndex;
    private indexToKey;
    private nextIndex;
    private readonly maxIndex;
    constructor(maxIndex: number);
    /**
     * Get or create index for a key.
     * Returns existing index if key is known, or allocates new one.
     * WARNING: When all slots are used, falls back to hash-based index which may collide!
     */
    getIndex(key: string): number;
    /**
     * Get key for a given index.
     * Returns null if index is unused.
     */
    getKey(index: number): string | null;
    /**
     * Check if a key is registered.
     */
    hasKey(key: string): boolean;
    /**
     * Get usage statistics.
     */
    getStats(): {
        usedSlots: number;
        totalSlots: number;
        utilizationPercent: number;
    };
    /**
     * Clear all mappings.
     */
    clear(): void;
    /**
     * Simple hash function for string keys.
     * Uses FNV-1a algorithm for fast, well-distributed hashes.
     */
    private hashKey;
}
export declare class PriceMatrix {
    private config;
    private mapper;
    private sharedBuffer;
    private priceArray;
    private timestampArray;
    private fallbackPrices;
    private fallbackTimestamps;
    private useSharedMemory;
    private dataView;
    private readonly timestampEpoch;
    private writtenSlots;
    private stats;
    private destroyed;
    constructor(config?: Partial<PriceMatrixConfig>);
    private initializeArrays;
    private clearArrays;
    private getPriceArray;
    private getTimestampArray;
    getConfig(): PriceMatrixConfig;
    /**
     * Set price for a key.
     */
    setPrice(key: string, price: number, timestamp: number): void;
    /**
     * Get price for a key.
     */
    getPrice(key: string): PriceEntry | null;
    /**
     * Delete price for a key.
     */
    deletePrice(key: string): void;
    /**
     * Set multiple prices in batch.
     */
    setBatch(updates: BatchUpdate[]): void;
    /**
     * Get multiple prices in batch.
     */
    getBatch(keys: string[]): (PriceEntry | null)[];
    /**
     * Clear all prices.
     */
    clear(): void;
    /**
     * Get array offset for a key.
     */
    getOffset(key: string): number;
    private getIndexForKey;
    /**
     * Pre-register keys to reserve their indices.
     */
    registerKeys(keys: string[]): void;
    /**
     * Check if using SharedArrayBuffer.
     */
    isSharedMemory(): boolean;
    /**
     * Check if using Atomics.
     */
    usesAtomics(): boolean;
    /**
     * Get memory usage statistics.
     */
    getMemoryUsage(): MemoryUsage;
    /**
     * Get operation statistics.
     */
    getStats(): PriceMatrixStats;
    /**
     * Reset statistics.
     */
    resetStats(): void;
    /**
     * Export metrics in Prometheus format.
     */
    getPrometheusMetrics(): string;
    /**
     * Destroy the matrix and release resources.
     */
    destroy(): void;
}
/**
 * Get singleton PriceMatrix instance.
 * @param config - Configuration (only used on first call, ignored afterward)
 */
export declare function getPriceMatrix(config?: Partial<PriceMatrixConfig>): PriceMatrix;
/**
 * Reset singleton instance.
 */
export declare function resetPriceMatrix(): void;
//# sourceMappingURL=price-matrix.d.ts.map