/**
 * Detector Connection Manager
 *
 * Manages Redis and Streams connections for detector services.
 * Extracted from base-detector.ts to reduce class size and improve testability.
 *
 * This module handles INITIALIZATION ONLY - not hot-path operations.
 * All connections are established once at startup.
 *
 * @see base-detector.ts - Original implementation
 * @see ADR-002 - Redis Streams Architecture
 */

import {
  RedisClient,
  getRedisClient,
} from '../redis';
import {
  RedisStreamsClient,
  getRedisStreamsClient,
} from '../redis-streams';
import {
  SwapEventFilter,
  WhaleAlert,
  VolumeAggregate,
} from '../analytics/swap-event-filter';
import type {
  DetectorConnectionConfig,
  DetectorConnectionResources,
  EventFilterHandlers,
} from './types';
import {
  DEFAULT_BATCHER_CONFIG,
  DEFAULT_SWAP_FILTER_CONFIG,
} from './types';

/**
 * Initialize all detector connections and batchers.
 *
 * This is a ONE-TIME initialization function called at detector startup.
 * NOT part of the hot path.
 *
 * @param config - Connection configuration
 * @param handlers - Event filter callback handlers
 * @returns Promise resolving to all connection resources
 * @throws Error if Redis Streams initialization fails (required per ADR-002)
 */
export async function initializeDetectorConnections(
  config: DetectorConnectionConfig,
  handlers: EventFilterHandlers
): Promise<DetectorConnectionResources> {
  const { chain, logger, batcherConfig = {}, swapFilterConfig = {} } = config;

  try {
    // Initialize Redis client for basic operations
    const redis = await getRedisClient() as RedisClient;
    logger.debug('Redis client initialized', { chain });

    // Initialize Redis Streams client (REQUIRED per ADR-002)
    const streamsClient = await getRedisStreamsClient();
    logger.debug('Redis Streams client initialized', { chain });

    // Merge configurations with defaults
    const priceConfig = { ...DEFAULT_BATCHER_CONFIG.priceUpdates, ...batcherConfig.priceUpdates };
    const swapConfig = { ...DEFAULT_BATCHER_CONFIG.swapEvents, ...batcherConfig.swapEvents };
    const whaleConfig = { ...DEFAULT_BATCHER_CONFIG.whaleAlerts, ...batcherConfig.whaleAlerts };

    // Create batchers for efficient command usage
    const priceUpdateBatcher = streamsClient.createBatcher(
      RedisStreamsClient.STREAMS.PRICE_UPDATES,
      priceConfig
    );

    const swapEventBatcher = streamsClient.createBatcher(
      RedisStreamsClient.STREAMS.SWAP_EVENTS,
      swapConfig
    );

    const whaleAlertBatcher = streamsClient.createBatcher(
      RedisStreamsClient.STREAMS.WHALE_ALERTS,
      whaleConfig
    );

    logger.info('Redis Streams batchers initialized', {
      chain,
      priceUpdates: priceConfig,
      swapEvents: swapConfig,
      whaleAlerts: whaleConfig,
    });

    // Initialize Smart Swap Event Filter (S1.2)
    const filterConfig = { ...DEFAULT_SWAP_FILTER_CONFIG, ...swapFilterConfig };
    const swapEventFilter = new SwapEventFilter(filterConfig);

    // Set up event handlers
    swapEventFilter.onWhaleAlert((alert: WhaleAlert) => {
      handlers.onWhaleAlert(alert);
    });

    swapEventFilter.onVolumeAggregate((aggregate: VolumeAggregate) => {
      handlers.onVolumeAggregate(aggregate);
    });

    logger.info('Smart Swap Event Filter initialized', {
      chain,
      minUsdValue: filterConfig.minUsdValue,
      whaleThreshold: filterConfig.whaleThreshold,
    });

    return {
      redis,
      streamsClient,
      priceUpdateBatcher,
      swapEventBatcher,
      whaleAlertBatcher,
      swapEventFilter,
    };
  } catch (error) {
    logger.error('Failed to initialize detector connections', { chain, error });
    throw new Error('Redis Streams initialization failed - Streams required per ADR-002');
  }
}

/**
 * Disconnect all detector connections gracefully.
 *
 * @param resources - Connection resources to disconnect
 * @param logger - Logger for operation logging
 */
export async function disconnectDetectorConnections(
  resources: Partial<DetectorConnectionResources>,
  logger: { info: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void }
): Promise<void> {
  const { redis, streamsClient, priceUpdateBatcher, swapEventBatcher, whaleAlertBatcher, swapEventFilter } = resources;

  // Flush any pending batched items
  const batchers = [
    { name: 'priceUpdate', batcher: priceUpdateBatcher },
    { name: 'swapEvent', batcher: swapEventBatcher },
    { name: 'whaleAlert', batcher: whaleAlertBatcher },
  ];

  // Use Promise.allSettled for parallel cleanup - one failure doesn't block others
  const flushPromises = batchers
    .filter(({ batcher }) => batcher !== null && batcher !== undefined)
    .map(async ({ name, batcher }) => {
      try {
        await batcher!.destroy();
        return { name, success: true };
      } catch (error) {
        return { name, success: false, error };
      }
    });

  const flushResults = await Promise.allSettled(flushPromises);

  // Log any flush failures
  flushResults.forEach((result, index) => {
    if (result.status === 'rejected' || (result.status === 'fulfilled' && !result.value.success)) {
      const batcherName = batchers.filter(b => b.batcher)[index]?.name || 'unknown';
      logger.error('Error flushing batcher during disconnect', {
        batcher: batcherName,
        error: result.status === 'rejected' ? result.reason : (result.value as { error?: unknown }).error,
      });
    }
  });

  // Cleanup swap event filter
  if (swapEventFilter) {
    try {
      swapEventFilter.destroy();
    } catch (error) {
      logger.error('Error destroying swap event filter', { error });
    }
  }

  // Disconnect streams client
  if (streamsClient) {
    try {
      await streamsClient.disconnect();
    } catch (error) {
      logger.error('Error disconnecting streams client', { error });
    }
  }

  // Disconnect Redis
  if (redis) {
    try {
      await redis.disconnect();
    } catch (error) {
      logger.error('Error disconnecting Redis', { error });
    }
  }

  logger.info('Detector connections disconnected');
}
