/**
 * Solana Pool Manager
 *
 * ARCH-REFACTOR: Extracted from solana-detector.ts
 * Manages pool CRUD operations with three synchronized indices:
 * - pools (address -> pool)
 * - poolsByDex (dex -> Set<address>)
 * - poolsByTokenPair (pairKey -> Set<address>)
 *
 * Owns the poolUpdateMutex for atomic write operations.
 * Readers use lock-free snapshots via getPoolsSnapshot().
 *
 * @see ADR-014: Modular Detector Components
 */

import { AsyncMutex } from '../async/async-mutex';
import type { SolanaDetectorLogger, SolanaPool } from './solana-types';
import { SOLANA_DEX_PROGRAMS } from './solana-types';

// =============================================================================
// Public Interface
// =============================================================================

export interface SolanaPoolManager {
  addPool(pool: SolanaPool): Promise<void>;
  removePool(address: string): Promise<void>;
  getPool(address: string): SolanaPool | undefined;
  getPoolCount(): number;
  getPoolsByDex(dex: string): SolanaPool[];
  getPoolsByTokenPair(token0: string, token1: string): SolanaPool[];
  updatePoolPrice(poolAddress: string, update: { price: number; reserve0: string; reserve1: string; slot: number }): Promise<void>;
  /** Lock-free snapshot for arbitrage detection. Synchronous Map/Array copy is atomic w.r.t. the event loop. */
  getPoolsSnapshot(): { pools: Map<string, SolanaPool>; pairEntries: [string, Set<string>][] };
  /** Clear all pools and indices. */
  cleanup(): void;
}

export interface PoolManagerDeps {
  logger: SolanaDetectorLogger;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Solana pool manager instance.
 *
 * @param deps - Dependencies
 * @returns SolanaPoolManager
 */
export function createSolanaPoolManager(deps: PoolManagerDeps): SolanaPoolManager {
  const { logger } = deps;

  // Private state
  const pools = new Map<string, SolanaPool>();
  const poolsByDex = new Map<string, Set<string>>();
  const poolsByTokenPair = new Map<string, Set<string>>();
  const poolUpdateMutex = new AsyncMutex();

  // Known programs for validation warnings (Set for O(1) lookup)
  const knownProgramsSet: ReadonlySet<string> = new Set(Object.values(SOLANA_DEX_PROGRAMS));

  function getTokenPairKey(token0: string, token1: string): string {
    // Solana addresses are base58 (case-sensitive) — no toLowerCase needed.
    // Direct comparison also avoids array allocation + sort.
    return token0 < token1 ? `${token0}_${token1}` : `${token1}_${token0}`;
  }

  async function addPool(pool: SolanaPool): Promise<void> {
    await poolUpdateMutex.runExclusive(async () => {
      pools.set(pool.address, pool);

      // Index by DEX
      if (!poolsByDex.has(pool.dex)) {
        poolsByDex.set(pool.dex, new Set());
      }
      poolsByDex.get(pool.dex)!.add(pool.address);

      // Index by token pair (normalized)
      const pairKey = getTokenPairKey(pool.token0.mint, pool.token1.mint);
      if (!poolsByTokenPair.has(pairKey)) {
        poolsByTokenPair.set(pairKey, new Set());
      }
      poolsByTokenPair.get(pairKey)!.add(pool.address);

      // Warn about unknown program IDs
      if (pool.programId && !knownProgramsSet.has(pool.programId)) {
        logger.warn('Pool added with unknown program ID', {
          address: pool.address,
          programId: pool.programId,
          dex: pool.dex
        });
      }

      logger.debug('Pool added', {
        address: pool.address,
        dex: pool.dex,
        pair: `${pool.token0.symbol}/${pool.token1.symbol}`
      });
    });
  }

  async function removePool(address: string): Promise<void> {
    await poolUpdateMutex.runExclusive(async () => {
      const pool = pools.get(address);
      if (!pool) return;

      // Remove from DEX index and clean up empty Set
      const dexSet = poolsByDex.get(pool.dex);
      if (dexSet) {
        dexSet.delete(address);
        if (dexSet.size === 0) {
          poolsByDex.delete(pool.dex);
        }
      }

      // Remove from token pair index and clean up empty Set
      const pairKey = getTokenPairKey(pool.token0.mint, pool.token1.mint);
      const pairSet = poolsByTokenPair.get(pairKey);
      if (pairSet) {
        pairSet.delete(address);
        if (pairSet.size === 0) {
          poolsByTokenPair.delete(pairKey);
        }
      }

      // Remove from main map
      pools.delete(address);

      logger.debug('Pool removed', { address });
    });
  }

  function getPool(address: string): SolanaPool | undefined {
    return pools.get(address);
  }

  function getPoolCount(): number {
    return pools.size;
  }

  function getPoolsByDex(dex: string): SolanaPool[] {
    const addresses = poolsByDex.get(dex);
    if (!addresses) return [];

    return Array.from(addresses)
      .map(addr => pools.get(addr))
      .filter((p): p is SolanaPool => p !== undefined);
  }

  function getPoolsByTokenPair(token0: string, token1: string): SolanaPool[] {
    const pairKey = getTokenPairKey(token0, token1);
    const addresses = poolsByTokenPair.get(pairKey);
    if (!addresses) return [];

    return Array.from(addresses)
      .map(addr => pools.get(addr))
      .filter((p): p is SolanaPool => p !== undefined);
  }

  async function updatePoolPrice(
    poolAddress: string,
    update: { price: number; reserve0: string; reserve1: string; slot: number }
  ): Promise<void> {
    // Reject invalid prices before acquiring mutex
    if (!Number.isFinite(update.price) || update.price <= 0) {
      logger.warn('Invalid price rejected in updatePoolPrice', { poolAddress, price: update.price });
      return;
    }

    await poolUpdateMutex.runExclusive(async () => {
      const pool = pools.get(poolAddress);
      if (!pool) {
        logger.warn('Pool not found for price update', { poolAddress });
        return;
      }

      // RACE CONDITION FIX: Create new pool object instead of mutating in-place.
      // checkArbitrage() snapshots the Map but gets references to pool objects —
      // mutation during iteration could cause incorrect buy/sell direction.
      const updatedPool: SolanaPool = {
        ...pool,
        price: update.price,
        reserve0: update.reserve0,
        reserve1: update.reserve1,
        lastSlot: update.slot,
      };
      pools.set(poolAddress, updatedPool);
    });
  }

  function getPoolsSnapshot(): { pools: Map<string, SolanaPool>; pairEntries: [string, Set<string>][] } {
    // Synchronous Map copy + Array.from is atomic w.r.t. the JS event loop.
    // No mutex needed — writers hold the mutex, and these sync operations
    // cannot be interleaved with async mutex-protected writes.
    return {
      pools: new Map(pools),
      pairEntries: Array.from(poolsByTokenPair.entries()).map(
        ([key, set]) => [key, new Set(set)] as [string, Set<string>]
      ),
    };
  }

  function cleanup(): void {
    pools.clear();
    poolsByDex.clear();
    poolsByTokenPair.clear();
  }

  return {
    addPool,
    removePool,
    getPool,
    getPoolCount,
    getPoolsByDex,
    getPoolsByTokenPair,
    updatePoolPrice,
    getPoolsSnapshot,
    cleanup,
  };
}
