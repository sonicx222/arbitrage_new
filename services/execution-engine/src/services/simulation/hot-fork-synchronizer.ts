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
import type { AnvilForkManager } from './anvil-manager';

// =============================================================================
// Types
// =============================================================================

/**
 * Minimal logger interface for HotForkSynchronizer.
 * Fix 3.2: Added to replace console.error with proper logging.
 */
export interface SynchronizerLogger {
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  info: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Default console-based logger for backward compatibility.
 * Fix 3.2: Used when no logger is provided in config.
 */
const defaultLogger: SynchronizerLogger = {
  error: (message: string, meta?: object) => console.error(`[HotForkSynchronizer] ${message}`, meta ?? ''),
  warn: (message: string, meta?: object) => console.warn(`[HotForkSynchronizer] ${message}`, meta ?? ''),
  info: (message: string, meta?: object) => console.info(`[HotForkSynchronizer] ${message}`, meta ?? ''),
  debug: (message: string, meta?: object) => console.debug(`[HotForkSynchronizer] ${message}`, meta ?? ''),
};

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
  /** Logger instance for structured logging (default: console-based) - Fix 3.2 */
  logger?: SynchronizerLogger;
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
 */
export type SynchronizerState = 'stopped' | 'running' | 'paused' | 'error';

/**
 * Metrics for synchronizer operations.
 */
export interface SynchronizerMetrics {
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
  /** Fix 3.2: Logger instance for proper structured logging */
  private readonly logger: SynchronizerLogger;
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
  /** Fix 10.5: Track block timestamps for adaptive interval calculation */
  private blockTimestamps: number[] = [];
  private currentSyncIntervalMs: number;

  constructor(config: HotForkSynchronizerConfig) {
    this.anvilManager = config.anvilManager;
    this.sourceProvider = config.sourceProvider;
    this.baseSyncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.maxConsecutiveFailures = config.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
    this.logger = config.logger ?? defaultLogger;
    this.metrics = this.createEmptyMetrics();

    // Fix 10.5: Initialize adaptive sync configuration
    this.adaptiveSync = config.adaptiveSync ?? false;
    this.minSyncIntervalMs = config.minSyncIntervalMs ?? DEFAULT_MIN_SYNC_INTERVAL_MS;
    this.maxSyncIntervalMs = config.maxSyncIntervalMs ?? DEFAULT_MAX_SYNC_INTERVAL_MS;
    this.currentSyncIntervalMs = this.baseSyncIntervalMs;

    if (config.autoStart) {
      this.start().catch((err) => {
        // Fix 3.2: Use logger instead of console.error
        this.logger.error('Auto-start failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.state = 'error';
      });
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
    if (this.state === 'running') {
      return;
    }

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

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    // Fix 10.5: Clear adaptive sync timeout
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }

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
   */
  private async syncToLatestBlock(): Promise<void> {
    // Skip if paused or already syncing
    if (this.state === 'paused' || this.isSyncing) {
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

      // Only reset if there's a new block
      if (currentBlock > this.lastSyncedBlock) {
        await this.anvilManager.resetToBlock(currentBlock);
        this.lastSyncedBlock = currentBlock;

        // Fix 10.5: Track block timestamp for adaptive interval calculation
        if (this.adaptiveSync) {
          this.recordBlockTimestamp(Date.now());
        }
      }

      // Update metrics on success
      this.metrics.successfulSyncs++;
      this.metrics.consecutiveFailures = 0;
      this.metrics.lastSyncedBlock = this.lastSyncedBlock;
      this.metrics.lastSyncTime = Date.now();
      this.updateAverageLatency(Date.now() - startTime);
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
   * Fix 10.5: Record a block timestamp for interval calculation.
   */
  private recordBlockTimestamp(timestamp: number): void {
    this.blockTimestamps.push(timestamp);
    // Keep only recent timestamps within the window
    if (this.blockTimestamps.length > ADAPTIVE_WINDOW_SIZE) {
      this.blockTimestamps.shift();
    }
  }

  /**
   * Fix 10.5: Calculate optimal sync interval based on block production rate.
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

    // Calculate average block time from recent timestamps
    const intervals: number[] = [];
    for (let i = 1; i < this.blockTimestamps.length; i++) {
      intervals.push(this.blockTimestamps[i] - this.blockTimestamps[i - 1]);
    }

    const avgBlockTime = intervals.reduce((a, b) => a + b, 0) / intervals.length;

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
   * Update rolling average latency.
   */
  private updateAverageLatency(latencyMs: number): void {
    const total = this.metrics.successfulSyncs;
    if (total === 1) {
      this.metrics.averageSyncLatencyMs = latencyMs;
    } else {
      this.metrics.averageSyncLatencyMs =
        (this.metrics.averageSyncLatencyMs * (total - 1) + latencyMs) / total;
    }
  }

  /**
   * Create empty metrics object.
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
