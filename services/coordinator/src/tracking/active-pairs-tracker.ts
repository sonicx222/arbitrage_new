/**
 * Active Pairs Tracker
 *
 * Tracks which trading pairs are currently active across all streams
 * (swap events, volume aggregates, price updates). Provides TTL-based
 * cleanup and emergency eviction with hysteresis to prevent unbounded
 * memory growth.
 *
 * Extracted from coordinator.ts (P1-2 god class extraction).
 *
 * @see coordinator.ts for usage in stream message handlers
 * @see P3-005: Max active pairs limit
 * @see P0 FIX #2 + #11: Emergency cleanup with hysteresis
 */

import { findKSmallest } from '@arbitrage/core/data-structures/min-heap';

// =============================================================================
// Types
// =============================================================================

export interface ActivePairsTrackerConfig {
  /** How long a pair stays active without new activity (default: 300000ms = 5 min) */
  pairTtlMs: number;
  /** Maximum pairs tracked before emergency eviction (default: 10000) */
  maxActivePairs: number;
}

export interface ActivePairInfo {
  lastSeen: number;
  chain: string;
  dex: string;
}

/** Minimal logger interface for the tracker */
export interface ActivePairsLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

// =============================================================================
// ActivePairsTracker
// =============================================================================

export class ActivePairsTracker {
  private readonly activePairs: Map<string, ActivePairInfo> = new Map();

  constructor(
    private readonly logger: ActivePairsLogger,
    private readonly config: ActivePairsTrackerConfig,
  ) {}

  /**
   * Track an active trading pair.
   *
   * P3-005 FIX: Includes emergency eviction with hysteresis when map
   * exceeds maxActivePairs. Evicts down to 75% of limit to prevent
   * re-triggering on every subsequent message.
   *
   * P0 FIX #2 + #11: Uses findKSmallest() for O(n log k) selection
   * instead of Array.from().sort() for O(n log n).
   */
  trackPair(pairKey: string, chain: string, dex: string): void {
    this.activePairs.set(pairKey, {
      lastSeen: Date.now(),
      chain,
      dex,
    });

    // Emergency cleanup with hysteresis and O(n log k) selection
    if (this.activePairs.size > this.config.maxActivePairs) {
      const targetSize = Math.floor(this.config.maxActivePairs * 0.75);
      const toRemove = this.activePairs.size - targetSize;
      const oldest = findKSmallest(
        this.activePairs.entries(),
        toRemove,
        ([, a], [, b]) => a.lastSeen - b.lastSeen,
      );

      for (const [key] of oldest) {
        this.activePairs.delete(key);
      }

      this.logger.debug('Emergency activePairs cleanup triggered', {
        removed: oldest.length,
        remaining: this.activePairs.size,
        limit: this.config.maxActivePairs,
      });
    }
  }

  /**
   * Remove pairs that haven't been seen within the TTL window.
   * Called periodically by the coordinator's cleanup interval.
   */
  cleanup(): void {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [pairAddress, info] of this.activePairs) {
      if (now - info.lastSeen > this.config.pairTtlMs) {
        toDelete.push(pairAddress);
      }
    }

    for (const pairAddress of toDelete) {
      this.activePairs.delete(pairAddress);
    }

    if (toDelete.length > 0) {
      this.logger.debug('Cleaned up stale active pairs', {
        removed: toDelete.length,
        remaining: this.activePairs.size,
      });
    }
  }

  /** Current number of tracked pairs */
  get size(): number {
    return this.activePairs.size;
  }

  /** Clear all tracked pairs (used during shutdown) */
  clear(): void {
    this.activePairs.clear();
  }

  /** Check if a pair is currently tracked (used in tests) */
  has(key: string): boolean {
    return this.activePairs.has(key);
  }

  /** Get a pair's info (used in tests) */
  get(key: string): ActivePairInfo | undefined {
    return this.activePairs.get(key);
  }

  /** Set a pair directly (used in tests for setup) */
  set(key: string, info: ActivePairInfo): void {
    this.activePairs.set(key, info);
  }
}
