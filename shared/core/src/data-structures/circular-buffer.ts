/**
 * Circular Buffer - O(1) FIFO Operations
 *
 * A high-performance circular buffer implementation for:
 * - Rolling window statistics (health scoring, latency tracking)
 * - FIFO queues with fixed capacity
 * - Event/message buffering
 *
 * Features:
 * - O(1) push, shift, and size operations
 * - Memory-efficient: fixed allocation, no array resizing
 * - GC-friendly: explicit clear with slot nullification (`clearOnRemove: true`,
 *   the default). Set `clearOnRemove: false` for rolling windows where references
 *   to overwritten items are acceptable (avoids per-slot nullification overhead).
 * - Rolling window support with countWhere predicate
 *
 * Note: For hot-path code, ADR-022 recommends inline implementations
 * rather than class-based data structures. This module targets non-hot-path
 * consumers (queue management, statistics).
 *
 * Used by:
 * - execution-engine/queue.service.ts (opportunity queue)
 * - execution-engine/simulation/types.ts (health scoring)
 * - execution-engine/simulation/hot-fork-synchronizer.ts (block timestamps)
 * - cross-chain-detector/bridge-predictor.ts (bridge latency tracking)
 * - mempool-detector (pending transaction buffering)
 * - bloxroute-feed.ts (latency tracking)
 * - Any service needing fixed-size rolling buffers
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for CircularBuffer
 */
export interface CircularBufferConfig {
  /** Maximum capacity of the buffer */
  capacity: number;
  /** Whether to clear slots on removal for GC (default: true) */
  clearOnRemove?: boolean;
}

/**
 * Statistics about the buffer state
 */
export interface CircularBufferStats {
  /** Current number of items */
  size: number;
  /** Maximum capacity */
  capacity: number;
  /** Fill ratio (0-1) */
  fillRatio: number;
  /** Whether buffer is full */
  isFull: boolean;
  /** Whether buffer is empty */
  isEmpty: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Generic circular buffer with O(1) operations.
 *
 * Supports two modes of operation:
 * 1. FIFO Queue Mode: push() adds to tail, shift() removes from head
 * 2. Rolling Window Mode: push() overwrites oldest when full, toArray() gets all items
 *
 * @template T Type of items stored in the buffer
 */
export class CircularBuffer<T> {
  private readonly buffer: (T | undefined)[];
  private readonly clearOnRemove: boolean;
  private head = 0; // Next read position (for FIFO mode)
  private tail = 0; // Next write position
  private count = 0;

  /**
   * Create a new CircularBuffer.
   *
   * @param capacityOrConfig - Capacity number or full configuration object
   */
  constructor(capacityOrConfig: number | CircularBufferConfig) {
    const config = typeof capacityOrConfig === 'number'
      ? { capacity: capacityOrConfig }
      : capacityOrConfig;

    if (!Number.isInteger(config.capacity) || config.capacity <= 0) {
      throw new Error('CircularBuffer capacity must be a positive integer');
    }

    this.buffer = new Array(config.capacity).fill(undefined);
    this.clearOnRemove = config.clearOnRemove ?? true;
  }

  /**
   * Get the buffer capacity.
   */
  get capacity(): number {
    return this.buffer.length;
  }

  /**
   * Get the current number of items.
   */
  get length(): number {
    return this.count;
  }

  /**
   * Get the current number of items (alias for length).
   */
  get size(): number {
    return this.count;
  }

  /**
   * Check if the buffer is empty.
   */
  get isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Check if the buffer is full.
   */
  get isFull(): boolean {
    return this.count >= this.buffer.length;
  }

  // ===========================================================================
  // FIFO Queue Operations (Queue Mode)
  // ===========================================================================

  /**
   * Add an item to the end of the buffer. O(1)
   *
   * In queue mode, returns false if buffer is full.
   * Use pushOverwrite() for rolling window behavior.
   *
   * @param item - Item to add
   * @returns true if added, false if buffer is full
   */
  push(item: T): boolean {
    if (this.count >= this.buffer.length) {
      return false;
    }

    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.buffer.length;
    this.count++;
    return true;
  }

  /**
   * Add an item, overwriting the oldest if full. O(1)
   *
   * Use this for rolling window behavior where oldest data is discarded.
   *
   * @param item - Item to add
   */
  pushOverwrite(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.buffer.length;

    if (this.count < this.buffer.length) {
      this.count++;
    } else {
      // Buffer is full, advance head to discard oldest
      this.head = (this.head + 1) % this.buffer.length;
    }
  }

  /**
   * Remove and return the oldest item. O(1)
   *
   * @returns The oldest item, or undefined if buffer is empty
   */
  shift(): T | undefined {
    if (this.count === 0) {
      return undefined;
    }

    const item = this.buffer[this.head];

    // Clear slot to allow GC of stored object
    if (this.clearOnRemove) {
      this.buffer[this.head] = undefined;
    }

    this.head = (this.head + 1) % this.buffer.length;
    this.count--;

    return item;
  }

  /**
   * Peek at the oldest item without removing it. O(1)
   *
   * @returns The oldest item, or undefined if buffer is empty
   */
  peek(): T | undefined {
    if (this.count === 0) {
      return undefined;
    }
    return this.buffer[this.head];
  }

  /**
   * Peek at the newest item without removing it. O(1)
   *
   * @returns The newest item, or undefined if buffer is empty
   */
  peekLast(): T | undefined {
    if (this.count === 0) {
      return undefined;
    }
    const lastIndex = (this.tail - 1 + this.buffer.length) % this.buffer.length;
    return this.buffer[lastIndex];
  }

  // ===========================================================================
  // Rolling Window Operations
  // ===========================================================================

  /**
   * Get all items in order from oldest to newest. O(n)
   *
   * @returns Array of all items in chronological order
   */
  toArray(): T[] {
    if (this.count === 0) return [];

    const result: T[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.buffer.length;
      result[i] = this.buffer[index] as T;
    }

    return result;
  }

  /**
   * Count items matching a predicate. O(n)
   *
   * Useful for calculating success rates, error counts, etc.
   *
   * @param predicate - Function to test each item
   * @returns Number of items matching the predicate
   */
  countWhere(predicate: (item: T) => boolean): number {
    let matches = 0;

    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.buffer.length;
      if (predicate(this.buffer[index] as T)) {
        matches++;
      }
    }

    return matches;
  }

  /**
   * Filter items matching a predicate. O(n)
   *
   * @param predicate - Function to test each item
   * @returns Array of items matching the predicate
   */
  filter(predicate: (item: T) => boolean): T[] {
    const results: T[] = [];

    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.buffer.length;
      const item = this.buffer[index] as T;
      if (predicate(item)) {
        results.push(item);
      }
    }

    return results;
  }

  /**
   * Find the first item matching a predicate. O(n)
   *
   * @param predicate - Function to test each item
   * @returns The first matching item, or undefined
   */
  find(predicate: (item: T) => boolean): T | undefined {
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.buffer.length;
      const item = this.buffer[index] as T;
      if (predicate(item)) {
        return item;
      }
    }
    return undefined;
  }

  /**
   * Check if any item matches a predicate. O(n)
   *
   * @param predicate - Function to test each item
   * @returns true if any item matches
   */
  some(predicate: (item: T) => boolean): boolean {
    return this.find(predicate) !== undefined;
  }

  /**
   * Check if all items match a predicate. O(n)
   *
   * @param predicate - Function to test each item
   * @returns true if all items match (or buffer is empty)
   */
  every(predicate: (item: T) => boolean): boolean {
    return this.countWhere(predicate) === this.count;
  }

  /**
   * Apply a function to each item. O(n)
   *
   * @param fn - Function to apply to each item
   */
  forEach(fn: (item: T, index: number) => void): void {
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.buffer.length;
      fn(this.buffer[index] as T, i);
    }
  }

  /**
   * Reduce items to a single value. O(n)
   *
   * @param fn - Reducer function
   * @param initialValue - Initial accumulator value
   * @returns Final accumulated value
   */
  reduce<R>(fn: (acc: R, item: T, index: number) => R, initialValue: R): R {
    let acc = initialValue;

    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.buffer.length;
      acc = fn(acc, this.buffer[index] as T, i);
    }

    return acc;
  }

  // ===========================================================================
  // Buffer Management
  // ===========================================================================

  /**
   * Clear the buffer. O(n) when clearOnRemove is true.
   *
   * Explicitly clears all slots to allow GC of stored objects.
   */
  clear(): void {
    if (this.clearOnRemove) {
      // Clear slots to allow GC of stored objects
      for (let i = 0; i < this.buffer.length; i++) {
        this.buffer[i] = undefined;
      }
    }

    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  /**
   * Get buffer statistics.
   *
   * @returns Statistics about the buffer state
   */
  getStats(): CircularBufferStats {
    return {
      size: this.count,
      capacity: this.buffer.length,
      fillRatio: this.buffer.length > 0 ? this.count / this.buffer.length : 0,
      isFull: this.isFull,
      isEmpty: this.isEmpty,
    };
  }

  /**
   * Create an iterator over the buffer items.
   */
  *[Symbol.iterator](): Iterator<T> {
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.buffer.length;
      yield this.buffer[index] as T;
    }
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a CircularBuffer for FIFO queue usage.
 *
 * @param capacity - Maximum capacity
 * @returns A new CircularBuffer instance
 */
export function createFifoBuffer<T>(capacity: number): CircularBuffer<T> {
  return new CircularBuffer<T>({ capacity, clearOnRemove: true });
}

/**
 * Create a CircularBuffer for rolling window statistics.
 *
 * @param capacity - Maximum capacity (window size)
 * @returns A new CircularBuffer instance
 */
export function createRollingWindow<T>(capacity: number): CircularBuffer<T> {
  return new CircularBuffer<T>({ capacity, clearOnRemove: false });
}
