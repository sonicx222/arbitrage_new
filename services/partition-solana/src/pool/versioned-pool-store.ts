/**
 * Versioned Pool Store
 *
 * High-performance pool storage with versioning for efficient change detection:
 * - O(1) get/set/delete operations
 * - Indexed by pair key for fast lookups
 * - Version counter for change detection (avoid deep copies)
 * - LRU eviction when at capacity
 *
 * Features:
 * - Maintains pools indexed by address and by pair key
 * - Version increments on any mutation for snapshotting
 * - Size limit with LRU eviction using Set (preserves insertion order)
 * - Memory-efficient: no deep copying for detection snapshots
 *
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

import type { InternalPoolInfo } from '../types';

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum number of pools in VersionedPoolStore.
 * Prevents unbounded cache growth causing OOM.
 * 50,000 pools is generous for most Solana DEX scenarios.
 */
const DEFAULT_MAX_SIZE = 50000;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Versioned pool store for efficient snapshotting and change detection.
 *
 * Uses a version counter to track changes. Detection methods can
 * work on a "logical snapshot" by checking version at start/end.
 */
export class VersionedPoolStore {
  private pools = new Map<string, InternalPoolInfo>();
  private poolsByPair = new Map<string, Set<string>>();
  private version = 0;
  private readonly maxSize: number;
  /**
   * Track insertion order for LRU eviction using a Set.
   * Set preserves insertion order in ES6 and provides O(1) operations.
   */
  private insertionOrder = new Set<string>();

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  /**
   * Get the current version number.
   * Use this to detect if the store has changed between operations.
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * Add or update a pool in the store.
   * Increments version on every change.
   * Evicts oldest pool if at capacity.
   *
   * @param pool - Pool to add/update
   */
  set(pool: InternalPoolInfo): void {
    const existing = this.pools.get(pool.address);

    // Enforce size limit with LRU eviction
    if (!existing && this.pools.size >= this.maxSize) {
      this.evictOldestPool();
    }

    this.pools.set(pool.address, pool);

    // Update insertion order for LRU tracking
    // If key exists, delete and re-add to move to end (most recently used)
    if (existing) {
      this.insertionOrder.delete(pool.address);
    }
    this.insertionOrder.add(pool.address);

    // Update pair index
    if (!existing || existing.pairKey !== pool.pairKey) {
      // Remove from old pair index if different
      if (existing && existing.pairKey !== pool.pairKey) {
        this.poolsByPair.get(existing.pairKey)?.delete(pool.address);
      }
      // Add to new pair index
      if (!this.poolsByPair.has(pool.pairKey)) {
        this.poolsByPair.set(pool.pairKey, new Set());
      }
      this.poolsByPair.get(pool.pairKey)!.add(pool.address);
    }

    this.version++;
  }

  /**
   * Evict the oldest pool to make room for new entries.
   * Uses Set iterator for O(1) access to oldest entry.
   */
  private evictOldestPool(): void {
    if (this.insertionOrder.size === 0) {
      return;
    }

    // Get the first (oldest) entry from the Set
    const oldest = this.insertionOrder.values().next().value;
    if (oldest !== undefined) {
      this.deleteInternal(oldest);
      this.insertionOrder.delete(oldest);
    }
  }

  /**
   * Get a pool by address.
   *
   * @param address - Pool address
   * @returns Pool info or undefined
   */
  get(address: string): InternalPoolInfo | undefined {
    return this.pools.get(address);
  }

  /**
   * Check if a pool exists.
   *
   * @param address - Pool address
   * @returns true if pool exists
   */
  has(address: string): boolean {
    return this.pools.has(address);
  }

  /**
   * Delete a pool from the store.
   * O(1) operation using Set.delete().
   *
   * @param address - Pool address
   * @returns true if pool was deleted
   */
  delete(address: string): boolean {
    const result = this.deleteInternal(address);
    if (result) {
      this.insertionOrder.delete(address);
    }
    return result;
  }

  /**
   * Internal delete operation (doesn't touch insertionOrder).
   */
  private deleteInternal(address: string): boolean {
    const pool = this.pools.get(address);
    if (!pool) return false;

    this.poolsByPair.get(pool.pairKey)?.delete(address);
    this.pools.delete(address);
    this.version++;
    return true;
  }

  /**
   * Get the current number of pools.
   */
  get size(): number {
    return this.pools.size;
  }

  /**
   * Get pools for a specific pair key.
   * Returns current pools - caller should handle concurrency.
   *
   * @param pairKey - Normalized pair key (e.g., "SOL-USDC")
   * @returns Array of pools for this pair
   */
  getPoolsForPair(pairKey: string): InternalPoolInfo[] {
    const addresses = this.poolsByPair.get(pairKey);
    if (!addresses) return [];

    const result: InternalPoolInfo[] = [];
    for (const addr of addresses) {
      const pool = this.pools.get(addr);
      if (pool) result.push(pool);
    }
    return result;
  }

  /**
   * Get all unique pair keys.
   *
   * @returns Array of pair keys
   */
  getPairKeys(): string[] {
    return Array.from(this.poolsByPair.keys());
  }

  /**
   * Get all pools as array.
   * Creates a new array - prefer poolsIterator() for iteration.
   *
   * @returns Array of all pools
   */
  getAllPools(): InternalPoolInfo[] {
    return Array.from(this.pools.values());
  }

  /**
   * Get iterator over all pools.
   * More memory-efficient than getAllPools() for large pool sets.
   *
   * @returns Iterator over pools
   */
  poolsIterator(): IterableIterator<InternalPoolInfo> {
    return this.pools.values();
  }

  /**
   * Clear all pools.
   * Useful for testing and shutdown.
   */
  clear(): void {
    this.pools.clear();
    this.poolsByPair.clear();
    this.insertionOrder.clear();
    this.version++;
  }
}
