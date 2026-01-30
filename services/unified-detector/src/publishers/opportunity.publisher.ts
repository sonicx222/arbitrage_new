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

import { RedisStreamsClient } from '@arbitrage/core';
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
   * @param opportunity - The arbitrage opportunity to publish
   * @returns true if published successfully, false otherwise
   */
  async publish(opportunity: ArbitrageOpportunity): Promise<boolean> {
    try {
      // FIX P1: Publish opportunity directly without wrapper envelope
      // The coordinator expects fields (id, timestamp, profitPercentage, etc.) at top level
      // Previous wrapper format (id, type, data, metadata) caused metadata to be lost
      // when redis-streams.ts parseStreamResult() does `data.data ?? data` unwrapping
      //
      // Add source metadata directly to opportunity for traceability
      const enrichedOpportunity = {
        ...opportunity,
        // Add source metadata inline (not nested) for traceability
        _source: `unified-detector-${this.partitionId}`,
        _publishedAt: Date.now(),
      };

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
      });

      return true;
    } catch (error) {
      this.stats.failed++;

      this.logger.error('Failed to publish opportunity to stream', {
        opportunityId: opportunity.id,
        error: (error as Error).message,
      });

      return false;
    }
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
    };
  }
}
