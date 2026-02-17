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
import { RedisStreamsClient, type StreamBatcher } from '../redis-streams';
import type { RedisClient } from '../redis';
import type { ServiceLogger } from '../logging/types';
import type { SwapEventFilter, WhaleAlert, VolumeAggregate } from '../analytics/swap-event-filter';
// R7 Consolidation: Use shared retry utility
import { retryWithLogging } from '../resilience/retry-mechanism';

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
 * Standard batcher configurations for different message types.
 */
export const STANDARD_BATCHER_CONFIGS: Record<string, PublishingBatcherConfig> = {
  priceUpdates: {
    stream: RedisStreams.PRICE_UPDATES,
    maxBatchSize: 50,
    maxWaitMs: 100, // Flush every 100ms for latency-sensitive price data
    name: 'priceUpdateBatcher',
  },
  swapEvents: {
    stream: RedisStreams.SWAP_EVENTS,
    maxBatchSize: 100,
    maxWaitMs: 500, // Less time-sensitive
    name: 'swapEventBatcher',
  },
  whaleAlerts: {
    stream: RedisStreams.WHALE_ALERTS,
    maxBatchSize: 10,
    maxWaitMs: 50, // Whale alerts are time-sensitive
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
    // Redis-based deduplication for multi-instance deployments
    const dedupKey = `opp:dedup:${opportunity.id}`;
    const DEDUP_TTL_SECONDS = 30;

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

    // Arbitrage opportunities are high-priority - publish directly (no batching)
    await this.streamsClient.xadd(
      RedisStreamsClient.STREAMS.OPPORTUNITIES,
      message
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
    await this.streamsClient.xadd(
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

  /**
   * Sleep helper for retry backoff.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
