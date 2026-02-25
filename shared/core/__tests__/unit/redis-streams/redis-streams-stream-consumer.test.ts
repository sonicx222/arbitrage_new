/**
 * Redis Streams StreamConsumer Tests
 *
 * Tests for the StreamConsumer class:
 * - Lifecycle: start, stop
 * - Message Processing: handler execution, auto-ack
 * - Statistics: message counts, errors
 * - Backpressure: pause/resume
 * - Error Handling
 *
 * P0-4 FIX: Previously 0% coverage on critical class.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RedisStreamsClient, StreamConsumer } from '@arbitrage/core/redis';
import type { StreamConsumerConfig, RedisStreamsConstructor } from '@arbitrage/core/redis';
import { createMockRedisConstructor, createMockHandler } from './test-helpers';

describe('StreamConsumer', () => {
  let client: RedisStreamsClient;
  let mockRedis: any;
  let MockRedis: RedisStreamsConstructor;
  let getMockInstance: () => any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    const mocks = createMockRedisConstructor();
    MockRedis = mocks.MockRedis;
    getMockInstance = mocks.getMockInstance;

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
