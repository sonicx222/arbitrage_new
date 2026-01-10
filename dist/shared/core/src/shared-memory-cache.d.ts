export interface SharedCacheConfig {
    size: number;
    enableCompression: boolean;
    enableEncryption: boolean;
    maxKeyLength: number;
    enableAtomicOperations: boolean;
}
export interface SharedCacheEntry {
    key: string;
    value: any;
    timestamp: number;
    ttl?: number;
    compressed: boolean;
    encrypted: boolean;
    size: number;
}
export declare class SharedMemoryCache {
    private config;
    private buffer;
    private view;
    private metadataView;
    private dataView;
    private static readonly METADATA_SIZE;
    private static readonly ENTRY_HEADER_SIZE;
    private static readonly MAX_KEY_LENGTH;
    private static readonly MAX_VALUE_LENGTH;
    private static readonly VERSION_OFFSET;
    private static readonly ENTRY_COUNT_OFFSET;
    private static readonly MAX_ENTRIES_OFFSET;
    private static readonly DATA_START_OFFSET;
    private textEncoder;
    private textDecoder;
    constructor(config?: Partial<SharedCacheConfig>);
    get(key: string): any;
    set(key: string, value: any, ttl?: number): boolean;
    delete(key: string): boolean;
    clear(): void;
    has(key: string): boolean;
    size(): number;
    keys(): string[];
    stats(): any;
    increment(key: string, delta?: number): number;
    compareAndSet(key: string, expectedValue: any, newValue: any): boolean;
    getSharedBuffer(): SharedArrayBuffer;
    private initializeSharedBuffer;
    private validateKey;
    private findEntry;
    private findEntryIndex;
    private createEntry;
    private updateEntry;
    private removeEntry;
    private serializeValue;
    private deserializeValue;
    private simpleEncrypt;
    private simpleDecrypt;
    private getFlags;
    private readUint32;
    private writeUint32;
    private readUint64;
    private writeUint64;
    private readString;
    private getUtilization;
    cleanup(): void;
    destroy(): void;
}
export declare function createSharedMemoryCache(config?: Partial<SharedCacheConfig>): SharedMemoryCache;
export declare function getSharedMemoryCache(): SharedMemoryCache;
//# sourceMappingURL=shared-memory-cache.d.ts.map