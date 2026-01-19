/**
 * Opportunity Consumer
 *
 * Handles Redis Stream consumption for arbitrage opportunities.
 * Implements deferred ACK pattern and dead letter queue for failures.
 *
 * Key features:
 * - Blocking read pattern for low-latency delivery
 * - Backpressure coupling with queue service
 * - Deferred ACK after execution completion
 * - Dead letter queue for processing failures
 *
 * @see engine.ts (parent service)
 */

import {
  RedisStreamsClient,
  ConsumerGroupConfig,
  StreamConsumer,
  getErrorMessage,
} from '@arbitrage/core';
import { ARBITRAGE_CONFIG } from '@arbitrage/config';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { Logger, ExecutionStats, QueueService } from '../types';

export interface OpportunityConsumerConfig {
  logger: Logger;
  streamsClient: RedisStreamsClient;
  queueService: QueueService;
  stats: ExecutionStats;
  instanceId: string;
  /** Callback when opportunity is queued successfully */
  onOpportunityQueued?: (opportunity: ArbitrageOpportunity) => void;
}

export interface PendingMessageInfo {
  streamName: string;
  groupName: string;
  messageId: string;
}

export class OpportunityConsumer {
  private readonly logger: Logger;
  private readonly streamsClient: RedisStreamsClient;
  private readonly queueService: QueueService;
  private readonly stats: ExecutionStats;
  private readonly instanceId: string;
  private readonly onOpportunityQueued?: (opportunity: ArbitrageOpportunity) => void;

  private streamConsumer: StreamConsumer | null = null;
  private consumerGroup: ConsumerGroupConfig;
  private pendingMessages: Map<string, PendingMessageInfo> = new Map();
  private activeExecutions: Set<string> = new Set();

  constructor(config: OpportunityConsumerConfig) {
    this.logger = config.logger;
    this.streamsClient = config.streamsClient;
    this.queueService = config.queueService;
    this.stats = config.stats;
    this.instanceId = config.instanceId;
    this.onOpportunityQueued = config.onOpportunityQueued;

    // Define consumer group configuration
    this.consumerGroup = {
      streamName: RedisStreamsClient.STREAMS.OPPORTUNITIES,
      groupName: 'execution-engine-group',
      consumerName: this.instanceId,
      startId: '$'
    };
  }

  /**
   * Create consumer group for Redis Streams.
   */
  async createConsumerGroup(): Promise<void> {
    try {
      await this.streamsClient.createConsumerGroup(this.consumerGroup);
      this.logger.info('Consumer group ready', {
        stream: this.consumerGroup.streamName,
        group: this.consumerGroup.groupName
      });
    } catch (error) {
      this.logger.error('Failed to create consumer group', {
        error,
        stream: this.consumerGroup.streamName
      });
    }
  }

  /**
   * Start consuming opportunities from stream.
   */
  start(): void {
    this.streamConsumer = new StreamConsumer(this.streamsClient, {
      config: this.consumerGroup,
      handler: async (message) => {
        await this.handleStreamMessage(message);
      },
      batchSize: 10,
      blockMs: 1000,
      autoAck: false, // Deferred ACK after execution
      logger: {
        error: (msg, ctx) => this.logger.error(msg, ctx),
        debug: (msg, ctx) => this.logger.debug(msg, ctx)
      },
      onPauseStateChange: (isPaused) => {
        this.logger.info('Stream consumer pause state changed', {
          isPaused,
          queueSize: this.queueService.size()
        });
      }
    });

    // Couple backpressure to stream consumer
    this.queueService.onPauseStateChange((isPaused) => {
      if (isPaused) {
        this.streamConsumer?.pause();
      } else {
        this.streamConsumer?.resume();
      }
    });

    this.streamConsumer.start();
    this.logger.info('Stream consumer started with blocking reads', {
      stream: this.consumerGroup.streamName,
      blockMs: 1000
    });
  }

  /**
   * Stop consuming opportunities.
   */
  async stop(): Promise<void> {
    if (this.streamConsumer) {
      await this.streamConsumer.stop();
      this.streamConsumer = null;
    }
    // Clear pending messages (will be redelivered by Redis Streams)
    this.pendingMessages.clear();
  }

  /**
   * Handle individual stream message with deferred ACK pattern.
   *
   * ACK strategy:
   * - Empty messages: ACK immediately
   * - Rejected opportunities (validation/backpressure): ACK immediately
   * - Queued opportunities: Deferred ACK after execution completes
   */
  private async handleStreamMessage(
    message: { id: string; data: unknown }
  ): Promise<void> {
    try {
      if (!message.data) {
        this.logger.warn('Skipping message with no data', { messageId: message.id });
        // ACK empty messages to prevent redelivery
        await this.streamsClient.xack(
          this.consumerGroup.streamName,
          this.consumerGroup.groupName,
          message.id
        );
        return;
      }

      const opportunity = message.data as unknown as ArbitrageOpportunity;

      // Handle the opportunity - returns true if successfully queued
      const wasQueued = this.handleArbitrageOpportunity(opportunity);

      if (wasQueued) {
        // Store message info for deferred ACK after execution
        this.pendingMessages.set(opportunity.id, {
          streamName: this.consumerGroup.streamName,
          groupName: this.consumerGroup.groupName,
          messageId: message.id
        });
      } else {
        // Opportunity was rejected - ACK immediately to prevent redelivery
        // Rejected opportunities shouldn't be retried (they'll just fail again)
        await this.streamsClient.xack(
          this.consumerGroup.streamName,
          this.consumerGroup.groupName,
          message.id
        );
      }
    } catch (error) {
      // Always ACK on processing error to prevent infinite redelivery
      this.stats.messageProcessingErrors++;
      this.logger.error('Message processing error - ACKing to prevent redelivery loop', {
        messageId: message.id,
        error: getErrorMessage(error)
      });

      // Move to Dead Letter Queue and ACK
      await this.moveToDeadLetterQueue(message, error as Error);
      await this.streamsClient.xack(
        this.consumerGroup.streamName,
        this.consumerGroup.groupName,
        message.id
      );
    }
  }

  /**
   * Handle arbitrage opportunity by validating and enqueueing.
   * @returns true if successfully queued, false if rejected
   */
  private handleArbitrageOpportunity(opportunity: ArbitrageOpportunity): boolean {
    this.stats.opportunitiesReceived++;

    try {
      // Validate opportunity
      if (!this.validateOpportunity(opportunity)) {
        this.stats.opportunitiesRejected++;
        return false;
      }

      // Try to enqueue
      if (!this.queueService.enqueue(opportunity)) {
        this.stats.queueRejects++;
        this.logger.warn('Opportunity rejected due to queue backpressure', {
          id: opportunity.id,
          queueSize: this.queueService.size()
        });
        return false;
      }

      this.logger.info('Added opportunity to execution queue', {
        id: opportunity.id,
        type: opportunity.type,
        profit: opportunity.expectedProfit,
        queueSize: this.queueService.size()
      });

      // Notify callback
      if (this.onOpportunityQueued) {
        this.onOpportunityQueued(opportunity);
      }

      return true;
    } catch (error) {
      this.logger.error('Failed to handle arbitrage opportunity', { error });
      return false;
    }
  }

  /**
   * Validate opportunity before enqueueing.
   */
  private validateOpportunity(opportunity: ArbitrageOpportunity): boolean {
    // Check confidence threshold
    if (opportunity.confidence < ARBITRAGE_CONFIG.confidenceThreshold) {
      this.logger.debug('Opportunity rejected: low confidence', {
        id: opportunity.id,
        confidence: opportunity.confidence
      });
      return false;
    }

    // Check profit threshold
    if ((opportunity.expectedProfit ?? 0) < ARBITRAGE_CONFIG.minProfitPercentage) {
      this.logger.debug('Opportunity rejected: insufficient profit', {
        id: opportunity.id,
        profit: opportunity.expectedProfit
      });
      return false;
    }

    // Check if already in local tracking
    if (this.activeExecutions.has(opportunity.id)) {
      this.logger.debug('Opportunity rejected: already executing', {
        id: opportunity.id
      });
      return false;
    }

    return true;
  }

  /**
   * ACK message after successful execution.
   */
  async ackMessageAfterExecution(opportunityId: string): Promise<void> {
    const pendingInfo = this.pendingMessages.get(opportunityId);
    if (!pendingInfo) return;

    try {
      await this.streamsClient.xack(
        pendingInfo.streamName,
        pendingInfo.groupName,
        pendingInfo.messageId
      );
      this.pendingMessages.delete(opportunityId);
      this.logger.debug('Message ACKed after execution', { opportunityId });
    } catch (error) {
      this.logger.error('Failed to ACK message after execution', {
        opportunityId,
        error: getErrorMessage(error)
      });
    }
  }

  /**
   * Move failed messages to Dead Letter Queue.
   */
  private async moveToDeadLetterQueue(
    message: { id: string; data: unknown },
    error: Error
  ): Promise<void> {
    try {
      await this.streamsClient.xadd('stream:dead-letter-queue', {
        originalMessageId: message.id,
        originalStream: RedisStreamsClient.STREAMS.OPPORTUNITIES,
        data: message.data,
        error: error.message,
        timestamp: Date.now(),
        service: 'execution-engine'
      });
    } catch (dlqError) {
      this.logger.error('Failed to move message to DLQ', {
        messageId: message.id,
        error: (dlqError as Error).message
      });
    }
  }

  /**
   * Mark opportunity as actively executing (for duplicate detection).
   */
  markActive(opportunityId: string): void {
    this.activeExecutions.add(opportunityId);
  }

  /**
   * Remove opportunity from active set.
   */
  markComplete(opportunityId: string): void {
    this.activeExecutions.delete(opportunityId);
  }

  /**
   * Get count of active executions.
   */
  getActiveCount(): number {
    return this.activeExecutions.size;
  }

  /**
   * Get pending messages count.
   */
  getPendingCount(): number {
    return this.pendingMessages.size;
  }

  /**
   * Pause stream consumption.
   */
  pause(): void {
    this.streamConsumer?.pause();
  }

  /**
   * Resume stream consumption.
   */
  resume(): void {
    this.streamConsumer?.resume();
  }
}
