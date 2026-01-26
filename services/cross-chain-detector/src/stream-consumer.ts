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
import {
  RedisStreamsClient,
  ConsumerGroupConfig,
  ServiceStateManager,
} from '@arbitrage/core';
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
  } = config;

  const emitter = new EventEmitter() as StreamConsumer;
  let pollInterval: NodeJS.Timeout | null = null;
  let isConsuming = false; // Concurrency guard

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
    if (typeof tx.usdValue !== 'number' || isNaN(tx.usdValue) || tx.usdValue < 0) {
      return false;
    }
    if (typeof tx.direction !== 'string' || !['buy', 'sell'].includes(tx.direction)) {
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
    if (typeof intent.slippageTolerance !== 'number' || intent.slippageTolerance < 0) {
      return false;
    }

    // Amount fields (may be serialized as string from Redis)
    if (intent.amountIn === undefined || intent.amountIn === null) {
      return false;
    }
    if (intent.expectedAmountOut === undefined || intent.expectedAmountOut === null) {
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
   * Consume price updates from Redis Streams.
   */
  async function consumePriceUpdates(): Promise<void> {
    const config = consumerGroups.find(
      (c) => c.streamName === RedisStreamsClient.STREAMS.PRICE_UPDATES
    );
    if (!config) return;

    try {
      // FIX 3.2: Use configurable block timeout instead of hardcoded value
      const messages = await streamsClient.xreadgroup(config, {
        count: priceUpdatesBatchSize,
        block: blockTimeoutMs,
        startId: '>',
      });

      for (const message of messages) {
        const update = message.data as unknown as PriceUpdate;
        if (!validatePriceUpdate(update)) {
          logger.warn('Skipping invalid price update message', { messageId: message.id });
          await streamsClient.xack(config.streamName, config.groupName, message.id);
          continue;
        }
        emitter.emit('priceUpdate', update);
        await streamsClient.xack(config.streamName, config.groupName, message.id);
      }
    } catch (error) {
      if (!(error as Error).message?.includes('timeout')) {
        logger.error('Error consuming price updates stream', { error: (error as Error).message });
      }
    }
  }

  /**
   * Consume whale alerts from Redis Streams.
   */
  async function consumeWhaleAlerts(): Promise<void> {
    const config = consumerGroups.find(
      (c) => c.streamName === RedisStreamsClient.STREAMS.WHALE_ALERTS
    );
    if (!config) return;

    try {
      // FIX 3.2: Use configurable block timeout instead of hardcoded value
      const messages = await streamsClient.xreadgroup(config, {
        count: whaleAlertsBatchSize,
        block: blockTimeoutMs,
        startId: '>',
      });

      for (const message of messages) {
        const whaleTx = message.data as unknown as WhaleTransaction;
        if (!validateWhaleTransaction(whaleTx)) {
          logger.warn('Skipping invalid whale transaction message', { messageId: message.id });
          await streamsClient.xack(config.streamName, config.groupName, message.id);
          continue;
        }
        emitter.emit('whaleTransaction', whaleTx);
        await streamsClient.xack(config.streamName, config.groupName, message.id);
      }
    } catch (error) {
      if (!(error as Error).message?.includes('timeout')) {
        logger.error('Error consuming whale alerts stream', { error: (error as Error).message });
      }
    }
  }

  /**
   * Consume pending opportunities from Redis Streams.
   * Task 1.3.3: Integration with Existing Detection
   */
  async function consumePendingOpportunities(): Promise<void> {
    const config = consumerGroups.find(
      (c) => c.streamName === RedisStreamsClient.STREAMS.PENDING_OPPORTUNITIES
    );
    if (!config) return;

    try {
      const messages = await streamsClient.xreadgroup(config, {
        count: pendingOpportunityBatchSize,
        block: blockTimeoutMs,
        startId: '>',
      });

      for (const message of messages) {
        const pendingOpp = message.data as unknown as PendingOpportunity;
        if (!validatePendingOpportunity(pendingOpp)) {
          logger.warn('Skipping invalid pending opportunity message', { messageId: message.id });
          await streamsClient.xack(config.streamName, config.groupName, message.id);
          continue;
        }
        emitter.emit('pendingOpportunity', pendingOpp);
        await streamsClient.xack(config.streamName, config.groupName, message.id);
      }
    } catch (error) {
      if (!(error as Error).message?.includes('timeout')) {
        logger.error('Error consuming pending opportunities stream', { error: (error as Error).message });
      }
    }
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
      await Promise.all([
        consumePriceUpdates(),
        consumeWhaleAlerts(),
        consumePendingOpportunities(),
      ]);
    } catch (error) {
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
