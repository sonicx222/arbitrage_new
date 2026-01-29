/**
 * Detector Connection Manager Types
 * Extracted from base-detector.ts for single-responsibility principle.
 *
 * This module contains type definitions for detector connection initialization.
 * NOT part of hot-path operations.
 *
 * @see ADR-002: Redis Streams Architecture
 */

import type { RedisClient } from '../redis';
import type { RedisStreamsClient, StreamBatcher } from '../redis-streams';
import type { SwapEventFilter } from '../analytics/swap-event-filter';
import type { ServiceLogger } from '../logging';

/**
 * Configuration for detector connection initialization.
 */
export interface DetectorConnectionConfig {
  /** Chain identifier for logging context */
  chain: string;
  /** Logger instance for operation logging */
  logger: ServiceLogger;
  /** Batcher configuration overrides */
  batcherConfig?: {
    priceUpdates?: { maxBatchSize?: number; maxWaitMs?: number };
    swapEvents?: { maxBatchSize?: number; maxWaitMs?: number };
    whaleAlerts?: { maxBatchSize?: number; maxWaitMs?: number };
  };
  /** Swap event filter configuration */
  swapFilterConfig?: {
    minUsdValue?: number;
    whaleThreshold?: number;
    dedupWindowMs?: number;
    aggregationWindowMs?: number;
  };
}

/**
 * Resources created by connection initialization.
 * All resources are nullable to support graceful degradation.
 */
export interface DetectorConnectionResources {
  redis: RedisClient;
  streamsClient: RedisStreamsClient;
  priceUpdateBatcher: StreamBatcher<unknown>;
  swapEventBatcher: StreamBatcher<unknown>;
  whaleAlertBatcher: StreamBatcher<unknown>;
  swapEventFilter: SwapEventFilter;
}

/**
 * Callback types for event filter handlers.
 */
export interface EventFilterHandlers {
  onWhaleAlert: (alert: unknown) => void;
  onVolumeAggregate: (aggregate: unknown) => void;
}

/**
 * Default batcher configurations per ADR-002 efficiency targets (50:1 ratio).
 */
export const DEFAULT_BATCHER_CONFIG = {
  priceUpdates: { maxBatchSize: 50, maxWaitMs: 100 },
  swapEvents: { maxBatchSize: 100, maxWaitMs: 500 },
  whaleAlerts: { maxBatchSize: 10, maxWaitMs: 50 },
} as const;

/**
 * Default swap event filter configuration.
 */
export const DEFAULT_SWAP_FILTER_CONFIG = {
  minUsdValue: 10,
  whaleThreshold: 50000,
  dedupWindowMs: 5000,
  aggregationWindowMs: 5000,
} as const;
