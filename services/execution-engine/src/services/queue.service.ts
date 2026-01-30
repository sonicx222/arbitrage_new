/**
 * Queue Service
 *
 * Manages the execution queue with backpressure control.
 * Implements water mark-based pausing/resuming to prevent memory exhaustion.
 *
 * Key features:
 * - O(1) enqueue/dequeue using CircularBuffer from @arbitrage/core
 * - Configurable queue size limits
 * - Hysteresis-based backpressure (high/low water marks)
 * - Pause state change notifications for stream consumer coupling
 * - Event signaling for efficient processing (avoids polling)
 *
 * @see engine.ts (parent service)
 * @see @arbitrage/core CircularBuffer for O(1) FIFO implementation
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import { CircularBuffer } from '@arbitrage/core';
import type { Logger, QueueConfig, QueueService } from '../types';
import { DEFAULT_QUEUE_CONFIG } from '../types';

/**
 * Configuration for QueueServiceImpl
 */
export interface QueueServiceConfig {
  logger: Logger;
  queueConfig?: Partial<QueueConfig>;
}

/**
 * Queue service implementation using CircularBuffer from @arbitrage/core.
 *
 * @see CircularBuffer for O(1) FIFO operations
 */
export class QueueServiceImpl implements QueueService {
  private readonly logger: Logger;
  private readonly config: QueueConfig;

  // O(1) circular buffer instead of O(n) array.shift()
  private queue: CircularBuffer<ArbitrageOpportunity>;
  private paused = false;
  private pauseCallback: ((isPaused: boolean) => void) | null = null;

  // Event signaling for efficient processing (replaces polling)
  private itemAvailableCallback: (() => void) | null = null;

  // Manual pause state for standby mode (ADR-007)
  private manuallyPaused = false;

  constructor(config: QueueServiceConfig) {
    this.logger = config.logger;
    this.config = {
      maxSize: config.queueConfig?.maxSize ?? DEFAULT_QUEUE_CONFIG.maxSize,
      highWaterMark: config.queueConfig?.highWaterMark ?? DEFAULT_QUEUE_CONFIG.highWaterMark,
      lowWaterMark: config.queueConfig?.lowWaterMark ?? DEFAULT_QUEUE_CONFIG.lowWaterMark
    };

    // Initialize circular buffer with max capacity
    this.queue = new CircularBuffer<ArbitrageOpportunity>(this.config.maxSize);
  }

  /**
   * Add opportunity to queue if possible.
   * Returns false if queue is at capacity or paused.
   * Signals item availability for event-driven processing.
   */
  enqueue(opportunity: ArbitrageOpportunity): boolean {
    if (!this.canEnqueue()) {
      return false;
    }

    const added = this.queue.push(opportunity);
    if (added) {
      this.updateBackpressure();
      // Signal that an item is available for processing
      this.signalItemAvailable();
    }
    return added;
  }

  /**
   * Get next opportunity from queue. O(1) operation.
   */
  dequeue(): ArbitrageOpportunity | undefined {
    const item = this.queue.shift();
    if (item) {
      this.updateBackpressure();
    }
    return item;
  }

  /**
   * Check if queue can accept more items.
   * Respects both backpressure pause and manual pause (standby mode).
   */
  canEnqueue(): boolean {
    return !this.paused && !this.manuallyPaused && this.queue.length < this.config.maxSize;
  }

  /**
   * Get current queue size.
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is paused due to backpressure or manual pause.
   */
  isPaused(): boolean {
    return this.paused || this.manuallyPaused;
  }

  /**
   * Manually pause the queue (for standby mode).
   * Unlike backpressure pause, this doesn't auto-release.
   */
  pause(): void {
    if (!this.manuallyPaused) {
      this.manuallyPaused = true;
      this.logger.info('Queue manually paused (standby mode)');
      if (this.pauseCallback) {
        this.pauseCallback(true);
      }
    }
  }

  /**
   * Resume a manually paused queue (for standby activation).
   * Backpressure still applies after resuming.
   */
  resume(): void {
    if (this.manuallyPaused) {
      this.manuallyPaused = false;
      this.logger.info('Queue manually resumed (activated)');
      // Only notify resume if not also backpressure-paused
      if (this.pauseCallback && !this.paused) {
        this.pauseCallback(false);
      }
      // Signal if items are waiting to be processed
      if (this.queue.length > 0) {
        this.signalItemAvailable();
      }
    }
  }

  /**
   * Check if queue is manually paused (standby mode).
   */
  isManuallyPaused(): boolean {
    return this.manuallyPaused;
  }

  /**
   * Clear the queue.
   */
  clear(): void {
    this.queue.clear();
    this.paused = false;
    this.manuallyPaused = false;
  }

  /**
   * Set pause state change callback.
   * Used to couple backpressure to stream consumer.
   */
  onPauseStateChange(callback: (isPaused: boolean) => void): void {
    this.pauseCallback = callback;
  }

  /**
   * Set callback for when an item becomes available.
   * Enables event-driven processing instead of polling.
   * @param callback Function to call when item is available
   */
  onItemAvailable(callback: () => void): void {
    this.itemAvailableCallback = callback;
  }

  /**
   * Signal that an item is available for processing.
   *
   * Hot-path optimization: Direct synchronous call instead of setImmediate.
   * The engine's processQueueItems() already has re-entrancy protection via
   * isProcessingQueue flag, so we don't need the async delay.
   *
   * This saves ~1-4ms latency per item in competitive arbitrage scenarios.
   *
   * Fix 10.1: Added try-catch to prevent callback exceptions from:
   * 1. Crashing the enqueue operation
   * 2. Leaving the queue in an inconsistent state (item added but signal failed)
   *
   * Thread Safety Note (Fix 5.2):
   * =============================
   * The callback (typically engine's processQueueItems) MUST remain synchronous
   * until it sets its re-entrancy guard flag. If the callback has an await point
   * before setting its guard, concurrent signals could cause multiple processing
   * runs. The current engine implementation is safe because:
   * 1. processQueueItems() sets isProcessingQueue=true synchronously at entry
   * 2. No await point exists before the guard check
   * 3. All subsequent async operations happen AFTER the guard is set
   */
  private signalItemAvailable(): void {
    if (this.itemAvailableCallback && !this.isPaused()) {
      try {
        // Direct call - callback is expected to have re-entrancy protection
        this.itemAvailableCallback();
      } catch (error) {
        // Fix 10.1: Log but don't throw - item is already in queue
        this.logger.error('itemAvailableCallback threw an exception', {
          error: error instanceof Error ? error.message : String(error),
          queueSize: this.queue.length,
        });
      }
    }
  }

  /**
   * Update backpressure state based on queue size.
   * Uses hysteresis to prevent thrashing:
   * - Pause when queue size >= highWaterMark (at or above)
   * - Resume when queue size <= lowWaterMark (at or below)
   *
   * Fix 6.3: Clarified comments to match code behavior (>= and <= thresholds).
   */
  private updateBackpressure(): void {
    const queueSize = this.queue.length;
    const prevPaused = this.paused;
    const prevEffectivePause = prevPaused || this.manuallyPaused;

    // Update backpressure state atomically
    if (this.paused) {
      // If paused, only release when at or below low water mark (hysteresis)
      if (queueSize <= this.config.lowWaterMark) {
        this.paused = false;
      }
    } else {
      // If not paused, engage at or above high water mark
      if (queueSize >= this.config.highWaterMark) {
        this.paused = true;
      }
    }

    // Log backpressure state changes
    if (prevPaused !== this.paused) {
      if (this.paused) {
        this.logger.warn('Queue backpressure engaged', {
          queueSize,
          highWaterMark: this.config.highWaterMark
        });
      } else {
        this.logger.info('Queue backpressure released', {
          queueSize,
          lowWaterMark: this.config.lowWaterMark
        });
      }
    }

    // Notify callback on EFFECTIVE pause state change (backpressure OR manual)
    // This ensures stream consumer only resumes when BOTH are false
    const currentEffectivePause = this.paused || this.manuallyPaused;
    if (prevEffectivePause !== currentEffectivePause && this.pauseCallback) {
      this.pauseCallback(currentEffectivePause);
    }
  }

  /**
   * Get queue configuration (for monitoring).
   */
  getConfig(): Readonly<QueueConfig> {
    return this.config;
  }
}
