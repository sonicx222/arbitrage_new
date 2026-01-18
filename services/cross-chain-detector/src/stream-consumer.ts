/**
 * StreamConsumer - Redis Streams Consumption Module
 *
 * ARCH-REFACTOR: Extracted from CrossChainDetectorService to provide a single
 * responsibility module for Redis Streams consumption.
 *
 * Responsibilities:
 * - Consuming price update streams
 * - Consuming whale alert streams
 * - Consumer group management
 * - Message validation and acknowledgment
 *
 * Design Principles:
 * - Factory function for dependency injection
 * - EventEmitter for loose coupling with consumers
 * - Concurrency guard to prevent overlapping stream reads
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-014: Modular Detector Components
 */

import { EventEmitter } from 'events';
import {
  RedisStreamsClient,
  ConsumerGroupConfig,
  ServiceStateManager,
} from '@arbitrage/core';
import { PriceUpdate, WhaleTransaction } from '@arbitrage/types';

// =============================================================================
// Types
// =============================================================================

/** Logger interface for dependency injection */
export interface Logger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

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
  error: (error: Error) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_PRICE_UPDATES_BATCH_SIZE = 50;
const DEFAULT_WHALE_ALERTS_BATCH_SIZE = 10;

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
    if (typeof update.price !== 'number' || isNaN(update.price) || update.price < 0) {
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
      const messages = await streamsClient.xreadgroup(config, {
        count: priceUpdatesBatchSize,
        block: 0,
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
      const messages = await streamsClient.xreadgroup(config, {
        count: whaleAlertsBatchSize,
        block: 0,
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
   * Poll streams for new messages.
   */
  async function poll(): Promise<void> {
    // Concurrency guard: skip if already consuming
    if (isConsuming || !stateManager.isRunning()) return;

    isConsuming = true;
    try {
      await Promise.all([
        consumePriceUpdates(),
        consumeWhaleAlerts(),
      ]);
    } catch (error) {
      logger.error('Stream consumer poll error', { error: (error as Error).message });
      emitter.emit('error', error as Error);
    } finally {
      isConsuming = false;
    }
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Start consuming streams.
   */
  function start(): void {
    logger.info('Starting StreamConsumer', {
      instanceId,
      pollIntervalMs,
    });

    pollInterval = setInterval(poll, pollIntervalMs);

    logger.info('StreamConsumer started');
  }

  /**
   * Stop consuming streams.
   */
  function stop(): void {
    logger.info('Stopping StreamConsumer');

    if (pollInterval) {
      clearInterval(pollInterval);
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
