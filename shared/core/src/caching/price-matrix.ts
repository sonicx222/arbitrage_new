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
 * - 4 bytes: sequence counter (Int32 - odd=write in progress, even=consistent)
 * Total: 16 bytes per pair
 * For 1000 pairs: ~16KB data + ~4KB index = ~20KB total
 *
 * Thread Safety (Fix #7):
 * Sequence counter protocol prevents torn reads:
 * - Writer: increment seq to odd -> write price+timestamp -> set seq to even
 * - Reader: read seq (retry if odd) -> read price+timestamp -> re-read seq (retry if changed)
 */

import { createLogger } from '../logger';
import type { Resettable } from '@arbitrage/types';
import { SharedKeyRegistry } from './shared-key-registry';

const logger = createLogger('price-matrix');

// =============================================================================
// Types
// =============================================================================

export interface PriceMatrixConfig {
  maxPairs: number;        // Maximum number of pairs to store (default: 1000)
  reserveSlots: number;    // Extra slots for dynamic pairs (default: 100)
  strictMode: boolean;     // If true, getOffset returns -1 for unknown keys
  enableAtomics: boolean;  // Enable Atomics for thread safety (default: true)
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

// =============================================================================
// Price Index Mapper
// =============================================================================

/**
 * Error thrown when the PriceIndexMapper is full and cannot allocate new keys.
 * P0-FIX 4.3: Instead of silently using hash-based collision (which overwrites data),
 * we now throw an explicit error to prevent data corruption.
 */
export class PriceMatrixFullError extends Error {
  readonly key: string;
  readonly maxIndex: number;

  constructor(key: string, maxIndex: number) {
    super(`PriceMatrix is full: cannot add key "${key}". Max capacity: ${maxIndex}`);
    this.name = 'PriceMatrixFullError';
    this.key = key;
    this.maxIndex = maxIndex;
  }
}

/**
 * Maps string keys ("chain:dex:pair") to array offsets with O(1) complexity.
 * Uses sequential allocation for deterministic, collision-free mapping.
 */
export class PriceIndexMapper {
  private keyToIndex: Map<string, number> = new Map();
  private indexToKey: Map<number, string> = new Map();
  private nextIndex = 0;
  private readonly maxIndex: number;

  constructor(maxIndex: number) {
    this.maxIndex = maxIndex;
  }

  /**
   * Check if the mapper can accept new keys.
   * @returns true if there's capacity for more keys
   */
  hasCapacity(): boolean {
    return this.nextIndex < this.maxIndex;
  }

  /**
   * Get remaining capacity (number of new keys that can be added).
   */
  getRemainingCapacity(): number {
    return Math.max(0, this.maxIndex - this.nextIndex);
  }

  /**
   * Get or create index for a key.
   * Returns existing index if key is known, or allocates new one.
   *
   * P0-FIX 4.3: When all slots are used, returns -1 instead of using
   * hash-based collision which could overwrite existing price data.
   *
   * @returns Index for the key, or -1 if mapper is full and key is new
   */
  getIndex(key: string): number {
    // Fast path: key already exists
    const existing = this.keyToIndex.get(key);
    if (existing !== undefined) {
      return existing;
    }

    // Slow path: allocate new index
    if (this.nextIndex >= this.maxIndex) {
      // P0-FIX 4.3: Return -1 instead of hash collision to prevent data corruption
      // The caller (PriceMatrix) should handle this by logging a warning and skipping the update
      logger.warn('PriceIndexMapper: All slots used, cannot allocate new key', {
        key,
        usedSlots: this.nextIndex,
        maxIndex: this.maxIndex
      });
      return -1;
    }

    const index = this.nextIndex++;
    this.keyToIndex.set(key, index);
    this.indexToKey.set(index, key);
    return index;
  }

  /**
   * Get or create index for a key, throwing if full.
   * Use this when you need guaranteed allocation.
   *
   * @throws PriceMatrixFullError if mapper is full and key is new
   */
  getIndexOrThrow(key: string): number {
    const index = this.getIndex(key);
    if (index === -1) {
      throw new PriceMatrixFullError(key, this.maxIndex);
    }
    return index;
  }

  /**
   * Get key for a given index.
   * Returns null if index is unused.
   */
  getKey(index: number): string | null {
    return this.indexToKey.get(index) ?? null;
  }

  /**
   * Check if a key is registered.
   */
  hasKey(key: string): boolean {
    return this.keyToIndex.has(key);
  }

  /**
   * Get usage statistics.
   */
  getStats(): { usedSlots: number; totalSlots: number; utilizationPercent: number } {
    return {
      usedSlots: this.keyToIndex.size,
      totalSlots: this.maxIndex,
      utilizationPercent: (this.keyToIndex.size / this.maxIndex) * 100
    };
  }

  /**
   * Clear all mappings.
   */
  clear(): void {
    this.keyToIndex.clear();
    this.indexToKey.clear();
    this.nextIndex = 0;
  }
}

// =============================================================================
// Price Matrix
// =============================================================================

// Fix #7: Bytes per pair constant (8 price + 4 timestamp + 4 sequence = 16)
const BYTES_PER_PAIR = 16;
// Fix #7: Max retries for sequence counter spin loop to prevent livelock
const MAX_SEQ_RETRIES = 100;

export class PriceMatrix implements Resettable {
  private config: PriceMatrixConfig;
  private mapper: PriceIndexMapper;

  // SharedArrayBuffer backing storage
  private sharedBuffer: SharedArrayBuffer | null = null;
  private priceArray: Float64Array | null = null;
  private timestampArray: Int32Array | null = null; // Int32Array for Atomics compatibility
  // Fix #7: Sequence counter array for torn read protection
  private sequenceArray: Int32Array | null = null;

  // PHASE3-TASK43: Shared key registry for worker thread access
  private keyRegistry: SharedKeyRegistry | null = null;
  private isWorkerMode = false; // Set to true when created via fromSharedBuffer

  // Fallback arrays if SharedArrayBuffer is not available
  private fallbackPrices: Float64Array | null = null;
  private fallbackTimestamps: Int32Array | null = null; // Int32Array for consistency
  private fallbackSequences: Int32Array | null = null; // Fix #7: fallback sequence counters
  private useSharedMemory = false;

  // Cached DataView for atomic operations (avoids allocation per operation)
  private dataView: DataView | null = null;

  // Epoch for relative timestamps (reduce timestamp storage size)
  private readonly timestampEpoch: number;

  // Track which slots have been written to
  private writtenSlots: Set<number> = new Set();

  // Statistics
  private stats: PriceMatrixStats = {
    reads: 0,
    writes: 0,
    hits: 0,
    misses: 0,
    batchReads: 0,
    batchWrites: 0
  };

  // Lifecycle state
  private destroyed = false;

  constructor(config: Partial<PriceMatrixConfig> = {}) {
    // Validate config values
    if (config.maxPairs !== undefined && config.maxPairs <= 0) {
      throw new Error('maxPairs must be positive');
    }
    if (config.reserveSlots !== undefined && config.reserveSlots < 0) {
      throw new Error('reserveSlots must be non-negative');
    }

    this.config = {
      maxPairs: config.maxPairs ?? 1000,
      reserveSlots: config.reserveSlots ?? 100,
      strictMode: config.strictMode ?? false,
      enableAtomics: config.enableAtomics ?? true
    };

    const totalSlots = this.config.maxPairs + this.config.reserveSlots;
    this.mapper = new PriceIndexMapper(totalSlots);

    // Use epoch from 2024-01-01 to keep timestamps small
    this.timestampEpoch = new Date('2024-01-01T00:00:00Z').getTime();

    this.initializeArrays(totalSlots);

    // PHASE3-TASK43: Initialize SharedKeyRegistry for worker access
    if (this.useSharedMemory) {
      try {
        this.keyRegistry = new SharedKeyRegistry({
          maxKeys: this.config.maxPairs + this.config.reserveSlots
        });
        logger.debug('SharedKeyRegistry initialized for worker access');
      } catch (error) {
        logger.warn('Failed to initialize SharedKeyRegistry', { error });
        this.keyRegistry = null;
      }
    }

    logger.info('PriceMatrix initialized', {
      maxPairs: this.config.maxPairs,
      totalSlots,
      useSharedMemory: this.useSharedMemory,
      keyRegistryEnabled: this.keyRegistry !== null
    });
  }

  /**
   * PHASE3-TASK42/43: Create PriceMatrix from existing SharedArrayBuffer.
   * Used by worker threads to access price data without copying.
   *
   * @param buffer - SharedArrayBuffer containing price and timestamp data
   * @param keyRegistryBuffer - SharedArrayBuffer containing key-to-index mappings
   * @param config - Optional configuration (maxPairs, reserveSlots)
   * @returns PriceMatrix instance wrapping the shared buffer
   */
  static fromSharedBuffer(
    buffer: SharedArrayBuffer,
    keyRegistryBuffer: SharedArrayBuffer | null = null,
    config: Partial<Pick<PriceMatrixConfig, 'maxPairs' | 'reserveSlots' | 'enableAtomics'>> = {}
  ): PriceMatrix {
    // Calculate total slots from buffer size
    // Fix #7: Buffer layout: [Float64 prices][Int32 timestamps][Int32 sequences]
    // Each entry: 8 bytes (price) + 4 bytes (timestamp) + 4 bytes (sequence) = 16 bytes total
    const totalBytes = buffer.byteLength;
    const totalSlots = Math.floor(totalBytes / BYTES_PER_PAIR);

    if (totalSlots <= 0) {
      throw new Error('SharedArrayBuffer too small for PriceMatrix');
    }

    // Infer maxPairs and reserveSlots from buffer size
    const reserveSlots = config.reserveSlots ?? 100;
    const maxPairs = config.maxPairs ?? (totalSlots - reserveSlots);

    if (maxPairs + reserveSlots > totalSlots) {
      throw new Error(`Buffer size mismatch: need ${maxPairs + reserveSlots} slots, but buffer has ${totalSlots}`);
    }

    // Create instance with minimal config (don't allocate new buffer)
    const instance = Object.create(PriceMatrix.prototype) as PriceMatrix;

    instance.config = {
      maxPairs,
      reserveSlots,
      strictMode: false,
      enableAtomics: config.enableAtomics ?? true
    };

    instance.mapper = new PriceIndexMapper(totalSlots);
    // Use Object.defineProperty to set readonly field
    Object.defineProperty(instance, 'timestampEpoch', {
      value: new Date('2024-01-01T00:00:00Z').getTime(),
      writable: false,
      enumerable: true,
      configurable: false
    });
    instance.destroyed = false;
    instance.writtenSlots = new Set();
    instance.stats = {
      reads: 0,
      writes: 0,
      hits: 0,
      misses: 0,
      batchReads: 0,
      batchWrites: 0
    };

    // Attach to existing SharedArrayBuffer
    instance.sharedBuffer = buffer;
    const priceBytes = totalSlots * 8;
    const timestampBytes = totalSlots * 4;
    instance.priceArray = new Float64Array(buffer, 0, totalSlots);
    instance.timestampArray = new Int32Array(buffer, priceBytes, totalSlots);
    // Fix #7: Sequence counter array after timestamps
    instance.sequenceArray = new Int32Array(buffer, priceBytes + timestampBytes, totalSlots);
    instance.dataView = new DataView(buffer);
    instance.useSharedMemory = true;

    // No fallback arrays needed
    instance.fallbackPrices = null;
    instance.fallbackTimestamps = null;
    instance.fallbackSequences = null;

    // PHASE3-TASK43: Attach to SharedKeyRegistry if provided
    if (keyRegistryBuffer) {
      try {
        instance.keyRegistry = new SharedKeyRegistry(
          { maxKeys: totalSlots },
          keyRegistryBuffer
        );
        instance.isWorkerMode = true; // Mark as worker mode
        logger.debug('Worker attached to SharedKeyRegistry');
      } catch (error) {
        logger.warn('Failed to attach SharedKeyRegistry in worker', { error });
        instance.keyRegistry = null;
        instance.isWorkerMode = false;
      }
    } else {
      instance.keyRegistry = null;
      instance.isWorkerMode = false;
    }

    logger.debug('PriceMatrix created from SharedArrayBuffer', {
      maxPairs: instance.config.maxPairs,
      totalSlots,
      bufferSize: totalBytes,
      hasKeyRegistry: instance.keyRegistry !== null,
      isWorkerMode: instance.isWorkerMode
    });

    return instance;
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  private initializeArrays(totalSlots: number): void {
    // Calculate buffer size
    // Fix #7: Each slot: 8 bytes (Float64) + 4 bytes (Int32 timestamp) + 4 bytes (Int32 sequence) = 16 bytes
    const priceBytes = totalSlots * 8;
    const timestampBytes = totalSlots * 4;
    const sequenceBytes = totalSlots * 4;
    const totalBytes = priceBytes + timestampBytes + sequenceBytes;

    try {
      // Try to use SharedArrayBuffer for true shared memory
      if (typeof SharedArrayBuffer !== 'undefined') {
        this.sharedBuffer = new SharedArrayBuffer(totalBytes);
        this.priceArray = new Float64Array(this.sharedBuffer, 0, totalSlots);
        this.timestampArray = new Int32Array(this.sharedBuffer, priceBytes, totalSlots);
        // Fix #7: Sequence counter array after timestamps
        this.sequenceArray = new Int32Array(this.sharedBuffer, priceBytes + timestampBytes, totalSlots);
        this.dataView = new DataView(this.sharedBuffer); // Cache DataView for atomic ops
        this.useSharedMemory = true;
        logger.debug('Using SharedArrayBuffer for price storage');
      } else {
        throw new Error('SharedArrayBuffer not available');
      }
    } catch (error) {
      // Fallback to regular ArrayBuffer
      logger.warn('SharedArrayBuffer not available, falling back to ArrayBuffer', { error });
      this.fallbackPrices = new Float64Array(totalSlots);
      this.fallbackTimestamps = new Int32Array(totalSlots);
      this.fallbackSequences = new Int32Array(totalSlots);
      this.useSharedMemory = false;
    }

    // Initialize all values to 0/NaN to indicate empty slots
    this.clearArrays();
  }

  private clearArrays(): void {
    const prices = this.getPriceArray();
    const timestamps = this.getTimestampArray();
    const sequences = this.getSequenceArray();

    for (let i = 0; i < prices.length; i++) {
      if (this.useSharedMemory && this.config.enableAtomics && this.dataView) {
        // Use Atomics for thread-safe writes (using cached DataView)
        this.dataView.setFloat64(i * 8, 0, true);
        Atomics.store(timestamps, i, 0);
        // Fix #7: Clear sequence counters (0 = even = consistent)
        Atomics.store(sequences, i, 0);
      } else {
        prices[i] = 0;
        timestamps[i] = 0;
        sequences[i] = 0;
      }
    }
  }

  // ===========================================================================
  // Array Accessors
  // ===========================================================================

  private getPriceArray(): Float64Array {
    return this.priceArray ?? this.fallbackPrices!;
  }

  private getTimestampArray(): Int32Array {
    return this.timestampArray ?? this.fallbackTimestamps!;
  }

  // Fix #7: Sequence counter array accessor
  private getSequenceArray(): Int32Array {
    return this.sequenceArray ?? this.fallbackSequences!;
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  getConfig(): PriceMatrixConfig {
    return { ...this.config };
  }

  // ===========================================================================
  // Core Operations
  // ===========================================================================

  /**
   * Set price for a key.
   *
   * P0-FIX 4.3: Now properly handles capacity limits by returning false
   * instead of silently using hash collisions which could corrupt data.
   *
   * @returns true if price was set, false if rejected (capacity full, invalid key, etc.)
   */
  setPrice(key: string, price: number, timestamp: number): boolean {
    if (this.destroyed) {
      logger.warn('setPrice called on destroyed PriceMatrix');
      return false;
    }

    if (!key) {
      return false; // Ignore empty keys
    }

    // Fix #6: Validate price is a finite non-negative number
    // Use price < 0 (not <= 0) because HierarchicalCache.setInL1() defaults price to 0
    // for non-price entries, so rejecting 0 would silently break non-price cache entries
    if (!Number.isFinite(price) || price < 0) {
      return false;
    }

    // Check if we've reached maxPairs limit for new keys
    const isNewKey = !this.mapper.hasKey(key);
    if (isNewKey && this.writtenSlots.size >= this.config.maxPairs) {
      logger.warn('PriceMatrix maxPairs limit reached, ignoring new key', { key });
      return false;
    }

    const index = this.getIndexForKey(key);
    if (index < 0) {
      // P0-FIX 4.3: -1 means either strict mode rejection OR capacity full
      // The mapper already logged a warning, so just return false
      return false;
    }

    // Convert timestamp to relative seconds
    const relativeTimestamp = Math.floor((timestamp - this.timestampEpoch) / 1000);

    const prices = this.getPriceArray();
    const timestamps = this.getTimestampArray();
    const sequences = this.getSequenceArray();

    // P1-FIX: Write price to SharedArrayBuffer BEFORE registering key
    // This ensures workers cannot read uninitialized data (timestamp=0)
    // when they look up a newly registered key
    if (this.useSharedMemory && this.config.enableAtomics && this.dataView) {
      // Fix #7: Sequence counter protocol for atomic price+timestamp writes
      // 1. Pre-increment sequence to odd (signals write in progress)
      const seq = Atomics.add(sequences, index, 1) + 1; // seq is now odd
      // 2. Write price and timestamp
      this.dataView.setFloat64(index * 8, price, true); // little-endian
      Atomics.store(timestamps, index, relativeTimestamp);
      // 3. Post-increment sequence to even (signals write complete)
      Atomics.store(sequences, index, seq + 1);
    } else {
      // Fix #7: Non-atomic path still uses sequence counter for consistency
      sequences[index]++; // odd
      prices[index] = price;
      timestamps[index] = relativeTimestamp;
      sequences[index]++; // even
    }

    // Track that this slot has been written
    this.writtenSlots.add(index);

    // PHASE3-TASK43: Register key in SharedKeyRegistry for worker access
    // P1-FIX: Key registration happens AFTER price write to prevent workers
    // from reading uninitialized slots (race condition eliminated)
    if (this.keyRegistry && !this.isWorkerMode && isNewKey) {
      this.keyRegistry.register(key, index);
    }

    this.stats.writes++;
    return true;
  }

  /**
   * Get price for a key.
   *
   * ⚠️ TORN READ WARNING (P0-2):
   * Price and timestamp are NOT atomically read together. A concurrent writer
   * may update the price between reading the two values, resulting in:
   * - New price + old timestamp (most common)
   * - Old price + new timestamp (rare but possible)
   *
   * For most price feed use cases, this slight inconsistency is acceptable
   * because we're looking at approximate price freshness.
   *
   * If you need guaranteed consistency for critical decisions (e.g., trade execution),
   * use `getPriceWithFreshnessCheck()` which validates the timestamp is recent
   * regardless of potential torn reads.
   */
  getPrice(key: string): PriceEntry | null {
    if (this.destroyed) {
      return null;
    }

    this.stats.reads++;

    if (!key) {
      this.stats.misses++;
      return null;
    }

    // PHASE3-TASK43: Use getIndexForKey() which supports SharedKeyRegistry
    const index = this.getIndexForKey(key);
    if (index < 0) {
      this.stats.misses++;
      return null;
    }

    // Check if this slot has been written to
    // PHASE3-TASK43: Skip check for workers since writtenSlots isn't shared
    if (!this.isWorkerMode && !this.writtenSlots.has(index)) {
      this.stats.misses++;
      return null;
    }

    const prices = this.getPriceArray();
    const timestamps = this.getTimestampArray();
    const sequences = this.getSequenceArray();

    let price: number = 0;
    let relativeTimestamp: number = 0;

    if (this.useSharedMemory && this.config.enableAtomics && this.dataView) {
      // Fix #7: Sequence counter protocol for consistent reads
      // Retry if sequence is odd (write in progress) or changed after read
      let retries = 0;
      while (retries < MAX_SEQ_RETRIES) {
        const seq1 = Atomics.load(sequences, index);
        if (seq1 & 1) {
          // Odd = write in progress, spin
          retries++;
          continue;
        }
        price = this.dataView.getFloat64(index * 8, true);
        relativeTimestamp = Atomics.load(timestamps, index);
        const seq2 = Atomics.load(sequences, index);
        if (seq1 === seq2) {
          // Consistent read — sequence didn't change
          break;
        }
        // Sequence changed during read, retry
        retries++;
      }
      if (retries >= MAX_SEQ_RETRIES) {
        // Contention too high — return null rather than torn data
        this.stats.misses++;
        return null;
      }
    } else {
      price = prices[index];
      relativeTimestamp = timestamps[index];
    }

    // P1-FIX: Worker safety check - ensure slot has been initialized
    // With reordered writes (price before key registration), this should never
    // happen in normal operation, but provides defense-in-depth
    if (this.isWorkerMode && relativeTimestamp === 0) {
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;

    // Convert back to absolute timestamp
    const absoluteTimestamp = this.timestampEpoch + relativeTimestamp * 1000;

    return {
      price,
      timestamp: absoluteTimestamp
    };
  }

  /**
   * Get price with freshness validation - safer read for critical operations.
   *
   * P0-2 FIX: Addresses torn read risk by validating the data is recent.
   * If the timestamp indicates stale data (older than maxAgeMs), returns null
   * rather than potentially inconsistent data.
   *
   * Use this method when:
   * - Making trade execution decisions
   * - Calculating profit thresholds
   * - Any operation where incorrect timestamps could cause financial loss
   *
   * @param key - Price key
   * @param maxAgeMs - Maximum acceptable age in milliseconds (default: 5000ms)
   * @returns PriceEntry if fresh and valid, null if stale or not found
   */
  getPriceWithFreshnessCheck(key: string, maxAgeMs: number = 5000): PriceEntry | null {
    const entry = this.getPrice(key);
    if (!entry) {
      return null;
    }

    const age = Date.now() - entry.timestamp;

    // If data is too old, treat it as stale (could be torn read or legitimately old)
    if (age > maxAgeMs) {
      this.stats.misses++; // Count as miss since we're rejecting it
      return null;
    }

    // If age is negative (timestamp in future), this is definitely a torn read
    // where we got an old price with a newer timestamp
    if (age < -1000) { // Allow 1s clock skew tolerance
      logger.warn('PriceMatrix: Detected likely torn read (future timestamp)', {
        key,
        age,
        timestamp: entry.timestamp
      });
      return null;
    }

    return entry;
  }

  /**
   * Get only the price value (no timestamp) - fastest read for hot paths.
   *
   * Use this when you only need the price and don't care about freshness.
   * This is slightly faster than getPrice() because it avoids the timestamp read.
   *
   * @param key - Price key
   * @returns Price value or null if not found
   */
  getPriceOnly(key: string): number | null {
    if (this.destroyed || !key) {
      return null;
    }

    this.stats.reads++;

    // PHASE3-TASK43: Use getIndexForKey() which supports SharedKeyRegistry
    const index = this.getIndexForKey(key);
    // PHASE3-TASK43: Skip writtenSlots check for workers since writtenSlots isn't shared
    if (index < 0 || (!this.isWorkerMode && !this.writtenSlots.has(index))) {
      this.stats.misses++;
      return null;
    }

    if (this.useSharedMemory && this.config.enableAtomics && this.dataView) {
      // Fix #7: Sequence counter protocol for consistent price-only reads
      const sequences = this.getSequenceArray();
      let retries = 0;
      while (retries < MAX_SEQ_RETRIES) {
        const seq1 = Atomics.load(sequences, index);
        if (seq1 & 1) {
          retries++;
          continue;
        }
        const price = this.dataView.getFloat64(index * 8, true);
        const seq2 = Atomics.load(sequences, index);
        if (seq1 === seq2) {
          this.stats.hits++;
          return price;
        }
        retries++;
      }
      // Contention too high — count as miss, not hit
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return this.getPriceArray()[index];
  }

  /**
   * Delete price for a key.
   */
  deletePrice(key: string): void {
    if (this.destroyed || !key) {
      return;
    }

    if (!this.mapper.hasKey(key)) {
      return;
    }

    const index = this.mapper.getIndex(key);
    if (index < 0) {
      return;
    }

    const prices = this.getPriceArray();
    const timestamps = this.getTimestampArray();
    const sequences = this.getSequenceArray();

    if (this.useSharedMemory && this.config.enableAtomics && this.dataView) {
      // Fix #7: Use sequence protocol even for deletes
      const seq = Atomics.add(sequences, index, 1) + 1;
      this.dataView.setFloat64(index * 8, 0, true);
      Atomics.store(timestamps, index, 0);
      Atomics.store(sequences, index, seq + 1);
    } else {
      sequences[index]++;
      prices[index] = 0;
      timestamps[index] = 0;
      sequences[index]++;
    }

    // Remove from written slots
    this.writtenSlots.delete(index);
  }

  /**
   * Set multiple prices in batch.
   *
   * P2-1 OPTIMIZED: Now uses cache-friendly single-pass writes.
   * 1. Resolve all keys to indices first (N index lookups)
   * 2. Write all prices in a single pass (better cache locality)
   * 3. Write all timestamps in a single pass
   *
   * Benchmarks show ~30% improvement for batches of 50+ updates
   * compared to the previous N×setPrice() approach.
   */
  setBatch(updates: BatchUpdate[]): void {
    if (this.destroyed || updates.length === 0) {
      return;
    }

    // For small batches, use simple approach (overhead not worth it)
    if (updates.length < 10) {
      for (const update of updates) {
        this.setPrice(update.key, update.price, update.timestamp);
      }
      this.stats.batchWrites++;
      return;
    }

    // Phase 1: Resolve all indices (reuse array to avoid allocation)
    const resolved: Array<{ index: number; price: number; relativeTs: number }> = [];
    const maxPairs = this.config.maxPairs;

    for (const update of updates) {
      if (!update.key) continue;

      // Fix #6: Validate price in batch path (same as setPrice)
      if (!Number.isFinite(update.price) || update.price < 0) continue;

      // Skip if at maxPairs limit for new keys
      if (!this.mapper.hasKey(update.key) && this.writtenSlots.size >= maxPairs) {
        continue;
      }

      const index = this.getIndexForKey(update.key);
      if (index < 0) continue;

      resolved.push({
        index,
        price: update.price,
        relativeTs: Math.floor((update.timestamp - this.timestampEpoch) / 1000)
      });
    }

    if (resolved.length === 0) {
      return;
    }

    // Phase 2: Batch write prices (single pass for cache locality)
    const prices = this.getPriceArray();
    const timestamps = this.getTimestampArray();
    const sequences = this.getSequenceArray();

    if (this.useSharedMemory && this.config.enableAtomics && this.dataView) {
      // Optimized SharedArrayBuffer path with Fix #7 sequence counter protocol
      for (const { index, price, relativeTs } of resolved) {
        const seq = Atomics.add(sequences, index, 1) + 1;
        this.dataView.setFloat64(index * 8, price, true);
        Atomics.store(timestamps, index, relativeTs);
        Atomics.store(sequences, index, seq + 1);
        this.writtenSlots.add(index);
      }
    } else {
      // Fallback path
      for (const { index, price, relativeTs } of resolved) {
        sequences[index]++;
        prices[index] = price;
        timestamps[index] = relativeTs;
        sequences[index]++;
        this.writtenSlots.add(index);
      }
    }

    this.stats.writes += resolved.length;
    this.stats.batchWrites++;
  }

  /**
   * Get multiple prices in batch.
   */
  getBatch(keys: string[]): (PriceEntry | null)[] {
    if (this.destroyed) {
      return keys.map(() => null);
    }

    this.stats.batchReads++;
    return keys.map(key => this.getPrice(key));
  }

  /**
   * Clear all prices.
   */
  clear(): void {
    if (this.destroyed) {
      return;
    }

    this.clearArrays();
    this.mapper.clear();
    this.writtenSlots.clear();
  }

  // ===========================================================================
  // Index Mapping
  // ===========================================================================

  /**
   * Get array offset for a key.
   */
  getOffset(key: string): number {
    return this.getIndexForKey(key);
  }

  private getIndexForKey(key: string): number {
    // PHASE3-TASK43: Worker mode uses SharedKeyRegistry (read-only lookups)
    if (this.isWorkerMode && this.keyRegistry) {
      const index = this.keyRegistry.lookup(key);
      if (index >= 0) {
        return index;
      }
      // Key not in registry - return -1 (workers are read-only)
      return -1;
    }

    // Main thread mode: Use mapper (can allocate new indices)
    if (this.config.strictMode && !this.mapper.hasKey(key)) {
      return -1;
    }
    return this.mapper.getIndex(key);
  }

  /**
   * Pre-register keys to reserve their indices.
   */
  registerKeys(keys: string[]): void {
    for (const key of keys) {
      this.mapper.getIndex(key);
    }
  }

  // ===========================================================================
  // Status Methods
  // ===========================================================================

  /**
   * Check if using SharedArrayBuffer.
   */
  isSharedMemory(): boolean {
    return this.useSharedMemory;
  }

  /**
   * PHASE3-TASK41: Get the SharedArrayBuffer for worker thread access.
   * Returns null if not using shared memory.
   *
   * @returns The SharedArrayBuffer containing price and timestamp data, or null
   */
  getSharedBuffer(): SharedArrayBuffer | null {
    return this.sharedBuffer;
  }

  /**
   * PHASE3-TASK43: Get the SharedKeyRegistry buffer for worker thread access.
   * Returns null if key registry is not initialized.
   *
   * @returns The SharedArrayBuffer containing key-to-index mappings, or null
   */
  getKeyRegistryBuffer(): SharedArrayBuffer | null {
    return this.keyRegistry ? this.keyRegistry.getBuffer() : null;
  }

  /**
   * Check if using Atomics.
   */
  usesAtomics(): boolean {
    return this.useSharedMemory && this.config.enableAtomics;
  }

  /**
   * Get memory usage statistics.
   */
  getMemoryUsage(): MemoryUsage {
    const totalSlots = this.config.maxPairs + this.config.reserveSlots;
    const priceArrayBytes = totalSlots * 8;
    const timestampArrayBytes = totalSlots * 4;
    // Fix #7: Include sequence counter bytes in total
    const sequenceArrayBytes = totalSlots * 4;
    const totalBytes = priceArrayBytes + timestampArrayBytes + sequenceArrayBytes;
    const usedSlots = this.writtenSlots.size;

    return {
      totalBytes,
      usedSlots,
      totalSlots,
      utilizationPercent: (usedSlots / totalSlots) * 100,
      priceArrayBytes,
      timestampArrayBytes
    };
  }

  /**
   * Get operation statistics.
   */
  getStats(): PriceMatrixStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      reads: 0,
      writes: 0,
      hits: 0,
      misses: 0,
      batchReads: 0,
      batchWrites: 0
    };
  }

  /**
   * Reset state for test isolation
   *
   * Clears runtime state (statistics, written slots tracking) while preserving
   * expensive resources (SharedArrayBuffer, arrays, mapper).
   *
   * Use this in beforeEach() when sharing a PriceMatrix instance across tests
   * (created once in beforeAll()) to ensure test isolation.
   *
   * @internal For testing only
   */
  resetState(): void {
    // Reset statistics
    this.stats = {
      reads: 0,
      writes: 0,
      hits: 0,
      misses: 0,
      batchReads: 0,
      batchWrites: 0
    };

    // Clear written slots tracking
    this.writtenSlots.clear();

    // Clear prices in arrays (set to 0)
    if (this.priceArray) {
      this.priceArray.fill(0);
    }
    if (this.timestampArray) {
      this.timestampArray.fill(0);
    }
    // Fix #7: Clear sequence counters
    if (this.sequenceArray) {
      this.sequenceArray.fill(0);
    }
    if (this.fallbackPrices) {
      this.fallbackPrices.fill(0);
    }
    if (this.fallbackTimestamps) {
      this.fallbackTimestamps.fill(0);
    }
    if (this.fallbackSequences) {
      this.fallbackSequences.fill(0);
    }

    // Reset mapper to clear key-to-index mappings
    // Note: This recreates the mapper, but it's lightweight (just Maps)
    const totalSlots = this.config.maxPairs + this.config.reserveSlots;
    this.mapper = new PriceIndexMapper(totalSlots);

    // Don't reset config - configuration should be constant
    // Don't recreate SharedArrayBuffer or arrays - those are expensive
    // Don't reset destroyed flag - if destroyed, stay destroyed
  }

  // ===========================================================================
  // Prometheus Metrics
  // ===========================================================================

  /**
   * Export metrics in Prometheus format.
   */
  getPrometheusMetrics(): string {
    const memory = this.getMemoryUsage();
    const lines: string[] = [];

    lines.push('# HELP price_matrix_reads Total read operations');
    lines.push('# TYPE price_matrix_reads counter');
    lines.push(`price_matrix_reads ${this.stats.reads}`);

    lines.push('# HELP price_matrix_writes Total write operations');
    lines.push('# TYPE price_matrix_writes counter');
    lines.push(`price_matrix_writes ${this.stats.writes}`);

    lines.push('# HELP price_matrix_hits Total cache hits');
    lines.push('# TYPE price_matrix_hits counter');
    lines.push(`price_matrix_hits ${this.stats.hits}`);

    lines.push('# HELP price_matrix_misses Total cache misses');
    lines.push('# TYPE price_matrix_misses counter');
    lines.push(`price_matrix_misses ${this.stats.misses}`);

    lines.push('# HELP price_matrix_memory_bytes Total memory usage in bytes');
    lines.push('# TYPE price_matrix_memory_bytes gauge');
    lines.push(`price_matrix_memory_bytes ${memory.totalBytes}`);

    lines.push('# HELP price_matrix_utilization Cache utilization percentage');
    lines.push('# TYPE price_matrix_utilization gauge');
    lines.push(`price_matrix_utilization ${memory.utilizationPercent.toFixed(2)}`);

    lines.push('# HELP price_matrix_used_slots Number of used slots');
    lines.push('# TYPE price_matrix_used_slots gauge');
    lines.push(`price_matrix_used_slots ${memory.usedSlots}`);

    return lines.join('\n');
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Destroy the matrix and release resources.
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    // Clear arrays and cached views
    this.priceArray = null;
    this.timestampArray = null;
    this.sequenceArray = null;
    this.fallbackPrices = null;
    this.fallbackTimestamps = null;
    this.fallbackSequences = null;
    this.sharedBuffer = null;
    this.dataView = null;

    this.mapper.clear();
    this.writtenSlots.clear();

    logger.info('PriceMatrix destroyed');
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let matrixInstance: PriceMatrix | null = null;
let initializingMatrix = false; // Race condition guard

/**
 * Get singleton PriceMatrix instance.
 * @param config - Configuration (only used on first call, ignored afterward)
 */
export function getPriceMatrix(config?: Partial<PriceMatrixConfig>): PriceMatrix {
  // Return existing instance if available
  if (matrixInstance) {
    if (config) {
      logger.warn('getPriceMatrix called with config but instance already exists; config ignored');
    }
    return matrixInstance;
  }

  // Prevent concurrent initialization (race condition guard)
  if (initializingMatrix) {
    throw new Error('PriceMatrix is being initialized by another caller');
  }

  initializingMatrix = true;
  try {
    // Double-check after acquiring guard
    if (!matrixInstance) {
      matrixInstance = new PriceMatrix(config);
    }
    return matrixInstance;
  } finally {
    initializingMatrix = false;
  }
}

/**
 * Reset singleton instance.
 * FIX 4.3: Fixed race condition where concurrent callers could get
 * a destroying instance. Now nulls the reference before clearing the
 * initialization flag to prevent TOCTOU races.
 */
export function resetPriceMatrix(): void {
  // FIX 4.3: Save reference, null instance, clear flag, THEN destroy
  // This order prevents concurrent getPriceMatrix() from returning a destroying instance
  const instanceToDestroy = matrixInstance;
  matrixInstance = null;
  initializingMatrix = false;

  // Now safe to destroy - no one can get a reference to it anymore
  if (instanceToDestroy) {
    instanceToDestroy.destroy();
  }
}
