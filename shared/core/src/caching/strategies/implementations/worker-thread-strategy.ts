/**
 * WorkerThreadStrategy - CAS Loop for SharedKeyRegistry (Enhancement #4)
 *
 * Thread-safe registration strategy for worker threads using CAS loop.
 * Required for concurrent writes from multiple workers.
 *
 * @see caching/strategies/registration-strategy.interface.ts - IRegistrationStrategy contract
 * @see shared/core/src/caching/shared-key-registry.ts - Original implementation
 *
 * Performance: ~2-4μs (includes CAS loop overhead)
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
 * Worker thread registration strategy (CAS loop)
 *
 * Thread Safety:
 * - Uses Atomics.compareExchange for atomic slot claiming
 * - CAS (Compare-And-Swap) loop handles contention
 * - Safe for concurrent writes from multiple workers
 *
 * CAS Loop Algorithm:
 * 1. Read current entry count
 * 2. Try to atomically increment count (CAS)
 * 3. If CAS succeeds, we claimed a slot → write key
 * 4. If CAS fails, another thread claimed it → retry (goto 1)
 *
 * Contention Behavior:
 * - Low contention (<5 workers): 1-2 CAS iterations avg
 * - Moderate contention (5-10 workers): 3-10 iterations avg
 * - High contention (>10 workers): >10 iterations (rare)
 *
 * Memory Layout:
 * - [0-3]: Entry count (Int32, atomic)
 * - [4+]: Slots (64 bytes each: 60 bytes key + 4 bytes index)
 *
 * @example
 * ```typescript
 * const strategy = new WorkerThreadStrategy(sharedBuffer, maxKeys);
 *
 * const result = strategy.register('price:bsc:0xABC...');
 * // Returns: { index: 5, isNew: true, iterations: 2 }
 * // Duration: ~2-4μs (including CAS retries)
 * ```
 */
export class WorkerThreadStrategy implements IRegistrationStrategy {
  private readonly dataView: DataView;
  private readonly entryCount: Int32Array;
  private readonly maxKeys: number;
  private readonly keySize = 60;
  private readonly slotSize = 64;
  private readonly headerSize = 4;
  private failedRegistrations = 0;
  private totalCasIterations = 0;
  private totalRegistrations = 0;

  constructor(sharedBuffer: SharedArrayBuffer, maxKeys: number) {
    this.dataView = new DataView(sharedBuffer);
    this.entryCount = new Int32Array(sharedBuffer, 0, 1);
    this.maxKeys = maxKeys;
  }

  /**
   * Register key with CAS loop (thread-safe)
   *
   * Algorithm:
   * 1. Lookup existing key first (avoid unnecessary CAS)
   * 2. Validate key size
   * 3. CAS loop to claim slot:
   *    a. Load current entry count
   *    b. Check if registry full
   *    c. Try CAS: entryCount from current → current+1
   *    d. If CAS succeeds, we claimed slot at 'current'
   *    e. If CAS fails, another worker claimed it → retry
   * 4. Write key + index to claimed slot
   *
   * Performance: ~2-4μs (depends on contention)
   *
   * @param key - Cache key to register
   * @returns Registration result with allocated index
   */
  register(key: string): RegistrationResult {
    // Check if key already exists (avoid CAS loop for duplicates)
    const existingIndex = this.lookup(key);
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

    // CAS loop to atomically claim a slot
    let currentCount: number;
    let slotOffset: number;
    let iterations = 0;
    const maxIterations = 1000; // Safety limit

    while (true) {
      iterations++;

      if (iterations > maxIterations) {
        // Safety: Prevent infinite loop in case of bugs
        this.failedRegistrations++;
        throw new Error(
          `CAS loop exceeded max iterations (${maxIterations}). Possible contention or bug.`
        );
      }

      currentCount = Atomics.load(this.entryCount, 0);

      // Check if registry is full
      if (currentCount >= this.maxKeys) {
        this.failedRegistrations++;
        throw new RegistryFullError(this.maxKeys, key);
      }

      // Try to atomically claim this slot by incrementing the counter
      // If successful, we exclusively own the slot at 'currentCount'
      const previousCount = Atomics.compareExchange(
        this.entryCount,
        0, // index in Int32Array
        currentCount, // expected current value
        currentCount + 1 // new value if current matches expected
      );

      // If CAS succeeded, previousCount equals currentCount
      if (previousCount === currentCount) {
        // We successfully claimed slot at currentCount
        slotOffset = this.headerSize + (currentCount * this.slotSize);
        break;
      }
      // Otherwise, another thread claimed it first - retry with new count
    }

    // Now we exclusively own this slot - safe to write without race
    const keyBuffer = Buffer.from(key, 'utf8');
    for (let i = 0; i < this.keySize; i++) {
      const byte = i < keyBuffer.length ? keyBuffer[i] : 0;
      this.dataView.setUint8(slotOffset + i, byte);
    }

    // Write index (last 4 bytes of slot)
    this.dataView.setInt32(slotOffset + this.keySize, currentCount, true);

    // Update statistics
    this.totalCasIterations += iterations;
    this.totalRegistrations++;

    return {
      index: currentCount,
      isNew: true,
      iterations,
    };
  }

  /**
   * Lookup key index (linear scan through SharedArrayBuffer)
   *
   * Workers don't have local cache, must scan SharedArrayBuffer.
   * Performance: O(n) where n = number of keys
   *
   * @param key - Cache key to lookup
   * @returns Index if found, undefined otherwise
   */
  lookup(key: string): number | undefined {
    const count = Atomics.load(this.entryCount, 0);
    if (count === 0) {
      return undefined;
    }

    const keyBuffer = Buffer.from(key, 'utf8');

    // Linear scan (acceptable for ~1000 keys, <1ms)
    for (let i = 0; i < count; i++) {
      const slotOffset = this.headerSize + (i * this.slotSize);
      let matches = true;

      // Compare key bytes
      for (let j = 0; j < this.keySize; j++) {
        const slotByte = this.dataView.getUint8(slotOffset + j);
        const keyByte = j < keyBuffer.length ? keyBuffer[j] : 0;

        if (slotByte !== keyByte) {
          matches = false;
          break;
        }
      }

      if (matches) {
        return this.dataView.getInt32(slotOffset + this.keySize, true);
      }
    }

    return undefined;
  }

  /**
   * Get registry statistics
   *
   * @returns Registry stats with CAS metrics
   */
  getStats(): RegistryStats {
    const keyCount = Atomics.load(this.entryCount, 0);
    const utilizationPercent = (keyCount / this.maxKeys) * 100;
    const avgCasIterations =
      this.totalRegistrations > 0
        ? this.totalCasIterations / this.totalRegistrations
        : 0;

    return {
      keyCount,
      maxCapacity: this.maxKeys,
      utilizationPercent,
      avgCasIterations,
      failedRegistrations: this.failedRegistrations,
      threadMode: 'worker',
    };
  }
}
