/**
 * Dual Publish Utility Tests
 *
 * Tests for the dualPublish() function that publishes messages to both
 * Redis Streams (primary, ADR-002) and Pub/Sub (secondary/fallback).
 *
 * @see shared/core/src/resilience/dual-publish.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { dualPublish } from '../../../src/resilience/dual-publish';
import type { RedisStreamsClient } from '../../../src/redis/streams';
import { createInlineRedisMock } from '@arbitrage/test-utils';

// Mock the logger to suppress output and enable assertion on log calls
jest.mock('../../../src/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(),
  })),
}));

describe('dualPublish', () => {
  // Mock Redis Pub/Sub client - needs to satisfy RedisClient interface
  let mockRedis: ReturnType<typeof createInlineRedisMock>;

  // Mock Redis Streams client
  let mockStreamsClient: { xadd: jest.Mock<(...args: any[]) => Promise<any>> };

  const testStreamName = 'stream:test-events';
  const testPubsubChannel = 'test:events';
  const testMessage = { type: 'test', data: { foo: 'bar' }, timestamp: Date.now() };

  beforeEach(() => {
    mockRedis = createInlineRedisMock();

    mockStreamsClient = {
      xadd: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue('1234567890-0'),
    };
  });

  describe('initialization and basic behavior', () => {
    it('should be a callable function', () => {
      expect(typeof dualPublish).toBe('function');
    });

    it('should return a Promise', () => {
      const result = dualPublish(
        mockStreamsClient as unknown as RedisStreamsClient,
        mockRedis as any,
        testStreamName,
        testPubsubChannel,
        testMessage
      );

      expect(result).toBeInstanceOf(Promise);
    });

    it('should resolve without throwing when both clients succeed', async () => {
      await expect(
        dualPublish(
          mockStreamsClient as unknown as RedisStreamsClient,
          mockRedis as any,
          testStreamName,
          testPubsubChannel,
          testMessage
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('successful dual publish (both targets)', () => {
    it('should publish to Redis Streams when streams client is available', async () => {
      await dualPublish(
        mockStreamsClient as unknown as RedisStreamsClient,
        mockRedis as any,
        testStreamName,
        testPubsubChannel,
        testMessage
      );

      expect(mockStreamsClient.xadd).toHaveBeenCalledTimes(1);
      expect(mockStreamsClient.xadd).toHaveBeenCalledWith(testStreamName, testMessage);
    });

    it('should publish to Pub/Sub channel', async () => {
      await dualPublish(
        mockStreamsClient as unknown as RedisStreamsClient,
        mockRedis as any,
        testStreamName,
        testPubsubChannel,
        testMessage
      );

      expect(mockRedis.publish).toHaveBeenCalledTimes(1);
      expect(mockRedis.publish).toHaveBeenCalledWith(testPubsubChannel, testMessage);
    });

    it('should publish to both targets when both clients are available', async () => {
      await dualPublish(
        mockStreamsClient as unknown as RedisStreamsClient,
        mockRedis as any,
        testStreamName,
        testPubsubChannel,
        testMessage
      );

      expect(mockStreamsClient.xadd).toHaveBeenCalledTimes(1);
      expect(mockRedis.publish).toHaveBeenCalledTimes(1);
    });

    it('should pass different stream and channel names correctly', async () => {
      const customStream = 'stream:custom-alerts';
      const customChannel = 'alerts:custom';

      await dualPublish(
        mockStreamsClient as unknown as RedisStreamsClient,
        mockRedis as any,
        customStream,
        customChannel,
        testMessage
      );

      expect(mockStreamsClient.xadd).toHaveBeenCalledWith(customStream, testMessage);
      expect(mockRedis.publish).toHaveBeenCalledWith(customChannel, testMessage);
    });
  });

  describe('partial failure (one target fails, other succeeds)', () => {
    it('should still publish to Pub/Sub when Streams fails', async () => {
      mockStreamsClient.xadd.mockRejectedValueOnce(new Error('Stream unavailable'));

      await dualPublish(
        mockStreamsClient as unknown as RedisStreamsClient,
        mockRedis as any,
        testStreamName,
        testPubsubChannel,
        testMessage
      );

      // Streams failed but Pub/Sub should still succeed
      expect(mockStreamsClient.xadd).toHaveBeenCalledTimes(1);
      expect(mockRedis.publish).toHaveBeenCalledTimes(1);
    });

    it('should not throw when Streams fails but Pub/Sub succeeds', async () => {
      mockStreamsClient.xadd.mockRejectedValueOnce(new Error('Stream write error'));

      await expect(
        dualPublish(
          mockStreamsClient as unknown as RedisStreamsClient,
          mockRedis as any,
          testStreamName,
          testPubsubChannel,
          testMessage
        )
      ).resolves.toBeUndefined();
    });

    it('should still attempt Streams publish when Pub/Sub fails', async () => {
      mockRedis.publish.mockRejectedValueOnce(new Error('Pub/Sub connection lost'));

      await dualPublish(
        mockStreamsClient as unknown as RedisStreamsClient,
        mockRedis as any,
        testStreamName,
        testPubsubChannel,
        testMessage
      );

      // Streams should still have been called and succeeded
      expect(mockStreamsClient.xadd).toHaveBeenCalledTimes(1);
      expect(mockRedis.publish).toHaveBeenCalledTimes(1);
    });

    it('should not throw when Pub/Sub fails but Streams succeeds', async () => {
      mockRedis.publish.mockRejectedValueOnce(new Error('Pub/Sub error'));

      await expect(
        dualPublish(
          mockStreamsClient as unknown as RedisStreamsClient,
          mockRedis as any,
          testStreamName,
          testPubsubChannel,
          testMessage
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('complete failure (both targets fail)', () => {
    it('should not throw when both Streams and Pub/Sub fail', async () => {
      mockStreamsClient.xadd.mockRejectedValueOnce(new Error('Stream down'));
      mockRedis.publish.mockRejectedValueOnce(new Error('Pub/Sub down'));

      await expect(
        dualPublish(
          mockStreamsClient as unknown as RedisStreamsClient,
          mockRedis as any,
          testStreamName,
          testPubsubChannel,
          testMessage
        )
      ).resolves.toBeUndefined();
    });

    it('should attempt both publishes even when both will fail', async () => {
      mockStreamsClient.xadd.mockRejectedValueOnce(new Error('Stream error'));
      mockRedis.publish.mockRejectedValueOnce(new Error('Pub/Sub error'));

      await dualPublish(
        mockStreamsClient as unknown as RedisStreamsClient,
        mockRedis as any,
        testStreamName,
        testPubsubChannel,
        testMessage
      );

      expect(mockStreamsClient.xadd).toHaveBeenCalledTimes(1);
      expect(mockRedis.publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('null streams client (Pub/Sub only fallback)', () => {
    it('should skip Streams publish when streams client is null', async () => {
      await dualPublish(
        null,
        mockRedis as any,
        testStreamName,
        testPubsubChannel,
        testMessage
      );

      expect(mockRedis.publish).toHaveBeenCalledTimes(1);
      expect(mockRedis.publish).toHaveBeenCalledWith(testPubsubChannel, testMessage);
    });

    it('should not throw when streams client is null and Pub/Sub succeeds', async () => {
      await expect(
        dualPublish(null, mockRedis as any, testStreamName, testPubsubChannel, testMessage)
      ).resolves.toBeUndefined();
    });

    it('should not throw when streams client is null and Pub/Sub fails', async () => {
      mockRedis.publish.mockRejectedValueOnce(new Error('Pub/Sub unavailable'));

      await expect(
        dualPublish(null, mockRedis as any, testStreamName, testPubsubChannel, testMessage)
      ).resolves.toBeUndefined();
    });
  });

  describe('message payload handling', () => {
    it('should pass the exact message object to both targets', async () => {
      const complexMessage = {
        type: 'service_degradation',
        data: {
          serviceName: 'bsc-detector',
          degradationLevel: 'partial',
          enabledFeatures: ['arbitrage_detection'],
        },
        timestamp: 1234567890,
        source: 'graceful-degradation-manager',
      };

      await dualPublish(
        mockStreamsClient as unknown as RedisStreamsClient,
        mockRedis as any,
        testStreamName,
        testPubsubChannel,
        complexMessage
      );

      expect(mockStreamsClient.xadd).toHaveBeenCalledWith(testStreamName, complexMessage);
      expect(mockRedis.publish).toHaveBeenCalledWith(testPubsubChannel, complexMessage);
    });

    it('should handle empty message objects', async () => {
      const emptyMessage = {};

      await dualPublish(
        mockStreamsClient as unknown as RedisStreamsClient,
        mockRedis as any,
        testStreamName,
        testPubsubChannel,
        emptyMessage
      );

      expect(mockStreamsClient.xadd).toHaveBeenCalledWith(testStreamName, emptyMessage);
      expect(mockRedis.publish).toHaveBeenCalledWith(testPubsubChannel, emptyMessage);
    });
  });
});
