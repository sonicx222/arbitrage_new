/**
 * Solana Price Publisher Unit Tests
 *
 * Tests for price validation, standard format conversion,
 * and batcher delegation.
 */

import { createSolanaPricePublisher, type SolanaPricePublisher } from '../../../src/solana/solana-price-publisher';
import { createMockLogger, createMockBatcher, createTestPriceUpdate } from './solana-test-helpers';

describe('SolanaPricePublisher', () => {
  let publisher: SolanaPricePublisher;
  let logger: ReturnType<typeof createMockLogger>;
  let batcher: ReturnType<typeof createMockBatcher>;

  beforeEach(() => {
    logger = createMockLogger();
    batcher = createMockBatcher();
    publisher = createSolanaPricePublisher({ logger, batcher });
  });

  // =========================================================================
  // publishPriceUpdate
  // =========================================================================

  describe('publishPriceUpdate', () => {
    it('should add valid price update to batcher', async () => {
      const update = createTestPriceUpdate({ price: 103.45 });
      await publisher.publishPriceUpdate(update);

      expect(batcher.add).toHaveBeenCalledTimes(1);
      expect(batcher.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'price-update',
          source: 'solana-detector'
        })
      );
    });

    it('should reject price = 0', async () => {
      const update = createTestPriceUpdate({ price: 0 });
      await publisher.publishPriceUpdate(update);

      expect(batcher.add).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('Invalid price update rejected', expect.any(Object));
    });

    it('should reject negative price', async () => {
      const update = createTestPriceUpdate({ price: -1 });
      await publisher.publishPriceUpdate(update);
      expect(batcher.add).not.toHaveBeenCalled();
    });

    it('should reject NaN price', async () => {
      const update = createTestPriceUpdate({ price: NaN });
      await publisher.publishPriceUpdate(update);
      expect(batcher.add).not.toHaveBeenCalled();
    });

    it('should reject Infinity price', async () => {
      const update = createTestPriceUpdate({ price: Infinity });
      await publisher.publishPriceUpdate(update);
      expect(batcher.add).not.toHaveBeenCalled();
    });

    it('should reject -Infinity price', async () => {
      const update = createTestPriceUpdate({ price: -Infinity });
      await publisher.publishPriceUpdate(update);
      expect(batcher.add).not.toHaveBeenCalled();
    });

    it('should throw when batcher is not initialized', async () => {
      const pubWithoutBatcher = createSolanaPricePublisher({ logger, batcher: null });
      const update = createTestPriceUpdate();

      await expect(pubWithoutBatcher.publishPriceUpdate(update))
        .rejects.toThrow('Price update batcher not initialized');
    });
  });

  // =========================================================================
  // toStandardPriceUpdate
  // =========================================================================

  describe('toStandardPriceUpdate', () => {
    it('should map slot to blockNumber', () => {
      const update = createTestPriceUpdate({ slot: 200000001 });
      const result = publisher.toStandardPriceUpdate(update);
      expect(result.blockNumber).toBe(200000001);
    });

    it('should set chain to solana', () => {
      const update = createTestPriceUpdate();
      const result = publisher.toStandardPriceUpdate(update);
      expect(result.chain).toBe('solana');
    });

    it('should construct pairKey as dex_token0_token1', () => {
      const update = createTestPriceUpdate({
        dex: 'raydium',
        token0: 'SOL_MINT',
        token1: 'USDC_MINT'
      });
      const result = publisher.toStandardPriceUpdate(update);
      expect(result.pairKey).toBe('raydium_SOL_MINT_USDC_MINT');
    });

    it('should set latency to 0', () => {
      const update = createTestPriceUpdate();
      const result = publisher.toStandardPriceUpdate(update);
      expect(result.latency).toBe(0);
    });

    it('should pass through price, reserve0, reserve1, timestamp', () => {
      const update = createTestPriceUpdate({
        price: 150.5,
        reserve0: '999',
        reserve1: '888',
        timestamp: 1700000000000
      });
      const result = publisher.toStandardPriceUpdate(update);
      expect(result.price).toBe(150.5);
      expect(result.reserve0).toBe('999');
      expect(result.reserve1).toBe('888');
      expect(result.timestamp).toBe(1700000000000);
    });
  });

  // =========================================================================
  // getPendingUpdates
  // =========================================================================

  describe('getPendingUpdates', () => {
    it('should return batcher queue size', () => {
      (batcher.getStats as jest.Mock).mockReturnValue({ currentQueueSize: 5, batchesSent: 0 });
      expect(publisher.getPendingUpdates()).toBe(5);
    });

    it('should return 0 when batcher is not initialized', () => {
      const pubNoBatcher = createSolanaPricePublisher({ logger, batcher: null });
      expect(pubNoBatcher.getPendingUpdates()).toBe(0);
    });

    it('should handle nullish currentQueueSize via ??', () => {
      (batcher.getStats as jest.Mock).mockReturnValue({ currentQueueSize: undefined, batchesSent: 0 });
      expect(publisher.getPendingUpdates()).toBe(0);
    });
  });

  // =========================================================================
  // getBatcherStats
  // =========================================================================

  describe('getBatcherStats', () => {
    it('should return pending and flushed counts', () => {
      (batcher.getStats as jest.Mock).mockReturnValue({ currentQueueSize: 3, batchesSent: 10 });
      expect(publisher.getBatcherStats()).toEqual({ pending: 3, flushed: 10 });
    });

    it('should return zeros when batcher not initialized', () => {
      const pubNoBatcher = createSolanaPricePublisher({ logger, batcher: null });
      expect(pubNoBatcher.getBatcherStats()).toEqual({ pending: 0, flushed: 0 });
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('should destroy batcher', async () => {
      await publisher.cleanup();
      expect(batcher.destroy).toHaveBeenCalledTimes(1);
    });

    it('should handle batcher destroy failure gracefully', async () => {
      (batcher.destroy as jest.Mock).mockRejectedValue(new Error('destroy failed'));
      await publisher.cleanup();
      expect(logger.warn).toHaveBeenCalledWith('Error destroying price update batcher', expect.any(Object));
    });

    it('should make getPendingUpdates return 0 after cleanup', async () => {
      await publisher.cleanup();
      expect(publisher.getPendingUpdates()).toBe(0);
    });
  });
});
