/**
 * Redis Streams Client Tests
 *
 * TDD Test Suite for Redis Streams implementation
 * Tests: XADD, XREAD, XREADGROUP, XACK, Consumer Groups, Batching
 *
 * Uses DI pattern (P16) to inject mock Redis instead of Jest mock hoisting.
 *
 * @migrated from shared/core/src/redis-streams.test.ts
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';

// Import from package alias (new pattern per ADR-009)
import { RedisStreamsClient } from '@arbitrage/core';
import type { StreamMessage, ConsumerGroupConfig, RedisStreamsConstructor } from '@arbitrage/core';

// =============================================================================
// DI Mock Redis Implementation (P16 pattern)
// =============================================================================

/**
 * Creates a mock Redis instance with all required methods for RedisStreamsClient.
 */
function createMockRedisInstance() {
  const emitter = new EventEmitter();
  const instance: any = {};

  // Event methods
  instance.on = jest.fn((event: string, handler: (...args: any[]) => void) => {
    emitter.on(event, handler);
    return instance;
  });
  instance.removeAllListeners = jest.fn((event?: string) => {
    if (event) {
      emitter.removeAllListeners(event);
    } else {
      emitter.removeAllListeners();
    }
    return instance;
  });
  instance.emit = jest.fn((event: string, ...args: any[]) => {
    return emitter.emit(event, ...args);
  });

  // Stream operations
  instance.xadd = jest.fn();
  instance.xread = jest.fn();
  instance.xreadgroup = jest.fn();
  instance.xack = jest.fn();
  instance.xgroup = jest.fn();
  instance.xinfo = jest.fn();
  instance.xlen = jest.fn();
  instance.xtrim = jest.fn();
  instance.xpending = jest.fn();
  instance.xclaim = jest.fn();
  instance.ping = jest.fn(() => Promise.resolve('PONG'));
  instance.disconnect = jest.fn(() => Promise.resolve(undefined));
  instance.connect = jest.fn(() => Promise.resolve());

  return instance;
}

/**
 * Creates a mock Redis constructor for DI.
 */
function createMockRedisConstructor() {
  let mockInstance: any = null;

  const MockRedis = jest.fn(() => {
    mockInstance = createMockRedisInstance();
    return mockInstance;
  }) as unknown as RedisStreamsConstructor;

  return { MockRedis, getMockInstance: () => mockInstance };
}

describe('RedisStreamsClient', () => {
  let client: RedisStreamsClient;
  let mockRedis: any;
  let MockRedis: RedisStreamsConstructor;
  let getMockInstance: () => any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock Redis constructor
    const mocks = createMockRedisConstructor();
    MockRedis = mocks.MockRedis;
    getMockInstance = mocks.getMockInstance;

    // Create client with injected mock
    client = new RedisStreamsClient('redis://localhost:6379', undefined, {
      RedisImpl: MockRedis
    });

    // Get the mock instance for assertions
    mockRedis = getMockInstance();
  });

  afterEach(async () => {
    if (client && mockRedis) {
      mockRedis.disconnect.mockResolvedValue(undefined);
      await client.disconnect();
    }
  });

  describe('XADD - Adding messages to stream', () => {
    it('should add a message to a stream and return message ID', async () => {
      const streamName = 'stream:price-updates';
      const message = { type: 'price', chain: 'bsc', price: '100.5' };
      const expectedId = '1234567890-0';

      mockRedis.xadd.mockResolvedValue(expectedId);

      const messageId = await client.xadd(streamName, message);

      expect(messageId).toBe(expectedId);
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        streamName,
        '*',
        expect.any(String),
        expect.any(String)
      );
    });

    it('should add message with custom ID', async () => {
      const streamName = 'stream:test';
      const message = { data: 'test' };
      const customId = '1234567890-5';

      mockRedis.xadd.mockResolvedValue(customId);

      const messageId = await client.xadd(streamName, message, customId);

      expect(messageId).toBe(customId);
    });

    it('should validate stream name', async () => {
      const invalidStreamName = 'invalid stream name!@#';
      const message = { data: 'test' };

      await expect(client.xadd(invalidStreamName, message))
        .rejects
        .toThrow('Invalid stream name');
    });

    it('should serialize complex objects', async () => {
      const streamName = 'stream:test';
      const message = {
        type: 'price_update',
        data: {
          chain: 'bsc',
          dex: 'pancake',
          pair: 'WBNB_USDT',
          price: 300.5,
          timestamp: Date.now()
        }
      };

      mockRedis.xadd.mockResolvedValue('1234-0');

      await client.xadd(streamName, message);

      expect(mockRedis.xadd).toHaveBeenCalled();
    });
  });

  describe('XREAD - Reading from stream', () => {
    it('should read messages from stream starting from ID', async () => {
      const streamName = 'stream:test';
      const messages: StreamMessage[] = [
        { id: '1234-0', data: { type: 'test', value: 1 } },
        { id: '1234-1', data: { type: 'test', value: 2 } }
      ];

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', JSON.stringify({ type: 'test', value: 1 })]],
          ['1234-1', ['data', JSON.stringify({ type: 'test', value: 2 })]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('1234-0');
      expect(result[1].id).toBe('1234-1');
    });

    it('should return empty array when no messages', async () => {
      mockRedis.xread.mockResolvedValue(null);

      const result = await client.xread('stream:test', '0');

      expect(result).toEqual([]);
    });

    it('should support COUNT option', async () => {
      const streamName = 'stream:test';

      mockRedis.xread.mockResolvedValue(null);

      await client.xread(streamName, '0', { count: 10 });

      expect(mockRedis.xread).toHaveBeenCalledWith(
        'COUNT', 10,
        'STREAMS', streamName, '0'
      );
    });

    it('should support BLOCK option for blocking read', async () => {
      const streamName = 'stream:test';

      mockRedis.xread.mockResolvedValue(null);

      await client.xread(streamName, '$', { block: 1000 });

      expect(mockRedis.xread).toHaveBeenCalledWith(
        'BLOCK', 1000,
        'STREAMS', streamName, '$'
      );
    });
  });

  describe('Consumer Groups', () => {
    it('should create a consumer group', async () => {
      const config: ConsumerGroupConfig = {
        streamName: 'stream:test',
        groupName: 'arbitrage-detectors',
        consumerName: 'detector-1'
      };

      mockRedis.xgroup.mockResolvedValue('OK');

      await client.createConsumerGroup(config);

      expect(mockRedis.xgroup).toHaveBeenCalledWith(
        'CREATE',
        config.streamName,
        config.groupName,
        '$',
        'MKSTREAM'
      );
    });

    it('should handle group already exists error gracefully', async () => {
      const config: ConsumerGroupConfig = {
        streamName: 'stream:test',
        groupName: 'existing-group',
        consumerName: 'consumer-1'
      };

      mockRedis.xgroup.mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists'));

      // Should not throw
      await expect(client.createConsumerGroup(config)).resolves.not.toThrow();
    });

    it('should create group starting from specific ID', async () => {
      const config: ConsumerGroupConfig = {
        streamName: 'stream:test',
        groupName: 'group-1',
        consumerName: 'consumer-1',
        startId: '0'  // Start from beginning
      };

      mockRedis.xgroup.mockResolvedValue('OK');

      await client.createConsumerGroup(config);

      expect(mockRedis.xgroup).toHaveBeenCalledWith(
        'CREATE',
        config.streamName,
        config.groupName,
        '0',
        'MKSTREAM'
      );
    });
  });

  describe('XREADGROUP - Consumer group reads', () => {
    it('should read new messages for consumer group', async () => {
      const config: ConsumerGroupConfig = {
        streamName: 'stream:test',
        groupName: 'group-1',
        consumerName: 'consumer-1'
      };

      mockRedis.xreadgroup.mockResolvedValue([
        ['stream:test', [
          ['1234-0', ['data', JSON.stringify({ value: 'test' })]]
        ]]
      ]);

      const messages = await client.xreadgroup(config);

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('1234-0');
      expect(mockRedis.xreadgroup).toHaveBeenCalledWith(
        'GROUP', config.groupName, config.consumerName,
        'STREAMS', config.streamName, '>'
      );
    });

    it('should support COUNT option in XREADGROUP', async () => {
      const config: ConsumerGroupConfig = {
        streamName: 'stream:test',
        groupName: 'group-1',
        consumerName: 'consumer-1'
      };

      mockRedis.xreadgroup.mockResolvedValue(null);

      await client.xreadgroup(config, { count: 50 });

      expect(mockRedis.xreadgroup).toHaveBeenCalledWith(
        'GROUP', config.groupName, config.consumerName,
        'COUNT', 50,
        'STREAMS', config.streamName, '>'
      );
    });

    it('should support BLOCK option for blocking group read', async () => {
      const config: ConsumerGroupConfig = {
        streamName: 'stream:test',
        groupName: 'group-1',
        consumerName: 'consumer-1'
      };

      mockRedis.xreadgroup.mockResolvedValue(null);

      await client.xreadgroup(config, { block: 5000 });

      expect(mockRedis.xreadgroup).toHaveBeenCalledWith(
        'GROUP', config.groupName, config.consumerName,
        'BLOCK', 5000,
        'STREAMS', config.streamName, '>'
      );
    });

    it('should read pending messages when specifying ID', async () => {
      const config: ConsumerGroupConfig = {
        streamName: 'stream:test',
        groupName: 'group-1',
        consumerName: 'consumer-1'
      };

      mockRedis.xreadgroup.mockResolvedValue(null);

      await client.xreadgroup(config, { startId: '0' }); // Read pending from beginning

      expect(mockRedis.xreadgroup).toHaveBeenCalledWith(
        'GROUP', config.groupName, config.consumerName,
        'STREAMS', config.streamName, '0'
      );
    });
  });

  describe('XACK - Acknowledging messages', () => {
    it('should acknowledge single message', async () => {
      const streamName = 'stream:test';
      const groupName = 'group-1';
      const messageId = '1234-0';

      mockRedis.xack.mockResolvedValue(1);

      const acknowledged = await client.xack(streamName, groupName, messageId);

      expect(acknowledged).toBe(1);
      expect(mockRedis.xack).toHaveBeenCalledWith(streamName, groupName, messageId);
    });

    it('should acknowledge multiple messages', async () => {
      const streamName = 'stream:test';
      const groupName = 'group-1';
      const messageIds = ['1234-0', '1234-1', '1234-2'];

      mockRedis.xack.mockResolvedValue(3);

      const acknowledged = await client.xack(streamName, groupName, ...messageIds);

      expect(acknowledged).toBe(3);
      expect(mockRedis.xack).toHaveBeenCalledWith(streamName, groupName, ...messageIds);
    });

    it('should return 0 when acknowledging non-existent message', async () => {
      mockRedis.xack.mockResolvedValue(0);

      const acknowledged = await client.xack('stream:test', 'group-1', 'nonexistent-id');

      expect(acknowledged).toBe(0);
    });
  });

  describe('Stream Information', () => {
    it('should get stream length', async () => {
      mockRedis.xlen.mockResolvedValue(100);

      const length = await client.xlen('stream:test');

      expect(length).toBe(100);
    });

    it('should get stream info', async () => {
      mockRedis.xinfo.mockResolvedValue([
        'length', 100,
        'radix-tree-keys', 1,
        'radix-tree-nodes', 2,
        'last-generated-id', '1234-0',
        'groups', 2
      ]);

      const info = await client.xinfo('stream:test');

      expect(info.length).toBe(100);
      expect(info.lastGeneratedId).toBe('1234-0');
      expect(info.groups).toBe(2);
    });

    it('should get pending messages info', async () => {
      mockRedis.xpending.mockResolvedValue([
        5, // Total pending
        '1234-0', // Smallest ID
        '1234-4', // Largest ID
        [['consumer-1', '3'], ['consumer-2', '2']] // Consumer pending counts
      ]);

      const pending = await client.xpending('stream:test', 'group-1');

      expect(pending.total).toBe(5);
      expect(pending.smallestId).toBe('1234-0');
      expect(pending.largestId).toBe('1234-4');
    });
  });

  describe('Stream Trimming', () => {
    it('should trim stream by max length', async () => {
      mockRedis.xtrim.mockResolvedValue(50);

      const trimmed = await client.xtrim('stream:test', { maxLen: 1000 });

      expect(trimmed).toBe(50);
      expect(mockRedis.xtrim).toHaveBeenCalledWith('stream:test', 'MAXLEN', '~', 1000);
    });

    it('should trim stream by min ID', async () => {
      mockRedis.xtrim.mockResolvedValue(100);

      const trimmed = await client.xtrim('stream:test', { minId: '1234-0' });

      expect(trimmed).toBe(100);
      expect(mockRedis.xtrim).toHaveBeenCalledWith('stream:test', 'MINID', '~', '1234-0');
    });
  });

  describe('Batching', () => {
    it('should batch multiple messages before sending', async () => {
      mockRedis.xadd.mockResolvedValue('1234-0');

      const batcher = client.createBatcher('stream:test', {
        maxBatchSize: 3,
        maxWaitMs: 1000
      });

      // Add messages without immediately sending
      batcher.add({ type: 'price', value: 1 });
      batcher.add({ type: 'price', value: 2 });

      // Should not have sent yet (batch size not reached)
      expect(mockRedis.xadd).not.toHaveBeenCalled();

      // Add third message to trigger batch
      batcher.add({ type: 'price', value: 3 });

      // Wait for batch to be processed
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should have sent one batched message
      expect(mockRedis.xadd).toHaveBeenCalledTimes(1);

      batcher.destroy();
    });

    it('should flush batch on timeout', async () => {
      mockRedis.xadd.mockResolvedValue('1234-0');

      const batcher = client.createBatcher('stream:test', {
        maxBatchSize: 100,
        maxWaitMs: 50
      });

      batcher.add({ type: 'price', value: 1 });

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(mockRedis.xadd).toHaveBeenCalled();

      batcher.destroy();
    });

    it('should provide batch statistics', async () => {
      mockRedis.xadd.mockResolvedValue('1234-0');

      const batcher = client.createBatcher('stream:test', {
        maxBatchSize: 2,
        maxWaitMs: 1000
      });

      batcher.add({ value: 1 });
      batcher.add({ value: 2 });

      await new Promise(resolve => setTimeout(resolve, 10));

      const stats = batcher.getStats();

      expect(stats.totalMessagesQueued).toBeDefined();
      expect(stats.currentQueueSize).toBeDefined();
      expect(stats.batchesSent).toBeGreaterThanOrEqual(1);
      expect(stats.compressionRatio).toBeDefined();

      batcher.destroy();
    });
  });

  describe('Error Handling', () => {
    it('should handle connection errors gracefully', async () => {
      mockRedis.xadd.mockRejectedValue(new Error('Connection refused'));

      await expect(client.xadd('stream:test', { data: 'test' }))
        .rejects
        .toThrow('Connection refused');
    });

    it('should retry on transient failures', async () => {
      // First call fails, second succeeds
      mockRedis.xadd
        .mockRejectedValueOnce(new Error('BUSY'))
        .mockResolvedValueOnce('1234-0');

      const messageId = await client.xadd('stream:test', { data: 'test' }, undefined, { retry: true });

      expect(messageId).toBe('1234-0');
      expect(mockRedis.xadd).toHaveBeenCalledTimes(2);
    });
  });

  describe('Health Check', () => {
    it('should return true when Redis is healthy', async () => {
      mockRedis.ping.mockResolvedValue('PONG');

      const isHealthy = await client.ping();

      expect(isHealthy).toBe(true);
    });

    it('should return false when Redis is unhealthy', async () => {
      mockRedis.ping.mockRejectedValue(new Error('Connection lost'));

      const isHealthy = await client.ping();

      expect(isHealthy).toBe(false);
    });
  });

  describe('Stream Constants', () => {
    it('should export standard stream names', () => {
      expect(RedisStreamsClient.STREAMS.PRICE_UPDATES).toBe('stream:price-updates');
      expect(RedisStreamsClient.STREAMS.SWAP_EVENTS).toBe('stream:swap-events');
      expect(RedisStreamsClient.STREAMS.OPPORTUNITIES).toBe('stream:opportunities');
      expect(RedisStreamsClient.STREAMS.WHALE_ALERTS).toBe('stream:whale-alerts');
      expect(RedisStreamsClient.STREAMS.VOLUME_AGGREGATES).toBe('stream:volume-aggregates');
      expect(RedisStreamsClient.STREAMS.HEALTH).toBe('stream:health');
    });
  });

  // =============================================================================
  // Deep Dive Analysis Regression Tests
  // =============================================================================

  describe('Deep Dive Regression: StreamBatcher Message Loss Prevention', () => {
    it('should re-queue messages when flush fails', async () => {
      // Simulate flush failure then success
      mockRedis.xadd
        .mockRejectedValueOnce(new Error('Redis connection lost'))
        .mockResolvedValueOnce('1234-0');

      const batcher = client.createBatcher('stream:test', {
        maxBatchSize: 2,
        maxWaitMs: 1000
      });

      // Add messages to trigger batch
      batcher.add({ value: 1 });
      batcher.add({ value: 2 });

      // Wait for first (failed) flush attempt
      await new Promise(resolve => setTimeout(resolve, 50));

      // First call should have failed
      expect(mockRedis.xadd).toHaveBeenCalledTimes(1);

      // Messages should still be in queue - verify by checking stats
      const statsAfterFailure = batcher.getStats();
      expect(statsAfterFailure.currentQueueSize).toBe(2);

      // Manual flush to retry
      await batcher.flush();

      // Second call should succeed
      expect(mockRedis.xadd).toHaveBeenCalledTimes(2);

      // Messages should now be sent
      const statsAfterSuccess = batcher.getStats();
      expect(statsAfterSuccess.currentQueueSize).toBe(0);
      expect(statsAfterSuccess.totalMessagesSent).toBe(2);

      await batcher.destroy();
    });

    it('should preserve message order when re-queuing after failure', async () => {
      // Track the order of messages sent
      const sentMessages: any[] = [];
      mockRedis.xadd
        .mockRejectedValueOnce(new Error('Redis connection lost'))
        .mockImplementation(async (_stream: string, _id: string, _field: string, value: string) => {
          sentMessages.push(JSON.parse(value));
          return '1234-0';
        });

      const batcher = client.createBatcher('stream:test', {
        maxBatchSize: 3,
        maxWaitMs: 1000
      });

      // Add messages
      batcher.add({ order: 1 });
      batcher.add({ order: 2 });
      batcher.add({ order: 3 }); // Triggers flush

      // Wait for failed flush
      await new Promise(resolve => setTimeout(resolve, 50));

      // Retry
      await batcher.flush();

      // Verify messages were sent in order
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0].messages).toEqual([
        { order: 1 },
        { order: 2 },
        { order: 3 }
      ]);

      await batcher.destroy();
    });

    /**
     * P0-2 Regression Test: Messages added DURING flush must not be lost.
     * This tests the pendingDuringFlush queue that prevents race condition where
     * messages could be lost between queue swap and error re-queue.
     */
    it('should not lose messages added during flush operation', async () => {
      // Create a slow flush that allows messages to be added mid-flush
      let flushResolve: () => void;
      const flushPromise = new Promise<void>(resolve => { flushResolve = resolve; });

      mockRedis.xadd.mockImplementation(async () => {
        // Wait for external signal before completing
        await flushPromise;
        return '1234-0';
      });

      const batcher = client.createBatcher('stream:test', {
        maxBatchSize: 2,
        maxWaitMs: 5000 // Long timeout so only batch size triggers flush
      });

      // Add 2 messages to trigger flush
      batcher.add({ id: 1, phase: 'before_flush' });
      batcher.add({ id: 2, phase: 'before_flush' }); // Triggers flush

      // Wait for flush to start (async)
      await new Promise(resolve => setTimeout(resolve, 10));

      // Flush is now in progress - add messages that should go to pendingDuringFlush
      batcher.add({ id: 3, phase: 'during_flush' });
      batcher.add({ id: 4, phase: 'during_flush' });

      // Verify pending messages are counted in stats
      const statsWhileFlushing = batcher.getStats();
      expect(statsWhileFlushing.currentQueueSize).toBe(2); // pendingDuringFlush should be included

      // Complete the flush
      flushResolve!();
      await new Promise(resolve => setTimeout(resolve, 10));

      // Messages 3 and 4 should now be in the main queue
      const statsAfterFlush = batcher.getStats();
      expect(statsAfterFlush.currentQueueSize).toBe(2); // Should have messages 3 and 4
      expect(statsAfterFlush.totalMessagesSent).toBe(2); // Messages 1 and 2 sent

      // Flush again to send remaining messages
      await batcher.flush();

      const finalStats = batcher.getStats();
      expect(finalStats.currentQueueSize).toBe(0);
      expect(finalStats.totalMessagesSent).toBe(4); // All 4 messages sent

      await batcher.destroy();
    });
  });

  describe('Deep Dive Regression: Consumer Group Race Condition', () => {
    it('should handle BUSYGROUP error gracefully', async () => {
      // Simulate group already exists
      mockRedis.xgroup.mockRejectedValue(new Error('BUSYGROUP Consumer group already exists'));

      const config: ConsumerGroupConfig = {
        streamName: 'stream:test',
        groupName: 'existing-group',
        consumerName: 'consumer-1'
      };

      // Should not throw
      await expect(client.createConsumerGroup(config)).resolves.toBeUndefined();
    });

    it('should throw on non-BUSYGROUP errors', async () => {
      mockRedis.xgroup.mockRejectedValue(new Error('NOAUTH Authentication required'));

      const config: ConsumerGroupConfig = {
        streamName: 'stream:test',
        groupName: 'test-group',
        consumerName: 'consumer-1'
      };

      await expect(client.createConsumerGroup(config)).rejects.toThrow('NOAUTH');
    });
  });

  describe('Deep Dive Regression: XREAD Block Time Safety', () => {
    it('should cap block time to prevent indefinite blocking', async () => {
      mockRedis.xread.mockResolvedValue(null);

      // Request forever block (0) but should be capped
      await client.xread('stream:test', '0', { block: 0 });

      // Verify BLOCK was capped to 30000 (default maxBlockMs)
      expect(mockRedis.xread).toHaveBeenCalledWith(
        'BLOCK', 30000,
        'STREAMS', 'stream:test', '0'
      );
    });

    it('should cap excessive block times', async () => {
      mockRedis.xread.mockResolvedValue(null);

      // Request very long block time
      await client.xread('stream:test', '0', { block: 300000 });

      // Verify BLOCK was capped
      expect(mockRedis.xread).toHaveBeenCalledWith(
        'BLOCK', 30000,
        'STREAMS', 'stream:test', '0'
      );
    });

    it('should allow custom maxBlockMs override', async () => {
      mockRedis.xread.mockResolvedValue(null);

      await client.xread('stream:test', '0', { block: 0, maxBlockMs: 60000 });

      expect(mockRedis.xread).toHaveBeenCalledWith(
        'BLOCK', 60000,
        'STREAMS', 'stream:test', '0'
      );
    });
  });

  describe('Deep Dive Regression: Stream MAXLEN Limits', () => {
    it('should have recommended MAXLEN values for all streams', () => {
      expect(RedisStreamsClient.STREAM_MAX_LENGTHS).toBeDefined();
      expect(RedisStreamsClient.STREAM_MAX_LENGTHS[RedisStreamsClient.STREAMS.PRICE_UPDATES]).toBe(100000);
      expect(RedisStreamsClient.STREAM_MAX_LENGTHS[RedisStreamsClient.STREAMS.SWAP_EVENTS]).toBe(50000);
      expect(RedisStreamsClient.STREAM_MAX_LENGTHS[RedisStreamsClient.STREAMS.OPPORTUNITIES]).toBe(10000);
      expect(RedisStreamsClient.STREAM_MAX_LENGTHS[RedisStreamsClient.STREAMS.WHALE_ALERTS]).toBe(5000);
      expect(RedisStreamsClient.STREAM_MAX_LENGTHS[RedisStreamsClient.STREAMS.VOLUME_AGGREGATES]).toBe(10000);
      expect(RedisStreamsClient.STREAM_MAX_LENGTHS[RedisStreamsClient.STREAMS.HEALTH]).toBe(1000);
    });

    it('should use approximate MAXLEN for better performance', async () => {
      mockRedis.xadd.mockResolvedValue('1234-0');

      await client.xaddWithLimit('stream:price-updates', { price: 100 });

      // Verify approximate (~) MAXLEN was used
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'stream:price-updates',
        'MAXLEN', '~', '100000',
        '*',
        'data', expect.any(String)
      );
    });
  });
});

// =============================================================================
// StreamConsumer Tests (P0-4 FIX: Previously 0% coverage on critical class)
// =============================================================================

import { StreamConsumer } from '@arbitrage/core';
import type { StreamConsumerConfig, StreamConsumerStats } from '@arbitrage/core';

/**
 * Helper to create a mock handler that matches StreamConsumerConfig.handler signature.
 * We use `any` for the mock return type to avoid complex Jest type gymnastics.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createMockHandler = (): any => jest.fn();

describe('StreamConsumer', () => {
  let client: RedisStreamsClient;
  let mockRedis: any;
  let MockRedis: RedisStreamsConstructor;
  let getMockInstance: () => any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Create mock Redis constructor
    const mocks = createMockRedisConstructor();
    MockRedis = mocks.MockRedis;
    getMockInstance = mocks.getMockInstance;

    // Create client with injected mock
    client = new RedisStreamsClient('redis://localhost:6379', undefined, {
      RedisImpl: MockRedis
    });

    mockRedis = getMockInstance();
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (client && mockRedis) {
      mockRedis.disconnect.mockResolvedValue(undefined);
      await client.disconnect();
    }
  });

  describe('Lifecycle', () => {
    it('should start consuming messages when start() is called', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        batchSize: 10,
        blockMs: 1000
      };

      // Mock xreadgroup to return empty initially
      mockRedis.xreadgroup.mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      expect(consumer.getStats().isRunning).toBe(true);

      await consumer.stop();
    });

    it('should stop consuming when stop() is called', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 0 // Non-blocking for test
      };

      mockRedis.xreadgroup.mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      expect(consumer.getStats().isRunning).toBe(true);

      await consumer.stop();

      expect(consumer.getStats().isRunning).toBe(false);
    });

    it('should not start if already running', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler
      };

      mockRedis.xreadgroup.mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();
      consumer.start(); // Second start should be no-op

      expect(consumer.getStats().isRunning).toBe(true);

      await consumer.stop();
    });
  });

  describe('Message Processing', () => {
    it('should call handler for each received message', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 0
      };

      // Mock message response
      const mockMessages = [
        ['stream:test', [
          ['1234-0', ['data', '{"type":"test","value":1}']],
          ['1234-1', ['data', '{"type":"test","value":2}']]
        ]]
      ];

      mockRedis.xreadgroup
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValue(null);
      mockRedis.xack.mockResolvedValue(1);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      // Advance timers to allow poll to complete
      await jest.advanceTimersByTimeAsync(100);

      // Handler should have been called for each message
      expect(handler).toHaveBeenCalledTimes(2);

      await consumer.stop();
    });

    it('should auto-acknowledge messages after successful processing', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        autoAck: true,
        blockMs: 0
      };

      const mockMessages = [
        ['stream:test', [
          ['1234-0', ['data', '{"type":"test"}']]
        ]]
      ];

      mockRedis.xreadgroup
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValue(null);
      mockRedis.xack.mockResolvedValue(1);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      await jest.advanceTimersByTimeAsync(100);

      // Should have called xack for the message
      expect(mockRedis.xack).toHaveBeenCalledWith(
        'stream:test',
        'test-group',
        '1234-0'
      );

      await consumer.stop();
    });

    it('should NOT acknowledge messages when autoAck is false', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        autoAck: false,
        blockMs: 0
      };

      const mockMessages = [
        ['stream:test', [
          ['1234-0', ['data', '{"type":"test"}']]
        ]]
      ];

      mockRedis.xreadgroup
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      await jest.advanceTimersByTimeAsync(100);

      // Should NOT have called xack
      expect(mockRedis.xack).not.toHaveBeenCalled();

      await consumer.stop();
    });

    it('should NOT acknowledge messages when handler fails', async () => {
      const handler = createMockHandler().mockRejectedValue(new Error('Handler error'));
      const logger = { error: jest.fn(), debug: jest.fn() };
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        autoAck: true,
        blockMs: 0,
        logger
      };

      const mockMessages = [
        ['stream:test', [
          ['1234-0', ['data', '{"type":"test"}']]
        ]]
      ];

      mockRedis.xreadgroup
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      await jest.advanceTimersByTimeAsync(100);

      // Should NOT acknowledge failed message
      expect(mockRedis.xack).not.toHaveBeenCalled();

      // Should have logged error
      expect(logger.error).toHaveBeenCalled();

      await consumer.stop();
    });
  });

  describe('Statistics', () => {
    it('should track messages processed', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 0
      };

      const mockMessages = [
        ['stream:test', [
          ['1234-0', ['data', '{"type":"test"}']],
          ['1234-1', ['data', '{"type":"test"}']]
        ]]
      ];

      mockRedis.xreadgroup
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValue(null);
      mockRedis.xack.mockResolvedValue(1);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      await jest.advanceTimersByTimeAsync(100);

      const stats = consumer.getStats();
      expect(stats.messagesProcessed).toBe(2);
      expect(stats.messagesFailed).toBe(0);
      expect(stats.lastProcessedAt).not.toBeNull();

      await consumer.stop();
    });

    it('should track failed messages', async () => {
      const handler = createMockHandler().mockRejectedValue(new Error('Handler error'));
      const logger = { error: jest.fn(), debug: jest.fn() };
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 0,
        logger
      };

      const mockMessages = [
        ['stream:test', [
          ['1234-0', ['data', '{"type":"test"}']]
        ]]
      ];

      mockRedis.xreadgroup
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      await jest.advanceTimersByTimeAsync(100);

      const stats = consumer.getStats();
      expect(stats.messagesProcessed).toBe(0);
      expect(stats.messagesFailed).toBe(1);

      await consumer.stop();
    });
  });

  describe('Backpressure (Pause/Resume)', () => {
    it('should pause consumption when pause() is called', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 0
      };

      mockRedis.xreadgroup.mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      expect(consumer.isPaused()).toBe(false);

      consumer.pause();

      expect(consumer.isPaused()).toBe(true);
      expect(consumer.getStats().isPaused).toBe(true);

      await consumer.stop();
    });

    it('should resume consumption when resume() is called', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 0
      };

      mockRedis.xreadgroup.mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();
      consumer.pause();

      expect(consumer.isPaused()).toBe(true);

      consumer.resume();

      expect(consumer.isPaused()).toBe(false);
      expect(consumer.getStats().isPaused).toBe(false);

      await consumer.stop();
    });

    it('should call onPauseStateChange callback when pause state changes', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const onPauseStateChange = jest.fn();
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        onPauseStateChange,
        blockMs: 0
      };

      mockRedis.xreadgroup.mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      consumer.pause();
      expect(onPauseStateChange).toHaveBeenCalledWith(true);

      consumer.resume();
      expect(onPauseStateChange).toHaveBeenCalledWith(false);

      await consumer.stop();
    });

    it('should not process messages while paused', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 0
      };

      const mockMessages = [
        ['stream:test', [
          ['1234-0', ['data', '{"type":"test"}']]
        ]]
      ];

      // Initially return no messages, then set up messages after pause
      mockRedis.xreadgroup.mockResolvedValue(null);
      mockRedis.xack.mockResolvedValue(1);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      // Let initial poll complete with no messages
      await jest.advanceTimersByTimeAsync(10);

      // Now pause the consumer
      consumer.pause();

      // Clear any calls from before pause
      handler.mockClear();
      mockRedis.xreadgroup.mockClear();

      // Now set up messages to be returned (if poll runs)
      mockRedis.xreadgroup.mockResolvedValue(mockMessages);

      // Advance time - poll should NOT run while paused
      await jest.advanceTimersByTimeAsync(1000);

      // Should not have called xreadgroup while paused
      expect(mockRedis.xreadgroup).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();

      await consumer.stop();
    });
  });

  describe('Error Handling', () => {
    it('should continue polling after stream read error', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const logger = { error: jest.fn(), debug: jest.fn() };
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 0,
        logger
      };

      // First call fails, subsequent calls succeed
      mockRedis.xreadgroup
        .mockRejectedValueOnce(new Error('Connection error'))
        .mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      // First poll fails
      await jest.advanceTimersByTimeAsync(100);

      // Should have logged error
      expect(logger.error).toHaveBeenCalled();

      // Consumer should still be running
      expect(consumer.getStats().isRunning).toBe(true);

      await consumer.stop();
    });

    it('should ignore timeout errors from blocking read', async () => {
      const handler = createMockHandler().mockResolvedValue(undefined);
      const logger = { error: jest.fn(), debug: jest.fn() };
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 1000,
        logger
      };

      // Simulate timeout error from blocking read
      mockRedis.xreadgroup
        .mockRejectedValueOnce(new Error('read timeout'))
        .mockResolvedValue(null);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      await jest.advanceTimersByTimeAsync(100);

      // Should NOT have logged error for timeout
      expect(logger.error).not.toHaveBeenCalled();

      await consumer.stop();
    });
  });
});
