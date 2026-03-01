/**
 * StreamConsumer - Redis Streams Consumption Module
 *
 * ARCH-REFACTOR: Extracted from CrossChainDetectorService to provide a single
 * responsibility module for Redis Streams consumption.
 *
 * Responsibilities:
 * - Consuming price update streams
 * - Consuming whale alert streams
 * - Consuming pending opportunity streams (mempool)
 * - Consumer group management
 * - Message validation and acknowledgment
 *
 * Design Principles:
 * - Factory function for dependency injection
 * - EventEmitter for loose coupling with consumers
 * - Concurrency guard to prevent overlapping stream reads
 *
 * FIX 1.2: Architecture Decision - Custom StreamConsumer vs Core StreamConsumer:
 * -------------------------------------------------------------------------------
 * This module uses a CUSTOM StreamConsumer instead of @arbitrage/core's StreamConsumer.
 * Reasons:
 * 1. **Multi-stream consumption**: Core StreamConsumer consumes from ONE stream.
 *    This module consumes from THREE streams (price-updates, whale-alerts, pending).
 * 2. **Message validation**: This module has domain-specific validation for each
 *    message type (PriceUpdate, WhaleTransaction, PendingOpportunity).
 * 3. **Event emission**: Uses EventEmitter to decouple consumers from producers,
 *    whereas core StreamConsumer uses handler callbacks.
 * 4. **Parallel consumption**: Consumes all three streams in parallel within each
 *    poll cycle for lower latency.
 *
 * The core StreamConsumer (redis-streams.ts) is better suited for single-stream
 * consumption with backpressure support (pause/resume), which isn't needed here.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-014: Modular Detector Components
 * @see @arbitrage/core StreamConsumer - Alternative single-stream consumer
 */

import { EventEmitter } from 'events';
import { RedisStreamsClient, ConsumerGroupConfig, unwrapBatchMessages } from '@arbitrage/core/redis';
import { ServiceStateManager } from '@arbitrage/core/service-lifecycle';
import { PriceUpdate, WhaleTransaction, PendingOpportunity } from '@arbitrage/types';
// TYPE-CONSOLIDATION: Import shared Logger type instead of duplicating
import { Logger } from './types';

// =============================================================================
// Types
// =============================================================================

// Logger is now imported from ./types for consistency across modules
export type { Logger };

/** Configuration for StreamConsumer */
export interface StreamConsumerConfig {
  /** Instance ID for consumer identification */
  instanceId: string;

  /** Redis Streams client */
  streamsClient: RedisStreamsClient;

  /** State manager to check running state */
  stateManager: ServiceStateManager;

  /** Logger for output */
  logger: Logger;

  /** Consumer groups to manage */
  consumerGroups: ConsumerGroupConfig[];

  /** Polling interval in ms (default: 100) */
  pollIntervalMs?: number;

  /** Price updates batch size (default: 50) */
  priceUpdatesBatchSize?: number;

  /** Whale alerts batch size (default: 10) */
  whaleAlertsBatchSize?: number;

  /** Pending opportunities batch size (default: 20) */
  pendingOpportunityBatchSize?: number;

  /** FIX 3.2: Block timeout for XREADGROUP in ms (default: 1000) */
  blockTimeoutMs?: number;

  /** P2-11 FIX: Minimum valid price for manipulation detection (default: 1e-12) */
  minValidPrice?: number;

  /** P2-11 FIX: Maximum valid price for manipulation detection (default: 1e12) */
  maxValidPrice?: number;
}

/** Public interface for StreamConsumer */
export interface StreamConsumer extends EventEmitter {
  /** Create consumer groups */
  createConsumerGroups(): Promise<void>;

  /** Start consuming streams */
  start(): void;

  /** Stop consuming streams */
  stop(): void;
}

/** Events emitted by StreamConsumer */
export interface StreamConsumerEvents {
  priceUpdate: (update: PriceUpdate) => void;
  whaleTransaction: (tx: WhaleTransaction) => void;
  pendingOpportunity: (opp: PendingOpportunity) => void;
  error: (error: Error) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_PRICE_UPDATES_BATCH_SIZE = 50;
const DEFAULT_WHALE_ALERTS_BATCH_SIZE = 10;
const DEFAULT_PENDING_OPPORTUNITY_BATCH_SIZE = 20;
// FIX: Use 1 second block timeout instead of infinite (0)
// ADR-002 specifies 1000ms for low latency without hanging
const DEFAULT_BLOCK_TIMEOUT_MS = 1000;
// P2-11 FIX: Configurable price bounds for manipulation detection
const DEFAULT_MIN_VALID_PRICE = 1e-12;
const DEFAULT_MAX_VALID_PRICE = 1e12;

// =============================================================================
// Diagnostic Functions
// =============================================================================

/**
 * Diagnose why a price update message failed validation.
 *
 * Returns a human-readable reason string identifying which specific field
 * failed validation, or null if the update is valid. This enables field-level
 * logging when price updates are rejected, replacing the opaque
 * "Skipping invalid price update message" log.
 *
 * @param update - The raw message data to diagnose
 * @param minPrice - Minimum valid price bound (default: 1e-12)
 * @param maxPrice - Maximum valid price bound (default: 1e12)
 * @returns Reason string or null if valid
 */
export function getPriceUpdateRejectionReason(
  update: unknown,
  minPrice: number = DEFAULT_MIN_VALID_PRICE,
  maxPrice: number = DEFAULT_MAX_VALID_PRICE,
): string | null {
  if (!update || typeof update !== 'object') {
    return 'missing_or_invalid_chain';
  }

  const u = update as Record<string, unknown>;

  if (typeof u.chain !== 'string' || !u.chain) {
    return 'missing_or_invalid_chain';
  }
  if (typeof u.dex !== 'string' || !u.dex) {
    return 'missing_or_invalid_dex';
  }
  if (typeof u.pairKey !== 'string' || !u.pairKey) {
    return 'missing_or_invalid_pairKey';
  }
  if (typeof u.price !== 'number' || isNaN(u.price) || u.price <= 0) {
    return 'invalid_price';
  }
  if (u.price < minPrice || u.price > maxPrice) {
    return 'price_out_of_bounds';
  }
  if (typeof u.timestamp !== 'number' || u.timestamp <= 0) {
    return 'invalid_timestamp';
  }

  return null;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a StreamConsumer instance.
 *
 * @param config - Consumer configuration
 * @returns StreamConsumer instance
 */
export function createStreamConsumer(config: StreamConsumerConfig): StreamConsumer {
  const {
    instanceId,
    streamsClient,
    stateManager,
    logger,
    consumerGroups,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    priceUpdatesBatchSize = DEFAULT_PRICE_UPDATES_BATCH_SIZE,
    whaleAlertsBatchSize = DEFAULT_WHALE_ALERTS_BATCH_SIZE,
    pendingOpportunityBatchSize = DEFAULT_PENDING_OPPORTUNITY_BATCH_SIZE,
    blockTimeoutMs = DEFAULT_BLOCK_TIMEOUT_MS, // FIX 3.2: Configurable block timeout
    minValidPrice = DEFAULT_MIN_VALID_PRICE, // P2-11 FIX: Configurable price bounds
    maxValidPrice = DEFAULT_MAX_VALID_PRICE,
  } = config;

  const emitter = new EventEmitter() as StreamConsumer;
  let pollInterval: NodeJS.Timeout | null = null;
  let isConsuming = false; // Concurrency guard

  // ADR-022: Pre-build Map for O(1) consumer group lookup in hot poll loop
  const consumerGroupMap = new Map<string, ConsumerGroupConfig>(
    consumerGroups.map(cg => [cg.streamName, cg])
  );

  // ===========================================================================
  // Validation
  // ===========================================================================

  /**
   * Validate PriceUpdate message has all required fields.
   */
  function validatePriceUpdate(update: PriceUpdate | null | undefined): update is PriceUpdate {
    if (!update || typeof update !== 'object') {
      return false;
    }

    if (typeof update.chain !== 'string' || !update.chain) {
      return false;
    }
    if (typeof update.dex !== 'string' || !update.dex) {
      return false;
    }
    if (typeof update.pairKey !== 'string' || !update.pairKey) {
      return false;
    }
    // B1-FIX: Use <= 0 to prevent division by zero in profit calculations
    if (typeof update.price !== 'number' || isNaN(update.price) || update.price <= 0) {
      return false;
    }

    // SECURITY-FIX: Reject extreme prices that indicate potential manipulation
    // P2-11 FIX: Bounds are now configurable via StreamConsumerConfig
    // Defaults: min=1e-12 (even low-cap tokens), max=1e12 (more than global GDP)
    if (update.price < minValidPrice || update.price > maxValidPrice) {
      return false;
    }

    if (typeof update.timestamp !== 'number' || update.timestamp <= 0) {
      return false;
    }

    return true;
  }

  /**
   * Validate WhaleTransaction message has all required fields.
   */
  function validateWhaleTransaction(tx: WhaleTransaction | null | undefined): tx is WhaleTransaction {
    if (!tx || typeof tx !== 'object') {
      return false;
    }

    if (typeof tx.chain !== 'string' || !tx.chain) {
      return false;
    }
    // FIX #9: Validate usdValue is finite and within reasonable bounds ($100B cap)
    if (typeof tx.usdValue !== 'number' || isNaN(tx.usdValue) || tx.usdValue < 0 ||
        !Number.isFinite(tx.usdValue) || tx.usdValue > 100_000_000_000) {
      return false;
    }
    if (typeof tx.direction !== 'string' || !['buy', 'sell'].includes(tx.direction)) {
      return false;
    }
    // FIX #9: Validate token (string, non-empty)
    if (typeof tx.token !== 'string' || !tx.token) {
      return false;
    }
    // FIX #9: Validate transactionHash (string, non-empty)
    if (typeof tx.transactionHash !== 'string' || !tx.transactionHash) {
      return false;
    }
    // FIX #9: Validate amount (number, positive, finite)
    if (typeof tx.amount !== 'number' || isNaN(tx.amount) || tx.amount <= 0 || !Number.isFinite(tx.amount)) {
      return false;
    }
    // FIX #9: Validate timestamp (number, positive)
    if (typeof tx.timestamp !== 'number' || isNaN(tx.timestamp) || tx.timestamp <= 0) {
      return false;
    }

    return true;
  }

  /**
   * Validate PendingOpportunity message has all required fields.
   * Task 1.3.3: Integration with Existing Detection
   */
  function validatePendingOpportunity(opp: PendingOpportunity | null | undefined): opp is PendingOpportunity {
    if (!opp || typeof opp !== 'object') {
      return false;
    }

    if (opp.type !== 'pending') {
      return false;
    }

    const intent = opp.intent;
    if (!intent || typeof intent !== 'object') {
      return false;
    }

    // Required string fields
    if (typeof intent.hash !== 'string' || !intent.hash) {
      return false;
    }
    if (typeof intent.router !== 'string' || !intent.router) {
      return false;
    }
    // FIX: Validate intent.type (SwapRouterType) — used by detector.ts for DEX matching
    if (typeof intent.type !== 'string' || !intent.type) {
      return false;
    }
    if (typeof intent.tokenIn !== 'string' || !intent.tokenIn) {
      return false;
    }
    if (typeof intent.tokenOut !== 'string' || !intent.tokenOut) {
      return false;
    }
    if (typeof intent.sender !== 'string' || !intent.sender) {
      return false;
    }

    // Required numeric fields
    if (typeof intent.chainId !== 'number' || intent.chainId <= 0) {
      return false;
    }
    if (typeof intent.deadline !== 'number' || intent.deadline <= 0) {
      return false;
    }
    if (typeof intent.nonce !== 'number' || intent.nonce < 0) {
      return false;
    }
    if (typeof intent.slippageTolerance !== 'number' || intent.slippageTolerance < 0 || intent.slippageTolerance > 0.5) {
      return false;
    }
    // FIX #6: Validate gasPrice to prevent BigInt(undefined) crash in detector.ts
    // gasPrice must be a numeric string suitable for BigInt conversion
    if (typeof intent.gasPrice !== 'string' || !intent.gasPrice || !/^\d+$/.test(intent.gasPrice)) {
      return false;
    }

    // FIX #7: Amount fields must be valid numeric strings for BigInt conversion
    if (typeof intent.amountIn !== 'string' || !intent.amountIn || !/^\d+$/.test(intent.amountIn)) {
      return false;
    }
    if (typeof intent.expectedAmountOut !== 'string' || !intent.expectedAmountOut || !/^\d+$/.test(intent.expectedAmountOut)) {
      return false;
    }

    // Path must be an array with at least 2 elements
    if (!Array.isArray(intent.path) || intent.path.length < 2) {
      return false;
    }

    return true;
  }

  // ===========================================================================
  // Consumer Group Management
  // ===========================================================================

  /**
   * Create consumer groups for all configured streams.
   */
  async function createConsumerGroupsFn(): Promise<void> {
    for (const groupConfig of consumerGroups) {
      try {
        await streamsClient.createConsumerGroup(groupConfig);
        logger.info('Consumer group ready', {
          stream: groupConfig.streamName,
          group: groupConfig.groupName,
        });
      } catch (error) {
        logger.error('Failed to create consumer group', {
          error: (error as Error).message,
          stream: groupConfig.streamName,
        });
      }
    }
  }

  // ===========================================================================
  // Stream Consumption
  // ===========================================================================

  /**
   * FIX #14: Generic stream consumption function.
   * Extracts the common pattern from consumePriceUpdates, consumeWhaleAlerts,
   * and consumePendingOpportunities to eliminate code duplication.
   *
   * @param streamName - Redis stream name to consume from
   * @param batchSize - Number of messages to read per batch
   * @param validator - Type guard function to validate messages
   * @param eventName - Event name to emit for valid messages
   * @param errorLabel - Label for error log messages
   * @param onValidated - Optional callback invoked after validation succeeds
   * @param diagnosticFn - Optional function to diagnose why validation failed
   */
  async function consumeStream<T>(
    streamName: string,
    batchSize: number,
    validator: (data: T | null | undefined) => data is T,
    eventName: string,
    errorLabel: string,
    onValidated?: (data: T) => void,
    diagnosticFn?: (data: unknown) => string | null
  ): Promise<void> {
    const config = consumerGroupMap.get(streamName);
    if (!config) return;

    try {
      const messages = await streamsClient.xreadgroup(config, {
        count: batchSize,
        block: blockTimeoutMs,
        startId: '>',
      });

      for (const message of messages) {
        // Unwrap batch envelopes from StreamBatcher (ADR-002 batching)
        // For non-batched messages, returns single-element array (backward compatible)
        const items = unwrapBatchMessages<T>(message.data);
        for (const data of items) {
          if (!validator(data)) {
            const reason = diagnosticFn ? diagnosticFn(data) : undefined;
            // P2 Fix LW-024: Include data sample in rejection log for diagnostics
            const dataSample = data && typeof data === 'object'
              ? { chain: (data as Record<string, unknown>).chain, dex: (data as Record<string, unknown>).dex, price: (data as Record<string, unknown>).price }
              : undefined;
            logger.warn(`Skipping invalid ${errorLabel} message`, {
              messageId: message.id,
              ...(reason ? { reason } : {}),
              ...(dataSample ? { dataSample } : {}),
            });
            continue;
          }
          if (onValidated) {
            onValidated(data);
          }
          emitter.emit(eventName, data);
        }
        // ACK per stream message (not per item) — one stream entry may contain a batch
        await streamsClient.xack(config.streamName, config.groupName, message.id);
      }
    } catch (error) {
      // P2-15 FIX: Check for timeout errors more robustly
      // Redis XREADGROUP with BLOCK returns timeout errors when no data arrives;
      // these are normal operation and should not be logged as errors.
      const err = error as Error & { code?: string };
      const isTimeout = err.code === 'TIMEOUT' ||
        err.code === 'ERR_TIMEOUT' ||
        err.message?.includes('timeout');
      if (!isTimeout) {
        logger.error(`Error consuming ${errorLabel} stream`, { error: err.message });
      }
    }
  }

  /**
   * Consume price updates from Redis Streams.
   * Phase 0 instrumentation: stamps consumedAt on validated price updates.
   */
  async function consumePriceUpdates(): Promise<void> {
    return consumeStream<PriceUpdate>(
      RedisStreamsClient.STREAMS.PRICE_UPDATES,
      priceUpdatesBatchSize,
      validatePriceUpdate,
      'priceUpdate',
      'price update',
      (update) => {
        // Phase 0 instrumentation: stamp consumed timestamp
        const timestamps = update.pipelineTimestamps ?? {};
        timestamps.consumedAt = Date.now();
        update.pipelineTimestamps = timestamps;
      },
      (data: unknown) => getPriceUpdateRejectionReason(data, minValidPrice, maxValidPrice)
    );
  }

  /**
   * Consume whale alerts from Redis Streams.
   */
  async function consumeWhaleAlerts(): Promise<void> {
    return consumeStream<WhaleTransaction>(
      RedisStreamsClient.STREAMS.WHALE_ALERTS,
      whaleAlertsBatchSize,
      validateWhaleTransaction,
      'whaleTransaction',
      'whale transaction'
    );
  }

  /**
   * Consume pending opportunities from Redis Streams.
   * Task 1.3.3: Integration with Existing Detection
   */
  async function consumePendingOpportunities(): Promise<void> {
    return consumeStream<PendingOpportunity>(
      RedisStreamsClient.STREAMS.PENDING_OPPORTUNITIES,
      pendingOpportunityBatchSize,
      validatePendingOpportunity,
      'pendingOpportunity',
      'pending opportunity'
    );
  }

  /**
   * Poll streams for new messages.
   * FIX 10.3: Now uses setTimeout recursion instead of setInterval
   * This ensures consistent delay between poll END and next poll START.
   */
  async function poll(): Promise<void> {
    // Check if we should continue polling
    if (!stateManager.isRunning() || pollInterval === null) return;

    // Concurrency guard: skip if already consuming
    if (isConsuming) return;

    isConsuming = true;
    try {
      // BUG-FIX: Use Promise.allSettled to ensure all streams are processed
      // even if one fails. Promise.all would reject immediately on first failure,
      // causing other streams to be skipped.
      const results = await Promise.allSettled([
        consumePriceUpdates(),
        consumeWhaleAlerts(),
        consumePendingOpportunities(),
      ]);

      // Log any failures but don't throw - allow other streams to continue
      const streamNames = ['priceUpdates', 'whaleAlerts', 'pendingOpportunities'];
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          logger.error(`Stream consumption failed: ${streamNames[index]}`, {
            error: (result.reason as Error).message,
          });
          emitter.emit('error', result.reason as Error);
        }
      });
    } catch (error) {
      // This catch handles unexpected errors in the allSettled processing itself
      logger.error('Stream consumer poll error', { error: (error as Error).message });
      emitter.emit('error', error as Error);
    } finally {
      isConsuming = false;
      // FIX 10.3: Schedule next poll AFTER current completes
      // This ensures pollIntervalMs delay between poll completion and next poll start
      if (stateManager.isRunning() && pollInterval !== null) {
        pollInterval = setTimeout(poll, pollIntervalMs);
      }
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start consuming streams.
   * FIX 10.3: Uses setTimeout recursion pattern for more predictable timing.
   */
  function start(): void {
    logger.info('Starting StreamConsumer', {
      instanceId,
      pollIntervalMs,
    });

    // FIX 10.3: Start with setTimeout, subsequent calls scheduled in poll()
    pollInterval = setTimeout(poll, pollIntervalMs);

    logger.info('StreamConsumer started');
  }

  /**
   * Stop consuming streams.
   */
  function stop(): void {
    logger.info('Stopping StreamConsumer');

    if (pollInterval) {
      clearTimeout(pollInterval);
      pollInterval = null;
    }

    // Reset concurrency guard
    isConsuming = false;

    logger.info('StreamConsumer stopped');
  }

  // ===========================================================================
  // Attach Methods to Emitter
  // ===========================================================================

  emitter.createConsumerGroups = createConsumerGroupsFn;
  emitter.start = start;
  emitter.stop = stop;

  return emitter;
}
