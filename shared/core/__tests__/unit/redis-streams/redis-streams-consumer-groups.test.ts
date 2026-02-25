/**
 * Redis Streams Consumer Groups Tests
 *
 * Tests for Consumer Group operations and batching:
 * - Consumer Groups: XGROUP CREATE
 * - XREADGROUP: Consumer group reads
 * - XACK: Acknowledging messages
 * - Batching: StreamBatcher
 * - Deep Dive Regression Tests
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RedisStreamsClient } from '@arbitrage/core/redis';
import type { ConsumerGroupConfig, RedisStreamsConstructor } from '@arbitrage/core/redis';
import { createMockRedisConstructor } from './test-helpers';

describe('RedisStreamsClient - Consumer Groups', () => {
  let client: RedisStreamsClient;
  let mockRedis: any;
  let MockRedis: RedisStreamsConstructor;
  let getMockInstance: () => any;

  beforeEach(() => {
    jest.clearAllMocks();

    const mocks = createMockRedisConstructor();
    MockRedis = mocks.MockRedis;
    getMockInstance = mocks.getMockInstance;

    client = new RedisStreamsClient('redis://localhost:6379', undefined, {
      RedisImpl: MockRedis
    });

    mockRedis = getMockInstance();
  });

  afterEach(async () => {
    if (client && mockRedis) {
      mockRedis.disconnect.mockResolvedValue(undefined);
      await client.disconnect();
    }
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

  // ===========================================================================
  // Phase 0 Regression: totalBatchFlushes counter
  // ===========================================================================

  describe('Phase 0 Regression: totalBatchFlushes counter', () => {
    it('should increment totalBatchFlushes after each successful flush', async () => {
      mockRedis.xadd.mockResolvedValue('1234-0');

      const batcher = client.createBatcher('stream:test', {
        maxBatchSize: 2,
        maxWaitMs: 1000,
      });

      // Initial stats should have 0 commands
      expect(batcher.getStats().totalBatchFlushes).toBe(0);

      // Add 2 messages to trigger batch-size flush
      batcher.add({ value: 1 });
      batcher.add({ value: 2 });
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(batcher.getStats().totalBatchFlushes).toBe(1);
      expect(batcher.getStats().batchesSent).toBe(1);

      // Second batch
      batcher.add({ value: 3 });
      batcher.add({ value: 4 });
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(batcher.getStats().totalBatchFlushes).toBe(2);
      expect(batcher.getStats().batchesSent).toBe(2);

      await batcher.destroy();
    });

    it('should not increment totalBatchFlushes on failed flush', async () => {
      mockRedis.xadd.mockRejectedValueOnce(new Error('Redis connection lost'));

      const batcher = client.createBatcher('stream:test', {
        maxBatchSize: 2,
        maxWaitMs: 1000,
      });

      batcher.add({ value: 1 });
      batcher.add({ value: 2 });

      // Wait for auto-flush to trigger (and fail)
      await new Promise(resolve => setTimeout(resolve, 10));

      const stats = batcher.getStats();
      expect(stats.totalBatchFlushes).toBe(0);
      expect(stats.batchesSent).toBe(0);
      // Messages should be re-queued
      expect(stats.currentQueueSize).toBe(2);

      await batcher.destroy();
    });
  });
});
