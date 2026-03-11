/**
 * OPT-004: Shared Key Registry with FNV-1a Hash Table
 *
 * Provides thread-safe key-to-index mapping using SharedArrayBuffer.
 * Main thread writes key mappings, workers read them for zero-copy price lookups.
 *
 * Architecture:
 * - FNV-1a hash table for O(1) lookups (was O(n) linear scan)
 * - Open addressing with linear probing for collision resolution
 * - Load factor ≤ 0.5 (hash table size = next power of 2 ≥ maxKeys × 2)
 * - Fixed-size slots (64 bytes each): key string (60 bytes) + index (4 bytes)
 * - Atomics for thread-safe publish/subscribe between main thread and workers
 *
 * Buffer Layout:
 * [4 bytes: entry count (Int32)]
 * [4 bytes: hash table size (Int32)]
 * [hashTableSize × 4 bytes: hash buckets (Int32, -1 = empty)]
 * [slot 0: 60 bytes key + 4 bytes index]
 * [slot 1: 60 bytes key + 4 bytes index]
 * ...
 *
 * Memory overhead per configuration:
 * - 1,000 keys:  64KB slots + 8KB hash = 72KB total
 * - 10,000 keys: 640KB slots + 128KB hash = 768KB total
 *
 * @see ADR-005 L1 Cache
 */

import { createLogger } from '../logger';

const logger = createLogger('shared-key-registry');

// FNV-1a 32-bit constants
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

// Hash table empty sentinel
const EMPTY_BUCKET = -1;

/** Next power of 2 >= n (minimum 2) */
function nextPowerOf2(n: number): number {
  if (n <= 2) return 2;
  n--;
  n |= n >> 1;
  n |= n >> 2;
  n |= n >> 4;
  n |= n >> 8;
  n |= n >> 16;
  return n + 1;
}

// Registry configuration
export interface KeyRegistryConfig {
  /** Maximum number of keys that can be stored */
  maxKeys: number;
  /** Size of each key slot in bytes (default: 64) */
  slotSize?: number;
}

/**
 * SharedArrayBuffer-backed key registry with FNV-1a hash table.
 *
 * Thread safety model (single writer, multiple readers):
 * - Main thread calls register() (writes slots + hash buckets)
 * - Workers call lookup() (reads hash buckets + slot data)
 * - Atomics.store on hash buckets provides release semantics (publish)
 * - Atomics.load on hash buckets provides acquire semantics (subscribe)
 * - Workers never see a hash bucket pointing to a partially-written slot
 */
export class SharedKeyRegistry {
  private config: Required<KeyRegistryConfig>;
  private buffer: SharedArrayBuffer;
  private dataView: DataView;
  private entryCount: Int32Array;
  private hashTable: Int32Array;
  private readonly keySize = 60;
  private readonly slotSize: number;
  private readonly headerSize = 8; // 4 bytes entry count + 4 bytes hash table size
  private hashTableSize: number;
  private slotsOffset: number;
  private readonly isWriter: boolean;

  // Local cache for faster lookups (works on both main thread and workers)
  private keyToIndexCache: Map<string, number> = new Map();

  constructor(config: KeyRegistryConfig, existingBuffer?: SharedArrayBuffer) {
    this.config = {
      maxKeys: config.maxKeys,
      slotSize: config.slotSize ?? 64
    };

    this.slotSize = this.config.slotSize;

    this.isWriter = !existingBuffer;

    if (existingBuffer) {
      // Worker mode: Attach to existing buffer, read layout from header
      this.buffer = existingBuffer;
      this.dataView = new DataView(this.buffer);
      this.entryCount = new Int32Array(this.buffer, 0, 1);
      this.hashTableSize = Atomics.load(new Int32Array(this.buffer, 4, 1), 0);
      this.slotsOffset = this.headerSize + this.hashTableSize * 4;
      this.hashTable = new Int32Array(this.buffer, this.headerSize, this.hashTableSize);
      logger.debug('SharedKeyRegistry attached to existing buffer', {
        maxKeys: this.config.maxKeys,
        hashTableSize: this.hashTableSize,
        bufferSize: this.buffer.byteLength
      });
    } else {
      // Main thread mode: Create new buffer with hash table
      this.hashTableSize = nextPowerOf2(this.config.maxKeys * 2);
      this.slotsOffset = this.headerSize + this.hashTableSize * 4;
      const bufferSize = this.slotsOffset + (this.config.maxKeys * this.slotSize);
      this.buffer = new SharedArrayBuffer(bufferSize);
      this.dataView = new DataView(this.buffer);
      this.entryCount = new Int32Array(this.buffer, 0, 1);
      this.hashTable = new Int32Array(this.buffer, this.headerSize, this.hashTableSize);

      // Initialize header
      Atomics.store(this.entryCount, 0, 0);
      Atomics.store(new Int32Array(this.buffer, 4, 1), 0, this.hashTableSize);

      // Initialize all hash buckets to empty (-1)
      this.hashTable.fill(EMPTY_BUCKET);

      logger.info('SharedKeyRegistry created', {
        maxKeys: this.config.maxKeys,
        hashTableSize: this.hashTableSize,
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
   * Write-then-publish pattern:
   * 1. Write key bytes + index to slot (non-atomic, no readers yet)
   * 2. Write slot index to hash bucket via Atomics.store (release semantics)
   * 3. Increment entry count via Atomics.store
   *
   * Workers using Atomics.load on hash buckets (acquire semantics) will
   * never see a bucket pointing to a partially-written slot.
   *
   * @param key - The key string (max 60 bytes UTF-8)
   * @param index - The array index for this key
   * @returns true if registered, false if registry is full or key exists
   */
  register(key: string, index: number): boolean {
    // H-02: Enforce single-writer invariant — workers must not call register()
    if (!this.isWriter) {
      throw new Error('SharedKeyRegistry.register() called on worker (read-only) instance');
    }

    // Check if key already exists in cache
    if (this.keyToIndexCache.has(key)) {
      return false;
    }

    // L-03: Single Buffer.from() for both validation and slot write
    const keyBuffer = Buffer.from(key, 'utf8');
    const keyLen = keyBuffer.length;

    if (keyLen > this.keySize) {
      logger.warn('Key too large for registry', {
        key,
        keyBytes: keyLen,
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

    // 1. Write key bytes to slot
    const slotOffset = this.slotsOffset + (currentCount * this.slotSize);
    for (let i = 0; i < this.keySize; i++) {
      this.dataView.setUint8(slotOffset + i, i < keyLen ? keyBuffer[i] : 0);
    }

    // 2. Write index (last 4 bytes of slot)
    this.dataView.setInt32(slotOffset + this.keySize, index, true);

    // 3. Insert into hash table via linear probing
    const hash = this.fnv1a32(keyBuffer, keyLen);
    const mask = this.hashTableSize - 1;
    let inserted = false;
    for (let probe = 0; probe < this.hashTableSize; probe++) {
      const bucketIdx = (hash + probe) & mask;
      if (Atomics.load(this.hashTable, bucketIdx) === EMPTY_BUCKET) {
        // PUBLISH: Atomics.store has release semantics — all prior writes
        // (key bytes + index in slot) are guaranteed visible to any thread
        // that subsequently reads this bucket via Atomics.load.
        Atomics.store(this.hashTable, bucketIdx, currentCount);
        inserted = true;
        break;
      }
    }

    // H-01: Guard against hash table full (all buckets occupied)
    if (!inserted) {
      logger.error('Hash table full — no empty bucket found after full probe', {
        key,
        hashTableSize: this.hashTableSize,
        entryCount: currentCount
      });
      return false;
    }

    // 4. Increment entry count (for getAllEntries iteration)
    Atomics.store(this.entryCount, 0, currentCount + 1);

    // Update local cache
    this.keyToIndexCache.set(key, index);

    return true;
  }

  /**
   * Look up the index for a key (thread-safe, usable by workers).
   * Uses FNV-1a hash table for O(1) average-case lookup.
   *
   * @param key - The key to look up
   * @returns The index, or -1 if not found
   */
  lookup(key: string): number {
    // Check local cache first (works on main thread and workers)
    if (this.keyToIndexCache.size > 0) {
      const cached = this.keyToIndexCache.get(key);
      if (cached !== undefined) {
        return cached;
      }
    }

    // Convert key to bytes for hashing and comparison
    const keyBuffer = Buffer.from(key, 'utf8');
    const keyLen = Math.min(keyBuffer.length, this.keySize);
    const hash = this.fnv1a32(keyBuffer, keyLen);
    const mask = this.hashTableSize - 1;

    // Probe hash table with linear probing
    for (let probe = 0; probe < this.hashTableSize; probe++) {
      const bucketIdx = (hash + probe) & mask;
      const slotIdx = Atomics.load(this.hashTable, bucketIdx);

      if (slotIdx === EMPTY_BUCKET) {
        return -1; // Empty bucket = key not in registry
      }

      // Compare key bytes at the referenced slot
      const slotOffset = this.slotsOffset + (slotIdx * this.slotSize);
      if (this.compareKeyAtSlot(slotOffset, keyBuffer, keyLen)) {
        // Found — read index from last 4 bytes of slot
        const index = this.dataView.getInt32(slotOffset + this.keySize, true);
        this.keyToIndexCache.set(key, index);
        return index;
      }
      // Hash collision — continue probing
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
      const slotOffset = this.slotsOffset + (i * this.slotSize);

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
    hashTableSize: number;
  } {
    const count = Atomics.load(this.entryCount, 0);
    return {
      entryCount: count,
      maxKeys: this.config.maxKeys,
      utilizationPercent: (count / this.config.maxKeys) * 100,
      bufferSize: this.buffer.byteLength,
      hashTableSize: this.hashTableSize
    };
  }

  /**
   * Clear all entries (main thread only).
   * Resets entry count, hash table buckets, and local cache.
   *
   * IMPORTANT: Worker instances cache lookup results in `keyToIndexCache`.
   * After clearing, existing worker instances will return stale cached values.
   * Workers must be recreated (new SharedKeyRegistry with the same buffer)
   * to see the cleared state.
   */
  clear(): void {
    Atomics.store(this.entryCount, 0, 0);
    this.hashTable.fill(EMPTY_BUCKET);
    this.keyToIndexCache.clear();
    logger.debug('SharedKeyRegistry cleared');
  }

  /** FNV-1a 32-bit hash of key bytes */
  private fnv1a32(keyBuffer: Buffer, keyLen: number): number {
    let hash = FNV_OFFSET_BASIS;
    for (let i = 0; i < keyLen; i++) {
      hash ^= keyBuffer[i];
      hash = Math.imul(hash, FNV_PRIME) >>> 0;
    }
    return hash;
  }

  /** Compare key bytes at a slot offset against a key buffer */
  private compareKeyAtSlot(slotOffset: number, keyBuffer: Buffer, keyLen: number): boolean {
    for (let j = 0; j < keyLen; j++) {
      if (this.dataView.getUint8(slotOffset + j) !== keyBuffer[j]) {
        return false;
      }
    }
    // Verify rest of slot is null-padded (exact key match, no prefix collision)
    for (let j = keyLen; j < this.keySize; j++) {
      if (this.dataView.getUint8(slotOffset + j) !== 0) {
        return false;
      }
    }
    return true;
  }
}
