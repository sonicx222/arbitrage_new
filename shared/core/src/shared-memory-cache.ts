// Shared Memory Cache using SharedArrayBuffer
// Enables atomic operations and cross-worker data sharing

import { createLogger } from './logger';

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
  value: any;
  timestamp: number;
  ttl?: number;
  compressed: boolean;
  encrypted: boolean;
  size: number;
}

// Memory layout for SharedArrayBuffer:
// [metadata][key-value store][free space]
// Metadata: [version][entryCount][maxEntries][dataStartOffset]
export class SharedMemoryCache {
  private config: SharedCacheConfig;
  private buffer: SharedArrayBuffer;
  private view: Uint8Array;
  private metadataView: Uint32Array; // First 16 bytes for metadata
  private dataView: Uint8Array; // Rest for data

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

  constructor(config: Partial<SharedCacheConfig> = {}) {
    this.config = {
      size: config.size || 256, // 256MB default
      enableCompression: config.enableCompression || false,
      enableEncryption: config.enableEncryption || false,
      maxKeyLength: config.maxKeyLength || SharedMemoryCache.MAX_KEY_LENGTH,
      enableAtomicOperations: config.enableAtomicOperations !== false
    };

    this.initializeSharedBuffer();
    logger.info('Shared memory cache initialized', {
      size: this.config.size,
      enableCompression: this.config.enableCompression,
      enableEncryption: this.config.enableEncryption
    });
  }

  get(key: string): any {
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

  set(key: string, value: any, ttl?: number): boolean {
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
      const entryIndex = this.findEntryIndex(key);
      if (entryIndex === -1) return false;

      return this.removeEntry(entryIndex);
    } catch (error) {
      logger.error('Shared cache delete error', { error, key });
      return false;
    }
  }

  clear(): void {
    try {
      Atomics.store(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET, 0);
      // Reset data area (optional - could be expensive)
      logger.info('Shared memory cache cleared');
    } catch (error) {
      logger.error('Shared cache clear error', { error });
    }
  }

  has(key: string): boolean {
    return this.findEntry(key) !== null;
  }

  size(): number {
    return Atomics.load(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET);
  }

  keys(): string[] {
    const keys: string[] = [];
    try {
      const entryCount = Atomics.load(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET);
      let offset = Atomics.load(this.metadataView, SharedMemoryCache.DATA_START_OFFSET);

      for (let i = 0; i < entryCount; i++) {
        if (offset + SharedMemoryCache.ENTRY_HEADER_SIZE >= this.dataView.length) break;

        const keyLen = this.readUint32(offset);
        const key = this.readString(offset + 4, keyLen);

        if (key) keys.push(key);

        // Skip to next entry
        const valueLen = this.readUint32(offset + 4 + keyLen);
        offset += SharedMemoryCache.ENTRY_HEADER_SIZE + keyLen + valueLen;
      }
    } catch (error) {
      logger.error('Shared cache keys error', { error });
    }
    return keys;
  }

  stats(): any {
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
    if (!this.config.enableAtomicOperations) {
      const current = this.get(key) || 0;
      const newValue = current + delta;
      this.set(key, newValue);
      return newValue;
    }

    // Use Atomics for thread-safe operations
    const entry = this.findEntry(key);
    if (!entry) {
      this.set(key, delta);
      return delta;
    }

    // For numbers, we can do atomic operations on the value
    const valueView = new Int32Array(this.buffer, entry.valueOffset, 1);
    return Atomics.add(valueView, 0, delta) + delta;
  }

  compareAndSet(key: string, expectedValue: any, newValue: any): boolean {
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
  }

  private validateKey(key: string): boolean {
    return typeof key === 'string' &&
           key.length > 0 &&
           key.length <= this.config.maxKeyLength &&
           !key.includes('\0'); // Null bytes not allowed
  }

  private findEntry(key: string): SharedCacheEntry | null {
    const entryCount = Atomics.load(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET);
    let offset = Atomics.load(this.metadataView, SharedMemoryCache.DATA_START_OFFSET);

    for (let i = 0; i < entryCount; i++) {
      if (offset + SharedMemoryCache.ENTRY_HEADER_SIZE >= this.dataView.length) break;

      const keyLen = this.readUint32(offset);
      const entryKey = this.readString(offset + 4, keyLen);

      if (entryKey === key) {
        const valueLen = this.readUint32(offset + 4 + keyLen);
        const timestamp = this.readUint64(offset + 8 + keyLen);
        const flags = this.readUint32(offset + 16 + keyLen);
        const ttl = this.readUint32(offset + 20 + keyLen);

        return {
          key: entryKey,
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

      // Skip to next entry
      const valueLen = this.readUint32(offset + 4 + keyLen);
      offset += SharedMemoryCache.ENTRY_HEADER_SIZE + keyLen + valueLen;
    }

    return null;
  }

  private findEntryIndex(key: string): number {
    const entryCount = Atomics.load(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET);
    let offset = Atomics.load(this.metadataView, SharedMemoryCache.DATA_START_OFFSET);

    for (let i = 0; i < entryCount; i++) {
      if (offset + SharedMemoryCache.ENTRY_HEADER_SIZE >= this.dataView.length) break;

      const keyLen = this.readUint32(offset);
      const entryKey = this.readString(offset + 4, keyLen);

      if (entryKey === key) {
        return i;
      }

      // Skip to next entry
      const valueLen = this.readUint32(offset + 4 + keyLen);
      offset += SharedMemoryCache.ENTRY_HEADER_SIZE + keyLen + valueLen;
    }

    return -1;
  }

  private createEntry(key: string, value: any, ttl?: number): boolean {
    const entryCount = Atomics.load(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET);
    const maxEntries = Atomics.load(this.metadataView, SharedMemoryCache.MAX_ENTRIES_OFFSET);

    if (entryCount >= maxEntries) {
      logger.warn('Max entries reached, cannot create new entry');
      return false;
    }

    // Find insertion point (end of data)
    let offset = Atomics.load(this.metadataView, SharedMemoryCache.DATA_START_OFFSET);
    let dataOffset = offset;

    // Find the end of existing data
    for (let i = 0; i < entryCount; i++) {
      const keyLen = this.readUint32(dataOffset);
      const valueLen = this.readUint32(dataOffset + 4 + keyLen);
      dataOffset += SharedMemoryCache.ENTRY_HEADER_SIZE + keyLen + valueLen;
    }

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
    this.writeUint32(dataOffset + 20, ttl || 0);

    // Write key
    this.view.set(serializedKey, dataOffset + SharedMemoryCache.ENTRY_HEADER_SIZE);

    // Write value
    this.view.set(serializedValue, dataOffset + SharedMemoryCache.ENTRY_HEADER_SIZE + serializedKey.length);

    // Update entry count atomically
    Atomics.add(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET, 1);

    return true;
  }

  private updateEntry(key: string, value: any, ttl: number | undefined, existingEntry: any): boolean {
    // For now, delete and recreate (could be optimized)
    this.removeEntry(this.findEntryIndex(key));
    return this.createEntry(key, value, ttl);
  }

  private removeEntry(index: number): boolean {
    if (index === -1) return false;

    // This is a simplified implementation
    // In production, you'd need to handle compaction
    Atomics.sub(this.metadataView, SharedMemoryCache.ENTRY_COUNT_OFFSET, 1);
    return true;
  }

  private serializeValue(value: any): Uint8Array | null {
    try {
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

  private deserializeValue(entry: any): any {
    try {
      let data = this.readString(entry.valueOffset, entry.valueLen);

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

  private getFlags(value: any): number {
    let flags = 0;
    if (this.config.enableCompression) flags |= 1;
    if (this.config.enableEncryption) flags |= 2;
    return flags;
  }

  // Low-level memory access methods
  private readUint32(offset: number): number {
    return (this.view[offset] << 24) |
           (this.view[offset + 1] << 16) |
           (this.view[offset + 2] << 8) |
           this.view[offset + 3];
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

  // Cleanup expired entries
  cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    // Clean L3 storage
    for (const [key, entry] of this.l3Storage.entries()) {
      if (entry.ttl && now - entry.timestamp > entry.ttl * 1000) {
        this.l3Storage.delete(key);
        cleaned++;
      }
    }

    // Clean L1 metadata (though SharedArrayBuffer itself doesn't need cleanup)
    for (const [key, entry] of this.l1Metadata.entries()) {
      if (entry.ttl && now - entry.timestamp > entry.ttl * 1000) {
        this.invalidateL1(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Shared memory cache cleanup completed', { entriesRemoved: cleaned });
    }
  }

  // Force cleanup of all data
  destroy(): void {
    logger.info('Destroying shared memory cache');

    // Clear all metadata
    this.l1Metadata.clear();
    this.l1EvictionQueue.length = 0;
    this.l3Storage.clear();

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
      size: 512, // 512MB
      enableCompression: true,
      enableEncryption: false,
      enableAtomicOperations: true
    });
  }
  return defaultSharedCache;
}