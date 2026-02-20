/**
 * PHASE3-TASK43: Shared Key Registry for Worker Thread Access
 *
 * Provides thread-safe key-to-index mapping using SharedArrayBuffer.
 * Main thread writes key mappings, workers read them for zero-copy price lookups.
 *
 * Architecture:
 * - Fixed-size slots (64 bytes each): key string (60 bytes) + index (4 bytes)
 * - Keys stored in insertion order (not sorted, to avoid reordering overhead)
 * - Workers perform linear scan (acceptable for ~1000 keys, <1ms)
 * - Alternative: Sort and binary search for >10k keys
 *
 * Memory overhead: 64 bytes per key
 * - 1,000 keys = 64KB
 * - 10,000 keys = 640KB
 * - 100,000 keys = 6.4MB
 */

import { createLogger } from '../logger';

const logger = createLogger('shared-key-registry');

// Registry configuration
export interface KeyRegistryConfig {
  /** Maximum number of keys that can be stored */
  maxKeys: number;
  /** Size of each key slot in bytes (default: 64) */
  slotSize?: number;
}

/**
 * SharedArrayBuffer layout for key registry:
 *
 * [4 bytes: entry count]
 * [slot 0: 60 bytes key + 4 bytes index]
 * [slot 1: 60 bytes key + 4 bytes index]
 * ...
 * [slot N: 60 bytes key + 4 bytes index]
 *
 * Each slot format:
 * - Bytes 0-59: UTF-8 encoded key string (null-padded)
 * - Bytes 60-63: Int32 index value
 */

export class SharedKeyRegistry {
  private config: Required<KeyRegistryConfig>;
  private buffer: SharedArrayBuffer;
  private dataView: DataView;
  private entryCount: Int32Array; // First 4 bytes = number of entries
  private readonly keySize = 60; // Max key length in bytes
  private readonly slotSize: number;
  private readonly headerSize = 4; // 4 bytes for entry count

  // Local cache for faster lookups (only in main thread)
  private keyToIndexCache: Map<string, number> = new Map();

  constructor(config: KeyRegistryConfig, existingBuffer?: SharedArrayBuffer) {
    this.config = {
      maxKeys: config.maxKeys,
      slotSize: config.slotSize ?? 64
    };

    this.slotSize = this.config.slotSize;

    if (existingBuffer) {
      // Worker mode: Attach to existing buffer
      this.buffer = existingBuffer;
      this.dataView = new DataView(this.buffer);
      this.entryCount = new Int32Array(this.buffer, 0, 1);
      logger.debug('SharedKeyRegistry attached to existing buffer', {
        maxKeys: this.config.maxKeys,
        bufferSize: this.buffer.byteLength
      });
    } else {
      // Main thread mode: Create new buffer
      const bufferSize = this.headerSize + (this.config.maxKeys * this.slotSize);
      this.buffer = new SharedArrayBuffer(bufferSize);
      this.dataView = new DataView(this.buffer);
      this.entryCount = new Int32Array(this.buffer, 0, 1);

      // Initialize entry count to 0
      Atomics.store(this.entryCount, 0, 0);

      logger.info('SharedKeyRegistry created', {
        maxKeys: this.config.maxKeys,
        slotSize: this.slotSize,
        bufferSize
      });
    }
  }

  /**
   * Get the SharedArrayBuffer for passing to workers.
   */
  getBuffer(): SharedArrayBuffer {
    return this.buffer;
  }

  /**
   * Register a new key-to-index mapping (main thread only — single writer).
   *
   * IMPORTANT: This method must only be called from the main thread.
   * Workers must use lookup() which is read-only.
   *
   * Write-then-publish pattern: All slot data (key bytes + index) is written
   * BEFORE the entry count is incremented via Atomics.store (release semantics).
   * Workers calling lookup() use Atomics.load (acquire semantics), so they
   * will never see a partially-written slot.
   *
   * @param key - The key string (max 60 bytes UTF-8)
   * @param index - The array index for this key
   * @returns true if registered, false if registry is full or key exists
   */
  register(key: string, index: number): boolean {
    // Check if key already exists in cache
    if (this.keyToIndexCache.has(key)) {
      return false;
    }

    // Validate key size before attempting registration
    const keyBytes = Buffer.byteLength(key, 'utf8');
    if (keyBytes > this.keySize) {
      logger.warn('Key too large for registry', {
        key,
        keyBytes,
        maxBytes: this.keySize
      });
      return false;
    }

    const currentCount = Atomics.load(this.entryCount, 0);

    // Check if registry is full
    if (currentCount >= this.config.maxKeys) {
      logger.warn('SharedKeyRegistry is full', {
        maxKeys: this.config.maxKeys,
        currentCount
      });
      return false;
    }

    const slotOffset = this.headerSize + (currentCount * this.slotSize);

    // Write key bytes to slot FIRST (before publishing via entryCount)
    const keyBuffer = Buffer.from(key, 'utf8');
    for (let i = 0; i < this.keySize; i++) {
      const byte = i < keyBuffer.length ? keyBuffer[i] : 0;
      this.dataView.setUint8(slotOffset + i, byte);
    }

    // Write index (last 4 bytes of slot)
    this.dataView.setInt32(slotOffset + this.keySize, index, true);

    // PUBLISH: Atomics.store has release semantics — all prior writes
    // (key bytes + index) are guaranteed visible to any thread that
    // subsequently reads this count via Atomics.load (acquire semantics).
    // This eliminates the race where workers could see an incremented count
    // but read a partially-written slot.
    Atomics.store(this.entryCount, 0, currentCount + 1);

    // Update local cache
    this.keyToIndexCache.set(key, index);

    return true;
  }

  /**
   * Look up the index for a key (thread-safe, usable by workers).
   * Performs linear scan through registry.
   *
   * @param key - The key to look up
   * @returns The index, or -1 if not found
   */
  lookup(key: string): number {
    // Check local cache first (main thread only)
    if (this.keyToIndexCache.size > 0) {
      const cached = this.keyToIndexCache.get(key);
      if (cached !== undefined) {
        return cached;
      }
    }

    // Load entry count
    const count = Atomics.load(this.entryCount, 0);
    if (count === 0) {
      return -1;
    }

    // Convert key to bytes for comparison
    const keyBuffer = Buffer.from(key, 'utf8');
    const keyLen = Math.min(keyBuffer.length, this.keySize);

    // Linear scan through slots
    for (let i = 0; i < count; i++) {
      const slotOffset = this.headerSize + (i * this.slotSize);

      // Compare key bytes
      let match = true;
      for (let j = 0; j < keyLen; j++) {
        if (this.dataView.getUint8(slotOffset + j) !== keyBuffer[j]) {
          match = false;
          break;
        }
      }

      // Verify rest of slot is null-padded (key ends)
      if (match) {
        for (let j = keyLen; j < this.keySize; j++) {
          if (this.dataView.getUint8(slotOffset + j) !== 0) {
            match = false;
            break;
          }
        }
      }

      if (match) {
        // Found it - read index from last 4 bytes
        const index = this.dataView.getInt32(slotOffset + this.keySize, true);

        // Update local cache
        this.keyToIndexCache.set(key, index);

        return index;
      }
    }

    return -1;
  }

  /**
   * Get all registered key-index pairs.
   * Useful for debugging and verification.
   *
   * @returns Array of [key, index] pairs
   */
  getAllEntries(): Array<[string, number]> {
    const entries: Array<[string, number]> = [];
    const count = Atomics.load(this.entryCount, 0);

    for (let i = 0; i < count; i++) {
      const slotOffset = this.headerSize + (i * this.slotSize);

      // Read key string (find null terminator)
      const keyBytes: number[] = [];
      for (let j = 0; j < this.keySize; j++) {
        const byte = this.dataView.getUint8(slotOffset + j);
        if (byte === 0) break;
        keyBytes.push(byte);
      }

      if (keyBytes.length > 0) {
        const key = Buffer.from(keyBytes).toString('utf8');
        const index = this.dataView.getInt32(slotOffset + this.keySize, true);
        entries.push([key, index]);
      }
    }

    return entries;
  }

  /**
   * Get registry statistics.
   */
  getStats(): {
    entryCount: number;
    maxKeys: number;
    utilizationPercent: number;
    bufferSize: number;
  } {
    const count = Atomics.load(this.entryCount, 0);
    return {
      entryCount: count,
      maxKeys: this.config.maxKeys,
      utilizationPercent: (count / this.config.maxKeys) * 100,
      bufferSize: this.buffer.byteLength
    };
  }

  /**
   * Clear all entries (main thread only).
   * Resets entry count to 0.
   */
  clear(): void {
    Atomics.store(this.entryCount, 0, 0);
    this.keyToIndexCache.clear();
    logger.debug('SharedKeyRegistry cleared');
  }
}
