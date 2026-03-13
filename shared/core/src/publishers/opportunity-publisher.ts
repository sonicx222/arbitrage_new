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

import * as fsp from 'fs/promises';
import * as path from 'path';
import { RedisStreamsClient } from '../redis';
import { createTraceContext, TRACE_FIELDS } from '../tracing';
import type { TraceContext } from '../tracing';
import { getLatencyTracker } from '../monitoring/latency-tracker';
import { FEATURE_FLAGS, FAST_LANE_CONFIG, SYSTEM_CONSTANTS } from '@arbitrage/config';
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
  /** Maximum fallback file size per day (100MB) — matches DLQ fallback pattern */
  private static readonly MAX_FALLBACK_FILE_BYTES = 100 * 1024 * 1024;

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
    // FIX DI-08: Include schemaVersion for forward-compatible message evolution
    // OPT-006: Single Object.assign + inline trace fields instead of double-spread
    // (was: spread opportunity → propagateContext spreads again = 2 full copies)
    const enrichedOpportunity: Record<string, unknown> = Object.assign(
      {} as Record<string, unknown>, opportunity, {
        _source: sourceName,
        _publishedAt: Date.now(),
        schemaVersion: SYSTEM_CONSTANTS.stream.schemaVersion,
      }
    );
    enrichedOpportunity[TRACE_FIELDS.traceId] = traceCtx.traceId;
    enrichedOpportunity[TRACE_FIELDS.spanId] = traceCtx.spanId;
    enrichedOpportunity[TRACE_FIELDS.serviceName] = traceCtx.serviceName;
    enrichedOpportunity[TRACE_FIELDS.timestamp] = String(traceCtx.timestamp);
    if (traceCtx.parentSpanId) {
      enrichedOpportunity[TRACE_FIELDS.parentSpanId] = traceCtx.parentSpanId;
    }

    // Record pipeline latency (O(1), zero-allocation — same as PublishingService)
    if (opportunity.pipelineTimestamps) {
      getLatencyTracker().recordFromTimestamps(opportunity.pipelineTimestamps);
    }

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

  getStats(): Readonly<OpportunityPublisherStats> {
    // OPT-006: Return live reference instead of spread copy (callers are read-only consumers)
    return this.stats;
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
        // FIX F-04: When both primary and DLQ XADD fail (full Redis outage),
        // write to local JSONL file as last-resort fallback. Without this,
        // opportunities are permanently lost during Redis outages.
        this.logger.warn('DLQ write also failed, falling back to local JSONL', {
          opportunityId: opportunity.id,
          error: (dlqError as Error).message,
        });
        this.writeToLocalFallback(opportunity, lastError);
      });
  }

  /**
   * FIX F-04: Last-resort local JSONL file fallback when Redis is completely down.
   * Follows the same async-append pattern as TradeLogger (services/execution-engine).
   * File: ./data/lost-opportunities/lost-YYYY-MM-DD.jsonl
   */
  private writeToLocalFallback(opportunity: ArbitrageOpportunity, lastError: string): void {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const dir = process.env.LOST_OPPORTUNITY_DIR ?? './data/lost-opportunities';
    const filePath = path.join(dir, `lost-${dateStr}.jsonl`);

    const record = {
      opportunityId: opportunity.id,
      type: opportunity.type,
      chain: opportunity.chain,
      profitPercentage: opportunity.profitPercentage,
      expectedProfit: opportunity.expectedProfit,
      confidence: opportunity.confidence,
      lastError,
      partition: this.partitionId,
      timestamp: now.toISOString(),
    };

    const line = JSON.stringify(record) + '\n';

    // Fire-and-forget: mkdir + stat-check + append. If this also fails, log and move on —
    // we've exhausted all fallback paths.
    fsp.mkdir(dir, { recursive: true })
      .then(() => fsp.stat(filePath).catch(() => null))
      .then((fileStat) => {
        if (fileStat && fileStat.size >= OpportunityPublisher.MAX_FALLBACK_FILE_BYTES) {
          this.logger.warn('Lost opportunity fallback file size limit reached', {
            filePath,
            sizeBytes: fileStat.size,
            limitBytes: OpportunityPublisher.MAX_FALLBACK_FILE_BYTES,
            opportunityId: opportunity.id,
          });
          return;
        }
        return fsp.appendFile(filePath, line, 'utf8');
      })
      .then(() => {
        this.logger.info('Lost opportunity written to local JSONL fallback', {
          opportunityId: opportunity.id,
          filePath,
        });
      })
      .catch((fsError) => {
        this.logger.error('All fallback paths exhausted — opportunity permanently lost', {
          opportunityId: opportunity.id,
          error: (fsError as Error).message,
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
    const profitPct = opportunity.profitPercentage ?? 0;

    // OPT-005: Same-chain arbs have lower execution risk → reduced confidence threshold
    const isSameChain = opportunity.type !== 'cross-chain';
    const effectiveMinConfidence = isSameChain
      ? FAST_LANE_CONFIG.minConfidence - FAST_LANE_CONFIG.sameChainConfidenceDiscount
      : FAST_LANE_CONFIG.minConfidence;

    if (confidence < effectiveMinConfidence) return;

    // OPT-005: Qualify if absolute profit OR profit percentage meets threshold
    const meetsAbsoluteProfit = profit >= FAST_LANE_CONFIG.minProfitUsd;
    const meetsPercentageProfit = profitPct >= FAST_LANE_CONFIG.minProfitPercentage;
    if (!meetsAbsoluteProfit && !meetsPercentageProfit) return;

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
