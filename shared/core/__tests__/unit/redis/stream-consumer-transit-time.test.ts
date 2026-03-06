/**
 * StreamConsumer — Phase 3 (F1) Stream Message Transit Time Tests
 *
 * Verifies that StreamConsumer measures and reports the time between
 * message publication (from Redis message ID) and consumption via
 * the onMessageTransitTime callback.
 *
 * @see stream-consumer.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { StreamConsumer } from '../../../src/redis/stream-consumer';
import type { ConsumerGroupConfig } from '../../../src/redis/streams';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GROUP_CONFIG: ConsumerGroupConfig = {
  streamName: 'stream:opportunities',
  groupName: 'coordinator-group',
  consumerName: 'coordinator-1',
};

const createMockLogger = () => ({
  error: jest.fn<(msg: string, ctx?: Record<string, unknown>) => void>(),
  warn: jest.fn<(msg: string, ctx?: Record<string, unknown>) => void>(),
  info: jest.fn<(msg: string, ctx?: Record<string, unknown>) => void>(),
  debug: jest.fn<(msg: string, ctx?: Record<string, unknown>) => void>(),
});

const createMockClient = () => ({
  xreadgroup: jest.fn<() => Promise<any>>(),
  xack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  batchXack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  createConsumerGroup: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  xpendingRange: jest.fn<() => Promise<any[]>>().mockResolvedValue([]),
  xaddWithLimit: jest.fn<() => Promise<string>>().mockResolvedValue('1-0'),
});

async function awaitOnePoll(consumer: StreamConsumer): Promise<void> {
  await (consumer as any).pollPromise;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamConsumer — Transit Time (F1)', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockLogger = createMockLogger();
  });

  describe('per-message handler path', () => {
    it('should call onMessageTransitTime with transit time for each processed message', async () => {
      const onTransitTime = jest.fn<(ms: number, stream: string) => void>();
      const publishTimestamp = Date.now() - 50; // 50ms ago
      const messageId = `${publishTimestamp}-0`;

      mockClient.xreadgroup
        .mockResolvedValueOnce([{ id: messageId, data: { key: 'value' } }])
        .mockResolvedValue([]);

      const consumer = new StreamConsumer(mockClient as any, {
        config: GROUP_CONFIG,
        handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        logger: mockLogger,
        onMessageTransitTime: onTransitTime,
        blockMs: 0,
      });

      consumer.start();
      await awaitOnePoll(consumer);
      await consumer.stop();

      expect(onTransitTime).toHaveBeenCalledTimes(1);
      const [transitMs, streamName] = onTransitTime.mock.calls[0];
      expect(transitMs).toBeGreaterThanOrEqual(0);
      expect(transitMs).toBeLessThan(5000); // Should be roughly 50ms + processing overhead
      expect(streamName).toBe('stream:opportunities');
    });

    it('should not call onMessageTransitTime when callback is not provided', async () => {
      const publishTimestamp = Date.now() - 50;
      const messageId = `${publishTimestamp}-0`;

      mockClient.xreadgroup
        .mockResolvedValueOnce([{ id: messageId, data: { key: 'value' } }])
        .mockResolvedValue([]);

      const consumer = new StreamConsumer(mockClient as any, {
        config: GROUP_CONFIG,
        handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        logger: mockLogger,
        blockMs: 0,
      });

      consumer.start();
      await awaitOnePoll(consumer);
      await consumer.stop();

      // No error should occur — callback is simply not called
      expect(mockClient.xreadgroup).toHaveBeenCalled();
    });

    it('should not call onMessageTransitTime for failed messages', async () => {
      const onTransitTime = jest.fn<(ms: number, stream: string) => void>();
      const publishTimestamp = Date.now() - 50;
      const messageId = `${publishTimestamp}-0`;

      mockClient.xreadgroup
        .mockResolvedValueOnce([{ id: messageId, data: { key: 'value' } }])
        .mockResolvedValue([]);

      const consumer = new StreamConsumer(mockClient as any, {
        config: GROUP_CONFIG,
        handler: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('handler failed')),
        logger: mockLogger,
        onMessageTransitTime: onTransitTime,
        blockMs: 0,
      });

      consumer.start();
      await awaitOnePoll(consumer);
      await consumer.stop();

      expect(onTransitTime).not.toHaveBeenCalled();
    });

    it('should handle messages with unparseable IDs gracefully', async () => {
      const onTransitTime = jest.fn<(ms: number, stream: string) => void>();

      mockClient.xreadgroup
        .mockResolvedValueOnce([{ id: 'invalid-id', data: { key: 'value' } }])
        .mockResolvedValue([]);

      const consumer = new StreamConsumer(mockClient as any, {
        config: GROUP_CONFIG,
        handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        logger: mockLogger,
        onMessageTransitTime: onTransitTime,
        blockMs: 0,
      });

      consumer.start();
      await awaitOnePoll(consumer);
      await consumer.stop();

      // Should not call callback for unparseable IDs
      expect(onTransitTime).not.toHaveBeenCalled();
    });

    it('should record transit time for multiple messages in sequence', async () => {
      const onTransitTime = jest.fn<(ms: number, stream: string) => void>();
      const now = Date.now();
      const messages = [
        { id: `${now - 100}-0`, data: { key: '1' } },
        { id: `${now - 50}-0`, data: { key: '2' } },
        { id: `${now - 25}-0`, data: { key: '3' } },
      ];

      mockClient.xreadgroup
        .mockResolvedValueOnce(messages)
        .mockResolvedValue([]);

      const consumer = new StreamConsumer(mockClient as any, {
        config: GROUP_CONFIG,
        handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        logger: mockLogger,
        onMessageTransitTime: onTransitTime,
        blockMs: 0,
      });

      consumer.start();
      await awaitOnePoll(consumer);
      await consumer.stop();

      expect(onTransitTime).toHaveBeenCalledTimes(3);
      // Oldest message should have the highest transit time
      const transitTimes = onTransitTime.mock.calls.map(c => c[0]);
      expect(transitTimes[0]).toBeGreaterThanOrEqual(transitTimes[2]);
    });
  });

  describe('batch handler path', () => {
    it('should call onMessageTransitTime for batch-processed messages', async () => {
      const onTransitTime = jest.fn<(ms: number, stream: string) => void>();
      const now = Date.now();
      const messages = [
        { id: `${now - 100}-0`, data: { key: '1' } },
        { id: `${now - 50}-0`, data: { key: '2' } },
      ];

      mockClient.xreadgroup
        .mockResolvedValueOnce(messages)
        .mockResolvedValue([]);

      const batchHandler = jest.fn<() => Promise<string[]>>()
        .mockResolvedValue([`${now - 100}-0`, `${now - 50}-0`]);

      const consumer = new StreamConsumer(mockClient as any, {
        config: GROUP_CONFIG,
        handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        batchHandler,
        logger: mockLogger,
        onMessageTransitTime: onTransitTime,
        blockMs: 0,
      });

      consumer.start();
      await awaitOnePoll(consumer);
      await consumer.stop();

      expect(onTransitTime).toHaveBeenCalledTimes(2);
    });

    it('should only record transit time for successfully processed batch messages', async () => {
      const onTransitTime = jest.fn<(ms: number, stream: string) => void>();
      const now = Date.now();
      const messages = [
        { id: `${now - 100}-0`, data: { key: '1' } },
        { id: `${now - 50}-0`, data: { key: '2' } },
        { id: `${now - 25}-0`, data: { key: '3' } },
      ];

      mockClient.xreadgroup
        .mockResolvedValueOnce(messages)
        .mockResolvedValue([]);

      // Only first and third messages were successfully processed
      const batchHandler = jest.fn<() => Promise<string[]>>()
        .mockResolvedValue([`${now - 100}-0`, `${now - 25}-0`]);

      const consumer = new StreamConsumer(mockClient as any, {
        config: GROUP_CONFIG,
        handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        batchHandler,
        logger: mockLogger,
        onMessageTransitTime: onTransitTime,
        blockMs: 0,
      });

      consumer.start();
      await awaitOnePoll(consumer);
      await consumer.stop();

      // Only 2 out of 3 messages should have transit time recorded
      expect(onTransitTime).toHaveBeenCalledTimes(2);
    });
  });
});
