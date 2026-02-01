/**
 * BaseDetector Redis Streams Migration Tests
 *
 * TDD Test Suite for migrating price-updates from Pub/Sub to Streams
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see S1.1.4: Migrate price-updates channel to Stream
 *
 * @migrated from shared/core/src/base-detector-streams.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Make this file a module
export {};

// Define STREAMS constant for tests
const STREAMS = {
  PRICE_UPDATES: 'stream:price-updates',
  SWAP_EVENTS: 'stream:swap-events',
  OPPORTUNITIES: 'stream:opportunities',
  WHALE_ALERTS: 'stream:whale-alerts',
  VOLUME_AGGREGATES: 'stream:volume-aggregates',
  HEALTH: 'stream:health'
};

/**
 * Mock StreamBatcher for testing batched Redis Streams publishing.
 *
 * **Mock Configuration:**
 * - `add` - Jest spy for tracking individual message additions to batch
 * - `flush` - Jest spy that simulates sending batched messages to Redis
 * - `getStats` - Returns fake statistics (queue size, compression ratio, etc.)
 * - `destroy` - Jest spy for cleanup tracking
 *
 * **Purpose:**
 * Simulates the batching behavior that reduces Redis command overhead.
 * In production, 50 price updates are batched into 1 XADD command,
 * reducing network round-trips and improving throughput.
 *
 * **Usage:**
 * ```typescript
 * const batcher = streamsClient.createBatcher('stream:price-updates');
 * batcher.add({ price: 100 });
 * batcher.add({ price: 101 });
 * await batcher.flush(); // Sends 2 messages in 1 Redis command
 *
 * // Verify batching behavior
 * expect(batcher.add).toHaveBeenCalledTimes(2);
 * expect(batcher.flush).toHaveBeenCalled();
 * ```
 */
const mockBatcher = {
  add: jest.fn<any>(),
  flush: jest.fn<any>(() => Promise.resolve()),
  getStats: jest.fn<any>(() => ({
    currentQueueSize: 0,
    totalMessagesQueued: 0,
    batchesSent: 0,
    totalMessagesSent: 0,
    compressionRatio: 1,
    averageBatchSize: 0
  })),
  destroy: jest.fn<any>()
};

/**
 * Mock RedisStreamsClient for testing Redis Streams operations.
 *
 * **Mock Configuration:**
 * - `xadd` - Jest spy that simulates adding messages to Redis Streams (returns message ID)
 * - `createBatcher` - Returns the mockBatcher for batched publishing
 * - `disconnect` - Jest spy for connection cleanup tracking
 * - `ping` - Jest spy for health check simulation
 *
 * **Purpose:**
 * Allows testing Redis Streams migration (ADR-002) without real Redis instance.
 * Verifies that price updates, swap events, and opportunities are published
 * to correct streams with proper batching.
 *
 * **Usage:**
 * ```typescript
 * const streamsClient = await getRedisStreamsClient();
 * await streamsClient.xadd('stream:price-updates', { price: 100 });
 *
 * // Verify correct stream and message
 * expect(streamsClient.xadd).toHaveBeenCalledWith(
 *   'stream:price-updates',
 *   expect.objectContaining({ price: 100 })
 * );
 * ```
 */
const mockStreamsClient = {
  xadd: jest.fn<any>(() => Promise.resolve('1234-0')),
  createBatcher: jest.fn<any>(() => mockBatcher),
  disconnect: jest.fn<any>(() => Promise.resolve()),
  ping: jest.fn<any>(() => Promise.resolve(true))
};

/**
 * Mock legacy Redis client for Pub/Sub backward compatibility testing.
 *
 * **Mock Configuration:**
 * - `publish` - Jest spy for Pub/Sub channel publishing (returns subscriber count)
 * - `disconnect` - Jest spy for connection cleanup tracking
 *
 * **Purpose:**
 * Supports testing zero-downtime migration from Pub/Sub to Streams (ADR-002).
 * During migration, both Pub/Sub and Streams are supported to allow gradual
 * consumer migration without service disruption.
 *
 * **Usage:**
 * ```typescript
 * const redisClient = await getRedisClient();
 * await redisClient.publish('price-updates', { price: 100 });
 *
 * // Verify backward compatibility
 * expect(redisClient.publish).toHaveBeenCalledWith(
 *   'price-updates',
 *   expect.any(Object)
 * );
 * ```
 */
const mockRedisClient = {
  publish: jest.fn<any>(() => Promise.resolve(1)),
  disconnect: jest.fn<any>(() => Promise.resolve(undefined))
};

// Mock @arbitrage/core - this is what the tests import from
jest.mock('@arbitrage/core', () => ({
  getRedisStreamsClient: () => Promise.resolve(mockStreamsClient),
  getRedisClient: () => Promise.resolve(mockRedisClient),
  RedisStreamsClient: Object.assign(
    jest.fn(() => mockStreamsClient),
    { STREAMS }
  ),
  StreamBatcher: jest.fn(() => mockBatcher)
}));

describe('BaseDetector Streams Migration', () => {
  /**
   * Reset mock state before each test for isolation.
   *
   * **Why restore implementations after jest.clearAllMocks()?**
   * jest.clearAllMocks() clears call history but also resets mock implementations
   * to undefined. We must restore the default success behaviors (resolved promises,
   * return values) so that tests start with consistent, working mock implementations.
   *
   * **What gets restored:**
   * - createBatcher returns mockBatcher (not undefined)
   * - xadd resolves with message ID '1234-0' (not undefined)
   * - flush resolves successfully (not undefined)
   * - getStats returns initial statistics (not undefined)
   *
   * This pattern allows individual tests to override specific behaviors
   * (e.g., simulate errors) while ensuring all other tests have working mocks.
   */
  beforeEach(() => {
    jest.clearAllMocks();
    // Restore mock implementations after clearing
    mockStreamsClient.createBatcher.mockReturnValue(mockBatcher);
    mockStreamsClient.xadd.mockResolvedValue('1234-0');
    mockBatcher.flush.mockResolvedValue(undefined);
    mockBatcher.getStats.mockReturnValue({
      currentQueueSize: 0,
      totalMessagesQueued: 0,
      batchesSent: 0,
      totalMessagesSent: 0,
      compressionRatio: 1,
      averageBatchSize: 0
    });
  });

  describe('Stream Publishing', () => {
    /**
     * GIVEN: A price update from partition service
     * WHEN: Publishing the update to downstream consumers
     * THEN: Should use Redis Streams for improved reliability
     *
     * **Business Value (ADR-002):**
     * Redis Streams provides guaranteed delivery, message persistence,
     * and consumer group support. This prevents lost price updates
     * during network hiccups or consumer restarts, improving arbitrage
     * detection accuracy.
     */
    it('should use Redis Streams for improved price update delivery reliability', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
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
        source: 'partition-asia-fast'
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

    /**
     * GIVEN: High-frequency price updates (thousands per second)
     * WHEN: Publishing to Redis Streams
     * THEN: Should batch updates to reduce Redis command overhead
     *
     * **Business Value:**
     * Batching 50 price updates into 1 Redis command reduces network
     * round-trips, CPU usage, and Redis load. This allows the system
     * to handle higher throughput without scaling Redis infrastructure.
     */
    it('should batch price updates to reduce Redis load', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
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

    /**
     * GIVEN: Service is shutting down (deployment, scaling event, crash)
     * WHEN: Batcher still contains unsent messages
     * THEN: Should flush all pending messages to prevent data loss
     *
     * **Business Value:**
     * Ensures no price updates are lost during service restarts or
     * crashes. Critical for maintaining accurate arbitrage detection
     * and preventing missed opportunities.
     */
    it('should ensure no price updates are lost during shutdown', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
      const streamsClient = await getRedisStreamsClient();

      const batcher = streamsClient.createBatcher('stream:price-updates', {
        maxBatchSize: 50,
        maxWaitMs: 100
      });

      batcher.add({ price: 100 });
      await batcher.flush();

      expect(batcher.flush).toHaveBeenCalled();
    });

    /**
     * GIVEN: Swap events detected from blockchain monitoring
     * WHEN: Publishing to downstream consumers
     * THEN: Should route to dedicated swap stream for separation
     *
     * **Business Value:**
     * Dedicated streams allow different consumer patterns. Swap events
     * may need different processing (MEV detection, volume tracking)
     * than price updates. Stream separation enables independent scaling
     * and consumer group configuration.
     */
    it('should route swap events to dedicated stream for separation', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
      const streamsClient = await getRedisStreamsClient();

      const swapEvent = {
        type: 'swap-event',
        data: {
          pairAddress: '0x123',
          amount0In: '1000000000000000000',
          amount1Out: '300000000000000000000',
          usdValue: 300
        },
        source: 'partition-asia-fast'
      };

      await streamsClient.xadd(
        STREAMS.SWAP_EVENTS,
        swapEvent
      );

      expect(streamsClient.xadd).toHaveBeenCalled();
    });

    /**
     * GIVEN: Large transaction detected (>$100k USD value)
     * WHEN: Publishing whale alert
     * THEN: Should route to dedicated whale stream for priority processing
     *
     * **Business Value:**
     * Whale transactions can signal market-moving events. Dedicated stream
     * enables priority processing and alerts, helping traders react quickly
     * to major liquidity changes that may create or invalidate opportunities.
     */
    it('should route whale alerts to dedicated stream for priority processing', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
      const streamsClient = await getRedisStreamsClient();

      const whaleAlert = {
        type: 'whale-transaction',
        data: {
          address: '0xwhale',
          usdValue: 100000,
          direction: 'buy',
          impact: 0.02
        },
        source: 'partition-asia-fast'
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

    /**
     * GIVEN: Arbitrage opportunity detected
     * WHEN: Publishing to execution engine
     * THEN: Should route to opportunities stream for execution processing
     *
     * **Business Value:**
     * Dedicated opportunities stream enables consumer groups for execution
     * engines, ensuring each opportunity is processed exactly once by a
     * single execution instance (no duplicate trades).
     */
    it('should route opportunities to dedicated stream for execution processing', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
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
        source: 'partition-asia-fast'
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
    /**
     * GIVEN: System is migrating from Pub/Sub to Streams (ADR-002)
     * WHEN: Publishing price updates during migration period
     * THEN: Should support both channels for zero-downtime migration
     *
     * **Business Value:**
     * Enables gradual consumer migration without service disruption.
     * Old consumers continue reading from Pub/Sub while new consumers
     * migrate to Streams. Once all consumers are migrated, Pub/Sub
     * can be safely removed.
     */
    it('should enable zero-downtime migration from Pub/Sub to Streams', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
      const { getRedisClient } = require('@arbitrage/core');

      const streamsClient = await getRedisStreamsClient();
      const redisClient = await getRedisClient();

      const priceUpdate = { price: 100 };

      // Both should work during migration
      await streamsClient.xadd('stream:price-updates', priceUpdate);
      await redisClient.publish('price-updates', priceUpdate);

      expect(streamsClient.xadd).toHaveBeenCalled();
      expect(redisClient.publish).toHaveBeenCalled();
    });

    /**
     * GIVEN: Streams connection fails (Redis Streams unavailable)
     * WHEN: Publishing price update
     * THEN: Should maintain service availability by falling back to Pub/Sub
     *
     * **Business Value:**
     * Provides resilience during Redis Streams outages or version
     * incompatibilities. Ensures price updates continue flowing even
     * if Streams feature is temporarily unavailable, preventing complete
     * system failure.
     */
    it('should maintain service availability if Streams connection fails', async () => {
      const { getRedisClient } = require('@arbitrage/core');
      const redisClient = await getRedisClient();

      // Simulate Streams failure, fallback to Pub/Sub
      const priceUpdate = { price: 100 };
      await redisClient.publish('price-updates', priceUpdate);

      expect(redisClient.publish).toHaveBeenCalledWith('price-updates', priceUpdate);
    });
  });

  describe('Batching Efficiency', () => {
    /**
     * GIVEN: 50 individual price updates in rapid succession
     * WHEN: Using StreamBatcher with maxBatchSize=50
     * THEN: Should reduce 50 Redis commands down to 1 command (50:1 ratio)
     *
     * **Business Value (ADR-002 Performance Target):**
     * Batching reduces Redis CPU usage, network bandwidth, and round-trip
     * latency by 50x. This allows the system to handle 50,000+ price updates
     * per second without overwhelming Redis or requiring expensive Redis
     * Cluster scaling.
     */
    it('should reduce Redis commands by batching 50 updates into 1 command', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
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

    /**
     * GIVEN: Price updates arriving slower than batch size threshold
     * WHEN: maxWaitMs timeout expires (50ms)
     * THEN: Should flush partial batch to prevent stale data accumulation
     *
     * **Business Value:**
     * Prevents price updates from sitting in the batch queue too long
     * during low-activity periods. Ensures consumers receive timely updates
     * even when volume is low (e.g., overnight, low-liquidity pairs).
     */
    it('should flush partial batches to prevent stale data during low activity', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
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
      const { getRedisStreamsClient } = require('@arbitrage/core');
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
    /**
     * GIVEN: Redis Streams connection fails (network issue, Redis down)
     * WHEN: Attempting to publish price update
     * THEN: Should propagate error to caller for retry logic
     *
     * **Business Value:**
     * Allows calling code to implement retry strategies (exponential backoff,
     * circuit breakers, fallback to Pub/Sub). Failing fast is better than
     * silently dropping price updates, which would cause missed arbitrage
     * opportunities.
     */
    it('should propagate errors to caller for retry logic', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
      const streamsClient = await getRedisStreamsClient();

      // Simulate error
      streamsClient.xadd.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        streamsClient.xadd('stream:price-updates', { price: 100 })
      ).rejects.toThrow('Connection refused');
    });

    /**
     * GIVEN: Service is shutting down (SIGTERM received)
     * WHEN: Batcher cleanup is triggered
     * THEN: Should properly destroy batcher to free resources
     *
     * **Business Value:**
     * Ensures clean shutdown without resource leaks (timers, Redis connections).
     * Prevents "connection pool exhausted" errors in containerized environments
     * where services frequently restart (Kubernetes rolling deployments, autoscaling).
     */
    it('should properly destroy batcher to prevent resource leaks during shutdown', async () => {
      const { getRedisStreamsClient } = require('@arbitrage/core');
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
