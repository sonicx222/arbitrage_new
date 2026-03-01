/**
 * Opportunity Publisher (Shared Core)
 *
 * Publishes detected arbitrage opportunities to Redis Streams for consumption
 * by the Coordinator and Execution Engine.
 *
 * F4 FIX: Moved from services/unified-detector/src/publishers/ to shared/core
 * so that partition services running via `npm run dev:all` can also publish
 * opportunities. Previously, only the Docker entry point (unified-detector/index.ts)
 * had OpportunityPublisher wiring, leaving dev-mode partitions with a publishing gap.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 */

import { RedisStreamsClient } from '../redis';
import { createTraceContext, propagateContext } from '../tracing';
import type { TraceContext } from '../tracing';
import { FEATURE_FLAGS, FAST_LANE_CONFIG } from '@arbitrage/config';
import type { ArbitrageOpportunity, ILogger } from '@arbitrage/types';

// =============================================================================
// Types
// =============================================================================

export interface OpportunityPublisherConfig {
  /** Logger for output */
  logger: ILogger;

  /** Redis Streams client for publishing */
  streamsClient: RedisStreamsClient;

  /** Optional: partition ID for logging context */
  partitionId?: string;

  /** Optional: prefix for _source metadata (default: 'unified-detector') */
  sourcePrefix?: string;
}

export interface OpportunityPublisherStats {
  /** Total opportunities published successfully */
  published: number;

  /** Total publish failures */
  failed: number;

  /** Timestamp of last successful publish */
  lastPublishedAt: number | null;

  /** Total opportunities published to fast lane */
  fastLanePublished: number;

  /** FIX M10: Total fast lane publish failures (fire-and-forget, non-fatal) */
  fastLaneFailed: number;
}

// =============================================================================
// Opportunity Publisher
// =============================================================================

export class OpportunityPublisher {
  private readonly logger: ILogger;
  private readonly streamsClient: RedisStreamsClient;
  private readonly partitionId: string;
  private readonly sourcePrefix: string;

  private stats: OpportunityPublisherStats = {
    published: 0,
    failed: 0,
    lastPublishedAt: null,
    fastLanePublished: 0,
    fastLaneFailed: 0,
  };

  constructor(config: OpportunityPublisherConfig) {
    this.logger = config.logger;
    this.streamsClient = config.streamsClient;
    this.partitionId = config.partitionId || 'unknown';
    this.sourcePrefix = config.sourcePrefix ?? 'unified-detector';
  }

  // ===========================================================================
  // Publishing Methods
  // ===========================================================================

  /**
   * Publish an arbitrage opportunity to Redis Streams.
   *
   * @param opportunity - The arbitrage opportunity to publish
   * @param parentTraceContext - Optional parent trace context for end-to-end correlation
   *   (P2 Fix ES-007: propagates detector's trace context instead of creating a new one)
   * @returns true if published successfully, false otherwise
   */
  async publish(opportunity: ArbitrageOpportunity, parentTraceContext?: TraceContext): Promise<boolean> {
    const sourceName = `${this.sourcePrefix}-${this.partitionId}`;
    // P2 Fix ES-007: Use parent context if provided for end-to-end tracing
    const traceCtx = parentTraceContext ?? createTraceContext(sourceName);
    const enrichedOpportunity = propagateContext({
      ...opportunity,
      _source: sourceName,
      _publishedAt: Date.now(),
    }, traceCtx);

    // Bounded retry: 3 attempts with exponential backoff (50, 100, 200ms)
    const maxAttempts = 3;
    const baseDelayMs = 50;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.streamsClient.xaddWithLimit(
          RedisStreamsClient.STREAMS.OPPORTUNITIES,
          enrichedOpportunity
        );

        this.stats.published++;
        this.stats.lastPublishedAt = Date.now();

        this.logger.debug('Opportunity published to stream', {
          opportunityId: opportunity.id,
          type: opportunity.type,
          profit: opportunity.expectedProfit || opportunity.estimatedProfit,
          profitPct: opportunity.profitPercentage,
          ...(attempt > 1 ? { retriedAttempt: attempt } : {}),
        });

        this.tryPublishToFastLane(opportunity, enrichedOpportunity);

        return true;
      } catch (error) {
        if (attempt < maxAttempts) {
          const delayMs = baseDelayMs * (1 << (attempt - 1));
          this.logger.warn('Opportunity publish failed, retrying', {
            opportunityId: opportunity.id,
            attempt,
            maxAttempts,
            retryInMs: delayMs,
            error: (error as Error).message,
          });
          await new Promise<void>(resolve => setTimeout(resolve, delayMs));
        } else {
          this.stats.failed++;
          this.logger.error('Failed to publish opportunity after all retries', {
            opportunityId: opportunity.id,
            attempts: maxAttempts,
            error: (error as Error).message,
          });

          this.writeToDlq(opportunity, (error as Error).message);

          return false;
        }
      }
    }

    return false;
  }

  // ===========================================================================
  // Stats & Lifecycle
  // ===========================================================================

  getStats(): OpportunityPublisherStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      published: 0,
      failed: 0,
      lastPublishedAt: null,
      fastLanePublished: 0,
      fastLaneFailed: 0,
    };
  }

  // ===========================================================================
  // Dead Letter Queue
  // ===========================================================================

  private writeToDlq(opportunity: ArbitrageOpportunity, lastError: string): void {
    this.streamsClient
      .xaddWithLimit(RedisStreamsClient.STREAMS.DEAD_LETTER_QUEUE, {
        originalStream: RedisStreamsClient.STREAMS.OPPORTUNITIES,
        reason: 'publish_exhausted_retries',
        opportunityId: opportunity.id,
        type: opportunity.type,
        chain: opportunity.chain ?? '',
        profitPercentage: String(opportunity.profitPercentage ?? 0),
        lastError,
        partition: this.partitionId,
        timestamp: String(Date.now()),
      })
      .then(() => {
        this.logger.info('Failed opportunity written to DLQ', {
          opportunityId: opportunity.id,
        });
      })
      .catch((dlqError) => {
        this.logger.warn('DLQ write also failed (Redis degraded)', {
          opportunityId: opportunity.id,
          error: (dlqError as Error).message,
        });
      });
  }

  // ===========================================================================
  // Fast Lane Publishing
  // ===========================================================================

  private tryPublishToFastLane(
    opportunity: ArbitrageOpportunity,
    enrichedData: Record<string, unknown>
  ): void {
    if (!FEATURE_FLAGS.useFastLane) return;

    const confidence = opportunity.confidence ?? 0;
    const profit = opportunity.expectedProfit ?? opportunity.estimatedProfit ?? 0;

    if (confidence < FAST_LANE_CONFIG.minConfidence) return;
    if (profit < FAST_LANE_CONFIG.minProfitUsd) return;

    this.streamsClient
      .xaddWithLimit(RedisStreamsClient.STREAMS.FAST_LANE, enrichedData)
      .then(() => {
        this.stats.fastLanePublished++;
        this.logger.debug('Opportunity published to fast lane', {
          opportunityId: opportunity.id,
          confidence,
          profit,
        });
      })
      .catch((error) => {
        this.stats.fastLaneFailed++;
        this.logger.warn('Failed to publish to fast lane (non-fatal)', {
          opportunityId: opportunity.id,
          error: (error as Error).message,
        });
      });
  }
}
