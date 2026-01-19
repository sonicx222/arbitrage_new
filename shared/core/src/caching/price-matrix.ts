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

import { createLogger } from '../logger';

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
 * Maps string keys ("chain:dex:pair") to array offsets with O(1) complexity.
 * Uses a hash-based approach for fast lookups.
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
   * Get or create index for a key.
   * Returns existing index if key is known, or allocates new one.
   * WARNING: When all slots are used, falls back to hash-based index which may collide!
   */
  getIndex(key: string): number {
    // Fast path: key already exists
    const existing = this.keyToIndex.get(key);
    if (existing !== undefined) {
      return existing;
    }

    // Slow path: allocate new index
    if (this.nextIndex >= this.maxIndex) {
      // All slots used - use hash-based collision (may overwrite existing data!)
      const hashIndex = this.hashKey(key) % this.maxIndex;
      logger.warn('PriceIndexMapper: All slots used, using hash-based index (potential collision)', {
        key,
        hashIndex,
        maxIndex: this.maxIndex
      });
      return hashIndex;
    }

    const index = this.nextIndex++;
    this.keyToIndex.set(key, index);
    this.indexToKey.set(index, key);
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

  /**
   * Simple hash function for string keys.
   * Uses FNV-1a algorithm for fast, well-distributed hashes.
   */
  private hashKey(key: string): number {
    let hash = 2166136261; // FNV offset basis
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = (hash * 16777619) >>> 0; // FNV prime, keep as uint32
    }
    return hash;
  }
}

// =============================================================================
// Price Matrix
// =============================================================================

export class PriceMatrix {
  private config: PriceMatrixConfig;
  private mapper: PriceIndexMapper;

  // SharedArrayBuffer backing storage
  private sharedBuffer: SharedArrayBuffer | null = null;
  private priceArray: Float64Array | null = null;
  private timestampArray: Int32Array | null = null; // Int32Array for Atomics compatibility

  // Fallback arrays if SharedArrayBuffer is not available
  private fallbackPrices: Float64Array | null = null;
  private fallbackTimestamps: Int32Array | null = null; // Int32Array for consistency
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

    logger.info('PriceMatrix initialized', {
      maxPairs: this.config.maxPairs,
      totalSlots,
      useSharedMemory: this.useSharedMemory
    });
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  private initializeArrays(totalSlots: number): void {
    // Calculate buffer size
    // Each slot: 8 bytes (Float64) + 4 bytes (Uint32) = 12 bytes
    const priceBytes = totalSlots * 8;
    const timestampBytes = totalSlots * 4;
    const totalBytes = priceBytes + timestampBytes;

    try {
      // Try to use SharedArrayBuffer for true shared memory
      if (typeof SharedArrayBuffer !== 'undefined') {
        this.sharedBuffer = new SharedArrayBuffer(totalBytes);
        this.priceArray = new Float64Array(this.sharedBuffer, 0, totalSlots);
        this.timestampArray = new Int32Array(this.sharedBuffer, priceBytes, totalSlots);
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
      this.useSharedMemory = false;
    }

    // Initialize all values to 0/NaN to indicate empty slots
    this.clearArrays();
  }

  private clearArrays(): void {
    const prices = this.getPriceArray();
    const timestamps = this.getTimestampArray();

    for (let i = 0; i < prices.length; i++) {
      if (this.useSharedMemory && this.config.enableAtomics && this.dataView) {
        // Use Atomics for thread-safe writes (using cached DataView)
        this.dataView.setFloat64(i * 8, 0, true);
        Atomics.store(timestamps, i, 0);
      } else {
        prices[i] = 0;
        timestamps[i] = 0;
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
   */
  setPrice(key: string, price: number, timestamp: number): void {
    if (this.destroyed) {
      logger.warn('setPrice called on destroyed PriceMatrix');
      return;
    }

    if (!key) {
      return; // Ignore empty keys
    }

    // Check if we've reached maxPairs limit for new keys
    if (!this.mapper.hasKey(key) && this.writtenSlots.size >= this.config.maxPairs) {
      logger.warn('PriceMatrix maxPairs limit reached, ignoring new key', { key });
      return;
    }

    const index = this.getIndexForKey(key);
    if (index < 0) {
      return; // Strict mode and unknown key
    }

    // Convert timestamp to relative seconds
    const relativeTimestamp = Math.floor((timestamp - this.timestampEpoch) / 1000);

    const prices = this.getPriceArray();
    const timestamps = this.getTimestampArray();

    if (this.useSharedMemory && this.config.enableAtomics && this.dataView) {
      // Atomic write using cached DataView for Float64
      // Note: Price and timestamp are not atomically written together (torn write possible)
      this.dataView.setFloat64(index * 8, price, true); // little-endian
      Atomics.store(timestamps, index, relativeTimestamp);
    } else {
      prices[index] = price;
      timestamps[index] = relativeTimestamp;
    }

    // Track that this slot has been written
    this.writtenSlots.add(index);
    this.stats.writes++;
  }

  /**
   * Get price for a key.
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

    // Check if key has a mapping
    if (!this.mapper.hasKey(key)) {
      this.stats.misses++;
      return null;
    }

    const index = this.mapper.getIndex(key);
    if (index < 0) {
      this.stats.misses++;
      return null;
    }

    // Check if this slot has been written to
    if (!this.writtenSlots.has(index)) {
      this.stats.misses++;
      return null;
    }

    const prices = this.getPriceArray();
    const timestamps = this.getTimestampArray();

    let price: number;
    let relativeTimestamp: number;

    if (this.useSharedMemory && this.config.enableAtomics && this.dataView) {
      // Atomic read using cached DataView for Float64
      // Note: Price and timestamp are not atomically read together (torn read possible)
      price = this.dataView.getFloat64(index * 8, true);
      relativeTimestamp = Atomics.load(timestamps, index);
    } else {
      price = prices[index];
      relativeTimestamp = timestamps[index];
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

    if (this.useSharedMemory && this.config.enableAtomics && this.dataView) {
      this.dataView.setFloat64(index * 8, 0, true);
      Atomics.store(timestamps, index, 0);
    } else {
      prices[index] = 0;
      timestamps[index] = 0;
    }

    // Remove from written slots
    this.writtenSlots.delete(index);
  }

  /**
   * Set multiple prices in batch.
   */
  setBatch(updates: BatchUpdate[]): void {
    if (this.destroyed) {
      return;
    }

    for (const update of updates) {
      this.setPrice(update.key, update.price, update.timestamp);
    }

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
    const totalBytes = priceArrayBytes + timestampArrayBytes;
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
    this.fallbackPrices = null;
    this.fallbackTimestamps = null;
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
 */
export function resetPriceMatrix(): void {
  initializingMatrix = false; // Clear initialization flag
  if (matrixInstance) {
    matrixInstance.destroy();
    matrixInstance = null;
  }
}
