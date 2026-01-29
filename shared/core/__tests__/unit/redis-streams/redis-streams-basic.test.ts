/**
 * Redis Streams Basic Operations Tests
 *
 * Tests for basic Redis Streams operations:
 * - XADD: Adding messages to stream
 * - XREAD: Reading from stream
 * - Stream Information (XLEN, XINFO)
 * - Stream Trimming (XTRIM)
 * - Health Check (PING)
 * - Stream Constants
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RedisStreamsClient } from '@arbitrage/core';
import type { StreamMessage, RedisStreamsConstructor } from '@arbitrage/core';
import { createMockRedisConstructor } from './test-helpers';

describe('RedisStreamsClient - Basic Operations', () => {
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

  describe('XREAD Block Time Safety', () => {
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

  describe('Stream MAXLEN Limits', () => {
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
