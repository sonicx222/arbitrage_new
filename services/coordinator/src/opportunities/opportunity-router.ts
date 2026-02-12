/**
 * Opportunity Router
 *
 * Manages arbitrage opportunity lifecycle:
 * - Storage with size limits
 * - Duplicate detection
 * - Expiry cleanup
 * - Forwarding to execution engine
 *
 * @see R2 - Coordinator Subsystems extraction
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import { findKSmallest } from '@arbitrage/core';

/**
 * Logger interface for dependency injection
 */
export interface OpportunityRouterLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Redis streams client interface (subset needed by router)
 */
export interface OpportunityStreamsClient {
  xadd(streamName: string, data: Record<string, unknown>): Promise<string>;
}

/**
 * Circuit breaker interface for execution forwarding
 */
export interface CircuitBreaker {
  isCurrentlyOpen(): boolean;
  recordFailure(): boolean;
  recordSuccess(): boolean;
  getFailures(): number;
  getStatus(): { isOpen: boolean; failures: number; resetTimeoutMs: number };
}

/**
 * Alert callback for opportunity events
 */
export interface OpportunityAlert {
  type: 'EXECUTION_CIRCUIT_OPEN' | 'EXECUTION_FORWARD_FAILED';
  message: string;
  severity: 'warning' | 'high' | 'critical';
  data: Record<string, unknown>;
  timestamp: number;
}

/**
 * Configuration for the opportunity router
 */
export interface OpportunityRouterConfig {
  /** Maximum opportunities to keep in memory (default: 1000) */
  maxOpportunities?: number;
  /** Opportunity TTL in milliseconds (default: 60000) */
  opportunityTtlMs?: number;
  /** Duplicate detection window in milliseconds (default: 5000) */
  duplicateWindowMs?: number;
  /** Instance ID for forwarding metadata */
  instanceId?: string;
  /** Execution requests stream name */
  executionRequestsStream?: string;
  /** Minimum profit percentage (default: -100) */
  minProfitPercentage?: number;
  /** Maximum profit percentage (default: 10000) */
  maxProfitPercentage?: number;
  // P1-7 FIX: Retry and DLQ configuration
  /** Maximum retry attempts for forwarding failures (default: 3) */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 10) */
  retryBaseDelayMs?: number;
  /** Dead letter queue stream for FORWARDING failures (default: 'stream:forwarding-dlq').
   * P2 FIX #21 NOTE: Intentionally separate from StreamConsumerManager's
   * 'stream:dead-letter-queue' — different failure mode, different schema. */
  dlqStream?: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<OpportunityRouterConfig> = {
  maxOpportunities: 1000,
  opportunityTtlMs: 60000,
  duplicateWindowMs: 5000,
  instanceId: 'coordinator',
  executionRequestsStream: 'stream:execution-requests',
  minProfitPercentage: -100,
  maxProfitPercentage: 10000,
  // P1-7 FIX: Retry and DLQ defaults
  maxRetries: 3,
  retryBaseDelayMs: 10,
  dlqStream: 'stream:forwarding-dlq',
};

/**
 * Opportunity Router
 *
 * Manages the lifecycle of arbitrage opportunities from detection to execution.
 */
export class OpportunityRouter {
  private readonly config: Required<OpportunityRouterConfig>;
  private readonly logger: OpportunityRouterLogger;
  private readonly streamsClient: OpportunityStreamsClient | null;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly onAlert?: (alert: OpportunityAlert) => void;

  private readonly opportunities: Map<string, ArbitrageOpportunity> = new Map();

  // Metrics counters (exposed for coordinator to track)
  private _totalOpportunities = 0;
  private _totalExecutions = 0;
  // P1-7 FIX: Track dropped opportunities for monitoring
  private _opportunitiesDropped = 0;

  constructor(
    logger: OpportunityRouterLogger,
    circuitBreaker: CircuitBreaker,
    streamsClient?: OpportunityStreamsClient | null,
    config?: OpportunityRouterConfig,
    onAlert?: (alert: OpportunityAlert) => void
  ) {
    this.logger = logger;
    this.circuitBreaker = circuitBreaker;
    this.streamsClient = streamsClient ?? null;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onAlert = onAlert;
  }

  /**
   * Get the opportunities map (for API endpoints)
   */
  getOpportunities(): Map<string, ArbitrageOpportunity> {
    return new Map(this.opportunities);
  }

  /**
   * Get pending opportunities count
   */
  getPendingCount(): number {
    return this.opportunities.size;
  }

  /**
   * Get total opportunities processed
   */
  getTotalOpportunities(): number {
    return this._totalOpportunities;
  }

  /**
   * Get total executions forwarded
   */
  getTotalExecutions(): number {
    return this._totalExecutions;
  }

  /**
   * P1-7 FIX: Get total opportunities dropped due to forwarding failures
   */
  getOpportunitiesDropped(): number {
    return this._opportunitiesDropped;
  }

  /**
   * Process an incoming opportunity.
   * Handles duplicate detection, validation, storage, and optional forwarding.
   *
   * @param data - Raw opportunity data from stream message
   * @param isLeader - Whether this instance should forward to execution
   * @returns true if opportunity was processed, false if rejected
   */
  async processOpportunity(
    data: Record<string, unknown>,
    isLeader: boolean
  ): Promise<boolean> {
    const id = data.id as string | undefined;
    if (!id || typeof id !== 'string') {
      this.logger.debug('Skipping opportunity - missing or invalid id');
      return false;
    }

    const timestamp = typeof data.timestamp === 'number' ? data.timestamp : Date.now();

    // Duplicate detection
    const existing = this.opportunities.get(id);
    if (existing && Math.abs((existing.timestamp ?? 0) - timestamp) < this.config.duplicateWindowMs) {
      this.logger.debug('Duplicate opportunity detected, skipping', {
        id,
        existingTimestamp: existing.timestamp,
        newTimestamp: timestamp,
      });
      return false;
    }

    // Input validation for profit percentage
    const profitPercentage = typeof data.profitPercentage === 'number' ? data.profitPercentage : undefined;
    if (profitPercentage !== undefined) {
      if (profitPercentage < this.config.minProfitPercentage || profitPercentage > this.config.maxProfitPercentage) {
        this.logger.warn('Invalid profit percentage, rejecting opportunity', {
          id,
          profitPercentage,
          reason: profitPercentage < this.config.minProfitPercentage ? 'below_minimum' : 'above_maximum',
        });
        return false;
      }
    }

    // Build opportunity object
    const opportunity: ArbitrageOpportunity = {
      id,
      confidence: typeof data.confidence === 'number' ? data.confidence : 0,
      timestamp,
      chain: typeof data.chain === 'string' ? data.chain : undefined,
      buyDex: typeof data.buyDex === 'string' ? data.buyDex : undefined,
      sellDex: typeof data.sellDex === 'string' ? data.sellDex : undefined,
      profitPercentage,
      expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : undefined,
      status: typeof data.status === 'string' ? data.status as ArbitrageOpportunity['status'] : undefined,
    };

    // Store opportunity
    this.opportunities.set(id, opportunity);
    this._totalOpportunities++;

    this.logger.info('Opportunity detected', {
      id,
      chain: opportunity.chain,
      profitPercentage: opportunity.profitPercentage,
      buyDex: opportunity.buyDex,
      sellDex: opportunity.sellDex,
    });

    // Forward to execution engine if leader and pending
    if (isLeader && (opportunity.status === 'pending' || opportunity.status === undefined)) {
      await this.forwardToExecutionEngine(opportunity);
    }

    return true;
  }

  /**
   * Forward an opportunity to the execution engine via Redis Streams.
   *
   * P1-7 FIX: Now includes retry logic with exponential backoff and DLQ support.
   * Retries up to maxRetries times before moving to dead letter queue.
   *
   * Only the leader coordinator should call this method to prevent
   * duplicate execution attempts.
   */
  async forwardToExecutionEngine(opportunity: ArbitrageOpportunity): Promise<void> {
    if (!this.streamsClient) {
      this.logger.warn('Cannot forward opportunity - streams client not initialized', {
        id: opportunity.id,
      });
      return;
    }

    // Check circuit breaker before attempting to forward
    if (this.circuitBreaker.isCurrentlyOpen()) {
      this.logger.debug('Execution circuit open, skipping opportunity forwarding', {
        id: opportunity.id,
        failures: this.circuitBreaker.getFailures(),
      });
      // P1-7 FIX: Track as dropped when circuit is open
      this._opportunitiesDropped++;
      return;
    }

    const messageData = {
      id: opportunity.id,
      type: opportunity.type || 'simple',
      chain: opportunity.chain || 'unknown',
      buyDex: opportunity.buyDex || '',
      sellDex: opportunity.sellDex || '',
      profitPercentage: opportunity.profitPercentage?.toString() || '0',
      confidence: opportunity.confidence?.toString() || '0',
      timestamp: opportunity.timestamp?.toString() || Date.now().toString(),
      expiresAt: opportunity.expiresAt?.toString() || '',
      tokenIn: opportunity.tokenIn || '',
      tokenOut: opportunity.tokenOut || '',
      amountIn: opportunity.amountIn || '',
      forwardedBy: this.config.instanceId,
      forwardedAt: Date.now().toString(),
    };

    // P1-7 FIX: Retry loop with exponential backoff
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        await this.streamsClient.xadd(this.config.executionRequestsStream, messageData);

        // Success - record and return
        const justRecovered = this.circuitBreaker.recordSuccess();
        if (justRecovered) {
          this.logger.info('Execution circuit breaker closed - recovered');
        }

        this.logger.info('Forwarded opportunity to execution engine', {
          id: opportunity.id,
          chain: opportunity.chain,
          profitPercentage: opportunity.profitPercentage,
          attempt: attempt + 1,
        });

        this._totalExecutions++;
        return; // Success, exit the method

      } catch (error) {
        lastError = error as Error;

        // Record failure for circuit breaker
        const justOpened = this.circuitBreaker.recordFailure();

        if (justOpened) {
          const status = this.circuitBreaker.getStatus();
          this.logger.warn('Execution circuit breaker opened', {
            failures: status.failures,
            resetTimeoutMs: status.resetTimeoutMs,
          });

          this.onAlert?.({
            type: 'EXECUTION_CIRCUIT_OPEN',
            message: `Execution forwarding circuit breaker opened after ${status.failures} failures`,
            severity: 'high',
            data: { failures: status.failures },
            timestamp: Date.now(),
          });
          // Don't retry if circuit breaker just opened
          break;
        }

        // Don't retry if circuit breaker is already open
        if (this.circuitBreaker.isCurrentlyOpen()) {
          break;
        }

        // Log retry attempt
        if (attempt < this.config.maxRetries - 1) {
          const delay = this.config.retryBaseDelayMs * Math.pow(2, attempt);
          this.logger.debug('Retrying opportunity forwarding', {
            id: opportunity.id,
            attempt: attempt + 1,
            maxRetries: this.config.maxRetries,
            nextDelayMs: delay,
            error: lastError.message,
          });
          // Exponential backoff: 10ms, 20ms, 40ms...
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // P1-7 FIX: All retries exhausted - permanent failure
    this._opportunitiesDropped++;
    const status = this.circuitBreaker.getStatus();

    this.logger.error('Failed to forward opportunity after all retries', {
      id: opportunity.id,
      error: lastError?.message,
      attempts: this.config.maxRetries,
      circuitFailures: status.failures,
      totalDropped: this._opportunitiesDropped,
    });

    // Move to DLQ for later analysis/manual intervention
    await this.moveToDeadLetterQueue(opportunity, lastError);

    // Send alert for permanent forwarding failures (only if circuit not already open)
    if (!status.isOpen) {
      this.onAlert?.({
        type: 'EXECUTION_FORWARD_FAILED',
        message: `Failed to forward opportunity ${opportunity.id} after ${this.config.maxRetries} retries: ${lastError?.message}`,
        severity: 'high',
        data: {
          opportunityId: opportunity.id,
          chain: opportunity.chain,
          attempts: this.config.maxRetries,
          totalDropped: this._opportunitiesDropped,
        },
        timestamp: Date.now(),
      });
    }
  }

  /**
   * P1-7 FIX: Move failed opportunity to dead letter queue for later analysis.
   *
   * DLQ entries include original opportunity data plus error context,
   * allowing for debugging and potential manual replay if needed.
   */
  private async moveToDeadLetterQueue(
    opportunity: ArbitrageOpportunity,
    error: Error | null
  ): Promise<void> {
    if (!this.streamsClient) {
      return;
    }

    try {
      await this.streamsClient.xadd(this.config.dlqStream, {
        opportunityId: opportunity.id,
        originalData: JSON.stringify(opportunity),
        error: error?.message || 'Unknown error',
        errorStack: error?.stack?.substring(0, 500),
        failedAt: Date.now().toString(),
        service: 'opportunity-router',
        instanceId: this.config.instanceId,
        targetStream: this.config.executionRequestsStream,
      });

      this.logger.debug('Opportunity moved to DLQ', {
        opportunityId: opportunity.id,
        dlqStream: this.config.dlqStream,
      });
    } catch (dlqError) {
      // If DLQ write fails, log but don't throw - the opportunity is already lost
      this.logger.error('Failed to move opportunity to DLQ', {
        opportunityId: opportunity.id,
        dlqError: (dlqError as Error).message,
        originalError: error?.message,
      });
    }
  }

  /**
   * Clean up expired opportunities.
   *
   * This should be called on a separate interval (e.g., every 10s) to prevent
   * race conditions with concurrent message handlers.
   *
   * @returns Number of opportunities removed
   */
  cleanupExpiredOpportunities(): number {
    const now = Date.now();
    const toDelete: string[] = [];
    const initialSize = this.opportunities.size;

    // Phase 1: Identify expired opportunities
    for (const [id, opp] of this.opportunities) {
      // Delete if explicitly expired
      if (opp.expiresAt && opp.expiresAt < now) {
        toDelete.push(id);
        continue;
      }
      // Delete if older than TTL (for opportunities without expiresAt)
      if (opp.timestamp && (now - opp.timestamp) > this.config.opportunityTtlMs) {
        toDelete.push(id);
      }
    }

    // Phase 2: Delete expired entries
    for (const id of toDelete) {
      this.opportunities.delete(id);
    }

    // Phase 3: Enforce size limit by removing oldest entries
    // Uses findKSmallest for O(n log k) with bounded memory
    if (this.opportunities.size > this.config.maxOpportunities) {
      const removeCount = this.opportunities.size - this.config.maxOpportunities;

      // Find the k oldest opportunities efficiently
      // Only keeps removeCount items in memory instead of all opportunities
      const oldestK = findKSmallest(
        this.opportunities.entries(),
        removeCount,
        ([, a], [, b]) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
      );

      // Delete the oldest entries
      for (const [id] of oldestK) {
        this.opportunities.delete(id);
      }
    }

    // Log if cleanup occurred
    const removed = initialSize - this.opportunities.size;
    if (removed > 0) {
      this.logger.debug('Opportunity cleanup completed', {
        removed,
        remaining: this.opportunities.size,
        expiredCount: toDelete.length,
      });
    }

    return removed;
  }

  /**
   * Reset all state (for testing)
   */
  reset(): void {
    this.opportunities.clear();
    this._totalOpportunities = 0;
    this._totalExecutions = 0;
    this._opportunitiesDropped = 0;
  }
}
