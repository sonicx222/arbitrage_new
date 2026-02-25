/**
 * Pair Snapshot Manager
 *
 * Manages creation and caching of pair snapshots for thread-safe arbitrage detection.
 * Snapshots capture reserve values at a point in time to avoid race conditions
 * when reserves are updated by concurrent Sync events.
 *
 * ## Hot-Path Performance
 *
 * This module is in the HOT PATH. Key optimizations:
 * - Time-based cache with configurable TTL (default 100ms)
 * - Version-based cache invalidation for DexPool conversion
 * - Pre-allocated arrays (FIX 10.2) to avoid dynamic resizing
 * - BigInt values pre-computed during snapshot creation
 *
 * ## Cache Coherency
 *
 * Uses two-level caching:
 * 1. **Snapshot Cache**: Time-based TTL, stores Map<address, PairSnapshot>
 * 2. **DexPool Cache**: Version-based, invalidates on any snapshot mutation
 *
 * FIX Race 5.1: Captures version ONCE before checking to avoid TOCTOU race.
 *
 * ## BigInt Parsing
 *
 * Reserve values come as strings from events. This module:
 * - Parses to BigInt with try-catch for invalid formats
 * - Rejects zero reserves (division by zero protection)
 * - Caches BigInt values in snapshot for hot-path use
 *
 * ## Testing
 *
 * Comprehensive tests in `__tests__/unit/snapshot-manager.test.ts`:
 * - BigInt edge cases (very large, leading zeros)
 * - Cache invalidation scenarios
 * - Concurrent access patterns
 *
 * @module detection/snapshot-manager
 * @see R3 - Chain Instance Detection Strategies
 * @see docs/reports/BUG_FIX_LOG_2026-02.md - Fix 2.3, 10.2
 * @see ADR-022 - Hot-Path Memory Optimization
 */

import {
  calculatePriceFromBigIntReserves,
  type DexPool,
} from '@arbitrage/core';
import type { PairSnapshot } from './simple-arbitrage-detector';

// P0-2 FIX: Use centralized fee validation (FIX 9.3)
import { validateFee } from '@arbitrage/core';

/**
 * Extended pair interface with reserve data.
 * Compatible with the base Pair interface from @arbitrage/types.
 */
export interface ExtendedPair {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  fee?: number; // Optional to match Pair interface; defaults to 0.003 (0.3%)
  blockNumber: number;
  lastUpdate?: number;
  name?: string;
}

/**
 * Configuration for snapshot manager.
 */
export interface SnapshotManagerConfig {
  /** Cache TTL in milliseconds (default: 100ms) */
  cacheTtlMs?: number;
}

/**
 * Snapshot Manager
 *
 * Provides efficient pair snapshot creation with caching to avoid
 * redundant O(N) iterations when multiple pairs update within a short window.
 */
export class SnapshotManager {
  private readonly cacheTtlMs: number;

  // PERF-OPT: Snapshot caching to avoid O(N) iteration on every check
  private snapshotCache: Map<string, PairSnapshot> | null = null;
  private snapshotCacheTimestamp: number = 0;

  // FIX Perf 10.3: Version-based cache invalidation
  private snapshotVersion: number = 0;

  // PERF 10.3: Cache DexPool[] array to avoid O(N) conversion on every triangular check
  private dexPoolCache: DexPool[] | null = null;
  private dexPoolCacheVersion: number = -1;

  constructor(config?: SnapshotManagerConfig) {
    this.cacheTtlMs = config?.cacheTtlMs ?? 100;
  }

  /**
   * Create a snapshot of a single pair.
   * Captures current reserve values with BigInt caching for hot-path calculations.
   *
   * @param pair - Extended pair with reserve data
   * @returns PairSnapshot or null if reserves are invalid
   */
  createPairSnapshot(pair: ExtendedPair): PairSnapshot | null {
    if (!pair.reserve0 || !pair.reserve1) {
      return null;
    }

    // PERF 10.1: Pre-compute BigInt values for hot-path calculations
    // This avoids repeated string-to-BigInt conversion during arbitrage detection
    let reserve0BigInt: bigint;
    let reserve1BigInt: bigint;

    try {
      reserve0BigInt = BigInt(pair.reserve0);
      reserve1BigInt = BigInt(pair.reserve1);
    } catch {
      // Invalid reserve format
      return null;
    }

    // Skip pairs with zero reserves
    if (reserve0BigInt === 0n || reserve1BigInt === 0n) {
      return null;
    }

    // HOT-PATH OPT (Perf-3): Skip redundant toLowerCase() calls.
    // Addresses are already normalized to lowercase at pair creation time
    // (chain-instance.ts initializePairs). Callers are responsible for normalization.
    return {
      address: pair.address,
      dex: pair.dex,
      token0: pair.token0,
      token1: pair.token1,
      reserve0: pair.reserve0,
      reserve1: pair.reserve1,
      fee: validateFee(pair.fee),
      blockNumber: pair.blockNumber,
      reserve0BigInt,
      reserve1BigInt,
    };
  }

  /**
   * Create snapshots of all pairs with caching.
   * Uses time-based and version-based cache invalidation.
   *
   * @param pairs - Map of pair key to ExtendedPair
   * @param forceRefresh - If true, bypass cache
   * @returns Map of address to PairSnapshot
   */
  createPairsSnapshot(
    pairs: Map<string, ExtendedPair>,
    forceRefresh: boolean = false
  ): Map<string, PairSnapshot> {
    const now = Date.now();

    // Use cache if available and fresh
    if (
      !forceRefresh &&
      this.snapshotCache &&
      now - this.snapshotCacheTimestamp < this.cacheTtlMs
    ) {
      return this.snapshotCache;
    }

    // Create fresh snapshots
    const snapshots = new Map<string, PairSnapshot>();

    for (const [, pair] of pairs) {
      const snapshot = this.createPairSnapshot(pair);
      if (snapshot) {
        snapshots.set(snapshot.address, snapshot);
      }
    }

    // Update cache
    this.snapshotCache = snapshots;
    this.snapshotCacheTimestamp = now;
    this.snapshotVersion++;

    return snapshots;
  }

  /**
   * Convert pair snapshots to DexPool format for triangular detection.
   * Uses version-based caching to avoid redundant conversions.
   *
   * @param pairsSnapshot - Map of snapshots
   * @returns Array of DexPool objects
   */
  getDexPools(pairsSnapshot: Map<string, PairSnapshot>): DexPool[] {
    // FIX Race 5.1: Capture version ONCE to avoid TOCTOU race
    const capturedVersion = this.snapshotVersion;

    // Use cache if version matches
    if (this.dexPoolCache && this.dexPoolCacheVersion === capturedVersion) {
      return this.dexPoolCache;
    }

    // FIX 10.2: Pre-allocate array to avoid dynamic resizing
    // For ~500 pairs, avoids ~10 array copies during growth
    const pools: DexPool[] = new Array(pairsSnapshot.size);
    let i = 0;
    for (const snapshot of pairsSnapshot.values()) {
      pools[i++] = this.convertSnapshotToDexPool(snapshot);
    }

    // Update cache with captured version
    this.dexPoolCache = pools;
    this.dexPoolCacheVersion = capturedVersion;

    return pools;
  }

  /**
   * Convert a single pair snapshot to DexPool format.
   * Matches the interface required by CrossDexTriangularArbitrage.
   *
   * @param snapshot - Pair snapshot
   * @returns DexPool object
   */
  private convertSnapshotToDexPool(snapshot: PairSnapshot): DexPool {
    // P0-1 FIX: Use precision-safe price calculation
    const price = calculatePriceFromBigIntReserves(
      snapshot.reserve1BigInt,
      snapshot.reserve0BigInt
    ) ?? 0;

    // Estimate liquidity from reserves (simplified USD estimation)
    const liquidity = Number(snapshot.reserve0BigInt) * price * 2;

    // FIX 6.2: Fee already validated in createPairSnapshot() - don't validate again
    // HOT-PATH OPT: Removes redundant validateFee() call per snapshot conversion
    return {
      dex: snapshot.dex,
      token0: snapshot.token0,
      token1: snapshot.token1,
      reserve0: snapshot.reserve0,
      reserve1: snapshot.reserve1,
      fee: Math.round(snapshot.fee * 10000), // Convert to basis points
      liquidity,
      price,
    };
  }

  // P0-2 FIX: Removed private validateFee() - now uses centralized version from ../types

  /**
   * Invalidate cache when pairs are updated.
   * Should be called when Sync events are processed.
   */
  invalidateCache(): void {
    this.snapshotCache = null;
    this.snapshotVersion++;
  }

  /**
   * Get current snapshot version for cache coordination.
   */
  getSnapshotVersion(): number {
    return this.snapshotVersion;
  }

  /**
   * Clear all caches (for cleanup/testing).
   */
  clear(): void {
    this.snapshotCache = null;
    this.dexPoolCache = null;
    this.snapshotCacheTimestamp = 0;
    this.snapshotVersion = 0;
    this.dexPoolCacheVersion = -1;
  }
}

/**
 * Create a snapshot manager instance.
 *
 * @param config - Optional configuration
 * @returns SnapshotManager instance
 */
export function createSnapshotManager(
  config?: SnapshotManagerConfig
): SnapshotManager {
  return new SnapshotManager(config);
}
