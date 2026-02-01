/**
 * Lock Conflict Tracker
 *
 * Tracks repeated lock conflicts to detect crashed lock holders.
 * Used for crash recovery when a lock holder process dies while holding a lock.
 *
 * P1 FIX: Extracted from engine.ts for single-responsibility principle.
 * Improves testability and reduces engine.ts complexity.
 *
 * @see SPRINT 1 FIX: Lock holder crash recovery tracking
 * @see P0-FIX 1.7: Memory growth protection
 */

import { findKSmallest, createLogger } from '@arbitrage/core';

const logger = createLogger('lock-conflict-tracker');

/**
 * Conflict tracking information for a single opportunity.
 */
export interface ConflictInfo {
  /** Timestamp of first conflict seen */
  firstSeen: number;
  /** Number of conflicts observed */
  count: number;
}

/**
 * Configuration for the lock conflict tracker.
 */
export interface LockConflictTrackerConfig {
  /**
   * After this many consecutive lock conflicts, consider force-releasing the lock.
   * Default: 3
   */
  conflictThreshold?: number;

  /**
   * Time window (ms) within which conflicts are considered consecutive.
   * Default: 30000 (30 seconds)
   */
  windowMs?: number;

  /**
   * Minimum time since first conflict before considering force release.
   * Gives legitimate lock holders time to complete.
   * Default: 20000 (20 seconds)
   */
  minAgeMs?: number;

  /**
   * Maximum entries to prevent unbounded memory growth.
   * Default: 1000
   */
  maxEntries?: number;
}

/**
 * Tracks lock conflicts to detect crashed lock holders.
 *
 * When multiple execution attempts fail to acquire the same lock repeatedly,
 * this indicates the original lock holder may have crashed. This tracker
 * identifies such patterns and signals when a lock should be force-released.
 *
 * Thread-safe: Uses atomic Map operations.
 */
export class LockConflictTracker {
  private tracker: Map<string, ConflictInfo> = new Map();

  // Configuration (readonly after construction)
  private readonly conflictThreshold: number;
  private readonly windowMs: number;
  private readonly minAgeMs: number;
  private readonly maxEntries: number;

  constructor(config: LockConflictTrackerConfig = {}) {
    this.conflictThreshold = config.conflictThreshold ?? 3;
    this.windowMs = config.windowMs ?? 30000;
    this.minAgeMs = config.minAgeMs ?? 20000;
    this.maxEntries = config.maxEntries ?? 1000;
  }

  /**
   * Record a lock conflict for an opportunity.
   *
   * Tracks consecutive conflicts within the time window to detect
   * potential crashed lock holders.
   *
   * @param opportunityId - The ID of the opportunity that failed to acquire lock
   * @returns true if the lock should be force-released (holder likely crashed)
   */
  recordConflict(opportunityId: string): boolean {
    const now = Date.now();
    const existing = this.tracker.get(opportunityId);

    if (existing) {
      // Check if this conflict is within the tracking window
      const age = now - existing.firstSeen;

      if (age > this.windowMs) {
        // Old entry - reset tracking
        this.tracker.set(opportunityId, { firstSeen: now, count: 1 });
        return false;
      }

      // Increment conflict count
      existing.count++;

      // Check if we should force release:
      // 1. Enough conflicts have occurred (threshold)
      // 2. Enough time has passed (give legitimate holders a chance)
      if (existing.count >= this.conflictThreshold && age >= this.minAgeMs) {
        return true;
      }

      return false;
    }

    // First conflict for this opportunity - start tracking
    this.tracker.set(opportunityId, { firstSeen: now, count: 1 });
    return false;
  }

  /**
   * Get the current conflict info for an opportunity.
   * @param opportunityId - The opportunity ID
   * @returns Conflict info or undefined if not tracked
   */
  getConflictInfo(opportunityId: string): ConflictInfo | undefined {
    return this.tracker.get(opportunityId);
  }

  /**
   * Clear tracking for a specific opportunity.
   * Called after successful lock acquisition or force release.
   *
   * @param opportunityId - The opportunity ID to clear
   */
  clear(opportunityId: string): void {
    this.tracker.delete(opportunityId);
  }

  /**
   * Get current tracker size.
   */
  get size(): number {
    return this.tracker.size;
  }

  /**
   * Clean up stale entries and enforce size limit.
   *
   * Should be called periodically from health monitoring.
   * Uses O(n log k) eviction for efficiency.
   */
  cleanup(): void {
    const now = Date.now();
    const staleThreshold = this.windowMs * 2; // Double the window for stale detection

    // Phase 1: Remove stale entries (older than threshold)
    for (const [id, info] of this.tracker) {
      if (now - info.firstSeen > staleThreshold) {
        this.tracker.delete(id);
      }
    }

    // Phase 2: Enforce size limit by removing oldest entries
    // P0-FIX 1.7: Prevents unbounded memory growth under extreme load
    if (this.tracker.size > this.maxEntries) {
      const removeCount = this.tracker.size - this.maxEntries;

      // Use findKSmallest for O(n log k) instead of sorting all entries O(n log n)
      const oldestK = findKSmallest(
        this.tracker.entries(),
        removeCount,
        ([, a], [, b]) => a.firstSeen - b.firstSeen
      );

      for (const [id] of oldestK) {
        this.tracker.delete(id);
      }

      logger.debug('Lock conflict tracker size enforced', {
        removedCount: removeCount,
        newSize: this.tracker.size
      });
    }
  }

  /**
   * Reset tracker (used in testing).
   */
  reset(): void {
    this.tracker.clear();
  }
}

// Default singleton instance
let defaultTracker: LockConflictTracker | null = null;

/**
 * Get the default lock conflict tracker instance.
 */
export function getLockConflictTracker(): LockConflictTracker {
  if (!defaultTracker) {
    defaultTracker = new LockConflictTracker();
  }
  return defaultTracker;
}

/**
 * Reset the default tracker instance (used in testing).
 */
export function resetLockConflictTracker(): void {
  defaultTracker?.reset();
  defaultTracker = null;
}
