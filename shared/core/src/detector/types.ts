/**
 * Detector Module Types
 * Extracted from base-detector.ts for single-responsibility principle.
 *
 * This module contains type definitions for:
 * - Detector connection initialization (Phase 1)
 * - Pair initialization service (Phase 1.5)
 *
 * NOT part of hot-path operations.
 *
 * @see ADR-002: Redis Streams Architecture
 * @see MIGRATION_PLAN.md
 */

import type { RedisClient } from '../redis';
import type { RedisStreamsClient, StreamBatcher } from '../redis-streams';
import type { SwapEventFilter } from '../analytics/swap-event-filter';
import type { ServiceLogger } from '../logging';
import type { PairDiscoveryService } from '../pair-discovery';
import type { PairCacheService } from '../caching/pair-cache';
import type { Dex, Token, Pair } from '@arbitrage/types';

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

// =============================================================================
// Pair Initialization Service Types (Phase 1.5)
// =============================================================================

/**
 * Configuration for pair initialization.
 */
export interface PairInitializationConfig {
  /** Chain identifier */
  chain: string;
  /** Logger instance for operation logging */
  logger: ServiceLogger;
  /** Array of DEXs to discover pairs on */
  dexes: Dex[];
  /** Array of tokens to create pairs from */
  tokens: Token[];
  /** Pair discovery service instance (optional) */
  pairDiscoveryService?: PairDiscoveryService | null;
  /** Pair cache service instance (optional) */
  pairCacheService?: PairCacheService | null;
}

/**
 * Result of a successful pair discovery.
 * Contains all the data needed to register a pair in the detector.
 */
export interface DiscoveredPairResult {
  /** The full pair key (e.g., "uniswap_v2_WETH/USDC") */
  pairKey: string;
  /** The pair data */
  pair: Pair;
  /** Source DEX name */
  dex: string;
}

/**
 * Result of the pair initialization process.
 */
export interface PairInitializationResult {
  /** Array of discovered pairs */
  pairs: DiscoveredPairResult[];
  /** Number of pairs discovered */
  pairsDiscovered: number;
  /** Number of pairs that failed to be discovered */
  pairsFailed: number;
  /** Initialization duration in milliseconds */
  durationMs: number;
}

/**
 * Interface for pair address resolution.
 * Abstracts the cache-first lookup strategy.
 */
export interface PairAddressResolver {
  /**
   * Resolve a pair address using cache-first strategy.
   * @param dex - The DEX to look up the pair on
   * @param token0 - First token
   * @param token1 - Second token
   * @returns The pair address or null if not found
   */
  resolve(dex: Dex, token0: Token, token1: Token): Promise<string | null>;
}
