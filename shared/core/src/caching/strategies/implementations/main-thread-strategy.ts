/**
 * MainThreadStrategy - Fast Path for SharedKeyRegistry (Enhancement #4)
 *
 * Optimized registration strategy for main thread with direct cache access.
 * Skips CAS loop since main thread has exclusive write access.
 *
 * @see caching/strategies/registration-strategy.interface.ts - IRegistrationStrategy contract
 * @see docs/architecture/adr/ADR-005-hierarchical-cache.md - Performance targets
 *
 * Performance: ~50ns (vs ~2-4μs for worker thread CAS loop)
 *
 * @package @arbitrage/core
 * @module caching/strategies/implementations
 */

import {
  IRegistrationStrategy,
  RegistrationResult,
  RegistryStats,
  RegistryFullError,
  InvalidKeyError,
} from '../registration-strategy.interface';

/**
 * Main thread registration strategy (fast path)
 *
 * Optimization Rationale:
 * - Main thread writes are serialized by nature (single threaded)
 * - No contention possible → CAS loop unnecessary
 * - Direct cache access + simple counter increment = ~50ns
 * - 99% of writes happen on main thread
 *
 * Thread Safety:
 * - Assumes exclusive write access (main thread only)
 * - Still uses Atomics for entry count (readable by workers)
 * - NOT safe for concurrent writes
 *
 * Memory Layout:
 * - [0-3]: Entry count (Int32, atomic)
 * - [4+]: Slots (64 bytes each: 60 bytes key + 4 bytes index)
 *
 * @example
 * ```typescript
 * const strategy = new MainThreadStrategy(sharedBuffer, maxKeys);
 *
 * const result = strategy.register('price:bsc:0xABC...');
 * // Returns: { index: 0, isNew: true, iterations: 0 }
 * // Duration: ~50ns
 * ```
 */
export class MainThreadStrategy implements IRegistrationStrategy {
  private readonly dataView: DataView;
  private readonly entryCount: Int32Array;
  private readonly keyToIndexCache: Map<string, number>;
  private readonly maxKeys: number;
  private readonly keySize = 60;
  private readonly slotSize = 64;
  private readonly headerSize = 4;
  private failedRegistrations = 0;

  constructor(sharedBuffer: SharedArrayBuffer, maxKeys: number) {
    this.dataView = new DataView(sharedBuffer);
    this.entryCount = new Int32Array(sharedBuffer, 0, 1);
    this.keyToIndexCache = new Map();
    this.maxKeys = maxKeys;
  }

  /**
   * Register key with fast path (NO CAS loop)
   *
   * Algorithm (optimized for main thread):
   * 1. Check local cache (O(1) hash lookup)
   * 2. If found, return existing index
   * 3. Validate key size
   * 4. Atomically increment entry count (single operation)
   * 5. Write key + index to claimed slot
   * 6. Update local cache
   *
   * Performance: ~50ns (no CAS loop overhead)
   *
   * @param key - Cache key to register
   * @returns Registration result with allocated index
   */
  register(key: string): RegistrationResult {
    // Fast path: Check local cache first (O(1))
    const existingIndex = this.keyToIndexCache.get(key);
    if (existingIndex !== undefined) {
      return {
        index: existingIndex,
        isNew: false,
        iterations: 0,
      };
    }

    // Validate key size
    const keyBytes = Buffer.byteLength(key, 'utf8');
    if (keyBytes > this.keySize) {
      throw new InvalidKeyError(
        key,
        `Key too large: ${keyBytes} bytes (max: ${this.keySize})`
      );
    }

    // Check if registry is full
    const currentCount = Atomics.load(this.entryCount, 0);
    if (currentCount >= this.maxKeys) {
      this.failedRegistrations++;
      throw new RegistryFullError(this.maxKeys, key);
    }

    // Fast path: Direct increment (no CAS loop needed)
    // Since main thread has exclusive write access, no contention possible
    const allocatedIndex = currentCount;
    Atomics.store(this.entryCount, 0, currentCount + 1);

    // Write key to slot
    const slotOffset = this.headerSize + (allocatedIndex * this.slotSize);
    const keyBuffer = Buffer.from(key, 'utf8');

    for (let i = 0; i < this.keySize; i++) {
      const byte = i < keyBuffer.length ? keyBuffer[i] : 0;
      this.dataView.setUint8(slotOffset + i, byte);
    }

    // Write index (last 4 bytes of slot)
    this.dataView.setInt32(slotOffset + this.keySize, allocatedIndex, true);

    // Update local cache
    this.keyToIndexCache.set(key, allocatedIndex);

    return {
      index: allocatedIndex,
      isNew: true,
      iterations: 0, // No CAS iterations on main thread
    };
  }

  /**
   * Lookup key index (fast path with local cache)
   *
   * @param key - Cache key to lookup
   * @returns Index if found, undefined otherwise
   */
  lookup(key: string): number | undefined {
    // Fast path: Local cache (O(1))
    const cached = this.keyToIndexCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Fallback: Scan SharedArrayBuffer (for keys registered before cache init)
    const count = Atomics.load(this.entryCount, 0);
    const keyBuffer = Buffer.from(key, 'utf8');

    for (let i = 0; i < count; i++) {
      const slotOffset = this.headerSize + (i * this.slotSize);
      let matches = true;

      for (let j = 0; j < this.keySize; j++) {
        const slotByte = this.dataView.getUint8(slotOffset + j);
        const keyByte = j < keyBuffer.length ? keyBuffer[j] : 0;

        if (slotByte !== keyByte) {
          matches = false;
          break;
        }
      }

      if (matches) {
        const index = this.dataView.getInt32(slotOffset + this.keySize, true);
        // Update cache for future lookups
        this.keyToIndexCache.set(key, index);
        return index;
      }
    }

    return undefined;
  }

  /**
   * Get registry statistics
   *
   * @returns Registry stats
   */
  getStats(): RegistryStats {
    const keyCount = Atomics.load(this.entryCount, 0);
    const utilizationPercent = (keyCount / this.maxKeys) * 100;

    return {
      keyCount,
      maxCapacity: this.maxKeys,
      utilizationPercent,
      avgCasIterations: 0, // Main thread never uses CAS loop
      failedRegistrations: this.failedRegistrations,
      threadMode: 'main',
    };
  }
}
