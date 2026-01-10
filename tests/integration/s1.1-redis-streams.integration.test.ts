/**
 * S1.1 Redis Streams Migration Integration Tests
 *
 * End-to-end testing of Redis Streams implementation
 * Validates ADR-002 requirements and migration from Pub/Sub to Streams
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see S1.1.1-S1.1.5: Redis Streams Migration Tasks
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';

// Mock ioredis before importing modules that use it
const mockRedisData = new Map<string, any>();
const mockStreams = new Map<string, any[]>();
const mockConsumerGroups = new Map<string, Map<string, any>>();

const mockRedis = {
  xadd: jest.fn().mockImplementation(async (stream: string, id: string, ...args: string[]) => {
    const streamData = mockStreams.get(stream) || [];
    const messageId = id === '*' ? `${Date.now()}-${streamData.length}` : id;
    const fields: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      fields[args[i]] = args[i + 1];
    }
    streamData.push({ id: messageId, fields });
    mockStreams.set(stream, streamData);
    return messageId;
  }),
  xread: jest.fn().mockImplementation(async (...args: any[]) => {
    const streamsIdx = args.indexOf('STREAMS');
    if (streamsIdx === -1) return null;
    const streamName = args[streamsIdx + 1];
    const lastId = args[streamsIdx + 2];
    const streamData = mockStreams.get(streamName) || [];
    if (streamData.length === 0) return null;

    const messages = streamData.filter(m => {
      if (lastId === '0' || lastId === '$') return true;
      return m.id > lastId;
    });

    if (messages.length === 0) return null;
    return [[streamName, messages.map(m => [m.id, Object.entries(m.fields).flat()])]];
  }),
  xreadgroup: jest.fn().mockImplementation(async (...args: any[]) => {
    const groupIdx = args.indexOf('GROUP');
    const streamsIdx = args.indexOf('STREAMS');
    if (groupIdx === -1 || streamsIdx === -1) return null;

    const groupName = args[groupIdx + 1];
    const consumerName = args[groupIdx + 2];
    const streamName = args[streamsIdx + 1];

    const streamData = mockStreams.get(streamName) || [];
    if (streamData.length === 0) return null;

    // Return unacknowledged messages
    const messages = streamData.slice(0, 5);
    if (messages.length === 0) return null;
    return [[streamName, messages.map(m => [m.id, Object.entries(m.fields).flat()])]];
  }),
  xack: jest.fn().mockResolvedValue(1),
  xgroup: jest.fn().mockImplementation(async (command: string, stream: string, group: string) => {
    if (command === 'CREATE') {
      const groups = mockConsumerGroups.get(stream) || new Map();
      if (groups.has(group)) {
        throw new Error('BUSYGROUP Consumer Group name already exists');
      }
      groups.set(group, { lastDeliveredId: '0-0', consumers: new Map() });
      mockConsumerGroups.set(stream, groups);
    }
    return 'OK';
  }),
  xinfo: jest.fn().mockImplementation(async (command: string, stream: string) => {
    const streamData = mockStreams.get(stream) || [];
    return [
      'length', streamData.length,
      'radix-tree-keys', 1,
      'radix-tree-nodes', 2,
      'last-generated-id', streamData.length > 0 ? streamData[streamData.length - 1].id : '0-0',
      'groups', mockConsumerGroups.get(stream)?.size || 0
    ];
  }),
  xlen: jest.fn().mockImplementation(async (stream: string) => {
    return (mockStreams.get(stream) || []).length;
  }),
  xpending: jest.fn().mockImplementation(async (stream: string, group: string) => {
    const streamData = mockStreams.get(stream) || [];
    return [
      Math.min(5, streamData.length), // total pending
      streamData.length > 0 ? streamData[0].id : null, // smallest ID
      streamData.length > 0 ? streamData[streamData.length - 1].id : null, // largest ID
      [['consumer-1', '3'], ['consumer-2', '2']] // consumer pending counts
    ];
  }),
  xtrim: jest.fn().mockImplementation(async (stream: string, ...args: any[]) => {
    const maxLenIdx = args.indexOf('MAXLEN');
    if (maxLenIdx !== -1) {
      const maxLen = parseInt(args[maxLenIdx + 2] || args[maxLenIdx + 1], 10);
      const streamData = mockStreams.get(stream) || [];
      const trimmed = streamData.length - maxLen;
      mockStreams.set(stream, streamData.slice(-maxLen));
      return Math.max(0, trimmed);
    }
    return 0;
  }),
  ping: jest.fn().mockResolvedValue('PONG'),
  disconnect: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  removeAllListeners: jest.fn()
};

jest.mock('ioredis', () => {
  return jest.fn(() => mockRedis);
});

// Now import the modules
import {
  RedisStreamsClient,
  StreamBatcher,
  getRedisStreamsClient,
  resetRedisStreamsInstance
} from '../../shared/core/src/redis-streams';

import {
  StreamHealthMonitor,
  getStreamHealthMonitor,
  resetStreamHealthMonitor
} from '../../shared/core/src/stream-health-monitor';

import { delay, createMockPriceUpdate, createMockSwapEvent } from '../../shared/test-utils/src';

describe('S1.1 Redis Streams Migration Integration Tests', () => {
  let streamsClient: RedisStreamsClient;

  beforeAll(async () => {
    // Clear any previous state
    mockStreams.clear();
    mockConsumerGroups.clear();
    mockRedisData.clear();
    resetRedisStreamsInstance();
    resetStreamHealthMonitor();
  });

  afterAll(async () => {
    resetRedisStreamsInstance();
    resetStreamHealthMonitor();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockStreams.clear();
    mockConsumerGroups.clear();
  });

  // =========================================================================
  // S1.1.1: RedisStreamsClient Core Tests
  // =========================================================================
  describe('S1.1.1: RedisStreamsClient Core Functionality', () => {
    beforeEach(async () => {
      resetRedisStreamsInstance();
      streamsClient = await getRedisStreamsClient();
    });

    describe('XADD - Message Publishing', () => {
      it('should add messages to a stream with auto-generated ID', async () => {
        const message = { type: 'price-update', data: { price: 100 } };
        const messageId = await streamsClient.xadd(
          RedisStreamsClient.STREAMS.PRICE_UPDATES,
          message
        );

        expect(messageId).toBeDefined();
        expect(mockRedis.xadd).toHaveBeenCalledWith(
          'stream:price-updates',
          '*',
          'data',
          expect.any(String)
        );
      });

      it('should serialize complex objects correctly', async () => {
        const complexMessage = {
          type: 'swap-event',
          data: {
            pair: 'WBNB/USDT',
            amount0In: '1000000000000000000',
            timestamp: Date.now(),
            nested: { deep: { value: 42 } }
          }
        };

        await streamsClient.xadd(
          RedisStreamsClient.STREAMS.SWAP_EVENTS,
          complexMessage
        );

        expect(mockRedis.xadd).toHaveBeenCalled();
        const callArgs = mockRedis.xadd.mock.calls[0];
        const serialized = JSON.parse(callArgs[3]);
        expect(serialized).toEqual(complexMessage);
      });

      it('should validate stream names and reject unsafe characters', async () => {
        await expect(
          streamsClient.xadd('invalid stream!@#', { data: 'test' })
        ).rejects.toThrow('Invalid stream name');
      });

      it('should retry on transient failures when retry option is enabled', async () => {
        mockRedis.xadd
          .mockRejectedValueOnce(new Error('BUSY'))
          .mockResolvedValueOnce('1234-0');

        const messageId = await streamsClient.xadd(
          'stream:test',
          { data: 'test' },
          '*',
          { retry: true }
        );

        expect(messageId).toBe('1234-0');
        expect(mockRedis.xadd).toHaveBeenCalledTimes(2);
      });
    });

    describe('XREAD - Message Consumption', () => {
      it('should read messages from a stream', async () => {
        // Add test messages
        await streamsClient.xadd('stream:test', { value: 1 });
        await streamsClient.xadd('stream:test', { value: 2 });

        const messages = await streamsClient.xread('stream:test', '0');

        expect(messages).toBeDefined();
        expect(messages.length).toBeGreaterThan(0);
      });

      it('should return empty array when no messages available', async () => {
        mockRedis.xread.mockResolvedValueOnce(null);

        const messages = await streamsClient.xread('stream:empty', '0');

        expect(messages).toEqual([]);
      });

      it('should support COUNT option for limiting results', async () => {
        await streamsClient.xread('stream:test', '0', { count: 10 });

        expect(mockRedis.xread).toHaveBeenCalledWith(
          'COUNT', 10,
          'STREAMS', 'stream:test', '0'
        );
      });
    });

    describe('Consumer Groups', () => {
      it('should create a consumer group', async () => {
        await streamsClient.createConsumerGroup({
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        });

        expect(mockRedis.xgroup).toHaveBeenCalledWith(
          'CREATE',
          'stream:test',
          'test-group',
          '$',
          'MKSTREAM'
        );
      });

      it('should handle existing group gracefully', async () => {
        // First creation succeeds
        await streamsClient.createConsumerGroup({
          streamName: 'stream:test',
          groupName: 'existing-group',
          consumerName: 'consumer-1'
        });

        // Second creation should not throw
        await expect(
          streamsClient.createConsumerGroup({
            streamName: 'stream:test',
            groupName: 'existing-group',
            consumerName: 'consumer-1'
          })
        ).resolves.not.toThrow();
      });

      it('should read messages via consumer group', async () => {
        await streamsClient.xadd('stream:test', { data: 'test' });

        const messages = await streamsClient.xreadgroup({
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        });

        expect(mockRedis.xreadgroup).toHaveBeenCalled();
      });

      it('should acknowledge processed messages', async () => {
        const acked = await streamsClient.xack('stream:test', 'test-group', '1234-0');

        expect(acked).toBe(1);
        expect(mockRedis.xack).toHaveBeenCalledWith('stream:test', 'test-group', '1234-0');
      });
    });

    describe('Stream Constants', () => {
      it('should define all required stream names (ADR-002)', () => {
        expect(RedisStreamsClient.STREAMS.PRICE_UPDATES).toBe('stream:price-updates');
        expect(RedisStreamsClient.STREAMS.SWAP_EVENTS).toBe('stream:swap-events');
        expect(RedisStreamsClient.STREAMS.OPPORTUNITIES).toBe('stream:opportunities');
        expect(RedisStreamsClient.STREAMS.WHALE_ALERTS).toBe('stream:whale-alerts');
        expect(RedisStreamsClient.STREAMS.VOLUME_AGGREGATES).toBe('stream:volume-aggregates');
        expect(RedisStreamsClient.STREAMS.HEALTH).toBe('stream:health');
      });
    });
  });

  // =========================================================================
  // S1.1.2: StreamBatcher Tests
  // =========================================================================
  describe('S1.1.2: StreamBatcher for Efficient Command Usage', () => {
    let batcher: StreamBatcher<any>;

    beforeEach(async () => {
      resetRedisStreamsInstance();
      streamsClient = await getRedisStreamsClient();
    });

    afterEach(async () => {
      if (batcher) {
        await batcher.destroy();
      }
    });

    it('should batch messages before sending (50:1 ratio target)', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 50,
        maxWaitMs: 1000
      });

      // Add 50 individual messages
      for (let i = 0; i < 50; i++) {
        batcher.add({ price: 100 + i, index: i });
      }

      // Wait for batch to be processed
      await delay(50);

      // Should have sent only 1 batched message (50:1 compression)
      expect(mockRedis.xadd).toHaveBeenCalledTimes(1);

      const stats = batcher.getStats();
      expect(stats.totalMessagesSent).toBe(50);
      expect(stats.batchesSent).toBe(1);
      expect(stats.compressionRatio).toBe(50); // 50 messages / 1 batch
    });

    it('should flush batch on timeout even if not full', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 100,
        maxWaitMs: 50
      });

      batcher.add({ price: 100 });

      // Wait for timeout
      await delay(100);

      expect(mockRedis.xadd).toHaveBeenCalled();
    });

    it('should prevent race condition during concurrent flushes', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 1000,
        maxWaitMs: 10000
      });

      // Add messages
      for (let i = 0; i < 100; i++) {
        batcher.add({ index: i });
      }

      // Trigger multiple concurrent flushes
      const flushPromises = [
        batcher.flush(),
        batcher.flush(),
        batcher.flush()
      ];

      await Promise.all(flushPromises);

      // Should only have one actual flush (race condition prevented)
      expect(mockRedis.xadd).toHaveBeenCalledTimes(1);
    });

    it('should not accept messages after destroy', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 100,
        maxWaitMs: 1000
      });

      batcher.add({ before: true });
      await batcher.destroy();

      // This should be silently ignored
      batcher.add({ after: true });

      // Wait a bit
      await delay(50);

      // Only the first message should have been sent
      const stats = batcher.getStats();
      expect(stats.totalMessagesSent).toBe(1);
    });

    it('should flush remaining messages on destroy', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 1000,
        maxWaitMs: 10000 // Long timeout
      });

      // Add messages but don't wait for timeout
      batcher.add({ message: 1 });
      batcher.add({ message: 2 });

      // Destroy should flush
      await batcher.destroy();

      expect(mockRedis.xadd).toHaveBeenCalled();
    });

    it('should provide accurate statistics', async () => {
      batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 10,
        maxWaitMs: 1000
      });

      // Add 25 messages (should create 2 full batches + 5 queued)
      for (let i = 0; i < 25; i++) {
        batcher.add({ index: i });
      }

      await delay(50); // Wait for batches to process

      const stats = batcher.getStats();
      expect(stats.batchesSent).toBeGreaterThanOrEqual(2);
      expect(stats.totalMessagesSent).toBeGreaterThanOrEqual(20);
    });
  });

  // =========================================================================
  // S1.1.5: StreamHealthMonitor Tests
  // =========================================================================
  describe('S1.1.5: StreamHealthMonitor', () => {
    let healthMonitor: StreamHealthMonitor;

    beforeEach(() => {
      resetStreamHealthMonitor();
      healthMonitor = getStreamHealthMonitor();
    });

    afterEach(async () => {
      await healthMonitor.stop();
    });

    it('should check health of all monitored streams', async () => {
      const health = await healthMonitor.checkStreamHealth();

      expect(health).toBeDefined();
      expect(health.overall).toBeDefined();
      expect(health.streams).toBeDefined();
      expect(health.timestamp).toBeGreaterThan(0);
    });

    it('should report healthy status for streams with low pending count', async () => {
      mockRedis.xpending.mockResolvedValue([5, '1-0', '5-0', []]);

      const health = await healthMonitor.checkStreamHealth();

      expect(health.overall).toBe('healthy');
    });

    it('should report warning status when lag exceeds warning threshold', async () => {
      // Configure lower thresholds for testing
      healthMonitor.setThresholds({
        lagWarning: 10,
        lagCritical: 100
      });

      mockRedis.xpending.mockResolvedValue([50, '1-0', '50-0', []]);

      const lagInfo = await healthMonitor.getStreamLag('stream:test', 'test-group');

      expect(lagInfo.status).toBe('warning');
    });

    it('should report critical status when lag exceeds critical threshold', async () => {
      healthMonitor.setThresholds({
        lagWarning: 10,
        lagCritical: 100
      });

      mockRedis.xpending.mockResolvedValue([500, '1-0', '500-0', []]);

      const lagInfo = await healthMonitor.getStreamLag('stream:test', 'test-group');

      expect(lagInfo.status).toBe('critical');
    });

    it('should trigger alerts and deduplicate within cooldown period', async () => {
      const alertHandler = jest.fn();
      healthMonitor.onAlert(alertHandler);
      healthMonitor.setAlertCooldown(100); // 100ms cooldown for testing

      // Mock critical lag
      mockRedis.xpending.mockResolvedValue([5000, '1-0', '5000-0', []]);

      // First check should trigger alert
      await healthMonitor.checkStreamHealth();
      expect(alertHandler).toHaveBeenCalledTimes(1);

      // Second check within cooldown should NOT trigger another alert
      await healthMonitor.checkStreamHealth();
      expect(alertHandler).toHaveBeenCalledTimes(1); // Still 1

      // Wait for cooldown
      await delay(150);

      // Third check after cooldown SHOULD trigger alert
      await healthMonitor.checkStreamHealth();
      expect(alertHandler).toHaveBeenCalledTimes(2);
    });

    it('should provide summary statistics', async () => {
      const summary = await healthMonitor.getSummary();

      expect(summary.totalStreams).toBeGreaterThan(0);
      expect(summary.healthyStreams).toBeDefined();
      expect(summary.warningStreams).toBeDefined();
      expect(summary.criticalStreams).toBeDefined();
      expect(summary.totalPending).toBeDefined();
      expect(summary.averageLag).toBeDefined();
    });

    it('should export metrics in Prometheus format', async () => {
      const prometheusMetrics = await healthMonitor.getPrometheusMetrics();

      expect(prometheusMetrics).toContain('stream_length');
      expect(prometheusMetrics).toContain('stream_pending');
      expect(prometheusMetrics).toContain('stream_health_status');
    });

    it('should allow configuring consumer group name', () => {
      healthMonitor.setConsumerGroup('custom-group');

      // Verify it was set (internal state check via subsequent operations)
      expect(() => healthMonitor.setConsumerGroup('another-group')).not.toThrow();
    });

    it('should handle initialization race condition', async () => {
      resetStreamHealthMonitor();
      const monitor = getStreamHealthMonitor();

      // Trigger multiple concurrent initializations
      const promises = [
        monitor.checkStreamHealth(),
        monitor.checkStreamHealth(),
        monitor.checkStreamHealth()
      ];

      const results = await Promise.all(promises);

      // All should succeed without errors
      results.forEach(result => {
        expect(result).toBeDefined();
        expect(result.overall).toBeDefined();
      });
    });
  });

  // =========================================================================
  // S1.1.4: Migration Integration Tests
  // =========================================================================
  describe('S1.1.4: Pub/Sub to Streams Migration', () => {
    beforeEach(async () => {
      resetRedisStreamsInstance();
      streamsClient = await getRedisStreamsClient();
    });

    it('should publish price updates to streams with batching', async () => {
      const batcher = streamsClient.createBatcher(
        RedisStreamsClient.STREAMS.PRICE_UPDATES,
        { maxBatchSize: 50, maxWaitMs: 100 }
      );

      // Simulate detector publishing price updates
      const priceUpdates = [];
      for (let i = 0; i < 100; i++) {
        priceUpdates.push(createMockPriceUpdate({
          price0: 1800 + i * 0.1,
          timestamp: Date.now()
        }));
      }

      // Add all updates
      priceUpdates.forEach(update => {
        batcher.add({
          type: 'price-update',
          data: update,
          timestamp: Date.now(),
          source: 'bsc-detector'
        });
      });

      // Wait for batches to flush
      await delay(200);

      // Should have compressed 100 messages into 2 batches
      expect(mockRedis.xadd).toHaveBeenCalled();
      const callCount = mockRedis.xadd.mock.calls.length;
      expect(callCount).toBeLessThanOrEqual(3); // Max 3 batches for 100 messages

      await batcher.destroy();
    });

    it('should publish swap events to streams', async () => {
      const batcher = streamsClient.createBatcher(
        RedisStreamsClient.STREAMS.SWAP_EVENTS,
        { maxBatchSize: 100, maxWaitMs: 500 }
      );

      const swapEvent = createMockSwapEvent({
        amount0In: 1.5,
        amount1Out: 2700,
        timestamp: Date.now()
      });

      batcher.add({
        type: 'swap-event',
        data: swapEvent,
        timestamp: Date.now(),
        source: 'bsc-detector'
      });

      await batcher.flush();

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'stream:swap-events',
        '*',
        'data',
        expect.any(String)
      );

      await batcher.destroy();
    });

    it('should publish arbitrage opportunities directly (no batching)', async () => {
      const opportunity = {
        id: 'arb_test_123',
        sourceDex: 'pancakeswap',
        targetDex: 'biswap',
        estimatedProfit: 50,
        confidence: 0.9
      };

      await streamsClient.xadd(
        RedisStreamsClient.STREAMS.OPPORTUNITIES,
        {
          type: 'arbitrage-opportunity',
          data: opportunity,
          timestamp: Date.now(),
          source: 'bsc-detector'
        }
      );

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'stream:opportunities',
        '*',
        'data',
        expect.any(String)
      );
    });
  });

  // =========================================================================
  // Error Handling and Resilience Tests
  // =========================================================================
  describe('Error Handling and Resilience', () => {
    beforeEach(async () => {
      resetRedisStreamsInstance();
      streamsClient = await getRedisStreamsClient();
    });

    it('should handle Redis connection failures gracefully', async () => {
      mockRedis.ping.mockResolvedValueOnce(false);

      resetStreamHealthMonitor();
      const monitor = getStreamHealthMonitor();
      const alertHandler = jest.fn();
      monitor.onAlert(alertHandler);

      const health = await monitor.checkStreamHealth();

      expect(health.overall).toBe('critical');
      expect(alertHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stream_unavailable',
          severity: 'critical'
        })
      );
    });

    it('should re-queue failed messages in batcher', async () => {
      const batcher = streamsClient.createBatcher('stream:test', {
        maxBatchSize: 10,
        maxWaitMs: 1000
      });

      // Add messages
      for (let i = 0; i < 5; i++) {
        batcher.add({ index: i });
      }

      // Make xadd fail
      mockRedis.xadd.mockRejectedValueOnce(new Error('Connection refused'));

      // Flush should fail but re-queue messages
      await expect(batcher.flush()).rejects.toThrow('Connection refused');

      // Messages should still be in queue
      const stats = batcher.getStats();
      expect(stats.messagesQueued).toBe(5);

      await batcher.destroy();
    });

    it('should handle stream info errors gracefully', async () => {
      mockRedis.xinfo.mockRejectedValueOnce(new Error('Stream does not exist'));

      resetStreamHealthMonitor();
      const monitor = getStreamHealthMonitor();

      // Should not throw, but report unknown status
      const health = await monitor.checkStreamHealth();

      expect(health).toBeDefined();
      // Check if any stream has unknown status
      const hasUnknown = Object.values(health.streams).some(s => s.status === 'unknown');
      expect(hasUnknown).toBe(true);
    });
  });

  // =========================================================================
  // Performance Tests
  // =========================================================================
  describe('Performance Benchmarks', () => {
    beforeEach(async () => {
      resetRedisStreamsInstance();
      streamsClient = await getRedisStreamsClient();
    });

    it('should handle high throughput message publishing', async () => {
      const batcher = streamsClient.createBatcher('stream:perf-test', {
        maxBatchSize: 100,
        maxWaitMs: 50
      });

      const messageCount = 1000;
      const startTime = performance.now();

      // Publish messages
      for (let i = 0; i < messageCount; i++) {
        batcher.add({ index: i, timestamp: Date.now() });
      }

      // Wait for all batches to flush
      await delay(200);
      await batcher.flush();

      const endTime = performance.now();
      const duration = endTime - startTime;

      // Should complete in reasonable time (< 1 second for 1000 messages)
      expect(duration).toBeLessThan(1000);

      // Verify compression ratio
      const stats = batcher.getStats();
      expect(stats.compressionRatio).toBeGreaterThanOrEqual(10); // At least 10:1

      console.log(`Performance: ${messageCount} messages in ${duration.toFixed(2)}ms`);
      console.log(`Compression ratio: ${stats.compressionRatio.toFixed(1)}:1`);

      await batcher.destroy();
    });

    it('should have low latency for health checks', async () => {
      resetStreamHealthMonitor();
      const monitor = getStreamHealthMonitor();

      const iterations = 10;
      const times: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await monitor.checkStreamHealth();
        times.push(performance.now() - start);
      }

      const avgTime = times.reduce((a, b) => a + b, 0) / times.length;

      // Health checks should complete in < 100ms on average
      expect(avgTime).toBeLessThan(100);

      console.log(`Health check avg latency: ${avgTime.toFixed(2)}ms`);
    });
  });
});
