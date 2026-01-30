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
 * - Comprehensive validation with structured error codes
 *
 * Architecture Note (ADR-002):
 * This consumer reads from EXECUTION_REQUESTS stream (forwarded by coordinator),
 * NOT directly from the OPPORTUNITIES stream. This broker pattern provides:
 * - Leader election for opportunity deduplication
 * - Pre-filtering by coordinator
 * - Centralized routing decisions
 *
 * @see engine.ts (parent service)
 * @see docs/architecture/ARCHITECTURE_V2.md Section 5.4
 * @see docs/architecture/adr/ADR-002-redis-streams.md
 */

import {
  RedisStreamsClient,
  ConsumerGroupConfig,
  StreamConsumer,
  getErrorMessage,
} from '@arbitrage/core';
import { ARBITRAGE_CONFIG } from '@arbitrage/config';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type {
  Logger,
  ExecutionStats,
  QueueService,
  ConsumerConfig,
} from '../types';
import { DEFAULT_CONSUMER_CONFIG, DLQ_STREAM } from '../types';

// REFACTOR 9.1: Import validation types and functions from extracted module
import {
  validateMessageStructure,
  validateBusinessRules as validateBusinessRulesFunc,
  type ValidationResult,
  type ValidationFailure,
  type BusinessRuleResult,
} from './validation';

// =============================================================================
// Configuration Interface
// =============================================================================

export interface OpportunityConsumerConfig {
  logger: Logger;
  streamsClient: RedisStreamsClient;
  queueService: QueueService;
  stats: ExecutionStats;
  instanceId: string;
  /** Callback when opportunity is queued successfully */
  onOpportunityQueued?: (opportunity: ArbitrageOpportunity) => void;
  /** Consumer configuration overrides */
  consumerConfig?: Partial<ConsumerConfig>;
}

export interface PendingMessageInfo {
  streamName: string;
  groupName: string;
  messageId: string;
  /** Timestamp when message was queued (for TTL cleanup) */
  queuedAt: number;
}

// =============================================================================
// REFACTOR 9.1: Validation types moved to ./validation.ts
// Types imported: ValidationResult, BusinessRuleResult, SubValidationResult
// Functions imported: validateMessageStructure, validateBusinessRulesFunc
// =============================================================================

// =============================================================================
// Note: DLQ_STREAM constant is now imported from '../types' for centralization
// =============================================================================

// =============================================================================
// Type Safety Design Decision (REFACTOR 9.2)
// =============================================================================
//
// The `as unknown as ArbitrageOpportunity` cast at the end of validateMessage()
// is intentional. A type guard was considered but provides less value because:
//
// 1. Explicit field checks give specific error codes (MISSING_ID, MISSING_TYPE, etc.)
// 2. TypeScript can't track all the field validations we perform
// 3. The cast is safe because we've validated all required fields
// 4. A type guard would duplicate validation logic without better error messages
//
// If the ArbitrageOpportunity type changes, add new validation checks and
// update ValidationErrorCode accordingly.

// =============================================================================
// OpportunityConsumer Class
// =============================================================================

export class OpportunityConsumer {
  private readonly logger: Logger;
  private readonly streamsClient: RedisStreamsClient;
  private readonly queueService: QueueService;
  private readonly stats: ExecutionStats;
  private readonly instanceId: string;
  private readonly onOpportunityQueued?: (opportunity: ArbitrageOpportunity) => void;
  private readonly config: ConsumerConfig;

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

    // Merge config with defaults
    this.config = {
      ...DEFAULT_CONSUMER_CONFIG,
      ...config.consumerConfig,
    };

    // Define consumer group configuration
    // Architecture Note: Consumes from EXECUTION_REQUESTS (forwarded by coordinator leader)
    // This ensures only leader-approved opportunities are executed
    // @see ARCHITECTURE_V2.md Section 5.4 - Broker Pattern
    this.consumerGroup = {
      streamName: RedisStreamsClient.STREAMS.EXECUTION_REQUESTS,
      groupName: 'execution-engine-group',
      consumerName: this.instanceId,
      startId: '$',
    };
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Create consumer group for Redis Streams.
   */
  async createConsumerGroup(): Promise<void> {
    try {
      await this.streamsClient.createConsumerGroup(this.consumerGroup);
      this.logger.info('Consumer group ready', {
        stream: this.consumerGroup.streamName,
        group: this.consumerGroup.groupName,
      });
    } catch (error) {
      // Log but don't throw - group may already exist (BUSYGROUP error is expected)
      this.logger.error('Failed to create consumer group', {
        error: getErrorMessage(error),
        stream: this.consumerGroup.streamName,
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
      batchSize: this.config.batchSize,
      blockMs: this.config.blockMs,
      autoAck: false, // Deferred ACK after execution
      logger: {
        error: (msg: string, ctx?: Record<string, unknown>) => this.logger.error(msg, ctx),
        debug: (msg: string, ctx?: Record<string, unknown>) => this.logger.debug(msg, ctx),
      },
      onPauseStateChange: (isPaused) => {
        this.logger.info('Stream consumer pause state changed', {
          isPaused,
          queueSize: this.queueService.size(),
        });
      },
    });

    // Couple backpressure to stream consumer
    // RACE FIX 5.2: Guard against null streamConsumer during initialization/shutdown
    this.queueService.onPauseStateChange((isPaused) => {
      if (!this.streamConsumer) {
        // Log at debug level - this can happen during startup/shutdown
        this.logger.debug('Backpressure signal ignored - stream consumer not ready', {
          isPaused,
        });
        return;
      }
      if (isPaused) {
        this.streamConsumer.pause();
      } else {
        this.streamConsumer.resume();
      }
    });

    this.streamConsumer.start();
    this.logger.info('Stream consumer started with blocking reads', {
      stream: this.consumerGroup.streamName,
      batchSize: this.config.batchSize,
      blockMs: this.config.blockMs,
    });
  }

  /**
   * Stop consuming opportunities.
   *
   * Performance Optimization: Uses batch ACK pattern for efficient cleanup.
   * All pending messages are ACKed before shutdown to prevent redelivery storms.
   */
  async stop(): Promise<void> {
    // Stop stream consumer first
    if (this.streamConsumer) {
      await this.streamConsumer.stop();
      this.streamConsumer = null;
    }

    // Batch ACK all pending messages using pipeline pattern
    if (this.pendingMessages.size > 0) {
      this.logger.info('ACKing pending messages during shutdown', {
        count: this.pendingMessages.size,
      });

      await this.batchAckPendingMessages();
    }

    // Clear local state
    this.pendingMessages.clear();
    this.activeExecutions.clear();
  }

  /**
   * Batch ACK pending messages efficiently.
   * Uses Promise.allSettled with timeout for resilience.
   *
   * Performance Analysis (PERF 10.4):
   * - Current: Parallelized xack calls with Promise.allSettled + timeout guard
   * - Alternative: Redis MULTI/EXEC pipeline for true batching
   *
   * Design Decision: Parallelized approach is sufficient because:
   * 1. Shutdown is not hot-path - happens once at process termination
   * 2. Typical pending count at shutdown is <100 messages (maxConcurrentExecutions=5)
   * 3. Pipeline would require changes to RedisStreamsClient interface
   * 4. Parallelized calls complete in O(max_latency) not O(n*latency)
   *
   * Revisit if: pending count at shutdown regularly exceeds 1000 messages
   */
  private async batchAckPendingMessages(): Promise<void> {
    const ackPromises: Promise<void>[] = [];

    for (const [id, info] of this.pendingMessages) {
      const ackPromise = this.streamsClient
        .xack(info.streamName, info.groupName, info.messageId)
        .then(() => {
          this.logger.debug('ACKed pending message during shutdown', { id });
        })
        .catch((error) => {
          this.logger.warn('Failed to ACK pending message during shutdown', {
            id,
            error: getErrorMessage(error),
          });
        });
      ackPromises.push(ackPromise);
    }

    // Wait for all ACKs with configurable timeout
    await Promise.race([
      Promise.allSettled(ackPromises),
      new Promise<void>((resolve) =>
        setTimeout(resolve, this.config.shutdownAckTimeoutMs)
      ),
    ]);
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  /**
   * Handle individual stream message with deferred ACK pattern.
   *
   * ACK strategy:
   * - System messages (stream-init): ACK immediately, no DLQ
   * - Empty/invalid messages: ACK immediately, move to DLQ
   * - Rejected opportunities (validation/backpressure): ACK immediately
   * - Queued opportunities: Deferred ACK after execution completes
   */
  private async handleStreamMessage(
    message: { id: string; data: unknown }
  ): Promise<void> {
    // Validate message structure and content
    const validation = this.validateMessage(message);

    if (!validation.valid) {
      // Handle validation failure
      await this.handleValidationFailure(message, validation);
      return;
    }

    const opportunity = validation.opportunity;

    // Handle the opportunity - returns true if successfully queued
    const wasQueued = this.handleArbitrageOpportunity(opportunity);

    if (wasQueued) {
      // BUG FIX 4.2: Handle duplicate opportunity IDs properly
      // If we already have a pending message for this ID, ACK the OLD message first
      // to prevent orphaned entries in Redis PEL (Pending Entries List)
      const existingPending = this.pendingMessages.get(opportunity.id);
      if (existingPending) {
        this.logger.warn('Duplicate opportunity ID in pending messages - ACKing previous', {
          id: opportunity.id,
          existingMessageId: existingPending.messageId,
          newMessageId: message.id,
        });
        // ACK the previous message to prevent PEL leak
        // Fire-and-forget: don't block on ACK since it's cleanup
        // Note: Call xack directly instead of ackMessage to ensure .catch() works
        // (ackMessage has its own try-catch that swallows errors)
        this.streamsClient
          .xack(existingPending.streamName, existingPending.groupName, existingPending.messageId)
          .catch((err) => {
            this.logger.warn('Failed to ACK orphaned duplicate message', {
              messageId: existingPending.messageId,
              error: getErrorMessage(err),
            });
          });
      }

      // Store message info for deferred ACK after execution
      this.pendingMessages.set(opportunity.id, {
        streamName: this.consumerGroup.streamName,
        groupName: this.consumerGroup.groupName,
        messageId: message.id,
        queuedAt: Date.now(),
      });
    } else {
      // Opportunity was rejected - ACK immediately to prevent redelivery
      await this.ackMessage(message.id);
    }
  }

  /**
   * Handle validation failure by ACKing and optionally moving to DLQ.
   */
  private async handleValidationFailure(
    message: { id: string; data: unknown },
    validation: ValidationFailure
  ): Promise<void> {
    // System messages (like stream-init) are ACKed silently
    if (validation.isSystemMessage) {
      this.logger.debug('Skipping system message', {
        messageId: message.id,
        code: validation.code,
      });
      await this.ackMessage(message.id);
      return;
    }

    // Increment validation error counter for non-system validation failures
    this.stats.validationErrors++;

    const errorMessage = validation.details
      ? `${validation.code}: ${validation.details}`
      : validation.code;

    // FIX 6.2: Use warn instead of error - validation failures are expected
    // (malformed messages from upstream), not system errors
    this.logger.warn('Message validation failed - moving to DLQ', {
      messageId: message.id,
      code: validation.code,
      details: validation.details,
    });

    // Move to Dead Letter Queue for analysis
    await this.moveToDeadLetterQueue(message, new Error(errorMessage));

    // ACK to prevent infinite redelivery
    await this.ackMessage(message.id);
  }

  // ===========================================================================
  // Validation (REFACTOR 9.1: Delegates to ./validation.ts)
  // ===========================================================================

  /**
   * Validate incoming message structure and content.
   * REFACTOR 9.1: Delegates to validateMessageStructure from ./validation.ts
   *
   * @returns ValidationResult - Either success with parsed opportunity or failure with error code
   */
  private validateMessage(message: { id: string; data: unknown }): ValidationResult {
    return validateMessageStructure(message);
  }

  // ===========================================================================
  // Opportunity Handling
  // ===========================================================================

  /**
   * Handle arbitrage opportunity by validating business rules and enqueueing.
   *
   * BUG FIX 4.1: Uses atomic check-and-add pattern for duplicate detection.
   * The opportunity ID is added to activeExecutions IMMEDIATELY after successful
   * enqueue (not after dequeue by engine) to prevent race conditions where
   * duplicate messages pass the check before either is marked active.
   *
   * @returns true if successfully queued, false if rejected
   */
  private handleArbitrageOpportunity(opportunity: ArbitrageOpportunity): boolean {
    this.stats.opportunitiesReceived++;

    try {
      // Validate business rules
      const businessValidation = this.validateBusinessRules(opportunity);
      if (!businessValidation.valid) {
        this.stats.opportunitiesRejected++;
        this.logger.debug('Opportunity rejected by business rules', {
          id: opportunity.id,
          code: businessValidation.code,
          details: businessValidation.details,
        });
        return false;
      }

      // BUG FIX 4.1: Atomic check-and-add for duplicate detection
      // Check AND mark active in a single synchronous block to prevent race conditions
      // where two concurrent messages both pass the check before either is marked
      if (this.activeExecutions.has(opportunity.id)) {
        this.stats.opportunitiesRejected++;
        this.logger.debug('Opportunity rejected: already queued or executing', {
          id: opportunity.id,
        });
        return false;
      }

      // Mark active BEFORE enqueue to prevent race condition
      // If enqueue fails, we'll remove it from activeExecutions
      this.activeExecutions.add(opportunity.id);

      // Try to enqueue
      if (!this.queueService.enqueue(opportunity)) {
        // Rollback: remove from activeExecutions since enqueue failed
        this.activeExecutions.delete(opportunity.id);
        this.stats.queueRejects++;
        this.logger.warn('Opportunity rejected due to queue backpressure', {
          id: opportunity.id,
          queueSize: this.queueService.size(),
        });
        return false;
      }

      this.logger.info('Added opportunity to execution queue', {
        id: opportunity.id,
        type: opportunity.type,
        profit: opportunity.expectedProfit,
        queueSize: this.queueService.size(),
      });

      // Notify callback
      if (this.onOpportunityQueued) {
        this.onOpportunityQueued(opportunity);
      }

      return true;
    } catch (error) {
      // Rollback: ensure we don't leave orphaned entries on error
      this.activeExecutions.delete(opportunity.id);
      // BUG FIX 4.2: Track as rejection since opportunity was not processed
      this.stats.opportunitiesRejected++;
      this.logger.error('Failed to handle arbitrage opportunity', {
        id: opportunity.id,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Validate opportunity against business rules.
   * REFACTOR 9.1: Delegates to validateBusinessRulesFunc from ./validation.ts
   *
   * @returns BusinessRuleResult indicating pass or fail
   */
  private validateBusinessRules(opportunity: ArbitrageOpportunity): BusinessRuleResult {
    return validateBusinessRulesFunc(opportunity, {
      confidenceThreshold: ARBITRAGE_CONFIG.confidenceThreshold,
      minProfitPercentage: ARBITRAGE_CONFIG.minProfitPercentage,
    });
  }

  // ===========================================================================
  // ACK Operations
  // ===========================================================================

  /**
   * ACK a message immediately.
   */
  private async ackMessage(messageId: string): Promise<void> {
    try {
      await this.streamsClient.xack(
        this.consumerGroup.streamName,
        this.consumerGroup.groupName,
        messageId
      );
    } catch (error) {
      this.logger.error('Failed to ACK message', {
        messageId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * ACK message after successful execution.
   * Called by engine after execution completes.
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
        error: getErrorMessage(error),
      });
    }
  }

  // ===========================================================================
  // Dead Letter Queue
  // ===========================================================================

  /**
   * Move failed messages to Dead Letter Queue.
   * Stores essential information for debugging without the full message payload.
   */
  private async moveToDeadLetterQueue(
    message: { id: string; data: unknown },
    error: Error
  ): Promise<void> {
    try {
      // Extract essential fields for DLQ analysis (avoid storing full payload)
      const data = message.data as Record<string, unknown> | null;
      const dlqData = {
        originalMessageId: message.id,
        originalStream: RedisStreamsClient.STREAMS.EXECUTION_REQUESTS,
        opportunityId: data?.id ?? 'unknown',
        opportunityType: data?.type ?? 'unknown',
        error: error.message,
        timestamp: Date.now(),
        service: 'execution-engine',
        instanceId: this.instanceId,
      };

      await this.streamsClient.xadd(DLQ_STREAM, dlqData);
    } catch (dlqError) {
      this.logger.error('Failed to move message to DLQ', {
        messageId: message.id,
        error: getErrorMessage(dlqError),
      });
    }
  }

  // ===========================================================================
  // Active Execution Tracking
  // ===========================================================================

  /**
   * Mark opportunity as actively executing (for duplicate detection).
   * Called by engine when execution starts.
   *
   * NOTE: This is now idempotent - the ID is already added by handleArbitrageOpportunity()
   * immediately after enqueue to fix BUG 4.1 (race condition). This method is kept
   * for backwards compatibility and explicit documentation of the execution lifecycle.
   */
  markActive(opportunityId: string): void {
    this.activeExecutions.add(opportunityId);
  }

  /**
   * Remove opportunity from active set.
   * Called by engine when execution completes (success or failure).
   *
   * CRITICAL: This must be called after execution completes to allow
   * re-processing of opportunities with the same ID.
   */
  markComplete(opportunityId: string): void {
    this.activeExecutions.delete(opportunityId);
  }

  /**
   * Check if an opportunity is currently active (queued or executing).
   * Useful for external status checks.
   */
  isActive(opportunityId: string): boolean {
    return this.activeExecutions.has(opportunityId);
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

  // ===========================================================================
  // Pending Message Cleanup (BUG FIX 4.1)
  // ===========================================================================

  /**
   * Clean up stale pending messages to prevent memory leaks.
   *
   * BUG FIX 4.1: Messages that exceed config.pendingMessageMaxAgeMs are considered
   * orphaned (execution completed without ACK, or engine crashed). These are
   * ACKed to prevent Redis PEL growth and memory leaks.
   *
   * This method is called periodically from engine health monitoring.
   *
   * @returns Number of stale messages cleaned up
   */
  async cleanupStalePendingMessages(): Promise<number> {
    const now = Date.now();
    const maxAgeMs = this.config.pendingMessageMaxAgeMs;
    const staleIds: string[] = [];

    // Identify stale messages
    for (const [id, info] of this.pendingMessages) {
      if (now - info.queuedAt > maxAgeMs) {
        staleIds.push(id);
      }
    }

    if (staleIds.length === 0) {
      return 0;
    }

    this.logger.warn('Cleaning up stale pending messages', {
      count: staleIds.length,
      maxAgeMs,
    });

    // ACK and remove stale messages
    let cleanedCount = 0;
    for (const id of staleIds) {
      const info = this.pendingMessages.get(id);
      if (!info) continue;

      try {
        await this.streamsClient.xack(info.streamName, info.groupName, info.messageId);
        this.pendingMessages.delete(id);
        this.activeExecutions.delete(id); // Also clean up active tracking
        cleanedCount++;

        this.logger.debug('Cleaned up stale pending message', {
          id,
          messageId: info.messageId,
          ageMs: now - info.queuedAt,
        });
      } catch (error) {
        this.logger.error('Failed to ACK stale pending message', {
          id,
          error: getErrorMessage(error),
        });
      }
    }

    return cleanedCount;
  }

  /**
   * Get information about stale pending messages (for monitoring).
   *
   * @returns Array of opportunity IDs with their age in ms
   */
  getStalePendingInfo(): Array<{ id: string; ageMs: number }> {
    const now = Date.now();
    const maxAgeMs = this.config.pendingMessageMaxAgeMs;
    const stale: Array<{ id: string; ageMs: number }> = [];

    for (const [id, info] of this.pendingMessages) {
      const ageMs = now - info.queuedAt;
      if (ageMs > maxAgeMs) {
        stale.push({ id, ageMs });
      }
    }

    return stale;
  }

  /**
   * Get the configured pending message max age in milliseconds.
   * Useful for testing and monitoring.
   */
  getPendingMessageMaxAgeMs(): number {
    return this.config.pendingMessageMaxAgeMs;
  }

  // ===========================================================================
  // Pause/Resume
  // ===========================================================================

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
