/**
 * Solana Price Publisher
 *
 * ARCH-REFACTOR: Extracted from solana-detector.ts
 * Validates and publishes price updates to Redis Streams via batcher.
 * Converts Solana-specific format to standard PriceUpdate.
 *
 * @see ADR-014: Modular Detector Components
 */

import type { PriceUpdate, MessageEvent } from '../../../types';
import type {
  SolanaDetectorLogger,
  SolanaPriceUpdate,
  SolanaPriceUpdateBatcher,
} from './solana-types';

// =============================================================================
// Public Interface
// =============================================================================

export interface SolanaPricePublisher {
  publishPriceUpdate(update: SolanaPriceUpdate): Promise<void>;
  toStandardPriceUpdate(update: SolanaPriceUpdate): PriceUpdate;
  getPendingUpdates(): number;
  getBatcherStats(): { pending: number; flushed: number };
  /** Cleanup: destroy batcher. */
  cleanup(): Promise<void>;
}

export interface PricePublisherDeps {
  logger: SolanaDetectorLogger;
  /** Batcher for price updates. Pass null if not yet initialized. */
  batcher: SolanaPriceUpdateBatcher | null;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Solana price publisher instance.
 *
 * @param deps - Dependencies including the batcher
 * @returns SolanaPricePublisher
 */
export function createSolanaPricePublisher(deps: PricePublisherDeps): SolanaPricePublisher {
  const { logger } = deps;
  let batcher = deps.batcher;

  async function publishPriceUpdate(update: SolanaPriceUpdate): Promise<void> {
    if (!batcher) {
      throw new Error('Price update batcher not initialized');
    }

    if (!Number.isFinite(update.price) || update.price <= 0) {
      logger.warn('Invalid price update rejected', {
        poolAddress: update.poolAddress,
        price: update.price
      });
      return;
    }

    const standardUpdate = toStandardPriceUpdate(update);

    const message: MessageEvent = {
      type: 'price-update',
      data: standardUpdate,
      timestamp: Date.now(),
      source: 'solana-detector'
    };

    batcher.add(message as unknown as Record<string, unknown>);
  }

  function toStandardPriceUpdate(update: SolanaPriceUpdate): PriceUpdate {
    return {
      pairKey: `${update.dex}_${update.token0}_${update.token1}`,
      pairAddress: update.poolAddress,
      dex: update.dex,
      chain: 'solana',
      token0: update.token0,
      token1: update.token1,
      price: update.price,
      reserve0: update.reserve0,
      reserve1: update.reserve1,
      blockNumber: update.slot,
      timestamp: update.timestamp,
      latency: 0
    };
  }

  function getPendingUpdates(): number {
    if (!batcher) {
      logger.debug('getPendingUpdates called with no batcher initialized');
      return 0;
    }
    return batcher.getStats().currentQueueSize ?? 0;
  }

  function getBatcherStats(): { pending: number; flushed: number } {
    if (!batcher) {
      logger.debug('getBatcherStats called with no batcher initialized');
      return { pending: 0, flushed: 0 };
    }
    const stats = batcher.getStats();
    return {
      pending: stats.currentQueueSize ?? 0,
      flushed: stats.batchesSent ?? 0
    };
  }

  async function cleanup(): Promise<void> {
    if (batcher) {
      try {
        await batcher.destroy();
      } catch (error) {
        logger.warn('Error destroying price update batcher', { error });
      }
      batcher = null;
    }
  }

  return {
    publishPriceUpdate,
    toStandardPriceUpdate,
    getPendingUpdates,
    getBatcherStats,
    cleanup,
  };
}
