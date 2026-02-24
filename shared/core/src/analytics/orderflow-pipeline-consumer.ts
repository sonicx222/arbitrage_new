/**
 * Orderflow Pipeline Consumer
 *
 * Subscribes to the stream:pending-opportunities Redis Stream, converts
 * pending swap intents to orderflow features, runs ML predictions via
 * OrderflowPredictor, and caches predictions for O(1) hot-path reads.
 *
 * Gated by FEATURE_ORDERFLOW_PIPELINE feature flag.
 *
 * @see shared/config/src/feature-flags.ts - FEATURE_ORDERFLOW_PIPELINE
 * @see shared/ml/src/orderflow-predictor.ts - OrderflowPredictor
 * @see shared/ml/src/orderflow-features.ts - OrderflowFeatureInput
 */

import { FEATURE_FLAGS, getChainName } from '@arbitrage/config';
import { createLogger } from '../logger';
import { RedisStreamsClient, getRedisStreamsClient } from '../redis-streams';
import { ReserveCache, getReserveCache } from '../caching/reserve-cache';
import type { Logger } from '../logger';
import type { StreamMessage, ConsumerGroupConfig } from '../redis-streams';
import type { PendingOpportunity, PendingSwapIntent } from '@arbitrage/types';

// ---------------------------------------------------------------------------
// Local type definitions (structurally compatible with @arbitrage/ml exports)
// to break circular @arbitrage/core ↔ @arbitrage/ml build dependency.
// @see shared/ml/src/orderflow-predictor.ts - OrderflowPrediction
// @see shared/ml/src/orderflow-features.ts - OrderflowFeatureInput
// ---------------------------------------------------------------------------

/** Prediction result from the orderflow model. */
interface OrderflowPrediction {
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  orderflowPressure: number;
  expectedVolatility: number;
  whaleImpact: number;
  timeHorizonMs: number;
  features: Record<string, number | boolean>;
  timestamp: number;
}

/** Input features for orderflow prediction. */
interface OrderflowFeatureInput {
  pairKey: string;
  chain: string;
  currentTimestamp: number;
  poolReserves: { reserve0: bigint; reserve1: bigint };
  recentSwaps: Array<{ direction: 'buy' | 'sell'; amountUsd: number; timestamp: number }>;
  liquidationData?: { nearestLiquidationLevel: number; openInterestChange24h: number };
}

/** Minimal predictor interface (structurally compatible with OrderflowPredictor). */
interface IOrderflowPredictor {
  predict(input: OrderflowFeatureInput): Promise<OrderflowPrediction>;
}

// =============================================================================
// Configuration
// =============================================================================

/** TTL for cached predictions in milliseconds (default: 30 seconds). */
const ORDERFLOW_PREDICTION_CACHE_TTL_MS = parseInt(
  process.env.ORDERFLOW_PREDICTION_CACHE_TTL_MS ?? '30000', 10
);

/** Maximum entries in prediction cache before eviction (default: 10000). */
const ORDERFLOW_PREDICTION_CACHE_MAX_SIZE = parseInt(
  process.env.ORDERFLOW_PREDICTION_CACHE_MAX_SIZE ?? '10000', 10
);

/** Stream poll interval in milliseconds (default: 100ms). */
const ORDERFLOW_POLL_INTERVAL_MS = parseInt(
  process.env.ORDERFLOW_POLL_INTERVAL_MS ?? '100', 10
);

/** Batch size for XREADGROUP COUNT (default: 50). */
const ORDERFLOW_BATCH_SIZE = parseInt(
  process.env.ORDERFLOW_BATCH_SIZE ?? '50', 10
);

/** Stream name for pending opportunities. */
const PENDING_OPPORTUNITIES_STREAM = 'stream:pending-opportunities';

/** Consumer group name. */
const CONSUMER_GROUP = 'orderflow-pipeline';

// =============================================================================
// Types
// =============================================================================

/** Cached prediction entry with TTL tracking. */
interface CachedPrediction {
  prediction: OrderflowPrediction;
  cachedAt: number;
}

/** Configuration for OrderflowPipelineConsumer. */
export interface OrderflowPipelineConsumerConfig {
  /** Instance ID for consumer naming (default: random). */
  instanceId?: string;
  /** Cache TTL in milliseconds (default: ORDERFLOW_PREDICTION_CACHE_TTL_MS). */
  cacheTtlMs?: number;
  /** Max cache size (default: ORDERFLOW_PREDICTION_CACHE_MAX_SIZE). */
  maxCacheSize?: number;
  /** Poll interval in milliseconds (default: ORDERFLOW_POLL_INTERVAL_MS). */
  pollIntervalMs?: number;
  /** Batch size for stream reads (default: ORDERFLOW_BATCH_SIZE). */
  batchSize?: number;
}

/** Dependencies for OrderflowPipelineConsumer (Constructor DI). */
export interface OrderflowPipelineConsumerDeps {
  logger?: Logger;
  redisStreamsClient?: RedisStreamsClient;
  predictor?: IOrderflowPredictor;
  reserveCache?: ReserveCache;
}

// =============================================================================
// OrderflowPipelineConsumer Class
// =============================================================================

/**
 * Consumes pending swap opportunities from Redis Streams, runs orderflow
 * ML predictions, and caches results for synchronous hot-path reads.
 *
 * Lifecycle:
 * 1. start() → checks feature flag, creates consumer group, begins polling
 * 2. processMessage() → converts PendingOpportunity → OrderflowFeatureInput → predict → cache
 * 3. getPrediction() → O(1) cache read with TTL check (used by hot path)
 * 4. stop() → cleans up timers and state
 */
export class OrderflowPipelineConsumer {
  private readonly logger: Logger;
  private readonly instanceId: string;
  private readonly cacheTtlMs: number;
  private readonly maxCacheSize: number;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;

  private redisClient: RedisStreamsClient | null;
  private predictor: IOrderflowPredictor | null;
  private reserveCache: ReserveCache | null;
  private predictionCache: Map<string, CachedPrediction> = new Map();
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private consumerGroupConfig: ConsumerGroupConfig;

  constructor(
    config: OrderflowPipelineConsumerConfig = {},
    deps: OrderflowPipelineConsumerDeps = {},
  ) {
    this.logger = deps.logger ?? createLogger('orderflow-pipeline-consumer');
    this.instanceId = config.instanceId ?? `consumer-${Math.random().toString(36).slice(2, 10)}`;
    this.cacheTtlMs = config.cacheTtlMs ?? ORDERFLOW_PREDICTION_CACHE_TTL_MS;
    this.maxCacheSize = config.maxCacheSize ?? ORDERFLOW_PREDICTION_CACHE_MAX_SIZE;
    this.pollIntervalMs = config.pollIntervalMs ?? ORDERFLOW_POLL_INTERVAL_MS;
    this.batchSize = config.batchSize ?? ORDERFLOW_BATCH_SIZE;

    this.redisClient = deps.redisStreamsClient ?? null;
    this.predictor = deps.predictor ?? null;
    this.reserveCache = deps.reserveCache ?? null;

    this.consumerGroupConfig = {
      streamName: PENDING_OPPORTUNITIES_STREAM,
      groupName: CONSUMER_GROUP,
      consumerName: this.instanceId,
    };

    this.logger.info('OrderflowPipelineConsumer initialized', {
      instanceId: this.instanceId,
      cacheTtlMs: this.cacheTtlMs,
      maxCacheSize: this.maxCacheSize,
      pollIntervalMs: this.pollIntervalMs,
    });
  }

  /**
   * Start the pipeline consumer.
   * If feature flag is disabled, logs info and returns immediately.
   */
  async start(): Promise<void> {
    if (!FEATURE_FLAGS.useOrderflowPipeline) {
      this.logger.info('Orderflow pipeline disabled (FEATURE_ORDERFLOW_PIPELINE != true)');
      return;
    }

    if (this.isRunning) {
      this.logger.warn('OrderflowPipelineConsumer already running');
      return;
    }

    // Lazily resolve predictor via dynamic import (avoids circular build dep).
    // The variable indirection prevents TypeScript from resolving the module at compile time.
    if (!this.predictor) {
      try {
        const mlModule = '@arbitrage/ml';
         
        const ml = await (import(mlModule) as Promise<{ getOrderflowPredictor: () => IOrderflowPredictor }>);
        this.predictor = ml.getOrderflowPredictor();
      } catch (error) {
        this.logger.error('Failed to load @arbitrage/ml, orderflow pipeline will not start', { error });
        return;
      }
    }

    // Lazily resolve Redis client if not injected
    if (!this.redisClient) {
      try {
        this.redisClient = await getRedisStreamsClient();
      } catch (error) {
        this.logger.error('Failed to get Redis Streams client, orderflow pipeline will not start', { error });
        return;
      }
    }

    // Create consumer group (idempotent)
    try {
      await this.redisClient.createConsumerGroup(this.consumerGroupConfig);
    } catch (error) {
      this.logger.error('Failed to create consumer group', { error });
      return;
    }

    this.isRunning = true;
    this.startPolling();

    this.logger.info('OrderflowPipelineConsumer started', {
      stream: PENDING_OPPORTUNITIES_STREAM,
      group: CONSUMER_GROUP,
      consumer: this.instanceId,
    });
  }

  /**
   * Stop the pipeline consumer and clean up resources.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.predictionCache.clear();

    this.logger.info('OrderflowPipelineConsumer stopped');
  }

  /**
   * Get a cached prediction for a pair key.
   * O(1) lookup with TTL check. Returns undefined if no fresh prediction exists.
   *
   * @param pairKey - Trading pair key (e.g., "0xToken1-0xToken2")
   * @returns Cached prediction or undefined
   */
  getPrediction(pairKey: string): OrderflowPrediction | undefined {
    const cached = this.predictionCache.get(pairKey);
    if (!cached) return undefined;

    // Check TTL
    if (Date.now() - cached.cachedAt > this.cacheTtlMs) {
      this.predictionCache.delete(pairKey);
      return undefined;
    }

    return cached.prediction;
  }

  /**
   * Get cache statistics.
   */
  getStats(): { cacheSize: number; isRunning: boolean } {
    return {
      cacheSize: this.predictionCache.size,
      isRunning: this.isRunning,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Start the polling loop for reading from Redis Streams.
   */
  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      if (!this.isRunning) {
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        return;
      }

      try {
        await this.pollMessages();
      } catch (error) {
        this.logger.error('Error polling pending opportunities', { error });
      }
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  /**
   * Poll for new messages from the stream and process them.
   */
  private async pollMessages(): Promise<void> {
    if (!this.redisClient) return;

    const messages: StreamMessage[] = await this.redisClient.xreadgroup(
      this.consumerGroupConfig,
      {
        count: this.batchSize,
        block: 0,
        maxBlockMs: this.pollIntervalMs,
      },
    );

    if (messages.length === 0) return;

    // FIX 10: Track successfully processed message IDs separately
    // so only successful messages are ACKed. Failed messages remain
    // in the pending entries list for reprocessing.
    const successfulIds: string[] = [];

    for (const message of messages) {
      try {
        await this.processMessage(message);
        successfulIds.push(message.id);
      } catch (error) {
        this.logger.warn('Failed to process pending opportunity message', {
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // ACK only successfully processed messages
    if (successfulIds.length > 0) {
      try {
        await this.redisClient.xack(
          this.consumerGroupConfig.streamName,
          this.consumerGroupConfig.groupName,
          ...successfulIds,
        );
      } catch (error) {
        this.logger.warn('Failed to ACK messages', { error });
      }
    }
  }

  /**
   * Process a single stream message: extract features, predict, cache.
   */
  private async processMessage(message: StreamMessage): Promise<void> {
    const data = message.data as Record<string, unknown>;

    // Parse the PendingOpportunity from stream message data
    const opportunity = this.parseOpportunity(data);
    if (!opportunity) return;

    const intent = opportunity.intent;
    const pairKey = `${intent.tokenIn}-${intent.tokenOut}`;

    // Convert to orderflow feature input
    const featureInput = this.convertToFeatureInput(intent, pairKey);

    // Run prediction (predictor is guaranteed non-null after start())
    const prediction = await this.predictor!.predict(featureInput);

    // Cache the prediction
    this.cachePrediction(pairKey, prediction);
  }

  /**
   * Parse a PendingOpportunity from raw stream message data.
   */
  private parseOpportunity(data: Record<string, unknown>): PendingOpportunity | null {
    try {
      // Stream messages may have a 'data' field containing JSON
      const raw = typeof data.data === 'string' ? JSON.parse(data.data) : data;

      if (raw.type !== 'pending' || !raw.intent) {
        return null;
      }

      return raw as PendingOpportunity;
    } catch {
      this.logger.debug('Failed to parse pending opportunity from stream message');
      return null;
    }
  }

  /**
   * Convert a PendingSwapIntent to OrderflowFeatureInput for the ML predictor.
   *
   * Attempts to populate poolReserves from ReserveCache for better prediction
   * quality. Falls back to zero reserves if cache is unavailable or has no data.
   */
  private convertToFeatureInput(intent: PendingSwapIntent, pairKey: string): OrderflowFeatureInput {
    // Try to get real reserves from cache
    let poolReserves = { reserve0: 0n, reserve1: 0n };
    const cache = this.reserveCache ?? this.tryGetReserveCache();
    if (cache) {
      const chainName = getChainName(intent.chainId);
      const cached = cache.get(chainName, pairKey);
      if (cached) {
        poolReserves = {
          reserve0: BigInt(cached.reserve0),
          reserve1: BigInt(cached.reserve1),
        };
      }
    }

    return {
      pairKey,
      chain: getChainName(intent.chainId),
      currentTimestamp: Date.now(),
      poolReserves,
      recentSwaps: [{
        direction: 'buy' as const, // Inferred from pending swap direction
        amountUsd: 0, // Would need price lookup for accurate USD value
        timestamp: intent.firstSeen,
      }],
    };
  }

  /**
   * Lazily resolve the ReserveCache singleton if not injected via DI.
   * Returns null if the singleton is not yet initialized.
   */
  private tryGetReserveCache(): ReserveCache | null {
    try {
      this.reserveCache = getReserveCache();
      return this.reserveCache;
    } catch {
      return null;
    }
  }

  /**
   * Cache a prediction with eviction if cache exceeds max size.
   */
  private cachePrediction(pairKey: string, prediction: OrderflowPrediction): void {
    // Evict oldest entries if at capacity
    if (this.predictionCache.size >= this.maxCacheSize) {
      this.evictOldestEntries(Math.max(1, Math.floor(this.maxCacheSize * 0.1)));
    }

    this.predictionCache.set(pairKey, {
      prediction,
      cachedAt: Date.now(),
    });
  }

  /**
   * Evict the oldest entries from prediction cache.
   */
  private evictOldestEntries(count: number): void {
    let removed = 0;
    for (const key of this.predictionCache.keys()) {
      if (removed >= count) break;
      this.predictionCache.delete(key);
      removed++;
    }
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let pipelineConsumerInstance: OrderflowPipelineConsumer | null = null;

/**
 * Get the singleton OrderflowPipelineConsumer instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @param deps - Optional dependencies (only used on first initialization)
 * @returns The singleton instance
 */
export function getOrderflowPipelineConsumer(
  config?: OrderflowPipelineConsumerConfig,
  deps?: OrderflowPipelineConsumerDeps,
): OrderflowPipelineConsumer {
  if (!pipelineConsumerInstance) {
    pipelineConsumerInstance = new OrderflowPipelineConsumer(config, deps);
  }
  return pipelineConsumerInstance;
}

/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export async function resetOrderflowPipelineConsumer(): Promise<void> {
  if (pipelineConsumerInstance) {
    await pipelineConsumerInstance.stop();
  }
  pipelineConsumerInstance = null;
}
