/**
 * Hot Fork Synchronizer
 *
 * Keeps the Anvil fork synchronized with the latest block from the source RPC.
 * This minimizes fork reset time during pending transaction simulations.
 *
 * Features:
 * - Periodic sync with configurable interval
 * - Graceful degradation on sync failures
 * - Metrics tracking for sync operations
 * - Pause/resume capability
 *
 * @see Phase 2: Pending-State Simulation Engine (Implementation Plan v3.0)
 * @see Task 2.3.2: Hot Fork Synchronization
 */

import { ethers } from 'ethers';
import { createPinoLogger, CircularBuffer, clearIntervalSafe, clearTimeoutSafe, type ILogger } from '@arbitrage/core';
import type { AnvilForkManager } from './anvil-manager';
import type { Logger } from '../../types';
import type { BaseMetrics } from './types';

// =============================================================================
// Types
// =============================================================================

/**
 * Fix 6.2: Use shared Logger interface from types.ts for consistency.
 * The Logger interface from types.ts is used across all execution engine
 * components for consistent logging behavior.
 */

/**
 * Lazy-initialized Pino logger for when no logger is provided.
 * Uses Pino for proper structured logging with LOG_LEVEL support.
 */
let _defaultLogger: ILogger | null = null;
function getDefaultLogger(): ILogger {
  if (!_defaultLogger) {
    _defaultLogger = createPinoLogger('hot-fork-synchronizer');
  }
  return _defaultLogger;
}

/**
 * Configuration for HotForkSynchronizer.
 */
export interface HotForkSynchronizerConfig {
  /** AnvilForkManager instance to synchronize */
  anvilManager: AnvilForkManager;
  /** Source RPC provider for getting latest block */
  sourceProvider: ethers.JsonRpcProvider;
  /** Sync interval in milliseconds (default: 1000) */
  syncIntervalMs?: number;
  /** Maximum consecutive sync failures before pausing (default: 5) */
  maxConsecutiveFailures?: number;
  /** Whether to auto-start synchronization (default: false) */
  autoStart?: boolean;
  /** Logger instance for structured logging (default: console-based) - Fix 6.2 */
  logger?: Logger;
  /**
   * Fix 10.5: Enable adaptive sync interval based on block production rate.
   * When enabled, sync interval adjusts between minSyncIntervalMs and maxSyncIntervalMs
   * based on network activity. (default: false)
   */
  adaptiveSync?: boolean;
  /** Minimum sync interval when adaptive sync is enabled (default: 200ms) */
  minSyncIntervalMs?: number;
  /** Maximum sync interval when adaptive sync is enabled (default: 5000ms) */
  maxSyncIntervalMs?: number;
}

/**
 * Synchronizer state.
 * Fix: Added 'starting' state for async initialization tracking.
 */
export type SynchronizerState = 'stopped' | 'starting' | 'running' | 'paused' | 'error';

/**
 * Metrics for synchronizer operations.
 * @extends BaseMetrics for consistency with other metrics interfaces
 */
export interface SynchronizerMetrics extends BaseMetrics {
  /** Total sync attempts */
  totalSyncs: number;
  /** Successful syncs */
  successfulSyncs: number;
  /** Failed syncs */
  failedSyncs: number;
  /** Current consecutive failures */
  consecutiveFailures: number;
  /** Last synced block number */
  lastSyncedBlock: number;
  /** Last sync timestamp */
  lastSyncTime: number;
  /** Average sync latency in ms */
  averageSyncLatencyMs: number;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_SYNC_INTERVAL_MS = 1000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
/** Fix 10.5: Adaptive sync interval constants */
const DEFAULT_MIN_SYNC_INTERVAL_MS = 200;
const DEFAULT_MAX_SYNC_INTERVAL_MS = 5000;
/** How many recent block times to consider for adaptive interval calculation */
const ADAPTIVE_WINDOW_SIZE = 10;

// =============================================================================
// HotForkSynchronizer Implementation
// =============================================================================

/**
 * Keeps the Anvil fork synchronized with the latest block.
 *
 * Usage:
 * ```typescript
 * const synchronizer = new HotForkSynchronizer({
 *   anvilManager: manager,
 *   sourceProvider: new ethers.JsonRpcProvider(rpcUrl),
 *   syncIntervalMs: 1000,
 * });
 *
 * await synchronizer.start();
 * // ... fork is now being kept up-to-date
 * await synchronizer.stop();
 * ```
 */
export class HotForkSynchronizer {
  private readonly anvilManager: AnvilForkManager;
  private readonly sourceProvider: ethers.JsonRpcProvider;
  private readonly baseSyncIntervalMs: number;
  private readonly maxConsecutiveFailures: number;
  /** Fix 6.2: Logger instance for proper structured logging (using shared Logger interface) */
  private readonly logger: Logger;
  /** Fix 10.5: Adaptive sync configuration */
  private readonly adaptiveSync: boolean;
  private readonly minSyncIntervalMs: number;
  private readonly maxSyncIntervalMs: number;

  private state: SynchronizerState = 'stopped';
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private syncTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastSyncedBlock: number = 0;
  private metrics: SynchronizerMetrics;
  private isSyncing: boolean = false;
  /**
   * Fix: Track async start operation for autoStart race condition prevention.
   * Consumers can await this promise to ensure the synchronizer is fully started.
   */
  private startPromise: Promise<void> | null = null;
  /**
   * Fix 10.5 + Fix 4.2: Track block timestamps for adaptive interval calculation.
   * Uses CircularBuffer for O(1) pushOverwrite instead of O(n) array.shift().
   */
  private readonly blockTimestamps: CircularBuffer<number>;
  private currentSyncIntervalMs: number;

  constructor(config: HotForkSynchronizerConfig) {
    this.anvilManager = config.anvilManager;
    this.sourceProvider = config.sourceProvider;
    this.baseSyncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.logger = config.logger ?? getDefaultLogger();
    this.metrics = this.createEmptyMetrics();

    // Fix 10.5: Initialize adaptive sync configuration
    this.adaptiveSync = config.adaptiveSync ?? false;
    this.minSyncIntervalMs = config.minSyncIntervalMs ?? DEFAULT_MIN_SYNC_INTERVAL_MS;
    this.maxSyncIntervalMs = config.maxSyncIntervalMs ?? DEFAULT_MAX_SYNC_INTERVAL_MS;
    this.currentSyncIntervalMs = this.baseSyncIntervalMs;

    // Fix 4.2: Initialize CircularBuffer for O(1) block timestamp tracking
    this.blockTimestamps = new CircularBuffer<number>(ADAPTIVE_WINDOW_SIZE);

    /**
     * Fix: autoStart race condition prevention.
     * - Set state to 'starting' immediately to indicate async initialization
     * - Track the start promise so consumers can await via waitForReady()
     * - On failure, set state to 'error' for visibility
     */
    if (config.autoStart) {
      this.state = 'starting';
      this.startPromise = this.start()
        .catch((err) => {
          this.logger.error('Auto-start failed', {
            error: err instanceof Error ? err.message : String(err),
          });
          this.state = 'error';
        })
        .finally(() => {
          // Clear the promise once resolved/rejected
          this.startPromise = null;
        });
    }
  }

  /**
   * Wait for the synchronizer to be ready (for autoStart consumers).
   *
   * Fix: Provides a way to await async initialization when autoStart is used.
   * Returns immediately if already started or not using autoStart.
   *
   * @throws Error if autoStart failed (state will be 'error')
   *
   * @example
   * const sync = new HotForkSynchronizer({ autoStart: true, ... });
   * await sync.waitForReady(); // Safe to use now
   */
  async waitForReady(): Promise<void> {
    // If there's an active start promise, wait for it
    if (this.startPromise) {
      await this.startPromise;
    }

    // Check if autoStart failed
    if (this.state === 'error') {
      throw new Error('HotForkSynchronizer failed to start - check logs for details');
    }
  }

  // ===========================================================================
  // Public Methods - Lifecycle
  // ===========================================================================

  /**
   * Start the synchronization process.
   *
   * @throws Error if Anvil fork is not running
   */
  async start(): Promise<void> {
    // Already running - no-op
    if (this.state === 'running') {
      return;
    }

    // Fix: Allow start() to proceed when in 'starting' state (from autoStart)
    // This handles the case where start() is called explicitly while autoStart is pending

    // Verify Anvil is running
    if (this.anvilManager.getState() !== 'running') {
      throw new Error('Cannot start synchronizer: Anvil fork is not running');
    }

    // Get initial block number
    this.lastSyncedBlock = await this.sourceProvider.getBlockNumber();

    // Fix 10.5: Use adaptive scheduling if enabled, otherwise use fixed interval
    if (this.adaptiveSync) {
      this.scheduleNextSync();
    } else {
      // Start sync interval (non-adaptive mode)
      this.syncInterval = setInterval(() => {
        this.syncToLatestBlock().catch((err) => {
          // Fix 3.2: Use logger instead of console.error
          this.logger.error('Sync error', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, this.baseSyncIntervalMs);
    }

    this.state = 'running';
  }

  /**
   * Stop the synchronization process.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped') {
      return;
    }

    this.syncInterval = clearIntervalSafe(this.syncInterval);

    // Fix 10.5: Clear adaptive sync timeout
    this.syncTimeout = clearTimeoutSafe(this.syncTimeout);

    this.state = 'stopped';
  }

  /**
   * Pause synchronization temporarily.
   *
   * Use this when performing batch simulations to avoid
   * interference from sync operations.
   */
  pause(): void {
    if (this.state === 'running') {
      this.state = 'paused';
    }
  }

  /**
   * Resume synchronization after pause.
   */
  resume(): void {
    if (this.state === 'paused') {
      this.state = 'running';
      // Trigger immediate sync on resume
      this.syncToLatestBlock().catch((err) => {
        // Fix 3.2: Use logger instead of console.error
        this.logger.error('Resume sync error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // ===========================================================================
  // Public Methods - Status & Metrics
  // ===========================================================================

  /**
   * Get the current state of the synchronizer.
   */
  getState(): SynchronizerState {
    return this.state;
  }

  /**
   * Get the last synced block number.
   */
  getLastSyncedBlock(): number {
    return this.lastSyncedBlock;
  }

  /**
   * Get synchronizer metrics.
   */
  getMetrics(): SynchronizerMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics.
   */
  resetMetrics(): void {
    this.metrics = this.createEmptyMetrics();
  }

  /**
   * Force an immediate sync to the latest block.
   *
   * @returns The new block number after sync
   */
  async forceSync(): Promise<number> {
    await this.syncToLatestBlock();
    return this.lastSyncedBlock;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Sync the fork to the latest block.
   *
   * Fix 5.1: Added check for 'stopped' state to prevent race condition
   * where stop() is called during an in-flight sync operation.
   */
  private async syncToLatestBlock(): Promise<void> {
    // Fix 5.1: Skip if stopped, paused, or already syncing
    if (this.state === 'stopped' || this.state === 'paused' || this.isSyncing) {
      return;
    }

    // Skip if Anvil is not running
    if (this.anvilManager.getState() !== 'running') {
      return;
    }

    this.isSyncing = true;
    const startTime = Date.now();
    this.metrics.totalSyncs++;

    try {
      const currentBlock = await this.sourceProvider.getBlockNumber();

      // Fix 5.1: Re-check state after async operation to handle stop() during sync.
      // Use isStopped() helper to avoid TypeScript type narrowing issues.
      if (this.isStopped()) {
        return;
      }

      // Only reset if there's a new block
      if (currentBlock > this.lastSyncedBlock) {
        await this.anvilManager.resetToBlock(currentBlock);

        // Fix 5.1: Re-check state after reset operation
        if (this.isStopped()) {
          return;
        }

        this.lastSyncedBlock = currentBlock;

        // Fix 10.5: Track block timestamp for adaptive interval calculation
        if (this.adaptiveSync) {
          this.recordBlockTimestamp(Date.now());
        }
      }

      // Update metrics on success (only if still running)
      if (!this.isStopped()) {
        this.metrics.successfulSyncs++;
        this.metrics.consecutiveFailures = 0;
        this.metrics.lastSyncedBlock = this.lastSyncedBlock;
        this.metrics.lastSyncTime = Date.now();
        this.updateAverageLatency(Date.now() - startTime);
      }
    } catch (error) {
      this.metrics.failedSyncs++;
      this.metrics.consecutiveFailures++;

      // Pause if too many consecutive failures
      if (this.metrics.consecutiveFailures >= this.maxConsecutiveFailures) {
        // Fix 3.2: Use logger instead of console.error
        this.logger.error('Pausing after consecutive failures', {
          consecutiveFailures: this.metrics.consecutiveFailures,
          maxConsecutiveFailures: this.maxConsecutiveFailures,
          error: error instanceof Error ? error.message : String(error),
        });
        this.state = 'paused';
      }
    } finally {
      this.isSyncing = false;
    }
  }

  // ===========================================================================
  // Private Methods - Adaptive Sync (Fix 10.5)
  // ===========================================================================

  /**
   * Fix 10.5: Schedule the next sync with adaptive interval.
   * Uses dynamic interval based on recent block production rate.
   */
  private scheduleNextSync(): void {
    // Don't schedule if stopped
    if (this.state === 'stopped') {
      return;
    }

    this.syncTimeout = setTimeout(async () => {
      try {
        await this.syncToLatestBlock();
      } catch (err) {
        this.logger.error('Adaptive sync error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Calculate and apply new interval
      this.currentSyncIntervalMs = this.calculateOptimalInterval();

      // Schedule next sync if still running
      if (this.state === 'running') {
        this.scheduleNextSync();
      }
    }, this.currentSyncIntervalMs);
  }

  /**
   * Fix 10.5 + Fix 4.2: Record a block timestamp for interval calculation.
   * Uses O(1) pushOverwrite instead of O(n) array.shift().
   */
  private recordBlockTimestamp(timestamp: number): void {
    this.blockTimestamps.pushOverwrite(timestamp);
  }

  /**
   * Fix 10.5 + Fix 4.2: Calculate optimal sync interval based on block production rate.
   *
   * Analysis Note (Finding 10.5): Adaptive sync interval is ALREADY implemented.
   * This method dynamically adjusts sync frequency based on block production rate,
   * using CircularBuffer for O(1) timestamp tracking instead of array.shift().
   *
   * Algorithm:
   * - If blocks are coming quickly, decrease interval (sync more often)
   * - If blocks are coming slowly, increase interval (reduce polling)
   * - Apply exponential backoff on consecutive failures
   *
   * @returns Optimal sync interval in milliseconds
   */
  private calculateOptimalInterval(): number {
    // Apply backoff on consecutive failures
    if (this.metrics.consecutiveFailures > 0) {
      const backoffFactor = Math.min(
        Math.pow(2, this.metrics.consecutiveFailures),
        10 // Cap at 10x
      );
      return Math.min(
        this.baseSyncIntervalMs * backoffFactor,
        this.maxSyncIntervalMs
      );
    }

    // If not enough data, use base interval
    if (this.blockTimestamps.length < 2) {
      return this.baseSyncIntervalMs;
    }

    // Fix 4.2: Calculate average block time using forEach() for zero allocation.
    // Iterates in insertion order (oldest to newest) without creating an intermediate array.
    let totalInterval = 0;
    let prevTimestamp = -1;
    let pairCount = 0;
    this.blockTimestamps.forEach((ts) => {
      if (prevTimestamp >= 0) {
        totalInterval += ts - prevTimestamp;
        pairCount++;
      }
      prevTimestamp = ts;
    });
    const avgBlockTime = totalInterval / pairCount;

    // Target sync interval should be slightly less than avg block time
    // to catch new blocks quickly, but not waste resources polling too fast
    const targetInterval = avgBlockTime * 0.8;

    // Clamp to configured bounds
    return Math.max(
      this.minSyncIntervalMs,
      Math.min(targetInterval, this.maxSyncIntervalMs)
    );
  }

  /**
   * Fix 5.1: Helper to check if state is stopped or errored.
   * Using a method defeats TypeScript type narrowing, allowing re-checks
   * after async operations where state may have changed.
   */
  private isStopped(): boolean {
    return this.state === 'stopped' || this.state === 'error';
  }

  /**
   * Update rolling average latency.
   * Fix 6.3: Also updates lastUpdated timestamp.
   */
  private updateAverageLatency(latencyMs: number): void {
    const total = this.metrics.successfulSyncs;
    if (total === 1) {
      this.metrics.averageSyncLatencyMs = latencyMs;
    } else {
      this.metrics.averageSyncLatencyMs =
        (this.metrics.averageSyncLatencyMs * (total - 1) + latencyMs) / total;
    }
    // Fix 6.3: Update timestamp for consistency with other metrics
    this.metrics.lastUpdated = Date.now();
  }

  /**
   * Create empty metrics object.
   * Fix 6.3: Added lastUpdated field.
   */
  private createEmptyMetrics(): SynchronizerMetrics {
    return {
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      consecutiveFailures: 0,
      lastSyncedBlock: 0,
      lastSyncTime: 0,
      averageSyncLatencyMs: 0,
      lastUpdated: Date.now(),
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a HotForkSynchronizer instance.
 */
export function createHotForkSynchronizer(
  config: HotForkSynchronizerConfig
): HotForkSynchronizer {
  return new HotForkSynchronizer(config);
}
