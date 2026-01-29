/**
 * DetectorConnectionManager Tests
 *
 * Tests for the extracted detector connection management module.
 * Verifies initialization and disconnect functionality.
 */

import {
  initializeDetectorConnections,
  disconnectDetectorConnections,
} from '../detector-connection-manager';
import { getRedisClient, resetRedisInstance } from '../../redis';
import { getRedisStreamsClient, resetRedisStreamsInstance, RedisStreamsClient } from '../../redis-streams';
import { SwapEventFilter } from '../../analytics/swap-event-filter';

// Mock dependencies
jest.mock('../../redis', () => ({
  getRedisClient: jest.fn(),
  resetRedisInstance: jest.fn(),
}));

jest.mock('../../redis-streams', () => ({
  getRedisStreamsClient: jest.fn(),
  resetRedisStreamsInstance: jest.fn(),
  RedisStreamsClient: {
    STREAMS: {
      PRICE_UPDATES: 'stream:price-updates',
      SWAP_EVENTS: 'stream:swap-events',
      WHALE_ALERTS: 'stream:whale-alerts',
    },
  },
}));

jest.mock('../../analytics/swap-event-filter', () => ({
  SwapEventFilter: jest.fn().mockImplementation(() => ({
    onWhaleAlert: jest.fn(),
    onVolumeAggregate: jest.fn(),
    destroy: jest.fn(),
  })),
}));

describe('DetectorConnectionManager', () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const mockRedis = {
    disconnect: jest.fn().mockResolvedValue(undefined),
  };

  const mockBatcher = {
    add: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    getStats: jest.fn().mockReturnValue({}),
  };

  const mockStreamsClient = {
    createBatcher: jest.fn().mockReturnValue(mockBatcher),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getRedisClient as jest.Mock).mockResolvedValue(mockRedis);
    (getRedisStreamsClient as jest.Mock).mockResolvedValue(mockStreamsClient);
  });

  describe('initializeDetectorConnections', () => {
    it('should initialize all connections successfully', async () => {
      const handlers = {
        onWhaleAlert: jest.fn(),
        onVolumeAggregate: jest.fn(),
      };

      const resources = await initializeDetectorConnections(
        { chain: 'ethereum', logger: mockLogger },
        handlers
      );

      expect(resources.redis).toBeDefined();
      expect(resources.streamsClient).toBeDefined();
      expect(resources.priceUpdateBatcher).toBeDefined();
      expect(resources.swapEventBatcher).toBeDefined();
      expect(resources.whaleAlertBatcher).toBeDefined();
      expect(resources.swapEventFilter).toBeDefined();

      // Verify batchers were created with correct streams
      expect(mockStreamsClient.createBatcher).toHaveBeenCalledTimes(3);
      expect(mockStreamsClient.createBatcher).toHaveBeenCalledWith(
        'stream:price-updates',
        expect.any(Object)
      );
      expect(mockStreamsClient.createBatcher).toHaveBeenCalledWith(
        'stream:swap-events',
        expect.any(Object)
      );
      expect(mockStreamsClient.createBatcher).toHaveBeenCalledWith(
        'stream:whale-alerts',
        expect.any(Object)
      );
    });

    it('should use custom batcher config when provided', async () => {
      const customConfig = {
        priceUpdates: { maxBatchSize: 100, maxWaitMs: 200 },
        swapEvents: { maxBatchSize: 200, maxWaitMs: 1000 },
        whaleAlerts: { maxBatchSize: 20, maxWaitMs: 100 },
      };

      await initializeDetectorConnections(
        {
          chain: 'ethereum',
          logger: mockLogger,
          batcherConfig: customConfig,
        },
        { onWhaleAlert: jest.fn(), onVolumeAggregate: jest.fn() }
      );

      // Verify custom config was applied
      expect(mockStreamsClient.createBatcher).toHaveBeenCalledWith(
        'stream:price-updates',
        { maxBatchSize: 100, maxWaitMs: 200 }
      );
      expect(mockStreamsClient.createBatcher).toHaveBeenCalledWith(
        'stream:swap-events',
        { maxBatchSize: 200, maxWaitMs: 1000 }
      );
      expect(mockStreamsClient.createBatcher).toHaveBeenCalledWith(
        'stream:whale-alerts',
        { maxBatchSize: 20, maxWaitMs: 100 }
      );
    });

    it('should throw if Redis Streams fails', async () => {
      (getRedisStreamsClient as jest.Mock).mockRejectedValue(new Error('Connection failed'));

      await expect(
        initializeDetectorConnections(
          { chain: 'ethereum', logger: mockLogger },
          { onWhaleAlert: jest.fn(), onVolumeAggregate: jest.fn() }
        )
      ).rejects.toThrow('Redis Streams initialization failed');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to initialize detector connections',
        expect.objectContaining({ chain: 'ethereum' })
      );
    });

    it('should log initialization progress', async () => {
      await initializeDetectorConnections(
        { chain: 'bsc', logger: mockLogger },
        { onWhaleAlert: jest.fn(), onVolumeAggregate: jest.fn() }
      );

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Redis client initialized',
        { chain: 'bsc' }
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Redis Streams client initialized',
        { chain: 'bsc' }
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Redis Streams batchers initialized',
        expect.objectContaining({ chain: 'bsc' })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Smart Swap Event Filter initialized',
        expect.objectContaining({ chain: 'bsc' })
      );
    });
  });

  describe('disconnectDetectorConnections', () => {
    it('should disconnect all resources gracefully', async () => {
      const mockSwapEventFilter = {
        destroy: jest.fn(),
      };

      // Use type assertion to satisfy Partial<DetectorConnectionResources>
      const resources = {
        redis: mockRedis as any,
        streamsClient: mockStreamsClient as any,
        priceUpdateBatcher: mockBatcher as any,
        swapEventBatcher: mockBatcher as any,
        whaleAlertBatcher: mockBatcher as any,
        swapEventFilter: mockSwapEventFilter as any,
      };

      await disconnectDetectorConnections(resources, mockLogger);

      // Verify batchers were destroyed
      expect(mockBatcher.destroy).toHaveBeenCalledTimes(3);

      // Verify swap event filter was destroyed
      expect(mockSwapEventFilter.destroy).toHaveBeenCalled();

      // Verify streams client was disconnected
      expect(mockStreamsClient.disconnect).toHaveBeenCalled();

      // Verify Redis was disconnected
      expect(mockRedis.disconnect).toHaveBeenCalled();

      // Verify completion logged
      expect(mockLogger.info).toHaveBeenCalledWith('Detector connections disconnected');
    });

    it('should handle partial resources gracefully', async () => {
      // Use type assertion for partial mock
      const resources = {
        redis: mockRedis as any,
        // Missing other resources
      };

      await disconnectDetectorConnections(resources, mockLogger);

      // Should not throw and should disconnect what's available
      expect(mockRedis.disconnect).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Detector connections disconnected');
    });

    it('should handle disconnect errors without throwing', async () => {
      const failingRedis = {
        disconnect: jest.fn().mockRejectedValue(new Error('Disconnect failed')),
      };

      // Use type assertion for partial mock
      const resources = {
        redis: failingRedis as any,
      };

      // Should not throw
      await disconnectDetectorConnections(resources, mockLogger);

      // Should log the error
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error disconnecting Redis',
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it('should handle batcher flush errors without throwing', async () => {
      const failingBatcher = {
        destroy: jest.fn().mockRejectedValue(new Error('Flush failed')),
      };

      // Use type assertion for partial mock
      const resources = {
        priceUpdateBatcher: failingBatcher as any,
      };

      // Should not throw
      await disconnectDetectorConnections(resources, mockLogger);

      // Should log the error
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });
});
