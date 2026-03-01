/**
 * Stream Consumer
 *
 * Reusable consumer for Redis Streams with consumer groups.
 * Encapsulates the common pattern of read → process → acknowledge.
 *
 * Extracted from redis/streams.ts (cold-path code) to reduce file size
 * and improve modularity.
 *
 * @module redis/stream-consumer
 * @see ADR-002: Redis Streams over Pub/Sub
 */

import { clearTimeoutSafe } from '../async/lifecycle-utils';
import type { RedisStreamsClient, StreamMessage, ConsumerGroupConfig } from './streams';
import { RedisStreams } from '@arbitrage/types';

// =============================================================================
// Types
// =============================================================================

/**
 * FIX 6.1: Minimal logger interface for StreamConsumer.
 * Compatible with Pino and test mock loggers.
 * Uses Record<string, unknown> for type safety and consistency with ILogger.
 *
 * Fix 6.2: This interface only requires `error()` to support minimal error-only loggers.
 * For full logging capabilities, use `ILogger` from '@arbitrage/core'.
 *
 * @see shared/core/src/logging/types.ts - Canonical ILogger interface
 */
export interface StreamConsumerLogger {
  error: (msg: string, ctx?: Record<string, unknown>) => void;
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
  info?: (msg: string, ctx?: Record<string, unknown>) => void;
  debug?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface StreamConsumerConfig {
  /** Consumer group configuration */
  config: ConsumerGroupConfig;
  /** Handler function for each message */
  handler: (message: StreamMessage) => Promise<void>;
  /** Number of messages to fetch per read (default: 10) */
  batchSize?: number;
  /** Block time in ms (default: 1000, 0 = non-blocking) */
  blockMs?: number;
  /** Whether to auto-acknowledge after handler completes (default: true) */
  autoAck?: boolean;
  /** FIX 6.1: Logger instance using standardized interface */
  logger?: StreamConsumerLogger;
  /** Callback when pause state changes (for backpressure monitoring) */
  onPauseStateChange?: (isPaused: boolean) => void;
  /** OP-27 FIX: Inter-poll delay in ms between batch reads (default: 10, 0 = no delay) */
  interPollDelayMs?: number;
  /**
   * P0 Fix ES-003: Maximum delivery attempts before routing message to DLQ.
   * When set, periodically checks pending messages via XPENDING RANGE.
   * Messages exceeding this count are XACKed and routed to the dead-letter queue.
   * Default: undefined (no limit — existing behavior).
   */
  maxDeliveryCount?: number;
  /**
   * P0 Fix ES-003: How often (in poll cycles) to check for stuck pending messages.
   * Only used when maxDeliveryCount is set. Default: 10 (every 10th poll).
   */
  pendingCheckInterval?: number;
}

export interface StreamConsumerStats {
  messagesProcessed: number;
  messagesFailed: number;
  lastProcessedAt: number | null;
  isRunning: boolean;
  /** Whether consumption is paused due to backpressure */
  isPaused: boolean;
}

// =============================================================================
// StreamConsumer Class
// =============================================================================

/**
 * P2-1 FIX: Reusable stream consumer that encapsulates the common pattern of:
 * 1. Reading from consumer group
 * 2. Processing each message with a handler
 * 3. Acknowledging processed messages
 * 4. Handling errors gracefully
 *
 * Usage:
 * ```ts
 * const consumer = new StreamConsumer(streamsClient, {
 *   config: { streamName: RedisStreams.OPPORTUNITIES, groupName: 'coordinator', consumerName: 'worker-1' },
 *   handler: async (msg) => { console.log(msg.data); },
 *   batchSize: 10,
 *   blockMs: 1000
 * });
 * consumer.start();
 * // ... later
 * await consumer.stop();
 * ```
 */
export class StreamConsumer {
  private client: RedisStreamsClient;
  private config: StreamConsumerConfig;
  private running = false;
  private paused = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollPromise: Promise<void> | null = null;
  /** Consecutive poll errors for exponential backoff */
  private consecutiveErrors = 0;
  private static readonly MAX_ERROR_BACKOFF_MS = 30_000;
  private static readonly BASE_ERROR_DELAY_MS = 100;
  // P3 Fix DI-7: Track warned schema versions to avoid log spam (once per unknown version)
  private static readonly warnedSchemaVersions = new Set<string>();
  private static readonly KNOWN_SCHEMA_VERSION = '1';
  /** P0 Fix ES-003: Counter for periodic pending message cleanup */
  private pollCycleCount = 0;
  private stats: StreamConsumerStats = {
    messagesProcessed: 0,
    messagesFailed: 0,
    lastProcessedAt: null,
    isRunning: false,
    isPaused: false
  };

  constructor(client: RedisStreamsClient, config: StreamConsumerConfig) {
    this.client = client;
    this.config = {
      batchSize: 10,
      blockMs: 1000,
      autoAck: true,
      ...config
    };
  }

  /**
   * Start consuming messages from the stream.
   * Runs in a polling loop until stop() is called.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stats.isRunning = true;
    this.schedulePoll();
  }

  /**
   * Stop consuming messages.
   * Waits for any in-flight processing to complete.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.stats.isRunning = false;

    this.pollTimer = clearTimeoutSafe(this.pollTimer);

    // Await any in-flight poll to ensure clean shutdown
    if (this.pollPromise) {
      await this.pollPromise;
      this.pollPromise = null;
    }
  }

  /**
   * Get consumer statistics.
   */
  getStats(): StreamConsumerStats {
    return { ...this.stats };
  }

  /**
   * Pause consumption (for backpressure).
   * Consumer will stop reading new messages until resume() is called.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.stats.isPaused = true;
    this.config.logger?.debug?.('Stream consumer paused', {
      stream: this.config.config.streamName
    });
    this.config.onPauseStateChange?.(true);
  }

  /**
   * Resume consumption after pause.
   * Restarts the polling loop if consumer is still running.
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.stats.isPaused = false;
    this.config.logger?.debug?.('Stream consumer resumed', {
      stream: this.config.config.streamName
    });
    this.config.onPauseStateChange?.(false);
    // Restart polling if we were running
    if (this.running && !this.pollTimer) {
      this.schedulePoll();
    }
  }

  /**
   * Check if consumer is currently paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Schedule a poll() invocation, tracking its promise for clean shutdown.
   */
  private schedulePoll(): void {
    this.pollPromise = this.poll();
  }

  /**
   * P0 Fix ES-003: Check pending messages for excessive delivery attempts.
   * Messages exceeding maxDeliveryCount are ACKed and routed to the DLQ
   * to prevent infinite retry loops and unbounded PEL growth.
   */
  private async cleanupStuckPendingMessages(): Promise<void> {
    const maxDelivery = this.config.maxDeliveryCount;
    if (!maxDelivery) return;

    try {
      const pending = await this.client.xpendingRange(
        this.config.config.streamName,
        this.config.config.groupName,
        '-', '+', 50 // Check up to 50 pending messages at a time
      );

      const stuckMessages = pending.filter(entry => entry.deliveryCount > maxDelivery);
      if (stuckMessages.length === 0) return;

      const dlqStream = RedisStreams.DEAD_LETTER_QUEUE;

      for (const entry of stuckMessages) {
        try {
          // Route to DLQ with metadata about why the message was moved
          await this.client.xaddWithLimit(dlqStream, {
            originalStream: this.config.config.streamName,
            originalId: entry.id,
            consumerGroup: this.config.config.groupName,
            consumer: entry.consumer,
            reason: 'max_delivery_exceeded',
            deliveryCount: entry.deliveryCount,
            idleMs: entry.idleMs,
            timestamp: Date.now(),
          });

          // ACK the original message to remove from PEL
          await this.client.xack(
            this.config.config.streamName,
            this.config.config.groupName,
            entry.id
          );
        } catch (dlqError) {
          this.config.logger?.error('Failed to move stuck message to DLQ', {
            error: dlqError,
            messageId: entry.id,
            deliveryCount: entry.deliveryCount,
            stream: this.config.config.streamName,
          });
        }
      }

      this.config.logger?.warn?.('Moved stuck messages to DLQ', {
        stream: this.config.config.streamName,
        group: this.config.config.groupName,
        count: stuckMessages.length,
        maxDeliveryCount: maxDelivery,
        messageIds: stuckMessages.map(m => m.id),
      });
    } catch (error) {
      // Non-fatal: pending check failure should not block normal consumption
      this.config.logger?.error('Failed to check pending messages for cleanup', {
        error,
        stream: this.config.config.streamName,
      });
    }
  }

  private async poll(): Promise<void> {
    if (!this.running || this.paused) return;

    // P0 Fix ES-003: Periodically check for stuck pending messages
    if (this.config.maxDeliveryCount) {
      this.pollCycleCount++;
      const checkInterval = this.config.pendingCheckInterval ?? 10;
      if (this.pollCycleCount % checkInterval === 0) {
        await this.cleanupStuckPendingMessages();
      }
    }

    let pollSucceeded = false;

    try {
      const messages = await this.client.xreadgroup(this.config.config, {
        count: this.config.batchSize,
        block: this.config.blockMs,
        startId: '>'
      });

      // Successful read — reset backoff
      pollSucceeded = true;
      this.consecutiveErrors = 0;

      for (const message of messages) {
        if (!this.running) break;

        // P3 Fix DI-7: Warn once per unrecognized schema version
        const sv = (message.data as Record<string, unknown>)?.schemaVersion;
        if (typeof sv === 'string' && sv !== StreamConsumer.KNOWN_SCHEMA_VERSION
            && !StreamConsumer.warnedSchemaVersions.has(sv)) {
          StreamConsumer.warnedSchemaVersions.add(sv);
          this.config.logger?.warn?.('Unrecognized message schema version — processing anyway', {
            schemaVersion: sv,
            knownVersion: StreamConsumer.KNOWN_SCHEMA_VERSION,
            stream: this.config.config.streamName,
          });
        }

        try {
          await this.config.handler(message);
          this.stats.messagesProcessed++;
          this.stats.lastProcessedAt = Date.now();

          // Auto-acknowledge if enabled
          if (this.config.autoAck) {
            await this.client.xack(
              this.config.config.streamName,
              this.config.config.groupName,
              message.id
            );
          }
        } catch (handlerError) {
          this.stats.messagesFailed++;
          this.config.logger?.error('Stream message handler failed', {
            error: handlerError,
            stream: this.config.config.streamName,
            messageId: message.id
          });
          // Don't ack failed messages - they'll be retried
        }
      }
    } catch (error) {
      // Ignore timeout errors from blocking read (these are normal)
      const errorMessage = (error as Error).message || '';
      if (errorMessage.includes('timeout')) {
        pollSucceeded = true; // Timeout is not an error — reset backoff
        this.consecutiveErrors = 0;
      } else {
        this.consecutiveErrors++;
        this.config.logger?.error('Error consuming stream', {
          error,
          stream: this.config.config.streamName,
          consecutiveErrors: this.consecutiveErrors,
        });
      }
    }

    // Schedule next poll if still running and not paused
    if (this.running && !this.paused) {
      let delay: number;
      if (!pollSucceeded && this.consecutiveErrors > 0) {
        // Exponential backoff on consecutive errors to prevent tight error loop.
        // Without this, Redis failure causes ~100 error/sec log spam.
        delay = Math.min(
          StreamConsumer.BASE_ERROR_DELAY_MS * Math.pow(2, this.consecutiveErrors - 1),
          StreamConsumer.MAX_ERROR_BACKOFF_MS
        );
      } else {
        // OP-27 FIX: Configurable inter-poll delay (previously hardcoded 10ms)
        delay = this.config.blockMs === 0 ? 0 : (this.config.interPollDelayMs ?? 10);
      }
      this.pollTimer = setTimeout(() => this.schedulePoll(), delay);
    }
  }
}
