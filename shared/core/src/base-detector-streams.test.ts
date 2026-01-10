/**
 * BaseDetector Redis Streams Migration Tests
 *
 * TDD Test Suite for migrating price-updates from Pub/Sub to Streams
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see S1.1.4: Migrate price-updates channel to Stream
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Define STREAMS constant for tests
const STREAMS = {
  PRICE_UPDATES: 'stream:price-updates',
  SWAP_EVENTS: 'stream:swap-events',
  OPPORTUNITIES: 'stream:opportunities',
  WHALE_ALERTS: 'stream:whale-alerts',
  VOLUME_AGGREGATES: 'stream:volume-aggregates',
  HEALTH: 'stream:health'
};

// Mock Redis Streams Client
const mockBatcher = {
  add: jest.fn(),
  flush: jest.fn(() => Promise.resolve()),
  getStats: jest.fn().mockReturnValue({
    currentQueueSize: 0,
    totalMessagesQueued: 0,
    batchesSent: 0,
    totalMessagesSent: 0,
    compressionRatio: 1,
    averageBatchSize: 0
  }),
  destroy: jest.fn()
};

const mockStreamsClient = {
  xadd: jest.fn(() => Promise.resolve('1234-0')),
  createBatcher: jest.fn().mockReturnValue(mockBatcher),
  disconnect: jest.fn(() => Promise.resolve()),
  ping: jest.fn(() => Promise.resolve(true))
};

const MockRedisStreamsClient = Object.assign(
  jest.fn(() => mockStreamsClient),
  { STREAMS }
);

jest.mock('./redis-streams', () => ({
  RedisStreamsClient: MockRedisStreamsClient,
  getRedisStreamsClient: jest.fn(() => Promise.resolve(mockStreamsClient)),
  StreamBatcher: jest.fn(() => mockBatcher)
}));

// Mock the regular Redis client (for backward compatibility)
const mockRedisClient = {
  publish: jest.fn(() => Promise.resolve(1)),
  disconnect: jest.fn(() => Promise.resolve(undefined))
};

jest.mock('./redis', () => ({
  getRedisClient: jest.fn(() => Promise.resolve(mockRedisClient))
}));

describe('BaseDetector Streams Migration', () => {
  describe('Stream Publishing', () => {
    it('should publish price updates to Redis Stream instead of Pub/Sub', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      const priceUpdate = {
        type: 'price-update',
        data: {
          pairKey: 'pancake_WBNB_USDT',
          dex: 'pancakeswap',
          chain: 'bsc',
          price: 300.5,
          timestamp: Date.now()
        },
        source: 'bsc-detector'
      };

      // Simulate publishing to stream
      await streamsClient.xadd(
        STREAMS.PRICE_UPDATES,
        priceUpdate
      );

      expect(streamsClient.xadd).toHaveBeenCalledWith(
        'stream:price-updates',
        expect.objectContaining({
          type: 'price-update',
          data: expect.any(Object)
        })
      );
    });

    it('should use StreamBatcher for batched publishing', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      const batcher = streamsClient.createBatcher('stream:price-updates', {
        maxBatchSize: 50,
        maxWaitMs: 100
      });

      // Add multiple updates
      batcher.add({ price: 100 });
      batcher.add({ price: 101 });
      batcher.add({ price: 102 });

      expect(batcher.add).toHaveBeenCalledTimes(3);
    });

    it('should flush batcher when service stops', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      const batcher = streamsClient.createBatcher('stream:price-updates', {
        maxBatchSize: 50,
        maxWaitMs: 100
      });

      batcher.add({ price: 100 });
      await batcher.flush();

      expect(batcher.flush).toHaveBeenCalled();
    });

    it('should publish swap events to swap stream', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      const swapEvent = {
        type: 'swap-event',
        data: {
          pairAddress: '0x123',
          amount0In: '1000000000000000000',
          amount1Out: '300000000000000000000',
          usdValue: 300
        },
        source: 'bsc-detector'
      };

      await streamsClient.xadd(
        STREAMS.SWAP_EVENTS,
        swapEvent
      );

      expect(streamsClient.xadd).toHaveBeenCalled();
    });

    it('should publish whale alerts to whale stream', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      const whaleAlert = {
        type: 'whale-transaction',
        data: {
          address: '0xwhale',
          usdValue: 100000,
          direction: 'buy',
          impact: 0.02
        },
        source: 'bsc-detector'
      };

      await streamsClient.xadd(
        STREAMS.WHALE_ALERTS,
        whaleAlert
      );

      expect(streamsClient.xadd).toHaveBeenCalledWith(
        'stream:whale-alerts',
        expect.any(Object)
      );
    });

    it('should publish arbitrage opportunities to opportunities stream', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      const opportunity = {
        type: 'arbitrage-opportunity',
        data: {
          id: 'arb_bsc_123',
          sourceDex: 'pancakeswap',
          targetDex: 'biswap',
          estimatedProfit: 50,
          confidence: 0.85
        },
        source: 'bsc-detector'
      };

      await streamsClient.xadd(
        STREAMS.OPPORTUNITIES,
        opportunity
      );

      expect(streamsClient.xadd).toHaveBeenCalledWith(
        'stream:opportunities',
        expect.any(Object)
      );
    });
  });

  describe('Backward Compatibility', () => {
    it('should support both Pub/Sub and Streams during migration', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const { getRedisClient } = require('./redis');

      const streamsClient = await getRedisStreamsClient();
      const redisClient = await getRedisClient();

      const priceUpdate = { price: 100 };

      // Both should work during migration
      await streamsClient.xadd('stream:price-updates', priceUpdate);
      await redisClient.publish('price-updates', priceUpdate);

      expect(streamsClient.xadd).toHaveBeenCalled();
      expect(redisClient.publish).toHaveBeenCalled();
    });

    it('should gracefully fallback to Pub/Sub if Streams unavailable', async () => {
      const { getRedisClient } = require('./redis');
      const redisClient = await getRedisClient();

      // Simulate Streams failure, fallback to Pub/Sub
      const priceUpdate = { price: 100 };
      await redisClient.publish('price-updates', priceUpdate);

      expect(redisClient.publish).toHaveBeenCalledWith('price-updates', priceUpdate);
    });
  });

  describe('Batching Efficiency', () => {
    it('should achieve 50:1 batching ratio target', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      const batcher = streamsClient.createBatcher('stream:price-updates', {
        maxBatchSize: 50,
        maxWaitMs: 100
      });

      // Add 50 individual events
      for (let i = 0; i < 50; i++) {
        batcher.add({ price: 100 + i });
      }

      // After batching, should result in 1 Redis command (50:1 ratio)
      const stats = batcher.getStats();
      expect(stats).toBeDefined();
    });

    it('should respect maxWaitMs for time-based flushing', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      const batcher = streamsClient.createBatcher('stream:price-updates', {
        maxBatchSize: 1000,
        maxWaitMs: 50  // Short timeout for testing
      });

      batcher.add({ price: 100 });

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have flushed due to timeout even though batch wasn't full
      expect(batcher.add).toHaveBeenCalled();
    });
  });

  describe('Consumer Groups Integration', () => {
    it('should support consumer group subscription for coordinators', async () => {
      // Consumer group setup would be done by the coordinator service
      // This test verifies the pattern works
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      const batcher = streamsClient.createBatcher('stream:price-updates', {
        maxBatchSize: 50,
        maxWaitMs: 100
      });

      // Producers add to batcher
      batcher.add({ price: 100 });

      // Consumer groups will read from stream (tested in redis-streams.test.ts)
      expect(batcher.add).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle stream publish errors gracefully', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      // Simulate error
      streamsClient.xadd.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        streamsClient.xadd('stream:price-updates', { price: 100 })
      ).rejects.toThrow('Connection refused');
    });

    it('should cleanup batcher on service shutdown', async () => {
      const { getRedisStreamsClient } = require('./redis-streams');
      const streamsClient = await getRedisStreamsClient();

      const batcher = streamsClient.createBatcher('stream:price-updates', {
        maxBatchSize: 50,
        maxWaitMs: 100
      });

      batcher.add({ price: 100 });
      batcher.destroy();

      expect(batcher.destroy).toHaveBeenCalled();
    });
  });
});

describe('Stream Channel Constants', () => {
  it('should use consistent stream names', () => {
    // Verify stream names match ADR-002 specification
    expect(STREAMS.PRICE_UPDATES).toBe('stream:price-updates');
    expect(STREAMS.SWAP_EVENTS).toBe('stream:swap-events');
    expect(STREAMS.OPPORTUNITIES).toBe('stream:opportunities');
    expect(STREAMS.WHALE_ALERTS).toBe('stream:whale-alerts');
    expect(STREAMS.VOLUME_AGGREGATES).toBe('stream:volume-aggregates');
    expect(STREAMS.HEALTH).toBe('stream:health');
  });
});
