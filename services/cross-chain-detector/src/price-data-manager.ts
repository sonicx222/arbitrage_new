/**
 * PriceDataManager - Cross-Chain Price Data Management
 *
 * ARCH-REFACTOR: Extracted from CrossChainDetectorService to provide a single
 * responsibility module for price data storage, cleanup, and snapshots.
 *
 * Responsibilities:
 * - Storing price updates in hierarchical structure (chain/dex/pair)
 * - Cleaning old price data to prevent memory bloat
 * - Creating atomic snapshots for thread-safe detection
 * - Tracking chains being monitored
 *
 * Design Principles:
 * - Factory function for dependency injection
 * - Deterministic cleanup (counter-based, not random)
 * - Snapshot-based iteration to prevent concurrent modification issues
 *
 * @see ADR-014: Modular Detector Components
 */

import { PriceUpdate } from '@arbitrage/types';
// TYPE-CONSOLIDATION: Import shared types instead of duplicating
// P0-2 FIX: Use consolidated normalizeTokenPair from types.ts
import { Logger, PriceData, IndexedSnapshot, PricePoint, normalizeTokenPair } from './types';

// =============================================================================
// Types
// =============================================================================

// Logger and PriceData are now imported from ./types for consistency
export type { Logger, PriceData, IndexedSnapshot, PricePoint };

/** Configuration for PriceDataManager */
export interface PriceDataManagerConfig {
  /** Logger for output */
  logger: Logger;

  /** Cleanup frequency (every N updates) */
  cleanupFrequency?: number;

  /** Max age for price data in ms (default: 5 minutes) */
  maxPriceAgeMs?: number;
}

/** Public interface for PriceDataManager */
export interface PriceDataManager {
  /** Handle incoming price update */
  handlePriceUpdate(update: PriceUpdate): void;

  /**
   * Create atomic snapshot of price data.
   * @deprecated Use createIndexedSnapshot() for O(1) token pair lookups.
   * This method is retained for backwards compatibility but incurs O(n²) cost.
   */
  createSnapshot(): PriceData;

  /**
   * PERF-P1: Create indexed snapshot with O(1) token pair lookups.
   * Use this instead of createSnapshot() for detection to avoid O(n²) iteration.
   */
  createIndexedSnapshot(): IndexedSnapshot;

  /** Get list of chains being monitored */
  getChains(): string[];

  /** Get count of pairs being monitored */
  getPairCount(): number;

  /** Force cleanup of old data */
  cleanup(): void;

  /** Clear all price data */
  clear(): void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_CLEANUP_FREQUENCY = 100;
const DEFAULT_MAX_PRICE_AGE_MS = 5 * 60 * 1000; // 5 minutes

// P2-FIX: Maximum size for normalizedPairCache to prevent unbounded memory growth
// This limits memory usage in long-running services with many unique pairs
const MAX_NORMALIZED_PAIR_CACHE_SIZE = 10000;

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a PriceDataManager instance.
 *
 * @param config - Manager configuration
 * @returns PriceDataManager instance
 */
export function createPriceDataManager(config: PriceDataManagerConfig): PriceDataManager {
  const {
    logger,
    cleanupFrequency = DEFAULT_CLEANUP_FREQUENCY,
    maxPriceAgeMs = DEFAULT_MAX_PRICE_AGE_MS,
  } = config;

  const priceData: PriceData = {};
  let updateCounter = 0;

  // FIX #6: Cached pair count to avoid O(n) traversal in getPairCount()
  let pairCount = 0;

  // PERF-P4: Snapshot caching to avoid rebuilding when no data has changed
  // FIX 5.2: Use modulo to prevent integer overflow after billions of updates
  const MAX_VERSION = Number.MAX_SAFE_INTEGER - 1000; // Reset well before overflow
  let lastSnapshotVersion = 0; // Increments when data changes
  let cachedSnapshot: IndexedSnapshot | null = null;
  let cachedSnapshotVersion = -1;

  // FIX 10.1: Cache normalized token pairs to avoid repeated normalization
  // P2-FIX: Use bounded Map with LRU-style eviction when exceeding MAX_NORMALIZED_PAIR_CACHE_SIZE
  const normalizedPairCache = new Map<string, string | null>();

  /**
   * P2-FIX: Evict oldest entries from normalizedPairCache when it exceeds max size.
   * Uses simple FIFO eviction (Map maintains insertion order).
   * Evicts 20% of oldest entries to amortize eviction cost.
   */
  function pruneNormalizedPairCache(): void {
    if (normalizedPairCache.size <= MAX_NORMALIZED_PAIR_CACHE_SIZE) return;

    const evictionCount = Math.ceil(MAX_NORMALIZED_PAIR_CACHE_SIZE * 0.2);
    const keysToDelete: string[] = [];

    // Get oldest entries (Map iterates in insertion order)
    for (const key of normalizedPairCache.keys()) {
      keysToDelete.push(key);
      if (keysToDelete.length >= evictionCount) break;
    }

    for (const key of keysToDelete) {
      normalizedPairCache.delete(key);
    }

    logger.debug('Pruned normalizedPairCache', {
      evicted: keysToDelete.length,
      remaining: normalizedPairCache.size,
    });
  }

  // ===========================================================================
  // Price Data Management
  // ===========================================================================

  /**
   * Handle incoming price update.
   */
  function handlePriceUpdate(update: PriceUpdate): void {
    try {
      // Ensure nested structure exists
      if (!priceData[update.chain]) {
        priceData[update.chain] = {};
      }
      if (!priceData[update.chain][update.dex]) {
        priceData[update.chain][update.dex] = {};
      }

      // FIX #6: Track new pair insertions for cached pair count
      const isNewPair = !(update.pairKey in priceData[update.chain][update.dex]);

      // Store update
      priceData[update.chain][update.dex][update.pairKey] = update;

      if (isNewPair) {
        pairCount++;
      }

      // PERF-P4: Increment version to invalidate cached snapshot
      // FIX 5.2: Reset version counter to prevent overflow
      lastSnapshotVersion++;
      if (lastSnapshotVersion > MAX_VERSION) {
        // FIX #14: Log version reset for monitoring (rare event, indicates long-running service)
        logger.info('Snapshot version counter reset to prevent overflow', {
          previousVersion: MAX_VERSION,
          resetThreshold: MAX_VERSION,
        });
        // FIX 4.4: Reset to 1, not 0, to avoid potential collision with cachedSnapshotVersion=0 after clear()
        lastSnapshotVersion = 1;
        cachedSnapshotVersion = -1; // Force cache rebuild after reset
      }

      // Deterministic cleanup
      updateCounter++;
      if (updateCounter >= cleanupFrequency) {
        updateCounter = 0;
        cleanup();
      }

      // NOTE: Per-update debug logging removed (FIX 10.4 superseded)
      // Hot-path logging creates unacceptable overhead at 100s-1000s updates/sec.
      // Use cleanup() logs or external monitoring for price update visibility.
    } catch (error) {
      logger.error('Failed to handle price update', { error: (error as Error).message });
    }
  }

  /**
   * Clean old price data using snapshot-based iteration.
   * Prevents race conditions where priceData is modified during cleanup.
   */
  function cleanup(): void {
    const cutoffTime = Date.now() - maxPriceAgeMs;
    let dataRemoved = false;

    // Take snapshot of keys to prevent iterator invalidation
    const chainSnapshot = Object.keys(priceData);

    for (const chain of chainSnapshot) {
      // Check if chain still exists (may have been deleted by concurrent operation)
      if (!priceData[chain]) continue;

      const dexSnapshot = Object.keys(priceData[chain]);

      for (const dex of dexSnapshot) {
        // Check if dex still exists
        if (!priceData[chain] || !priceData[chain][dex]) continue;

        const pairSnapshot = Object.keys(priceData[chain][dex]);

        for (const pairKey of pairSnapshot) {
          // Check if pair still exists before accessing
          if (!priceData[chain]?.[dex]?.[pairKey]) continue;

          const update = priceData[chain][dex][pairKey];
          if (update && update.timestamp < cutoffTime) {
            delete priceData[chain][dex][pairKey];
            pairCount--;
            dataRemoved = true;
          }
        }

        // Clean empty dex objects (re-check existence)
        if (priceData[chain]?.[dex] && Object.keys(priceData[chain][dex]).length === 0) {
          delete priceData[chain][dex];
        }
      }

      // Clean empty chain objects (re-check existence)
      if (priceData[chain] && Object.keys(priceData[chain]).length === 0) {
        delete priceData[chain];
      }
    }

    // PERF-P4: Invalidate cache if data was removed
    if (dataRemoved) {
      lastSnapshotVersion++;
      // FIX 4.4: Handle overflow in cleanup (same as handlePriceUpdate)
      if (lastSnapshotVersion > MAX_VERSION) {
        lastSnapshotVersion = 1; // FIX: Reset to 1, not 0, to avoid cachedSnapshotVersion=0 collision
        cachedSnapshotVersion = -1;
      }
    }
  }

  /**
   * Create atomic snapshot of priceData for thread-safe detection.
   * Prevents race conditions where priceData is modified during detection.
   * @deprecated Use createIndexedSnapshot() for O(1) token pair lookups
   */
  function createSnapshot(): PriceData {
    const snapshot: PriceData = {};

    for (const chain of Object.keys(priceData)) {
      snapshot[chain] = {};
      for (const dex of Object.keys(priceData[chain])) {
        snapshot[chain][dex] = {};
        for (const pairKey of Object.keys(priceData[chain][dex])) {
          // Deep copy the PriceUpdate object
          // RACE-FIX: Check if original still exists (may have been deleted concurrently)
          const original = priceData[chain][dex][pairKey];
          if (original) {
            snapshot[chain][dex][pairKey] = { ...original };
          }
        }
      }
    }

    return snapshot;
  }

  /**
   * PERF-P1: Create indexed snapshot with O(1) token pair lookups.
   *
   * This builds a reverse index during snapshot creation so that detection
   * can look up prices by normalized token pair in O(1) instead of O(n²).
   *
   * Performance improvement:
   * - Old: O(tokenPairs × chains × dexes × pairs) for each detection cycle
   * - New: O(chains × dexes × pairs) once to build index, then O(1) per lookup
   *
   * PERF-P4: Added caching - returns cached snapshot if no data has changed.
   */
  function createIndexedSnapshot(): IndexedSnapshot {
    // PERF-P4: Return cached snapshot if data hasn't changed
    // NOTE: Per-hit debug logging removed - cache hits are high-frequency
    if (cachedSnapshot !== null && cachedSnapshotVersion === lastSnapshotVersion) {
      return cachedSnapshot;
    }

    const raw: PriceData = {};
    const byToken = new Map<string, PricePoint[]>();
    const tokenPairsSet = new Set<string>();
    const timestamp = Date.now();

    for (const chain of Object.keys(priceData)) {
      raw[chain] = {};
      for (const dex of Object.keys(priceData[chain])) {
        raw[chain][dex] = {};
        for (const pairKey of Object.keys(priceData[chain][dex])) {
          // RACE-FIX: Check if original still exists
          const original = priceData[chain][dex][pairKey];
          if (!original) continue;

          // Deep copy for raw snapshot
          const update = { ...original };
          raw[chain][dex][pairKey] = update;

          // FIX 10.1: Check cache first for normalized pair
          let normalizedPair = normalizedPairCache.get(pairKey);

          if (normalizedPair === undefined) {
            // P0-2 FIX: Use consolidated normalizeTokenPair from types.ts
            // This handles DEX prefixes, token validation, and cross-chain normalization
            try {
              normalizedPair = normalizeTokenPair(pairKey);
              normalizedPairCache.set(pairKey, normalizedPair);

              if (normalizedPair === null) {
                logger.warn('Invalid token pair format in pairKey', { pairKey, chain, dex });
                continue;
              }
            } catch (normError) {
              logger.warn('Token normalization threw error', {
                pairKey,
                error: (normError as Error).message
              });
              normalizedPairCache.set(pairKey, null);
              continue;
            }
          } else if (normalizedPair === null) {
            // Previously failed normalization - skip
            continue;
          }

          // Add to token pair set
          tokenPairsSet.add(normalizedPair);

          // Build price point
          const pricePoint: PricePoint = {
            chain,
            dex,
            pairKey,
            price: update.price,
            update,
          };

          // Add to index
          const existing = byToken.get(normalizedPair);
          if (existing) {
            existing.push(pricePoint);
          } else {
            byToken.set(normalizedPair, [pricePoint]);
          }
        }
      }
    }

    // P2-FIX: Prune cache if it has grown too large during processing
    pruneNormalizedPairCache();

    // PERF 10.2: Filter out token pairs with only single-chain data
    // Cross-chain arbitrage requires at least 2 chains with different prices
    const validTokenPairs: string[] = [];
    for (const tokenPair of tokenPairsSet) {
      const prices = byToken.get(tokenPair);
      if (prices && prices.length >= 2) {
        // Also verify we have at least 2 different chains
        const chains = new Set(prices.map(p => p.chain));
        if (chains.size >= 2) {
          validTokenPairs.push(tokenPair);
        }
      }
    }

    const snapshot: IndexedSnapshot = {
      byToken,
      raw,
      tokenPairs: validTokenPairs, // PERF 10.2: Only include pairs with cross-chain potential
      timestamp,
    };

    // PERF-P4: Cache the newly built snapshot
    cachedSnapshot = snapshot;
    cachedSnapshotVersion = lastSnapshotVersion;

    logger.debug('Built new indexed snapshot', {
      version: cachedSnapshotVersion,
      tokenPairs: snapshot.tokenPairs.length,
      chains: Object.keys(raw).length,
    });

    return snapshot;
  }

  /**
   * Get list of chains being monitored.
   */
  function getChains(): string[] {
    return Object.keys(priceData);
  }

  /**
   * Get count of pairs being monitored.
   */
  function getPairCount(): number {
    // FIX #6: Return cached counter instead of O(n) traversal
    return pairCount;
  }

  /**
   * Clear all price data.
   */
  function clear(): void {
    // Clear all entries
    for (const chain of Object.keys(priceData)) {
      delete priceData[chain];
    }
    updateCounter = 0;

    // FIX #6: Reset cached pair count
    pairCount = 0;

    // PERF-P4: Reset cache
    // FIX 4.4: Reset to consistent values that won't cause cache collision
    // - cachedSnapshot = null ensures first createIndexedSnapshot rebuilds
    // - cachedSnapshotVersion = -1 ensures no match with lastSnapshotVersion
    // - lastSnapshotVersion = 1 matches overflow reset behavior for consistency
    cachedSnapshot = null;
    cachedSnapshotVersion = -1;
    lastSnapshotVersion = 1;

    // FIX BUG-2: Clear normalizedPairCache to prevent stale entries on restart
    normalizedPairCache.clear();

    logger.info('PriceDataManager cleared');
  }

  return {
    handlePriceUpdate,
    createSnapshot,
    createIndexedSnapshot,
    getChains,
    getPairCount,
    cleanup,
    clear,
  };
}
