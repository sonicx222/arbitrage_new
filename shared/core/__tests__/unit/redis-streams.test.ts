/**
 * Redis Streams Client Tests
 *
 * TDD Test Suite for Redis Streams implementation
 * Tests: XADD, XREAD, XREADGROUP, XACK, Consumer Groups, Batching
 *
 * @migrated from shared/core/src/redis-streams.test.ts
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Import from package alias (new pattern per ADR-009)
import { RedisStreamsClient } from '@arbitrage/core';
import type { StreamMessage, ConsumerGroupConfig } from '@arbitrage/core';

// Mock ioredis
jest.mock('ioredis', () => {
  const mockRedis = {
    xadd: jest.fn<any>(),
    xread: jest.fn<any>(),
    xreadgroup: jest.fn<any>(),
    xack: jest.fn<any>(),
    xgroup: jest.fn<any>(),
    xinfo: jest.fn<any>(),
    xlen: jest.fn<any>(),
    xtrim: jest.fn<any>(),
    xpending: jest.fn<any>(),
    xclaim: jest.fn<any>(),
    ping: jest.fn<any>().mockResolvedValue('PONG'),
    disconnect: jest.fn<any>().mockResolvedValue(undefined),
    on: jest.fn<any>(),
    removeAllListeners: jest.fn<any>(),
  };
  return jest.fn<any>(() => mockRedis);
});

describe('RedisStreamsClient', () => {
  let client: RedisStreamsClient;
  let mockRedis: any;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new RedisStreamsClient('redis://localhost:6379');
    // Get the mock instance
    const Redis = require('ioredis');
    mockRedis = new Redis();
  });

  afterEach(async () => {
    await client.disconnect();
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
});
