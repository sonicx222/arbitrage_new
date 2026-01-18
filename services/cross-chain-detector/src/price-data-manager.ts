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

// =============================================================================
// Types
// =============================================================================

/** Logger interface for dependency injection */
export interface Logger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/** Hierarchical price data structure */
export interface PriceData {
  [chain: string]: {
    [dex: string]: {
      [pairKey: string]: PriceUpdate;
    };
  };
}

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

  /** Create atomic snapshot of price data */
  createSnapshot(): PriceData;

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

      // Store update
      priceData[update.chain][update.dex][update.pairKey] = update;

      // Deterministic cleanup
      updateCounter++;
      if (updateCounter >= cleanupFrequency) {
        updateCounter = 0;
        cleanup();
      }

      logger.debug(`Updated price: ${update.chain}/${update.dex}/${update.pairKey} = ${update.price}`);
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
  }

  /**
   * Create atomic snapshot of priceData for thread-safe detection.
   * Prevents race conditions where priceData is modified during detection.
   */
  function createSnapshot(): PriceData {
    const snapshot: PriceData = {};

    for (const chain of Object.keys(priceData)) {
      snapshot[chain] = {};
      for (const dex of Object.keys(priceData[chain])) {
        snapshot[chain][dex] = {};
        for (const pairKey of Object.keys(priceData[chain][dex])) {
          // Deep copy the PriceUpdate object
          const original = priceData[chain][dex][pairKey];
          snapshot[chain][dex][pairKey] = { ...original };
        }
      }
    }

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
    let count = 0;
    for (const chain of Object.keys(priceData)) {
      for (const dex of Object.keys(priceData[chain])) {
        count += Object.keys(priceData[chain][dex]).length;
      }
    }
    return count;
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
    logger.info('PriceDataManager cleared');
  }

  return {
    handlePriceUpdate,
    createSnapshot,
    getChains,
    getPairCount,
    cleanup,
    clear,
  };
}
