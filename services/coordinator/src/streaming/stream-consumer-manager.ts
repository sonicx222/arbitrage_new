/**
 * Stream Consumer Manager
 *
 * Manages Redis stream consumers with:
 * - Rate limiting (prevents DoS via message flooding)
 * - Deferred ACK with DLQ support (prevents message loss)
 * - Error tracking with alerting (monitors consumer health)
 *
 * @see R2 - Coordinator Subsystems extraction
 * @see ADR-002 - Redis Streams over Pub/Sub
 */

import fsPromises from 'fs/promises';
import path from 'path';
import { StreamRateLimiter, RateLimiterConfig } from './rate-limiter';
import { RedisStreams } from '@arbitrage/types';

/**
 * Minimal logger interface for dependency injection
 */
export interface StreamManagerLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Stream message structure
 */
export interface StreamMessage {
  id: string;
  data: Record<string, unknown>;
}

/**
 * Consumer group configuration
 */
export interface ConsumerGroupConfig {
  streamName: string;
  groupName: string;
  consumerName: string;
  startId?: string;
}

/**
 * Redis streams client interface (subset needed by manager)
 */
export interface StreamsClient {
  xack(streamName: string, groupName: string, messageId: string): Promise<number>;
  xadd(streamName: string, data: Record<string, unknown>): Promise<string>;
  xpending(streamName: string, groupName: string): Promise<{
    total: number;
    smallestId?: string;
    largestId?: string;
    consumers: Array<{ name: string; pending: number }>;
  } | null>;
  /** OP-1 FIX: Claim orphaned pending messages from stale consumers */
  xclaim(
    streamName: string,
    groupName: string,
    consumerName: string,
    minIdleTimeMs: number,
    messageIds: string[],
  ): Promise<StreamMessage[]>;
  /** OP-1 FIX: Get detailed pending entries with message IDs and idle times */
  xpendingRange(
    streamName: string,
    groupName: string,
    start: string,
    end: string,
    count: number,
    consumerName?: string,
  ): Promise<Array<{ id: string; consumer: string; idleMs: number; deliveryCount: number }>>;
}

/**
 * Alert callback for stream errors
 */
export interface StreamAlert {
  type: 'STREAM_CONSUMER_FAILURE' | 'STREAM_RECOVERED';
  message: string;
  severity: 'warning' | 'high' | 'critical';
  data: Record<string, unknown>;
  timestamp: number;
}

/**
 * Configuration for the stream consumer manager
 */
export interface StreamConsumerManagerConfig {
  /** Maximum stream errors before alerting (default: 10) */
  maxStreamErrors?: number;
  /** Dead letter queue stream name */
  dlqStream?: string;
  /** Rate limiter configuration */
  rateLimiterConfig?: Partial<RateLimiterConfig>;
  /** Instance ID for DLQ metadata */
  instanceId?: string;
  /** OP-1 FIX: Minimum idle time (ms) before claiming orphaned messages (default: 60000 = 1 min) */
  orphanClaimMinIdleMs?: number;
  /** OP-1 FIX: Maximum orphaned messages to claim per stream per recovery (default: 100) */
  orphanClaimBatchSize?: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<StreamConsumerManagerConfig> = {
  maxStreamErrors: 10,
  dlqStream: RedisStreams.DEAD_LETTER_QUEUE,
  rateLimiterConfig: {},
  instanceId: 'coordinator',
  orphanClaimMinIdleMs: 60000, // 1 minute idle before claiming
  orphanClaimBatchSize: 100,   // Max messages to claim per stream
};

/**
 * Stream Consumer Manager
 *
 * Provides utilities for managing stream consumers:
 * - Rate limiting to prevent DoS
 * - Deferred ACK with DLQ for message safety
 * - Error tracking with alerting
 */
export class StreamConsumerManager {
  private readonly config: Required<StreamConsumerManagerConfig>;
  private readonly logger: StreamManagerLogger;
  private readonly streamsClient: StreamsClient;
  private readonly rateLimiter: StreamRateLimiter;
  private readonly onAlert?: (alert: StreamAlert) => void;

  // Error tracking state
  private streamConsumerErrors = 0;
  private alertSentForCurrentErrorBurst = false;
  private sendingStreamErrorAlert = false;

  constructor(
    streamsClient: StreamsClient,
    logger: StreamManagerLogger,
    config?: StreamConsumerManagerConfig,
    onAlert?: (alert: StreamAlert) => void
  ) {
    this.streamsClient = streamsClient;
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rateLimiter = new StreamRateLimiter(this.config.rateLimiterConfig);
    this.onAlert = onAlert;
  }

  /**
   * Wrap a message handler with rate limiting.
   * Drops messages that exceed the rate limit.
   *
   * IMPORTANT: This method is private because rate-limited messages MUST be ACKed
   * to prevent PEL (Pending Entries List) leaks. Use wrapHandler() which combines
   * rate limiting with proper ACKing via withDeferredAck().
   *
   * @param streamName - Stream name for rate limit tracking
   * @param handler - Original message handler
   * @returns Wrapped handler with rate limiting
   */
  private withRateLimit(
    streamName: string,
    handler: (msg: StreamMessage) => Promise<void>
  ): (msg: StreamMessage) => Promise<void> {
    return async (msg: StreamMessage) => {
      if (!this.rateLimiter.checkRateLimit(streamName)) {
        this.logger.warn('Rate limit exceeded, dropping message', {
          stream: streamName,
          messageId: msg.id,
        });
        // P0-2 NOTE: We return without ACK here, but this method is private.
        // When used via wrapHandler(), withDeferredAck() wraps this and ACKs
        // rate-limited messages (since they don't throw, they're treated as success).
        return;
      }
      return handler(msg);
    };
  }

  /**
   * Wrap a message handler with deferred acknowledgment and DLQ support.
   *
   * This replaces autoAck: true with manual ACK after successful processing.
   * Failed messages are moved to DLQ before ACK to prevent data loss.
   *
   * Flow:
   * 1. Call handler with message
   * 2. On success: ACK the message
   * 3. On failure: Move to DLQ, then ACK (prevents infinite retries)
   *
   * @param groupConfig - Consumer group configuration
   * @param handler - Original message handler
   * @returns Wrapped handler with deferred ACK and DLQ
   */
  withDeferredAck(
    groupConfig: ConsumerGroupConfig,
    handler: (msg: StreamMessage) => Promise<void>
  ): (msg: StreamMessage) => Promise<void> {
    return async (msg: StreamMessage) => {
      try {
        await handler(msg);
        // Success: ACK the message
        await this.ackMessage(groupConfig, msg.id);
      } catch (error) {
        // Failure: Move to DLQ, then ACK to prevent infinite retries
        this.logger.error('Message handler failed, moving to DLQ', {
          stream: groupConfig.streamName,
          messageId: msg.id,
          error: (error as Error).message,
        });
        await this.moveToDeadLetterQueue(msg, error as Error, groupConfig.streamName);
        await this.ackMessage(groupConfig, msg.id);
      }
    };
  }

  /**
   * Wrap a handler with both rate limiting and deferred ACK.
   * This is the standard wrapper for production use.
   *
   * @param groupConfig - Consumer group configuration
   * @param handler - Original message handler
   * @returns Wrapped handler with rate limiting and deferred ACK
   */
  wrapHandler(
    groupConfig: ConsumerGroupConfig,
    handler: (msg: StreamMessage) => Promise<void>
  ): (msg: StreamMessage) => Promise<void> {
    const rateLimited = this.withRateLimit(groupConfig.streamName, handler);
    return this.withDeferredAck(groupConfig, rateLimited);
  }

  /**
   * Track a stream consumer error and send alerts if threshold exceeded.
   * Uses atomic flag pattern to prevent duplicate alerts from concurrent calls.
   *
   * @param streamName - Name of the stream that had an error
   */
  trackError(streamName: string): void {
    this.streamConsumerErrors++;

    // Atomic flag pattern to prevent duplicate alerts from concurrent consumers
    if (
      this.streamConsumerErrors >= this.config.maxStreamErrors &&
      !this.alertSentForCurrentErrorBurst &&
      !this.sendingStreamErrorAlert
    ) {
      // Set sending flag FIRST (synchronously) before any async work
      this.sendingStreamErrorAlert = true;

      this.onAlert?.({
        type: 'STREAM_CONSUMER_FAILURE',
        message: `Stream consumer experienced ${this.streamConsumerErrors} errors on ${streamName}`,
        severity: 'critical',
        data: { streamName, errorCount: this.streamConsumerErrors },
        timestamp: Date.now(),
      });

      // Set permanent flag after sending (prevents retries)
      this.alertSentForCurrentErrorBurst = true;
      this.sendingStreamErrorAlert = false;
    }
  }

  /**
   * Reset stream error tracking (called on successful processing).
   *
   * OP-26 FIX: Emits STREAM_RECOVERED alert when recovering from an error burst
   * that triggered a failure alert. Previously only a debug log was emitted.
   */
  resetErrors(streamName?: string): void {
    if (this.streamConsumerErrors > 0) {
      const previousErrors = this.streamConsumerErrors;

      // OP-26 FIX: Emit STREAM_RECOVERED alert if we previously sent a failure alert
      if (this.alertSentForCurrentErrorBurst) {
        this.onAlert?.({
          type: 'STREAM_RECOVERED',
          message: `Stream consumer recovered after ${previousErrors} errors${streamName ? ` on ${streamName}` : ''}`,
          severity: 'warning',
          data: { streamName: streamName ?? 'unknown', previousErrors },
          timestamp: Date.now(),
        });
      }

      this.logger.debug('Stream consumer recovered', {
        previousErrors,
      });
      this.streamConsumerErrors = 0;
      this.alertSentForCurrentErrorBurst = false;
    }
  }

  /**
   * Get current error count (for monitoring)
   */
  getErrorCount(): number {
    return this.streamConsumerErrors;
  }

  /**
   * Recover orphaned pending messages from previous coordinator instances.
   *
   * OP-1 FIX: When coordinator crashes mid-processing, messages remain in the
   * Pending Entries List (PEL) under the old consumer name. Since each coordinator
   * restart generates a unique consumer name (coordinator-${HOSTNAME}-${Date.now()}),
   * the old consumer's pending messages are permanently orphaned without XCLAIM.
   *
   * Recovery strategy:
   * 1. XPENDING summary to find all consumers with pending messages
   * 2. For OTHER consumers (not us), get detailed pending entries via XPENDING RANGE
   * 3. XCLAIM messages that have been idle longer than orphanClaimMinIdleMs
   * 4. ACK claimed messages immediately (stale data in a trading system is dangerous)
   * 5. Move claimed messages to DLQ for audit trail (optional reprocessing)
   *
   * Design notes:
   * - We ACK + DLQ rather than reprocess because stale trading data can cause bad trades
   * - The idle threshold (default 60s) prevents claiming messages from a healthy peer
   * - Batch size limits prevent recovery from blocking startup
   *
   * @param groupConfigs - Array of consumer group configurations to check
   */
  async recoverPendingMessages(groupConfigs: ConsumerGroupConfig[]): Promise<void> {
    for (const groupConfig of groupConfigs) {
      try {
        const pendingInfo = await this.streamsClient.xpending(
          groupConfig.streamName,
          groupConfig.groupName
        );

        if (!pendingInfo || pendingInfo.total === 0) {
          continue;
        }

        // Log pending messages for observability
        this.logger.warn('Found pending messages from previous instance', {
          stream: groupConfig.streamName,
          pendingCount: pendingInfo.total,
          smallestId: pendingInfo.smallestId,
          largestId: pendingInfo.largestId,
          consumers: pendingInfo.consumers,
        });

        // OP-1 FIX: Claim orphaned messages from OTHER consumers
        const otherConsumers = pendingInfo.consumers.filter(
          c => c.name !== groupConfig.consumerName && c.pending > 0
        );

        for (const staleConsumer of otherConsumers) {
          await this.claimOrphanedMessages(groupConfig, staleConsumer.name);
        }

        // Log our own pending (these will be redelivered naturally via XREADGROUP with '0')
        const ourPending = pendingInfo.consumers.find(
          c => c.name === groupConfig.consumerName
        );
        if (ourPending && ourPending.pending > 0) {
          this.logger.info('This consumer has pending messages to process', {
            stream: groupConfig.streamName,
            pendingForUs: ourPending.pending,
          });
        }
      } catch (error) {
        this.logger.error('Failed to check pending messages', {
          stream: groupConfig.streamName,
          error: (error as Error).message,
        });
        // Continue with other streams even if one fails
      }
    }
  }

  /**
   * OP-1 FIX: Claim orphaned messages from a stale consumer and move them to DLQ.
   *
   * Messages are ACKed immediately after claiming rather than reprocessed because:
   * - Stale price/opportunity data in a trading system can cause financial loss
   * - The DLQ provides an audit trail for manual review if needed
   * - The idle threshold ensures we only claim truly abandoned messages
   */
  private async claimOrphanedMessages(
    groupConfig: ConsumerGroupConfig,
    staleConsumerName: string,
  ): Promise<void> {
    try {
      // Get detailed pending entries for the stale consumer
      const pendingEntries = await this.streamsClient.xpendingRange(
        groupConfig.streamName,
        groupConfig.groupName,
        '-',
        '+',
        this.config.orphanClaimBatchSize,
        staleConsumerName,
      );

      // Filter to entries idle longer than threshold
      const orphanedIds = pendingEntries
        .filter(entry => entry.idleMs >= this.config.orphanClaimMinIdleMs)
        .map(entry => entry.id);

      if (orphanedIds.length === 0) {
        return;
      }

      // XCLAIM the orphaned messages to our consumer
      const claimed = await this.streamsClient.xclaim(
        groupConfig.streamName,
        groupConfig.groupName,
        groupConfig.consumerName,
        this.config.orphanClaimMinIdleMs,
        orphanedIds,
      );

      // ACK + DLQ each claimed message (stale data is unsafe to reprocess)
      for (const message of claimed) {
        await this.moveToDeadLetterQueue(message, new Error('Orphaned PEL message recovered via XCLAIM'), groupConfig.streamName);
        await this.ackMessage(groupConfig, message.id);
      }

      this.logger.info('Recovered orphaned pending messages', {
        stream: groupConfig.streamName,
        staleConsumer: staleConsumerName,
        claimedCount: claimed.length,
        totalOrphaned: orphanedIds.length,
      });
    } catch (error) {
      this.logger.error('Failed to claim orphaned messages', {
        stream: groupConfig.streamName,
        staleConsumer: staleConsumerName,
        error: (error as Error).message,
      });
      // Don't throw — continue with other consumers/streams
    }
  }

  /**
   * Acknowledge a message after processing.
   */
  private async ackMessage(groupConfig: ConsumerGroupConfig, messageId: string): Promise<void> {
    try {
      await this.streamsClient.xack(groupConfig.streamName, groupConfig.groupName, messageId);
    } catch (error) {
      this.logger.error('Failed to ACK message', {
        stream: groupConfig.streamName,
        messageId,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Move a failed message to the Dead Letter Queue.
   *
   * DLQ entries include:
   * - Original message data
   * - Error details
   * - Source stream for replay
   * - Timestamp for TTL-based cleanup
   */
  private async moveToDeadLetterQueue(
    message: StreamMessage,
    error: Error,
    sourceStream: string
  ): Promise<void> {
    try {
      await this.streamsClient.xadd(this.config.dlqStream, {
        originalMessageId: message.id,
        originalStream: sourceStream,
        originalData: JSON.stringify(message.data),
        error: error.message,
        errorStack: error.stack?.substring(0, 500), // Truncate stack trace
        timestamp: Date.now(),
        service: 'coordinator',
        instanceId: this.config.instanceId,
      });

      this.logger.debug('Message moved to DLQ', {
        originalMessageId: message.id,
        sourceStream,
      });
    } catch (dlqError) {
      // OP-16 FIX: If DLQ write fails, write to local file as last-resort backup.
      // Without this, double failure (handler + DLQ) loses the message permanently.
      this.logger.error('Failed to move message to DLQ, writing to local fallback', {
        originalMessageId: message.id,
        sourceStream,
        dlqError: (dlqError as Error).message,
      });
      this.writeLocalDlqFallback(message, error, sourceStream);
    }
  }

  /**
   * OP-16 FIX: Write failed message to local file when Redis DLQ is unavailable.
   *
   * This is a last-resort fallback for double-failure scenarios (handler fails
   * AND DLQ write fails). The message would otherwise be permanently lost
   * since it's ACKed to prevent infinite retry loops.
   *
   * Writes JSONL (one JSON object per line) to data/dlq-fallback-{date}.jsonl.
   * Append-only, async via fs/promises.
   */
  /** FIX 4.3: Maximum DLQ fallback file size per day (100MB) */
  private static readonly MAX_DLQ_FILE_BYTES = 100 * 1024 * 1024;

  private async writeLocalDlqFallback(
    message: StreamMessage,
    error: Error,
    sourceStream: string
  ): Promise<void> {
    try {
      const date = new Date().toISOString().split('T')[0];
      const dir = path.resolve('data');
      await fsPromises.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `dlq-fallback-${date}.jsonl`);

      // FIX 4.3: Enforce 100MB daily file size limit to prevent disk exhaustion
      try {
        const stat = await fsPromises.stat(filePath);
        if (stat.size >= StreamConsumerManager.MAX_DLQ_FILE_BYTES) {
          this.logger.warn('DLQ fallback file size limit reached, dropping message', {
            filePath,
            sizeBytes: stat.size,
            limitBytes: StreamConsumerManager.MAX_DLQ_FILE_BYTES,
            originalMessageId: message.id,
            sourceStream,
          });
          return;
        }
      } catch {
        // File doesn't exist yet — proceed to create it
      }

      const entry = JSON.stringify({
        originalMessageId: message.id,
        originalStream: sourceStream,
        originalData: message.data,
        error: error.message,
        timestamp: Date.now(),
        service: 'coordinator',
        instanceId: this.config.instanceId,
      });
      await fsPromises.appendFile(filePath, entry + '\n');
    } catch (fileError) {
      // Absolute last resort: message only exists in application logs
      this.logger.error('Local DLQ fallback write also failed', {
        originalMessageId: message.id,
        sourceStream,
        fileError: (fileError as Error).message,
      });
    }
  }

  /**
   * Reset all internal state (for testing)
   */
  reset(): void {
    this.streamConsumerErrors = 0;
    this.alertSentForCurrentErrorBurst = false;
    this.sendingStreamErrorAlert = false;
    this.rateLimiter.reset();
  }
}
