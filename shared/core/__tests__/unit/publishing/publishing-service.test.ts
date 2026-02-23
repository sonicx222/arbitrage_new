/**
 * Publishing Service Tests
 */

import {
  PublishingService,
  createPublishingService,
  STANDARD_BATCHER_CONFIGS,
} from '../../../src/publishing/publishing-service';
import { createMockLogger } from '@arbitrage/test-utils';

function createMockBatcher() {
  return {
    add: jest.fn(),
    destroy: jest.fn().mockResolvedValue(undefined),
    getStats: jest.fn().mockReturnValue({ pending: 0, flushed: 0 }),
  };
}

function createMockStreamsClient() {
  const mockBatcher = createMockBatcher();
  return {
    createBatcher: jest.fn().mockReturnValue(mockBatcher),
    xadd: jest.fn().mockResolvedValue('123-0'),
    xaddWithLimit: jest.fn().mockResolvedValue('123-0'),
    constructor: {
      STREAMS: {
        OPPORTUNITIES: 'stream:opportunities',
        VOLUME_AGGREGATES: 'stream:volume-aggregates',
      },
    },
    _mockBatcher: mockBatcher, // For test access
  };
}

function createMockRedis() {
  return {
    setNx: jest.fn().mockResolvedValue(true),
  };
}

describe('PublishingService', () => {
  let service: PublishingService;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger = createMockLogger();
    mockStreamsClient = createMockStreamsClient();
    mockRedis = createMockRedis();

    service = new PublishingService({
      streamsClient: mockStreamsClient as any,
      redis: mockRedis as any,
      logger: mockLogger as any,
      source: 'test-detector',
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize batchers with default configs', () => {
      service.initializeBatchers();

      expect(mockStreamsClient.createBatcher).toHaveBeenCalledTimes(3);
      expect(mockStreamsClient.createBatcher).toHaveBeenCalledWith(
        STANDARD_BATCHER_CONFIGS.priceUpdates.stream,
        expect.objectContaining({
          maxBatchSize: STANDARD_BATCHER_CONFIGS.priceUpdates.maxBatchSize,
          maxWaitMs: STANDARD_BATCHER_CONFIGS.priceUpdates.maxWaitMs,
        })
      );
      expect(service.areBatchersInitialized()).toBe(true);
    });

    it('should initialize batchers with custom configs', () => {
      const customConfig = {
        priceUpdate: {
          stream: 'custom:price-stream',
          maxBatchSize: 25,
          maxWaitMs: 50,
          name: 'customPriceBatcher',
        },
      };

      service.initializeBatchers(customConfig);

      expect(mockStreamsClient.createBatcher).toHaveBeenCalledWith(
        'custom:price-stream',
        expect.objectContaining({
          maxBatchSize: 25,
          maxWaitMs: 50,
        })
      );
    });

    it('should log initialization', () => {
      service.initializeBatchers();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Publishing service batchers initialized',
        expect.any(Object)
      );
    });
  });

  describe('publishPriceUpdate', () => {
    beforeEach(() => {
      service.initializeBatchers();
    });

    it('should add price update to batcher', async () => {
      const update = {
        pairKey: 'bsc:pancakeswap:WBNB/USDT',
        chain: 'bsc',
        dex: 'pancakeswap',
        pair: 'WBNB/USDT',
        pairAddress: '0x123',
        token0: '0xabc',
        token1: '0xdef',
        price: 300,
        reserve0: '1000000',
        reserve1: '300000',
        timestamp: Date.now(),
        blockNumber: 12345,
        latency: 5,
      };

      await service.publishPriceUpdate(update);

      expect(mockStreamsClient._mockBatcher.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'price-update',
          data: update,
          source: 'test-detector',
        })
      );
    });

    it('should throw if batcher not initialized', async () => {
      const uninitializedService = new PublishingService({
        streamsClient: mockStreamsClient as any,
        logger: mockLogger as any,
        source: 'test',
      });

      await expect(uninitializedService.publishPriceUpdate({} as any)).rejects.toThrow(
        'batcher not initialized'
      );
    });
  });

  describe('publishSwapEvent', () => {
    beforeEach(() => {
      service.initializeBatchers();
    });

    it('should add swap event to batcher', async () => {
      const swapEvent = {
        chain: 'bsc',
        dex: 'pancakeswap',
        pairAddress: '0x123',
        transactionHash: '0xtxhash',
        sender: '0xsender',
        recipient: '0xrecipient',
        to: '0xrecipient',
        amount0In: '1000000000000000000',
        amount1In: '0',
        amount0Out: '0',
        amount1Out: '300000000000000000000',
        timestamp: Date.now(),
        blockNumber: 12345,
      };

      await service.publishSwapEvent(swapEvent);

      expect(mockStreamsClient._mockBatcher.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'swap-event',
          data: swapEvent,
        })
      );
    });

    it('should filter swap events when filter is configured', async () => {
      const mockFilter = {
        processEvent: jest.fn().mockReturnValue({
          passed: false,
          filterReason: 'dust_transaction',
        }),
      };

      const serviceWithFilter = new PublishingService({
        streamsClient: mockStreamsClient as any,
        logger: mockLogger as any,
        source: 'test',
        swapEventFilter: mockFilter as any,
      });
      serviceWithFilter.initializeBatchers();

      await serviceWithFilter.publishSwapEvent({ transactionHash: '0xtest' } as any);

      expect(mockFilter.processEvent).toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Swap event filtered',
        expect.objectContaining({ reason: 'dust_transaction' })
      );
    });
  });

  describe('publishArbitrageOpportunity', () => {
    it('should publish directly without batching', async () => {
      const opportunity = {
        id: 'opp-123',
        chain: 'bsc',
        profit: '100000000000000000',
      };

      await service.publishArbitrageOpportunity(opportunity as any);

      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:opportunities',
        expect.objectContaining({
          type: 'arbitrage-opportunity',
          data: opportunity,
        })
      );
    });

    it('should deduplicate using Redis setNx', async () => {
      const opportunity = { id: 'opp-123' };

      await service.publishArbitrageOpportunity(opportunity as any);

      // P1-10: TTL extended from 30s to 900s to exceed XCLAIM minIdleMs (10 min default)
      expect(mockRedis.setNx).toHaveBeenCalledWith(
        'opp:dedup:opp-123',
        '1',
        900
      );
    });

    it('should skip duplicate opportunities', async () => {
      mockRedis.setNx.mockResolvedValue(false);

      await service.publishArbitrageOpportunity({ id: 'opp-123' } as any);

      expect(mockStreamsClient.xaddWithLimit).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Duplicate opportunity filtered',
        { id: 'opp-123' }
      );
    });

    it('should still publish if Redis dedup fails', async () => {
      mockRedis.setNx.mockRejectedValue(new Error('Redis error'));

      await service.publishArbitrageOpportunity({ id: 'opp-123' } as any);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Redis dedup check failed, publishing anyway',
        expect.any(Object)
      );
      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalled();
    });

    it('should stamp detectedAt on opportunity before publishing', async () => {
      const before = Date.now();
      const opportunity = { id: 'opp-ts-1' } as any;

      await service.publishArbitrageOpportunity(opportunity);

      const after = Date.now();
      expect(opportunity.pipelineTimestamps).toBeDefined();
      expect(opportunity.pipelineTimestamps.detectedAt).toBeGreaterThanOrEqual(before);
      expect(opportunity.pipelineTimestamps.detectedAt).toBeLessThanOrEqual(after);
    });

    it('should preserve existing pipelineTimestamps when stamping detectedAt', async () => {
      const opportunity = {
        id: 'opp-ts-2',
        pipelineTimestamps: { wsReceivedAt: 1700000000000, publishedAt: 1700000000001 },
      } as any;

      await service.publishArbitrageOpportunity(opportunity);

      expect(opportunity.pipelineTimestamps.wsReceivedAt).toBe(1700000000000);
      expect(opportunity.pipelineTimestamps.publishedAt).toBe(1700000000001);
      expect(opportunity.pipelineTimestamps.detectedAt).toBeDefined();
    });
  });

  describe('publishWhaleAlert', () => {
    beforeEach(() => {
      service.initializeBatchers();
    });

    it('should add whale alert to batcher', async () => {
      const alert = {
        chain: 'bsc',
        pair: 'WBNB/USDT',
        usdValue: 100000,
        direction: 'buy',
      };

      await service.publishWhaleAlert(alert as any);

      expect(mockStreamsClient._mockBatcher.add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'whale-alert',
          data: alert,
        })
      );
    });
  });

  describe('publishVolumeAggregate', () => {
    it('should publish directly without batching', async () => {
      const aggregate = {
        chain: 'bsc',
        pair: 'WBNB/USDT',
        totalVolume: '1000000000000000000000',
        windowMs: 5000,
      };

      await service.publishVolumeAggregate(aggregate as any);

      expect(mockStreamsClient.xaddWithLimit).toHaveBeenCalledWith(
        'stream:volume-aggregates',
        expect.objectContaining({
          type: 'volume-aggregate',
          data: aggregate,
        })
      );
    });
  });

  describe('publishWithRetry', () => {
    beforeEach(() => {
      service.initializeBatchers();
    });

    it('should succeed on first attempt', async () => {
      const publishFn = jest.fn().mockResolvedValue(undefined);

      await service.publishWithRetry(publishFn, 'test operation');

      expect(publishFn).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure with exponential backoff', async () => {
      const publishFn = jest
        .fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValue(undefined);

      const promise = service.publishWithRetry(publishFn, 'test operation', 3);

      // First attempt fails
      await jest.advanceTimersByTimeAsync(0);
      expect(publishFn).toHaveBeenCalledTimes(1);

      // Wait for first backoff (100ms)
      await jest.advanceTimersByTimeAsync(100);
      expect(publishFn).toHaveBeenCalledTimes(2);

      // Wait for second backoff (200ms)
      await jest.advanceTimersByTimeAsync(200);
      expect(publishFn).toHaveBeenCalledTimes(3);

      await promise;

      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });

    it('should log error after all retries exhausted', async () => {
      const publishFn = jest.fn().mockRejectedValue(new Error('Persistent failure'));

      const promise = service.publishWithRetry(publishFn, 'test operation', 3);

      await jest.advanceTimersByTimeAsync(100);
      await jest.advanceTimersByTimeAsync(200);
      await jest.advanceTimersByTimeAsync(400);

      await promise;

      expect(publishFn).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'test operation publish failed after 3 attempts',
        expect.any(Object)
      );
    });
  });

  describe('cleanup', () => {
    beforeEach(() => {
      service.initializeBatchers();
    });

    it('should destroy all batchers', async () => {
      await service.cleanup();

      expect(mockStreamsClient._mockBatcher.destroy).toHaveBeenCalled();
      expect(service.areBatchersInitialized()).toBe(false);
    });

    it('should log cleanup completion', async () => {
      await service.cleanup();

      expect(mockLogger.info).toHaveBeenCalledWith('Publishing service cleanup complete');
    });

    it('should handle batcher destroy failures gracefully', async () => {
      mockStreamsClient._mockBatcher.destroy.mockRejectedValue(new Error('Destroy failed'));

      await service.cleanup();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to destroy'),
        expect.any(Object)
      );
    });
  });

  describe('getBatcherStats', () => {
    it('should return null stats when batchers not initialized', () => {
      const stats = service.getBatcherStats();

      expect(stats.priceUpdate).toBeNull();
      expect(stats.swapEvent).toBeNull();
      expect(stats.whaleAlert).toBeNull();
    });

    it('should return batcher stats when initialized', () => {
      service.initializeBatchers();

      const stats = service.getBatcherStats();

      expect(stats.priceUpdate).toEqual({ pending: 0, flushed: 0 });
    });
  });

  describe('createPublishingService factory', () => {
    it('should create a new PublishingService instance', () => {
      const newService = createPublishingService({
        streamsClient: mockStreamsClient as any,
        logger: mockLogger as any,
        source: 'test',
      });

      expect(newService).toBeInstanceOf(PublishingService);
    });
  });
});
