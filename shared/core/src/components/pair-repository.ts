/**
 * PairRepository - In-Memory Pair Storage with O(1) Lookups
 *
 * ARCH-REFACTOR: Extracted from base-detector.ts to encapsulate
 * the three Maps (pairs, pairsByAddress, pairsByTokens) into a
 * single, well-tested component.
 *
 * Design Principles:
 * - Encapsulates all pair storage logic
 * - O(1) lookups by key, address, and token pair
 * - Thread-safe snapshot creation for arbitrage detection
 * - No external dependencies (pure in-memory storage)
 *
 * @see .claude/plans/detection-refactoring-plan.md
 * @see .claude/plans/component-architecture-proposal.md
 */

import type { Pair } from '@arbitrage/types';
// HOT-PATH: Import cached token pair key utility to avoid string allocation
import { getTokenPairKeyCached } from './token-utils';

// =============================================================================
// Types
// =============================================================================

/**
 * Snapshot of pair data for thread-safe arbitrage detection.
 * Captures reserve values at a point in time to avoid race conditions
 * when reserves are updated by concurrent processSyncEvent calls.
 */
export interface PairSnapshot {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  fee: number;
  blockNumber?: number;
}

/**
 * Extended pair interface with reserve data.
 * Used internally for pairs that have been initialized with reserves.
 */
export interface ExtendedPair extends Pair {
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;
}

/**
 * Options for creating a PairSnapshot.
 */
export interface SnapshotOptions {
  /** Default fee if pair.fee is undefined */
  defaultFee?: number;
}

/**
 * Statistics about the repository state.
 */
export interface RepositoryStats {
  /** Total number of pairs */
  totalPairs: number;
  /** Number of pairs with initialized reserves */
  pairsWithReserves: number;
  /** Number of unique token pair combinations */
  uniqueTokenPairs: number;
  /** Average pairs per token combination */
  avgPairsPerTokenPair: number;
}

/**
 * Callback for pair changes.
 */
export type PairChangeCallback = (pair: Pair, type: 'add' | 'update' | 'remove') => void;

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_FEE = 0.003; // 0.3% default fee

// =============================================================================
// PairRepository Class
// =============================================================================

/**
 * In-memory repository for trading pairs with O(1) lookups.
 *
 * Maintains three indexes for different access patterns:
 * 1. pairs: Map<key, Pair> - Primary storage by composite key
 * 2. pairsByAddress: Map<address, Pair> - O(1) lookup by contract address
 * 3. pairsByTokens: Map<tokenPairKey, Pair[]> - O(1) lookup by token combination
 */
export class PairRepository {
  /**
   * Primary storage: Map<key, Pair>
   * Key format: "{dex}_{pairName}" or "{dex}_{token0}_{token1}"
   */
  private readonly pairs: Map<string, Pair> = new Map();

  /**
   * Index by contract address for O(1) address lookups.
   * Key: lowercase address
   */
  private readonly pairsByAddress: Map<string, Pair> = new Map();

  /**
   * T1.1: Token Pair Index for O(1) arbitrage detection.
   * Key format: "tokenA_tokenB" where tokenA < tokenB (alphabetically sorted, lowercase)
   */
  private readonly pairsByTokens: Map<string, Pair[]> = new Map();

  /**
   * Optional callback for pair changes (for reactive updates).
   */
  private changeCallback: PairChangeCallback | null = null;

  // ===========================================================================
  // Core CRUD Operations
  // ===========================================================================

  /**
   * Add or update a pair in the repository.
   * Maintains all indexes automatically.
   *
   * @param key - Unique key for the pair (e.g., "uniswapv2_WETH_USDC")
   * @param pair - The pair to add or update
   * @returns True if added, false if updated
   */
  set(key: string, pair: Pair): boolean {
    const existing = this.pairs.get(key);
    const isNew = !existing;

    // Update primary storage
    this.pairs.set(key, pair);

    // Update address index
    const addressKey = pair.address.toLowerCase();
    if (existing && existing.address.toLowerCase() !== addressKey) {
      // Address changed (rare) - remove old address index
      this.pairsByAddress.delete(existing.address.toLowerCase());
    }
    this.pairsByAddress.set(addressKey, pair);

    // Update token pair index
    if (existing) {
      // Update existing reference in token index
      this.updatePairInTokenIndex(existing, pair);
    } else {
      // Add new pair to token index
      this.addPairToTokenIndex(pair);
    }

    // Notify callback
    this.changeCallback?.(pair, isNew ? 'add' : 'update');

    return isNew;
  }

  /**
   * Get a pair by its key.
   *
   * @param key - The pair key
   * @returns The pair or undefined
   */
  get(key: string): Pair | undefined {
    return this.pairs.get(key);
  }

  /**
   * Get a pair by its contract address (O(1) lookup).
   *
   * @param address - The pair contract address
   * @returns The pair or undefined
   */
  getByAddress(address: string): Pair | undefined {
    return this.pairsByAddress.get(address.toLowerCase());
  }

  /**
   * Get all pairs for a given token combination (O(1) lookup).
   * Returns pairs on different DEXs that trade the same tokens.
   *
   * @param token0 - First token address
   * @param token1 - Second token address
   * @returns Array of pairs trading these tokens (may be empty)
   */
  getByTokens(token0: string, token1: string): Pair[] {
    const key = this.getTokenPairKey(token0, token1);
    return this.pairsByTokens.get(key) || [];
  }

  /**
   * Check if a pair exists by key.
   *
   * @param key - The pair key
   * @returns True if exists
   */
  has(key: string): boolean {
    return this.pairs.has(key);
  }

  /**
   * Check if a pair exists by address.
   *
   * @param address - The pair contract address
   * @returns True if exists
   */
  hasAddress(address: string): boolean {
    return this.pairsByAddress.has(address.toLowerCase());
  }

  /**
   * Delete a pair by its key.
   *
   * @param key - The pair key
   * @returns True if deleted, false if not found
   */
  delete(key: string): boolean {
    const pair = this.pairs.get(key);
    if (!pair) {
      return false;
    }

    // Remove from all indexes
    this.pairs.delete(key);
    this.pairsByAddress.delete(pair.address.toLowerCase());
    this.removePairFromTokenIndex(pair);

    // Notify callback
    this.changeCallback?.(pair, 'remove');

    return true;
  }

  /**
   * Delete a pair by its address.
   *
   * @param address - The pair contract address
   * @returns True if deleted, false if not found
   */
  deleteByAddress(address: string): boolean {
    const pair = this.getByAddress(address);
    if (!pair) {
      return false;
    }

    const key = this.findKeyByAddress(address);
    if (key) {
      return this.delete(key);
    }
    return false;
  }

  /**
   * Clear all pairs from the repository.
   */
  clear(): void {
    this.pairs.clear();
    this.pairsByAddress.clear();
    this.pairsByTokens.clear();
  }

  // ===========================================================================
  // Snapshot Operations
  // ===========================================================================

  /**
   * Create a snapshot of a single pair for thread-safe operations.
   *
   * @param pair - The pair to snapshot
   * @param options - Snapshot options
   * @returns PairSnapshot or null if reserves not available
   */
  createSnapshot(pair: Pair, options?: SnapshotOptions): PairSnapshot | null {
    const reserve0 = pair.reserve0;
    const reserve1 = pair.reserve1;

    // Skip pairs without initialized reserves
    if (!reserve0 || !reserve1 || reserve0 === '0' || reserve1 === '0') {
      return null;
    }

    return {
      address: pair.address,
      dex: pair.dex,
      token0: pair.token0,
      token1: pair.token1,
      reserve0,
      reserve1,
      // Use ?? to correctly handle fee: 0
      fee: pair.fee ?? options?.defaultFee ?? DEFAULT_FEE,
      blockNumber: pair.blockNumber,
    };
  }

  /**
   * Create snapshots of all pairs with valid reserves.
   *
   * @param options - Snapshot options
   * @returns Map of key -> PairSnapshot
   */
  createAllSnapshots(options?: SnapshotOptions): Map<string, PairSnapshot> {
    const snapshots = new Map<string, PairSnapshot>();

    for (const [key, pair] of this.pairs.entries()) {
      const snapshot = this.createSnapshot(pair, options);
      if (snapshot) {
        snapshots.set(key, snapshot);
      }
    }

    return snapshots;
  }

  /**
   * Create snapshots of pairs for a specific token combination.
   * Used for efficient arbitrage detection.
   *
   * @param token0 - First token address
   * @param token1 - Second token address
   * @param options - Snapshot options
   * @returns Array of valid snapshots
   */
  createSnapshotsForTokens(
    token0: string,
    token1: string,
    options?: SnapshotOptions
  ): PairSnapshot[] {
    const pairs = this.getByTokens(token0, token1);
    const snapshots: PairSnapshot[] = [];

    for (const pair of pairs) {
      const snapshot = this.createSnapshot(pair, options);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }

    return snapshots;
  }

  // ===========================================================================
  // Iteration
  // ===========================================================================

  /**
   * Get the number of pairs in the repository.
   */
  get size(): number {
    return this.pairs.size;
  }

  /**
   * Iterate over all pairs.
   */
  values(): IterableIterator<Pair> {
    return this.pairs.values();
  }

  /**
   * Iterate over all key-pair entries.
   */
  entries(): IterableIterator<[string, Pair]> {
    return this.pairs.entries();
  }

  /**
   * Iterate over all keys.
   */
  keys(): IterableIterator<string> {
    return this.pairs.keys();
  }

  /**
   * Get all token pair keys (for iterating unique token combinations).
   */
  tokenPairKeys(): IterableIterator<string> {
    return this.pairsByTokens.keys();
  }

  /**
   * Execute a callback for each pair.
   */
  forEach(callback: (pair: Pair, key: string) => void): void {
    this.pairs.forEach((pair, key) => callback(pair, key));
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get repository statistics.
   */
  getStats(): RepositoryStats {
    let pairsWithReserves = 0;
    let totalPairsInTokenIndex = 0;

    for (const pair of this.pairs.values()) {
      if (pair.reserve0 && pair.reserve1 && pair.reserve0 !== '0' && pair.reserve1 !== '0') {
        pairsWithReserves++;
      }
    }

    for (const pairs of this.pairsByTokens.values()) {
      totalPairsInTokenIndex += pairs.length;
    }

    const uniqueTokenPairs = this.pairsByTokens.size;
    const avgPairsPerTokenPair = uniqueTokenPairs > 0
      ? totalPairsInTokenIndex / uniqueTokenPairs
      : 0;

    return {
      totalPairs: this.pairs.size,
      pairsWithReserves,
      uniqueTokenPairs,
      avgPairsPerTokenPair,
    };
  }

  // ===========================================================================
  // Change Notifications
  // ===========================================================================

  /**
   * Set a callback to be notified of pair changes.
   *
   * @param callback - Callback function, or null to clear
   */
  setChangeCallback(callback: PairChangeCallback | null): void {
    this.changeCallback = callback;
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * T1.1: Generate normalized token pair key for O(1) index lookup.
   * Tokens are sorted alphabetically (lowercase) to ensure consistent key
   * regardless of token order in the pair.
   *
   * HOT-PATH FIX: Now uses cached version from token-utils to avoid
   * repeated toLowerCase() and string concatenation in tight loops.
   */
  private getTokenPairKey(token0: string, token1: string): string {
    // HOT-PATH: Use cached version to avoid string allocation
    return getTokenPairKeyCached(token0, token1);
  }

  /**
   * T1.1: Add a pair to the token pair index.
   */
  private addPairToTokenIndex(pair: Pair): void {
    const key = this.getTokenPairKey(pair.token0, pair.token1);
    let pairsForKey = this.pairsByTokens.get(key);
    if (!pairsForKey) {
      pairsForKey = [];
      this.pairsByTokens.set(key, pairsForKey);
    }
    // Avoid duplicates
    if (!pairsForKey.some(p => p.address.toLowerCase() === pair.address.toLowerCase())) {
      pairsForKey.push(pair);
    }
  }

  /**
   * T1.1: Remove a pair from the token pair index.
   */
  private removePairFromTokenIndex(pair: Pair): void {
    const key = this.getTokenPairKey(pair.token0, pair.token1);
    const pairsForKey = this.pairsByTokens.get(key);
    if (pairsForKey) {
      const index = pairsForKey.findIndex(
        p => p.address.toLowerCase() === pair.address.toLowerCase()
      );
      if (index !== -1) {
        pairsForKey.splice(index, 1);
      }
      if (pairsForKey.length === 0) {
        this.pairsByTokens.delete(key);
      }
    }
  }

  /**
   * P0-1 FIX: Update a pair reference in the token index atomically.
   * Replaces the old pair reference with the new one in-place.
   */
  private updatePairInTokenIndex(oldPair: Pair, newPair: Pair): void {
    const key = this.getTokenPairKey(oldPair.token0, oldPair.token1);
    const pairsForKey = this.pairsByTokens.get(key);
    if (pairsForKey) {
      const index = pairsForKey.findIndex(
        p => p.address.toLowerCase() === oldPair.address.toLowerCase()
      );
      if (index !== -1) {
        // Atomic array element replacement
        pairsForKey[index] = newPair;
      }
    }
  }

  /**
   * Find the key for a pair by its address (reverse lookup).
   */
  private findKeyByAddress(address: string): string | null {
    const normalizedAddress = address.toLowerCase();
    for (const [key, pair] of this.pairs.entries()) {
      if (pair.address.toLowerCase() === normalizedAddress) {
        return key;
      }
    }
    return null;
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new PairRepository instance.
 */
export function createPairRepository(): PairRepository {
  return new PairRepository();
}
