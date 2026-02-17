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
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<StreamConsumerManagerConfig> = {
  maxStreamErrors: 10,
  dlqStream: RedisStreams.DEAD_LETTER_QUEUE,
  rateLimiterConfig: {},
  instanceId: 'coordinator',
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
   */
  resetErrors(): void {
    if (this.streamConsumerErrors > 0) {
      this.logger.debug('Stream consumer recovered', {
        previousErrors: this.streamConsumerErrors,
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
   * Check for and log pending messages from previous coordinator instance.
   *
   * When coordinator crashes mid-processing, messages remain in XPENDING.
   * Redis Streams automatically handles redelivery of pending messages
   * to consumers in the same group.
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

        // Find pending messages for THIS consumer (if any)
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
      // If DLQ write fails, log but don't throw - we still want to ACK the original message
      // to prevent infinite retry loops
      this.logger.error('Failed to move message to DLQ', {
        originalMessageId: message.id,
        sourceStream,
        dlqError: (dlqError as Error).message,
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
