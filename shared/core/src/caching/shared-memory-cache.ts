// Shared Memory Cache using SharedArrayBuffer
// Enables atomic operations and cross-worker data sharing

import { createLogger } from '../logger';

const logger = createLogger('shared-memory-cache');

export interface SharedCacheConfig {
  size: number; // Size in MB
  enableCompression: boolean;
  enableEncryption: boolean;
  maxKeyLength: number;
  enableAtomicOperations: boolean;
}

export interface SharedCacheEntry {
  key: string;
  value: unknown;
  timestamp: number;
  ttl?: number;
  compressed: boolean;
  encrypted: boolean;
  size: number;
  keyOffset?: number;
  valueOffset?: number;
  valueLen?: number;
}

// Memory layout for SharedArrayBuffer:
// [metadata][key-value store][free space]
// Metadata: [version][entryCount][maxEntries][dataStartOffset]
export class SharedMemoryCache {
  private config: SharedCacheConfig;
  private buffer!: SharedArrayBuffer;
  private view!: Uint8Array;
  private metadataView!: Uint32Array; // First 16 bytes for metadata
  private dataView!: Uint8Array; // Rest for data

  // Constants for memory layout
  private static readonly METADATA_SIZE = 16; // 4 * 4 bytes
  private static readonly ENTRY_HEADER_SIZE = 24; // keyLen(4) + valueLen(4) + timestamp(8) + flags(4) + ttl(4)
  private static readonly MAX_KEY_LENGTH = 256;
  private static readonly MAX_VALUE_LENGTH = 1024 * 1024; // 1MB per value

  // Metadata offsets (in 32-bit words)
  private static readonly VERSION_OFFSET = 0;
  private static readonly ENTRY_COUNT_OFFSET = 1;
  private static readonly MAX_ENTRIES_OFFSET = 2;
  private static readonly DATA_START_OFFSET = 3;

  private textEncoder = new TextEncoder();
  private textDecoder = new TextDecoder();

  // Fix #2+#4: Key→offset map for O(1) lookups and accurate size tracking
  private keyOffsetMap: Map<string, number> = new Map();

  // Write cursor: always points to the end of the data area (next free byte).
  // Avoids scanning the buffer to find insertion point, making tombstones safe.
  private nextWriteOffset: number = SharedMemoryCache.METADATA_SIZE;

  constructor(config: Partial<SharedCacheConfig> = {}) {
    this.config = {
      size: config.size ?? 64, // 64MB default (reduced from 256MB; no production callers)
      // W2-L2 FIX: Use ?? for convention compliance
      enableCompression: config.enableCompression ?? false,
      enableEncryption: config.enableEncryption ?? false,
      maxKeyLength: config.maxKeyLength ?? SharedMemoryCache.MAX_KEY_LENGTH,
      enableAtomicOperations: config.enableAtomicOperations !== false
    };

    this.initializeSharedBuffer();
    logger.info('Shared memory cache initialized', {
      size: this.config.size,
      enableCompression: this.config.enableCompression,
      enableEncryption: this.config.enableEncryption
    });
  }

  get(key: string): unknown {
    if (!this.validateKey(key)) return null;

    try {
      const entry = this.findEntry(key);
      if (!entry) return null;

      // Check TTL
      if (entry.ttl && Date.now() - entry.timestamp > entry.ttl * 1000) {
        this.delete(key);
        return null;
      }

      return this.deserializeValue(entry);
    } catch (error) {
      logger.error('Shared cache get error', { error, key });
      return null;
    }
  }

  set(key: string, value: unknown, ttl?: number): boolean {
    if (!this.validateKey(key)) return false;

    try {
      // Check if entry exists
      const existingEntry = this.findEntry(key);
      if (existingEntry) {
        // Update existing entry
        return this.updateEntry(key, value, ttl, existingEntry);
      } else {
        // Create new entry
        return this.createEntry(key, value, ttl);
      }
    } catch (error) {
      logger.error('Shared cache set error', { error, key });
      return false;
    }
  }

  delete(key: string): boolean {
    if (!this.validateKey(key)) return false;

    try {
      const entryOffset = this.findEntryOffset(key);
      if (entryOffset === -1) return false;

      return this.removeEntry(key, entryOffset);
    } catch (error) {
      logger.error('Shared cache delete error', { error, key });
      return false;
    }
  }

  clear(): void {
    try {
      Atomics.store(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET, 0);
      this.keyOffsetMap.clear();
      this.nextWriteOffset = SharedMemoryCache.METADATA_SIZE;
      logger.info('Shared memory cache cleared');
    } catch (error) {
      logger.error('Shared cache clear error', { error });
    }
  }

  has(key: string): boolean {
    return this.findEntry(key) !== null;
  }

  size(): number {
    return this.keyOffsetMap.size;
  }

  keys(): string[] {
    return Array.from(this.keyOffsetMap.keys());
  }

  stats(): {
    size: number;
    entries: number;
    utilization: number;
    compressionEnabled: boolean;
    encryptionEnabled: boolean;
    atomicOperationsEnabled: boolean;
  } {
    return {
      size: this.config.size,
      entries: this.size(),
      utilization: this.getUtilization(),
      compressionEnabled: this.config.enableCompression,
      encryptionEnabled: this.config.enableEncryption,
      atomicOperationsEnabled: this.config.enableAtomicOperations
    };
  }

  // Atomic operations for thread safety
  increment(key: string, delta: number = 1): number {
    // Values are JSON-serialized, so raw Atomics.add on the buffer is not
    // feasible. Use get/set for both atomic and non-atomic paths.
    const current = (this.get(key) as number) ?? 0;
    const newValue = current + delta;
    this.set(key, newValue);
    return newValue;
  }

  compareAndSet(key: string, expectedValue: unknown, newValue: unknown): boolean {
    if (!this.config.enableAtomicOperations) {
      const current = this.get(key);
      if (current === expectedValue) {
        this.set(key, newValue);
        return true;
      }
      return false;
    }

    // Atomic compare-and-set operation
    // This is more complex and would require careful implementation
    // For now, fall back to non-atomic operation
    const current = this.get(key);
    if (current === expectedValue) {
      this.set(key, newValue);
      return true;
    }
    return false;
  }

  // Shared buffer access for cross-worker communication
  getSharedBuffer(): SharedArrayBuffer {
    return this.buffer;
  }

  // Private methods
  private initializeSharedBuffer(): void {
    const totalSize = this.config.size * 1024 * 1024; // Convert MB to bytes

    this.buffer = new SharedArrayBuffer(totalSize);
    this.view = new Uint8Array(this.buffer);
    this.metadataView = new Uint32Array(this.buffer, 0, SharedMemoryCache.METADATA_SIZE / 4);
    this.dataView = new Uint8Array(this.buffer, SharedMemoryCache.METADATA_SIZE);

    // Initialize metadata
    Atomics.store(this.metadataView, SharedMemoryCache.VERSION_OFFSET, 1); // Version 1
    Atomics.store(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET, 0);
    Atomics.store(this.metadataView, SharedMemoryCache.MAX_ENTRIES_OFFSET, 10000); // Reasonable default
    Atomics.store(this.metadataView, SharedMemoryCache.DATA_START_OFFSET, SharedMemoryCache.METADATA_SIZE);

    // Clear the key→offset map and reset write cursor
    this.keyOffsetMap.clear();
    this.nextWriteOffset = SharedMemoryCache.METADATA_SIZE;
  }

  private validateKey(key: string): boolean {
    return typeof key === 'string' &&
      key.length > 0 &&
      key.length <= this.config.maxKeyLength &&
      !key.includes('\0'); // Null bytes not allowed
  }

  private findEntry(key: string): SharedCacheEntry | null {
    // O(1) lookup via keyOffsetMap
    const offset = this.keyOffsetMap.get(key);
    if (offset === undefined) return null;

    const keyLen = this.readUint32(offset);
    if (keyLen === 0) {
      // Tombstoned — stale map entry; clean up and return null
      this.keyOffsetMap.delete(key);
      return null;
    }

    const valueLen = this.readUint32(offset + 4);
    const timestamp = this.readUint64(offset + 8);
    const flags = this.readUint32(offset + 16);
    const ttl = this.readUint32(offset + 20);

    return {
      key,
      value: null, // Will be deserialized separately
      timestamp: Number(timestamp),
      ttl: ttl || undefined,
      compressed: !!(flags & 1),
      encrypted: !!(flags & 2),
      size: keyLen + valueLen + SharedMemoryCache.ENTRY_HEADER_SIZE,
      keyOffset: offset,
      valueOffset: offset + SharedMemoryCache.ENTRY_HEADER_SIZE + keyLen,
      valueLen
    };
  }

  private findEntryOffset(key: string): number {
    // O(1) lookup via keyOffsetMap; returns byte offset or -1
    const offset = this.keyOffsetMap.get(key);
    if (offset === undefined) return -1;

    // Verify not tombstoned
    const keyLen = this.readUint32(offset);
    if (keyLen === 0) {
      this.keyOffsetMap.delete(key);
      return -1;
    }

    return offset;
  }

  private createEntry(key: string, value: unknown, ttl?: number): boolean {
    const entryCount = Atomics.load(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET);
    const maxEntries = Atomics.load(this.metadataView, SharedMemoryCache.MAX_ENTRIES_OFFSET);

    if (entryCount >= maxEntries) {
      logger.warn('Max entries reached, cannot create new entry');
      return false;
    }

    // Use the tracked write cursor — always points to end of data.
    // This avoids scanning the buffer which breaks with tombstoned entries.
    const dataOffset = this.nextWriteOffset;

    // Serialize key and value
    const serializedKey = this.textEncoder.encode(key);
    const serializedValue = this.serializeValue(value);

    if (!serializedValue) return false;

    const totalSize = SharedMemoryCache.ENTRY_HEADER_SIZE + serializedKey.length + serializedValue.length;

    // Check if we have enough space
    if (dataOffset + totalSize >= this.view.length) {
      logger.warn('Insufficient space for new entry');
      return false;
    }

    // Write entry header
    this.writeUint32(dataOffset, serializedKey.length);
    this.writeUint32(dataOffset + 4, serializedValue.length);
    this.writeUint64(dataOffset + 8, Date.now());
    this.writeUint32(dataOffset + 16, this.getFlags(value));
    this.writeUint32(dataOffset + 20, ttl ?? 0);

    // Write key
    this.view.set(serializedKey, dataOffset + SharedMemoryCache.ENTRY_HEADER_SIZE);

    // Write value
    this.view.set(serializedValue, dataOffset + SharedMemoryCache.ENTRY_HEADER_SIZE + serializedKey.length);

    // Add to key→offset map
    this.keyOffsetMap.set(key, dataOffset);

    // Advance the write cursor past this entry
    this.nextWriteOffset = dataOffset + totalSize;

    // Update entry count atomically
    Atomics.add(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET, 1);

    return true;
  }

  private updateEntry(key: string, value: unknown, ttl: number | undefined, existingEntry: SharedCacheEntry): boolean {
    // Tombstone old entry, then create new one at end of data
    const offset = this.findEntryOffset(key);
    if (offset !== -1) {
      this.removeEntry(key, offset);
    }
    return this.createEntry(key, value, ttl);
  }

  private removeEntry(key: string, offset: number): boolean {
    if (offset === -1) return false;

    // Tombstone the entry by setting keyLen to 0
    this.writeUint32(offset, 0);

    // Remove from the key→offset map
    this.keyOffsetMap.delete(key);

    // Decrement the entry count
    Atomics.sub(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET, 1);
    return true;
  }

  // Fix #26: Numeric type flag (bit 2) for typed array fast-path
  private static readonly FLAG_NUMERIC = 4;

  private serializeValue(value: unknown): Uint8Array | null {
    try {
      // Fix #26: Fast path for numbers — use Float64 directly instead of JSON
      if (typeof value === 'number') {
        const buf = new Uint8Array(8);
        const dv = new DataView(buf.buffer);
        dv.setFloat64(0, value, true); // little-endian
        return buf;
      }

      let data = JSON.stringify(value);
      let flags = 0;

      if (this.config.enableCompression) {
        // Simple compression (would use proper algorithm in production)
        data = data.replace(/\s+/g, ' ');
        flags |= 1;
      }

      if (this.config.enableEncryption) {
        // Simple XOR encryption (would use proper encryption in production)
        data = this.simpleEncrypt(data);
        flags |= 2;
      }

      return this.textEncoder.encode(data);
    } catch (error) {
      logger.error('Value serialization error', { error });
      return null;
    }
  }

  private deserializeValue(entry: SharedCacheEntry): unknown {
    try {
      // Fix #26: Fast path for numeric entries — read Float64 directly
      if ((entry.compressed === false && entry.encrypted === false) && entry.valueLen === 8) {
        // Check the flags in the header for the numeric marker
        const flags = this.readUint32(entry.keyOffset! + 16);
        if (flags & SharedMemoryCache.FLAG_NUMERIC) {
          const dv = new DataView(this.view.buffer, entry.valueOffset, 8);
          return dv.getFloat64(0, true);
        }
      }

      let data = this.readString(entry.valueOffset!, entry.valueLen!);

      if (entry.encrypted && this.config.enableEncryption) {
        data = this.simpleDecrypt(data);
      }

      return JSON.parse(data);
    } catch (error) {
      logger.error('Value deserialization error', { error });
      return null;
    }
  }

  private simpleEncrypt(data: string): string {
    // Simple XOR encryption for demo (NOT secure)
    return data.split('').map(char =>
      String.fromCharCode(char.charCodeAt(0) ^ 0x55)
    ).join('');
  }

  private simpleDecrypt(data: string): string {
    // Simple XOR decryption
    return this.simpleEncrypt(data); // XOR is symmetric
  }

  private getFlags(value: unknown): number {
    let flags = 0;
    // Fix #26: Numeric values use typed array fast-path, skip compression/encryption
    if (typeof value === 'number') {
      flags |= SharedMemoryCache.FLAG_NUMERIC;
      return flags;
    }
    if (this.config.enableCompression) flags |= 1;
    if (this.config.enableEncryption) flags |= 2;
    return flags;
  }

  // Low-level memory access methods
  private readUint32(offset: number): number {
    return ((this.view[offset] << 24) |
      (this.view[offset + 1] << 16) |
      (this.view[offset + 2] << 8) |
      this.view[offset + 3]) >>> 0;
  }

  private writeUint32(offset: number, value: number): void {
    this.view[offset] = (value >>> 24) & 0xFF;
    this.view[offset + 1] = (value >>> 16) & 0xFF;
    this.view[offset + 2] = (value >>> 8) & 0xFF;
    this.view[offset + 3] = value & 0xFF;
  }

  private readUint64(offset: number): bigint {
    return (BigInt(this.readUint32(offset)) << 32n) | BigInt(this.readUint32(offset + 4));
  }

  private writeUint64(offset: number, value: number | bigint): void {
    const bigValue = BigInt(value);
    this.writeUint32(offset, Number(bigValue >> 32n));
    this.writeUint32(offset + 4, Number(bigValue & 0xFFFFFFFFn));
  }

  private readString(offset: number, length: number): string {
    return this.textDecoder.decode(this.view.subarray(offset, offset + length));
  }

  private getUtilization(): number {
    const dataStart = Atomics.load(this.metadataView, SharedMemoryCache.DATA_START_OFFSET);
    const used = this.view.length - dataStart;
    return used / this.view.length;
  }

  // Cleanup expired entries — single-pass over keyOffsetMap
  cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    const keysToDelete: string[] = [];

    for (const [key, offset] of this.keyOffsetMap) {
      try {
        const keyLen = this.readUint32(offset);
        if (keyLen === 0) {
          // Stale tombstone in map — remove
          keysToDelete.push(key);
          continue;
        }

        const ttl = this.readUint32(offset + 20);
        if (ttl === 0) continue; // No TTL — never expires

        const timestamp = Number(this.readUint64(offset + 8));
        if (now - timestamp > ttl * 1000) {
          keysToDelete.push(key);
          cleaned++;
        }
      } catch (error) {
        logger.error('Error during key cleanup', { key, error });
      }
    }

    // Delete expired entries outside the iteration to avoid mutation during iteration
    for (const key of keysToDelete) {
      this.delete(key);
    }

    if (cleaned > 0) {
      logger.debug('Shared memory cache cleanup completed', { entriesRemoved: cleaned });
    }
  }

  // Force cleanup of all data
  destroy(): void {
    logger.info('Destroying shared memory cache');

    // Clear metadata and map
    this.clear();
    this.keyOffsetMap.clear();

    // Note: SharedArrayBuffer cannot be explicitly freed in JavaScript
    // It will be garbage collected when no references remain

    logger.info('Shared memory cache destroyed');
  }
}

// Factory function
export function createSharedMemoryCache(config?: Partial<SharedCacheConfig>): SharedMemoryCache {
  return new SharedMemoryCache(config);
}

// Default instance
let defaultSharedCache: SharedMemoryCache | null = null;

export function getSharedMemoryCache(): SharedMemoryCache {
  if (!defaultSharedCache) {
    defaultSharedCache = new SharedMemoryCache({
      size: 64, // 64MB (reduced from 512MB; no production callers)
      enableCompression: true,
      enableEncryption: false,
      enableAtomicOperations: true
    });
  }
  return defaultSharedCache;
}