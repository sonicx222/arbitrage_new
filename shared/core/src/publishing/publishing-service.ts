/**
 * Publishing Service
 *
 * Centralized service for publishing messages to Redis Streams.
 * Extracts common publishing logic from BaseDetector to reduce duplication.
 *
 * Features:
 * - Generic publish helper with type safety
 * - Batched publishing for high-volume messages
 * - Direct publishing for high-priority messages
 * - Retry logic with exponential backoff
 * - Deduplication support for arbitrage opportunities
 *
 * @see base-detector.ts - Original publish methods
 * @see ADR-002 - Redis Streams architecture
 */

import {
  RedisStreams,
  type PriceUpdate,
  type ArbitrageOpportunity,
  type SwapEvent,
  type MessageEvent,
} from '@arbitrage/types';
import { RedisStreamsClient, type StreamBatcher } from '../redis/streams';
import type { RedisClient } from '../redis/client';
import type { ServiceLogger } from '../logging/types';
import type { SwapEventFilter, WhaleAlert, VolumeAggregate } from '../analytics/swap-event-filter';
// R7 Consolidation: Use shared retry utility
import { retryWithLogging } from '../resilience/retry-mechanism';
// P-NEW-1: LatencyTracker integration for pipeline latency recording
import { getLatencyTracker } from '../monitoring/latency-tracker';
// W2-23 FIX: Trace context injection for cross-service correlation
import { createTraceContext, propagateContext } from '../tracing/trace-context';
// P2-13: Schema version for forward-compatible message evolution
import { SYSTEM_CONSTANTS } from '@arbitrage/config';

// =============================================================================
// Types
// =============================================================================

/**
 * Message types supported by the publishing service.
 */
export type PublishableMessageType =
  | 'price-update'
  | 'swap-event'
  | 'arbitrage-opportunity'
  | 'whale-transaction'
  | 'whale-alert'
  | 'volume-aggregate';

/**
 * Configuration for a publishing batcher.
 * Named differently from redis-streams BatcherConfig to avoid conflicts.
 */
export interface PublishingBatcherConfig {
  /** Stream name to publish to */
  stream: string;
  /** Maximum messages per batch */
  maxBatchSize: number;
  /** Maximum wait time before flushing (ms) */
  maxWaitMs: number;
  /** Human-readable name for logging */
  name: string;
}

/**
 * Parse an environment variable as a positive integer, returning the fallback if
 * unset, empty, or not a valid positive number.
 */
function parseEnvPositiveInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined || val === '') return fallback;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Standard batcher configurations for different message types.
 *
 * Fix #21: maxWaitMs is now env-configurable per message type to allow
 * operators to tune the latency-vs-batching tradeoff without code changes.
 * Set PRICE_BATCHER_MAX_WAIT_MS, SWAP_BATCHER_MAX_WAIT_MS, or
 * WHALE_BATCHER_MAX_WAIT_MS to override the defaults.
 * @see docs/reports/PHASE1_DEEP_ANALYSIS_2026-02-22.md Finding #21
 */
export const STANDARD_BATCHER_CONFIGS: Record<string, PublishingBatcherConfig> = {
  priceUpdates: {
    stream: RedisStreams.PRICE_UPDATES,
    maxBatchSize: 50,
    maxWaitMs: parseEnvPositiveInt('PRICE_BATCHER_MAX_WAIT_MS', 5),
    name: 'priceUpdateBatcher',
  },
  swapEvents: {
    stream: RedisStreams.SWAP_EVENTS,
    maxBatchSize: 100,
    maxWaitMs: parseEnvPositiveInt('SWAP_BATCHER_MAX_WAIT_MS', 500),
    name: 'swapEventBatcher',
  },
  whaleAlerts: {
    stream: RedisStreams.WHALE_ALERTS,
    maxBatchSize: 10,
    maxWaitMs: parseEnvPositiveInt('WHALE_BATCHER_MAX_WAIT_MS', 50),
    name: 'whaleAlertBatcher',
  },
};

/**
 * Dependencies for PublishingService.
 */
export interface PublishingServiceDeps {
  /** Redis Streams client for direct publishing */
  streamsClient: RedisStreamsClient;
  /** Redis client for deduplication */
  redis?: RedisClient;
  /** Logger instance */
  logger: ServiceLogger;
  /** Source identifier (e.g., 'bsc-detector') */
  source: string;
  /** Optional swap event filter for filtering swap events */
  swapEventFilter?: SwapEventFilter;
}

/**
 * Batchers managed by the publishing service.
 */
export interface PublishingBatchers {
  priceUpdate: StreamBatcher<MessageEvent> | null;
  swapEvent: StreamBatcher<MessageEvent> | null;
  whaleAlert: StreamBatcher<MessageEvent> | null;
}

// =============================================================================
// Publishing Service
// =============================================================================

/**
 * Centralized service for publishing messages to Redis Streams.
 *
 * Provides:
 * - Batched publishing for high-volume, lower-priority messages
 * - Direct publishing for high-priority messages (arbitrage opportunities)
 * - Retry logic with exponential backoff
 * - Redis-based deduplication for arbitrage opportunities
 */
export class PublishingService {
  private readonly streamsClient: RedisStreamsClient;
  private readonly redis?: RedisClient;
  private readonly logger: ServiceLogger;
  private readonly source: string;
  private readonly swapEventFilter?: SwapEventFilter;

  private batchers: PublishingBatchers = {
    priceUpdate: null,
    swapEvent: null,
    whaleAlert: null,
  };

  constructor(deps: PublishingServiceDeps) {
    this.streamsClient = deps.streamsClient;
    this.redis = deps.redis;
    this.logger = deps.logger;
    this.source = deps.source;
    this.swapEventFilter = deps.swapEventFilter;
  }

  // ===========================================================================
  // Initialization
  // ===========================================================================

  /**
   * Initialize all batchers with standard configurations.
   */
  initializeBatchers(configs?: Partial<Record<keyof PublishingBatchers, PublishingBatcherConfig>>): void {
    const effectiveConfigs = {
      priceUpdate: configs?.priceUpdate ?? STANDARD_BATCHER_CONFIGS.priceUpdates,
      swapEvent: configs?.swapEvent ?? STANDARD_BATCHER_CONFIGS.swapEvents,
      whaleAlert: configs?.whaleAlert ?? STANDARD_BATCHER_CONFIGS.whaleAlerts,
    };

    this.batchers.priceUpdate = this.streamsClient.createBatcher(
      effectiveConfigs.priceUpdate.stream,
      {
        maxBatchSize: effectiveConfigs.priceUpdate.maxBatchSize,
        maxWaitMs: effectiveConfigs.priceUpdate.maxWaitMs,
      }
    );

    this.batchers.swapEvent = this.streamsClient.createBatcher(
      effectiveConfigs.swapEvent.stream,
      {
        maxBatchSize: effectiveConfigs.swapEvent.maxBatchSize,
        maxWaitMs: effectiveConfigs.swapEvent.maxWaitMs,
      }
    );

    this.batchers.whaleAlert = this.streamsClient.createBatcher(
      effectiveConfigs.whaleAlert.stream,
      {
        maxBatchSize: effectiveConfigs.whaleAlert.maxBatchSize,
        maxWaitMs: effectiveConfigs.whaleAlert.maxWaitMs,
      }
    );

    this.logger.info('Publishing service batchers initialized', {
      priceUpdates: { maxBatch: effectiveConfigs.priceUpdate.maxBatchSize, maxWaitMs: effectiveConfigs.priceUpdate.maxWaitMs },
      swapEvents: { maxBatch: effectiveConfigs.swapEvent.maxBatchSize, maxWaitMs: effectiveConfigs.swapEvent.maxWaitMs },
      whaleAlerts: { maxBatch: effectiveConfigs.whaleAlert.maxBatchSize, maxWaitMs: effectiveConfigs.whaleAlert.maxWaitMs },
    });
  }

  // ===========================================================================
  // Core Publishing Methods
  // ===========================================================================

  /**
   * Publish a price update using batched delivery.
   */
  async publishPriceUpdate(update: PriceUpdate): Promise<void> {
    this.assertBatcherInitialized('priceUpdate', 'Price update');
    const message = this.createMessage('price-update', update);
    this.batchers.priceUpdate!.add(message);
  }

  /**
   * Publish a swap event using batched delivery.
   * Applies swap event filter if configured.
   */
  async publishSwapEvent(swapEvent: SwapEvent): Promise<void> {
    // Apply Smart Swap Event Filter if configured
    if (this.swapEventFilter) {
      const filterResult = this.swapEventFilter.processEvent(swapEvent);
      if (!filterResult.passed) {
        this.logger.debug('Swap event filtered', {
          reason: filterResult.filterReason,
          txHash: swapEvent.transactionHash,
        });
        return;
      }
    }

    this.assertBatcherInitialized('swapEvent', 'Swap event');
    const message = this.createMessage('swap-event', swapEvent);
    this.batchers.swapEvent!.add(message);
  }

  /**
   * Publish an arbitrage opportunity directly (no batching).
   * Includes Redis-based deduplication for multi-instance deployments.
   */
  async publishArbitrageOpportunity(opportunity: ArbitrageOpportunity): Promise<void> {
    // Redis-based deduplication for multi-instance deployments.
    // P1-10: TTL must exceed XCLAIM minIdleMs (default 10 minutes = 600s) so that
    // PEL-recovered messages after restart still hit the dedup guard. With the old
    // 30s TTL, messages idle in PEL for 30-600s would pass dedup and re-execute.
    // @see docs/reports/EXTENDED_DEEP_ANALYSIS_2026-02-23.md P1-10
    const dedupKey = `opp:dedup:${opportunity.id}`;
    const DEDUP_TTL_SECONDS = 900; // 15 minutes — safely exceeds XCLAIM 10-min default

    if (this.redis) {
      try {
        const isFirstPublisher = await this.redis.setNx(dedupKey, '1', DEDUP_TTL_SECONDS);
        if (!isFirstPublisher) {
          this.logger.debug('Duplicate opportunity filtered', { id: opportunity.id });
          return;
        }
      } catch (error) {
        // If Redis fails, log warning but still publish
        this.logger.warn('Redis dedup check failed, publishing anyway', {
          id: opportunity.id,
          error: (error as Error).message,
        });
      }
    }

    // Phase 0 instrumentation: stamp detectedAt before publishing
    const timestamps = opportunity.pipelineTimestamps ?? {};
    timestamps.detectedAt = Date.now();
    opportunity.pipelineTimestamps = timestamps;

    const message = this.createMessage('arbitrage-opportunity', opportunity);

    // W2-23 FIX: Inject trace context for cross-service correlation.
    // The execution engine extracts _trace_* fields from the message
    // for end-to-end tracing from detection through execution.
    const traceCtx = createTraceContext(this.source);
    const tracedMessage = propagateContext(
      message as unknown as Record<string, unknown>,
      traceCtx,
    );

    // P-NEW-1: Record pipeline latency from timestamps (O(1), zero-allocation)
    if (opportunity.pipelineTimestamps) {
      getLatencyTracker().recordFromTimestamps(opportunity.pipelineTimestamps);
    }

    // Arbitrage opportunities are high-priority - publish directly (no batching)
    // @see OP-6: Use xaddWithLimit to prevent unbounded stream growth
    await this.streamsClient.xaddWithLimit(
      RedisStreamsClient.STREAMS.OPPORTUNITIES,
      tracedMessage,
    );
  }

  /**
   * Publish a whale transaction using batched delivery.
   */
  async publishWhaleTransaction(whaleTransaction: unknown): Promise<void> {
    this.assertBatcherInitialized('whaleAlert', 'Whale transaction');
    const message = this.createMessage('whale-transaction', whaleTransaction);
    this.batchers.whaleAlert!.add(message);
  }

  /**
   * Publish a whale alert using batched delivery.
   */
  async publishWhaleAlert(alert: WhaleAlert): Promise<void> {
    this.assertBatcherInitialized('whaleAlert', 'Whale alert');
    const message = this.createMessage('whale-alert', alert);
    this.batchers.whaleAlert!.add(message);
  }

  /**
   * Publish a volume aggregate directly (no batching).
   */
  async publishVolumeAggregate(aggregate: VolumeAggregate): Promise<void> {
    const message = this.createMessage('volume-aggregate', aggregate);
    // @see OP-6: Use xaddWithLimit to prevent unbounded stream growth
    await this.streamsClient.xaddWithLimit(
      RedisStreamsClient.STREAMS.VOLUME_AGGREGATES,
      message
    );
  }

  // ===========================================================================
  // Retry Support
  // ===========================================================================

  /**
   * Publish with retry and exponential backoff.
   * Use for critical messages that must not be lost.
   *
   * R7 Consolidation: Now delegates to shared retryWithLogging utility.
   */
  async publishWithRetry(
    publishFn: () => Promise<void>,
    operationName: string,
    maxRetries = 3
  ): Promise<void> {
    // R7 Consolidation: Delegate to shared utility
    await retryWithLogging(publishFn, operationName, this.logger, { maxRetries });
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Clean up all batchers (flush remaining messages and destroy).
   */
  async cleanup(): Promise<void> {
    const batcherEntries = [
      { name: 'priceUpdate', batcher: this.batchers.priceUpdate },
      { name: 'swapEvent', batcher: this.batchers.swapEvent },
      { name: 'whaleAlert', batcher: this.batchers.whaleAlert },
    ];

    const cleanupPromises = batcherEntries
      .filter(({ batcher }) => batcher !== null)
      .map(async ({ name, batcher }) => {
        try {
          await batcher!.destroy();
          this.logger.debug(`${name} batcher destroyed`);
        } catch (error) {
          this.logger.warn(`Failed to destroy ${name} batcher`, {
            error: (error as Error).message,
          });
        }
      });

    await Promise.allSettled(cleanupPromises);

    this.batchers = {
      priceUpdate: null,
      swapEvent: null,
      whaleAlert: null,
    };

    this.logger.info('Publishing service cleanup complete');
  }

  // ===========================================================================
  // Getters
  // ===========================================================================

  /**
   * Get batcher stats for monitoring.
   */
  getBatcherStats(): Record<string, unknown> {
    return {
      priceUpdate: this.batchers.priceUpdate?.getStats() ?? null,
      swapEvent: this.batchers.swapEvent?.getStats() ?? null,
      whaleAlert: this.batchers.whaleAlert?.getStats() ?? null,
    };
  }

  /**
   * Check if batchers are initialized.
   */
  areBatchersInitialized(): boolean {
    return (
      this.batchers.priceUpdate !== null &&
      this.batchers.swapEvent !== null &&
      this.batchers.whaleAlert !== null
    );
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Create a standard message envelope.
   */
  private createMessage(type: PublishableMessageType, data: unknown): MessageEvent {
    return {
      type,
      data,
      timestamp: Date.now(),
      source: this.source,
      // P2-13: Include schema version for forward-compatible message evolution.
      // Consumers can gracefully handle envelope changes by checking this field.
      schemaVersion: SYSTEM_CONSTANTS.stream.schemaVersion,
    };
  }

  /**
   * Assert that a batcher is initialized.
   */
  private assertBatcherInitialized(
    batcherKey: keyof PublishingBatchers,
    operationName: string
  ): void {
    if (!this.batchers[batcherKey]) {
      throw new Error(
        `${operationName} batcher not initialized - call initializeBatchers() first (ADR-002)`
      );
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new PublishingService instance.
 */
export function createPublishingService(deps: PublishingServiceDeps): PublishingService {
  return new PublishingService(deps);
}
