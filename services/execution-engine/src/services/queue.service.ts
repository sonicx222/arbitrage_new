/**
 * Queue Service
 *
 * Manages the execution queue with backpressure control.
 * Implements water mark-based pausing/resuming to prevent memory exhaustion.
 *
 * Key features:
 * - Configurable queue size limits
 * - Hysteresis-based backpressure (high/low water marks)
 * - Pause state change notifications for stream consumer coupling
 *
 * @see engine.ts (parent service)
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { Logger, QueueConfig, QueueService } from '../types';
import { DEFAULT_QUEUE_CONFIG } from '../types';

export interface QueueServiceConfig {
  logger: Logger;
  queueConfig?: Partial<QueueConfig>;
}

export class QueueServiceImpl implements QueueService {
  private readonly logger: Logger;
  private readonly config: QueueConfig;

  private queue: ArbitrageOpportunity[] = [];
  private paused = false;
  private pauseCallback: ((isPaused: boolean) => void) | null = null;

  constructor(config: QueueServiceConfig) {
    this.logger = config.logger;
    this.config = {
      maxSize: config.queueConfig?.maxSize ?? DEFAULT_QUEUE_CONFIG.maxSize,
      highWaterMark: config.queueConfig?.highWaterMark ?? DEFAULT_QUEUE_CONFIG.highWaterMark,
      lowWaterMark: config.queueConfig?.lowWaterMark ?? DEFAULT_QUEUE_CONFIG.lowWaterMark
    };
  }

  /**
   * Add opportunity to queue if possible.
   * Returns false if queue is at capacity or paused.
   */
  enqueue(opportunity: ArbitrageOpportunity): boolean {
    if (!this.canEnqueue()) {
      return false;
    }

    this.queue.push(opportunity);
    this.updateBackpressure();
    return true;
  }

  /**
   * Get next opportunity from queue.
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

  // Manual pause state for standby mode (ADR-007)
  private manuallyPaused = false;

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
    this.queue = [];
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
   * Update backpressure state based on queue size.
   * Uses hysteresis to prevent thrashing:
   * - Pause at high water mark
   * - Resume at low water mark (not immediately when below high)
   */
  private updateBackpressure(): void {
    const queueSize = this.queue.length;
    const prevPaused = this.paused;

    // Update backpressure state atomically
    if (this.paused) {
      // If paused, only release when below low water mark (hysteresis)
      if (queueSize <= this.config.lowWaterMark) {
        this.paused = false;
      }
    } else {
      // If not paused, engage at high water mark
      if (queueSize >= this.config.highWaterMark) {
        this.paused = true;
      }
    }

    // Notify on state change
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

      // Notify callback (for stream consumer coupling)
      if (this.pauseCallback) {
        this.pauseCallback(this.paused);
      }
    }
  }

  /**
   * Get queue configuration (for monitoring).
   */
  getConfig(): Readonly<QueueConfig> {
    return this.config;
  }
}
