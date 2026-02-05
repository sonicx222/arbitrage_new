/**
 * LRU Cache - Least Recently Used Cache
 *
 * A high-performance LRU cache implementation for:
 * - Token normalization caching
 * - Memoization with bounded memory
 * - Hot data caching with automatic eviction
 *
 * Features:
 * - O(1) get/set operations using Map with deletion/insertion for LRU ordering
 * - Configurable max size with automatic eviction
 * - Memory-efficient: fixed capacity, no unbounded growth
 *
 * Implementation Note:
 * Uses ES6 Map's insertion order preservation. When an item is accessed,
 * it's deleted and re-inserted to move it to the end (most recently used).
 * Eviction removes the first item (least recently used).
 *
 * Used by:
 * - partition-solana/arbitrage-detector.ts (token normalization cache)
 * - Any service needing bounded memoization
 *
 * @see ARCHITECTURE_V2.md Section 4.2 (Data Structures)
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Statistics about the cache state
 */
export interface LRUCacheStats {
  /** Current number of items */
  size: number;
  /** Maximum capacity */
  maxSize: number;
  /** Fill ratio (0-1) */
  fillRatio: number;
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Hit ratio (0-1), NaN if no accesses */
  hitRatio: number;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Simple LRU (Least Recently Used) cache.
 *
 * Provides O(1) get/set operations with automatic eviction of least
 * recently used items when capacity is exceeded.
 *
 * @template K Type of cache keys
 * @template V Type of cached values
 */
export class LRUCache<K, V> {
  private readonly cache = new Map<K, V>();
  private readonly maxSize: number;
  private hits = 0;
  private misses = 0;

  /**
   * Create a new LRUCache.
   *
   * @param maxSize - Maximum number of items to cache (must be positive)
   * @throws Error if maxSize is not positive
   */
  constructor(maxSize: number) {
    if (maxSize <= 0) {
      throw new Error('LRUCache maxSize must be positive');
    }
    this.maxSize = maxSize;
  }

  /**
   * Get a value from the cache. O(1)
   *
   * If the key exists, moves it to most-recently-used position.
   *
   * @param key - Key to look up
   * @returns The cached value, or undefined if not found
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
      this.hits++;
      return value;
    }
    this.misses++;
    return undefined;
  }

  /**
   * Get a value without updating LRU order. O(1)
   *
   * Use this for read-only access in hot paths where you don't want
   * to affect eviction priority. Does NOT increment hit/miss counters.
   *
   * @param key - Key to look up
   * @returns The cached value, or undefined if not found
   */
  peek(key: K): V | undefined {
    return this.cache.get(key);
  }

  /**
   * Check if a key exists without updating LRU order. O(1)
   *
   * @param key - Key to check
   * @returns true if key exists
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Set a value in the cache. O(1)
   *
   * If the key already exists, updates the value and moves to most-recently-used.
   * If at capacity, evicts the least recently used item first.
   *
   * @param key - Key to store
   * @param value - Value to cache
   */
  set(key: K, value: V): void {
    // If key exists, delete to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first entry)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  /**
   * Delete a key from the cache. O(1)
   *
   * @param key - Key to delete
   * @returns true if key was deleted, false if not found
   */
  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all items from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Reset statistics counters.
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Get the current number of items in the cache.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Get the maximum capacity of the cache.
   */
  get capacity(): number {
    return this.maxSize;
  }

  /**
   * Get cache statistics.
   *
   * @returns Statistics about the cache state
   */
  getStats(): LRUCacheStats {
    const totalAccesses = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      fillRatio: this.maxSize > 0 ? this.cache.size / this.maxSize : 0,
      hits: this.hits,
      misses: this.misses,
      hitRatio: totalAccesses > 0 ? this.hits / totalAccesses : NaN,
    };
  }

  /**
   * Get all keys in the cache (from oldest to newest).
   *
   * @returns Array of keys in LRU order
   */
  keys(): K[] {
    return Array.from(this.cache.keys());
  }

  /**
   * Get all values in the cache (from oldest to newest).
   *
   * @returns Array of values in LRU order
   */
  values(): V[] {
    return Array.from(this.cache.values());
  }

  /**
   * Get all entries in the cache (from oldest to newest).
   *
   * @returns Array of [key, value] pairs in LRU order
   */
  entries(): [K, V][] {
    return Array.from(this.cache.entries());
  }

  /**
   * Apply a function to each cached item (from oldest to newest).
   *
   * @param fn - Function to apply to each entry
   */
  forEach(fn: (value: V, key: K) => void): void {
    this.cache.forEach(fn);
  }

  /**
   * Create an iterator over cache entries.
   */
  *[Symbol.iterator](): Iterator<[K, V]> {
    yield* this.cache.entries();
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create an LRU cache with the specified capacity.
 *
 * @param maxSize - Maximum number of items to cache
 * @returns A new LRUCache instance
 */
export function createLRUCache<K, V>(maxSize: number): LRUCache<K, V> {
  return new LRUCache<K, V>(maxSize);
}
