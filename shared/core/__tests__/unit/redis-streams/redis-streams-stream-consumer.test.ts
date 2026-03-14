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

    it('should resume polling after pause/resume cycle spanning multiple poll cycles (stale pollTimer regression)', async () => {
      // Regression test for the execution engine consumer stall:
      // After several poll cycles, schedulePoll() left the expired setTimeout handle
      // in pollTimer. When poll() ended with paused=true and then resume() ran,
      // it checked !this.pollTimer → false (stale handle) → never restarted polling.
      const handler = createMockHandler().mockResolvedValue(undefined);
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 0,
        interPollDelayMs: 10,
      };

      const mockMessages = [
        ['stream:test', [
          ['1234-0', ['data', '{"type":"test"}']]
        ]]
      ];

      // Return messages for first few polls, then empty
      mockRedis.xreadgroup
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValue(null);
      mockRedis.xack.mockResolvedValue(1);

      const consumer = new StreamConsumer(client, config);
      consumer.start();

      // Let several poll cycles complete to accumulate stale timer handles
      await jest.advanceTimersByTimeAsync(100);

      const callsBefore = mockRedis.xreadgroup.mock.calls.length;
      expect(callsBefore).toBeGreaterThanOrEqual(3);

      // Now pause (simulating backpressure engaging during a poll)
      consumer.pause();
      expect(consumer.isPaused()).toBe(true);

      // Advance time — no polls should run while paused
      mockRedis.xreadgroup.mockClear();
      await jest.advanceTimersByTimeAsync(200);
      expect(mockRedis.xreadgroup).not.toHaveBeenCalled();

      // Resume — this is the critical moment. Before the fix, the stale pollTimer
      // caused resume() to skip schedulePoll(), permanently stalling the consumer.
      mockRedis.xreadgroup
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValue(null);
      consumer.resume();

      expect(consumer.isPaused()).toBe(false);

      // Advance time — polling MUST restart after resume
      await jest.advanceTimersByTimeAsync(100);

      // Verify poll restarted by checking xreadgroup was called after resume
      expect(mockRedis.xreadgroup).toHaveBeenCalled();

      await consumer.stop();
    });

    it('should not create duplicate polls when resume is called during active poll', async () => {
      // Guards against a secondary issue: if resume() fires while poll() is
      // still executing (e.g., 1-second fallback interval releases backpressure
      // during an xreadgroup await), we must not start a second concurrent poll.
      // The isPolling flag prevents this — the active poll will handle scheduling.
      let pauseCallback: ((isPaused: boolean) => void) | undefined;
      const handler = createMockHandler();
      const config: StreamConsumerConfig = {
        config: {
          streamName: 'stream:test',
          groupName: 'test-group',
          consumerName: 'consumer-1'
        },
        handler,
        blockMs: 0,
        interPollDelayMs: 10,
        onPauseStateChange: (isPaused) => {
          pauseCallback?.(isPaused);
        },
      };

      // First xreadgroup: handler will pause then resume during processing
      let handlerCallCount = 0;
      const consumer = new StreamConsumer(client, config);

      const mockMessages = [
        ['stream:test', [
          ['1234-0', ['data', '{"type":"test"}']]
        ]]
      ];

      handler.mockImplementation(async () => {
        handlerCallCount++;
        if (handlerCallCount === 1) {
          // Simulate backpressure: pause, then resume while handler is still running
          consumer.pause();
          consumer.resume();
        }
      });

      mockRedis.xreadgroup
        .mockResolvedValueOnce(mockMessages)
        .mockResolvedValue(null);
      mockRedis.xack.mockResolvedValue(1);

      consumer.start();
      await jest.advanceTimersByTimeAsync(100);

      // Should have processed the message
      expect(handlerCallCount).toBeGreaterThanOrEqual(1);

      // Consumer should still be running (not stalled, not crashed)
      expect(consumer.getStats().isRunning).toBe(true);
      expect(consumer.isPaused()).toBe(false);

      await consumer.stop();
    });
  });

  // ===========================================================================
  // T2-4: Batch handler partial ACK
  // ===========================================================================

  describe('Batch Handler partial ACK (T2-4)', () => {
    // Use direct mock client pattern (like stream-consumer-nogroup.test.ts)
    // because batchHandler needs batchXack on the client.
    const createBatchMockClient = () => ({
      xreadgroup: jest.fn<() => Promise<any>>(),
      xack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      batchXack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      createConsumerGroup: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      xpendingRange: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
      xaddWithLimit: jest.fn<() => Promise<string>>().mockResolvedValue('1-0'),
    });

    const batchLogger = () => ({
      error: jest.fn<(msg: string, ctx?: Record<string, unknown>) => void>(),
      warn: jest.fn<(msg: string, ctx?: Record<string, unknown>) => void>(),
      info: jest.fn<(msg: string, ctx?: Record<string, unknown>) => void>(),
      debug: jest.fn<(msg: string, ctx?: Record<string, unknown>) => void>(),
    });

    async function awaitBatchPoll(consumer: any): Promise<void> {
      await consumer.pollPromise;
    }

    it('should ACK only returned IDs when batchHandler returns partial results', async () => {
      const bClient = createBatchMockClient();
      const bLog = batchLogger();
      const batchHandler = jest.fn<() => Promise<string[]>>();

      // 3 messages arrive, handler only returns first 2 IDs (partial success)
      bClient.xreadgroup
        .mockResolvedValueOnce([
          { id: '100-0', data: { type: 'test' } },
          { id: '100-1', data: { type: 'test' } },
          { id: '100-2', data: { type: 'test' } },
        ])
        .mockResolvedValue([]);
      batchHandler.mockResolvedValueOnce(['100-0', '100-1']);

      const consumer = new StreamConsumer(bClient as any, {
        config: { streamName: 'stream:test', groupName: 'grp', consumerName: 'c1' },
        batchHandler,
        autoAck: true,
        blockMs: 0,
        logger: bLog,
      });

      consumer.start();
      await awaitBatchPoll(consumer);
      await consumer.stop();

      // Only the 2 returned IDs should be ACKed
      expect(bClient.batchXack).toHaveBeenCalledWith('stream:test', 'grp', ['100-0', '100-1']);
      const stats = consumer.getStats();
      expect(stats.messagesProcessed).toBe(2);
      expect(stats.messagesFailed).toBe(1);
    });

    it('should not call batchXack when batchHandler throws (no partial results)', async () => {
      const bClient = createBatchMockClient();
      const bLog = batchLogger();
      const batchHandler = jest.fn<() => Promise<string[]>>();

      bClient.xreadgroup
        .mockResolvedValueOnce([
          { id: '200-0', data: { type: 'test' } },
          { id: '200-1', data: { type: 'test' } },
        ])
        .mockResolvedValue([]);
      batchHandler.mockRejectedValueOnce(new Error('Handler crashed'));

      const consumer = new StreamConsumer(bClient as any, {
        config: { streamName: 'stream:test', groupName: 'grp', consumerName: 'c1' },
        batchHandler,
        autoAck: true,
        blockMs: 0,
        logger: bLog,
      });

      consumer.start();
      await awaitBatchPoll(consumer);
      await consumer.stop();

      // No IDs to ACK — handler threw before returning
      expect(bClient.batchXack).not.toHaveBeenCalled();
      const stats = consumer.getStats();
      expect(stats.messagesProcessed).toBe(0);
      expect(stats.messagesFailed).toBe(2);
      // Error should be logged with batch context
      expect(bLog.error).toHaveBeenCalledWith(
        expect.stringContaining('batch handler failed'),
        expect.objectContaining({ batchSize: 2 }),
      );
    });

    it('should ACK all IDs when batchHandler returns all results', async () => {
      const bClient = createBatchMockClient();
      const bLog = batchLogger();
      const batchHandler = jest.fn<() => Promise<string[]>>();

      bClient.xreadgroup
        .mockResolvedValueOnce([
          { id: '300-0', data: { type: 'test' } },
          { id: '300-1', data: { type: 'test' } },
        ])
        .mockResolvedValue([]);
      batchHandler.mockResolvedValueOnce(['300-0', '300-1']);

      const consumer = new StreamConsumer(bClient as any, {
        config: { streamName: 'stream:test', groupName: 'grp', consumerName: 'c1' },
        batchHandler,
        autoAck: true,
        blockMs: 0,
        logger: bLog,
      });

      consumer.start();
      await awaitBatchPoll(consumer);
      await consumer.stop();

      expect(bClient.batchXack).toHaveBeenCalledWith('stream:test', 'grp', ['300-0', '300-1']);
      const stats = consumer.getStats();
      expect(stats.messagesProcessed).toBe(2);
      expect(stats.messagesFailed).toBe(0);
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
