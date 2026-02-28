/**
 * Opportunity Publisher
 *
 * Publishes detected arbitrage opportunities to Redis Streams for consumption
 * by the Coordinator and Execution Engine.
 *
 * This publisher bridges the gap between the UnifiedChainDetector (which emits
 * opportunity events) and the downstream services that execute trades.
 *
 * Features:
 * - Publishes opportunities to stream:opportunities
 * - Uses StreamMessage envelope format for consistency
 * - Handles publish failures gracefully
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see implementation_plan.md: Fix Missing Opportunity Publisher
 */

import { RedisStreamsClient } from '@arbitrage/core/redis';
import { createTraceContext, propagateContext } from '@arbitrage/core/tracing';
import { FEATURE_FLAGS, FAST_LANE_CONFIG } from '@arbitrage/config';
import { ArbitrageOpportunity } from '@arbitrage/types';
import type { Logger } from '../types';

// =============================================================================
// Types
// =============================================================================

export interface OpportunityPublisherConfig {
  /** Logger for output */
  logger: Logger;

  /** Redis Streams client for publishing */
  streamsClient: RedisStreamsClient;

  /** Optional: partition ID for logging context */
  partitionId?: string;
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
  private readonly logger: Logger;
  private readonly streamsClient: RedisStreamsClient;
  private readonly partitionId: string;

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
  }

  // ===========================================================================
  // Publishing Methods
  // ===========================================================================

  /**
   * Publish an arbitrage opportunity to Redis Streams.
   *
   * The opportunity is published to stream:opportunities where it will be
   * consumed by the Coordinator service, which forwards qualifying opportunities
   * to the Execution Engine.
   *
   * Serialization: The ArbitrageOpportunity is published as a flat JSON object
   * with all fields at the top level (no wrapper envelope). This is required
   * because redis-streams.ts parseStreamResult() does `data.data ?? data`
   * unwrapping — nested wrappers would lose metadata.
   *
   * Source metadata (OpenTelemetry-compatible trace context):
   *   - `_source`: Identifies the producing partition (e.g., "unified-detector-asia-fast")
   *   - `_publishedAt`: Timestamp when the opportunity was published (ms since epoch)
   * These fields enable end-to-end tracing through the pipeline when correlated
   * with the Coordinator's `coordinatorAt` and Execution Engine's timestamps.
   *
   * @param opportunity - The arbitrage opportunity to publish
   * @returns true if published successfully, false otherwise
   * @see ADR-002: Redis Streams serialization
   */
  async publish(opportunity: ArbitrageOpportunity): Promise<boolean> {
    // FIX P1: Publish opportunity directly without wrapper envelope
    // The coordinator expects fields (id, timestamp, profitPercentage, etc.) at top level
    // Previous wrapper format (id, type, data, metadata) caused metadata to be lost
    // when redis-streams.ts parseStreamResult() does `data.data ?? data` unwrapping
    //
    // Add source metadata directly to opportunity for traceability
    const sourceName = `unified-detector-${this.partitionId}`;
    const traceCtx = createTraceContext(sourceName);
    const enrichedOpportunity = propagateContext({
      ...opportunity,
      // Add source metadata inline (not nested) for traceability
      _source: sourceName,
      _publishedAt: Date.now(),
    }, traceCtx);

    // FIX W2-6: Bounded retry on transient Redis failures
    // 3 attempts with 50ms exponential backoff (50, 100, 200ms)
    // Prevents permanent loss of detected opportunities during Redis blips
    const maxAttempts = 3;
    const baseDelayMs = 50;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Use xaddWithLimit to prevent unbounded stream growth
        // STREAM_MAX_LENGTHS[OPPORTUNITIES] = 10000 per redis-streams.ts
        await this.streamsClient.xaddWithLimit(
          RedisStreamsClient.STREAMS.OPPORTUNITIES,
          enrichedOpportunity
        );

        // Update stats
        this.stats.published++;
        this.stats.lastPublishedAt = Date.now();

        this.logger.debug('Opportunity published to stream', {
          opportunityId: opportunity.id,
          type: opportunity.type,
          profit: opportunity.expectedProfit || opportunity.estimatedProfit,
          profitPct: opportunity.profitPercentage,
          ...(attempt > 1 ? { retriedAttempt: attempt } : {}),
        });

        // Fast lane: publish high-confidence, high-profit opportunities
        // to stream:fast-lane for coordinator bypass (fire-and-forget)
        this.tryPublishToFastLane(opportunity, enrichedOpportunity);

        return true;
      } catch (error) {
        if (attempt < maxAttempts) {
          // Transient failure — retry after exponential backoff
          const delayMs = baseDelayMs * (1 << (attempt - 1)); // 50, 100, 200ms
          this.logger.warn('Opportunity publish failed, retrying', {
            opportunityId: opportunity.id,
            attempt,
            maxAttempts,
            retryInMs: delayMs,
            error: (error as Error).message,
          });
          await new Promise<void>(resolve => setTimeout(resolve, delayMs));
        } else {
          // Exhausted all attempts — permanent failure
          this.stats.failed++;
          this.logger.error('Failed to publish opportunity after all retries', {
            opportunityId: opportunity.id,
            attempts: maxAttempts,
            error: (error as Error).message,
          });

          // FIX H2: Write to DLQ so failed opportunities can be replayed/audited.
          // Fire-and-forget since Redis may be degraded — best-effort DLQ write.
          this.writeToDlq(opportunity, (error as Error).message);

          return false;
        }
      }
    }

    // Unreachable, but satisfies TypeScript
    return false;
  }

  // ===========================================================================
  // Stats & Lifecycle
  // ===========================================================================

  /**
   * Get publisher statistics.
   */
  getStats(): OpportunityPublisherStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics (useful for testing).
   */
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
  // Dead Letter Queue (FIX H2)
  // ===========================================================================

  /**
   * Write a permanently failed opportunity to the DLQ stream for replay/audit.
   * Fire-and-forget — if DLQ write fails, we log but don't retry (Redis is likely degraded).
   */
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
  // Fast Lane Publishing (Item 12)
  // ===========================================================================

  /**
   * Publish to fast lane if opportunity meets confidence and profit criteria.
   * Fire-and-forget: failures are logged but don't affect normal path.
   */
  private tryPublishToFastLane(
    opportunity: ArbitrageOpportunity,
    enrichedData: Record<string, unknown>
  ): void {
    if (!FEATURE_FLAGS.useFastLane) return;

    const confidence = opportunity.confidence ?? 0;
    const profit = opportunity.expectedProfit ?? opportunity.estimatedProfit ?? 0;

    if (confidence < FAST_LANE_CONFIG.minConfidence) return;
    if (profit < FAST_LANE_CONFIG.minProfitUsd) return;

    // Fire-and-forget publish to fast lane stream
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
        // FIX M10: Track fast lane failures for monitoring
        this.stats.fastLaneFailed++;
        this.logger.warn('Failed to publish to fast lane (non-fatal)', {
          opportunityId: opportunity.id,
          error: (error as Error).message,
        });
      });
  }
}
