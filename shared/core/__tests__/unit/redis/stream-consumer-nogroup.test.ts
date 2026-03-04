/**
 * StreamConsumer — NOGROUP self-healing tests
 *
 * Verifies that when Redis restarts and consumer groups are lost, the
 * StreamConsumer automatically recreates them and resumes processing
 * instead of entering a permanent error backoff loop.
 *
 * Root cause: Memurai (in-memory Redis) restart drops all consumer group
 * state. Services must recreate groups on the next NOGROUP error rather
 * than treating it as a fatal read failure.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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

/** Advance one poll cycle by awaiting the current pollPromise. */
async function awaitOnePoll(consumer: StreamConsumer): Promise<void> {
  await (consumer as any).pollPromise;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamConsumer — NOGROUP self-healing', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockClient = createMockClient();
    mockLogger = createMockLogger();
  });

  afterEach(async () => {
    jest.useRealTimers();
  });

  it('recreates the consumer group when xreadgroup throws NOGROUP', async () => {
    mockClient.xreadgroup.mockRejectedValueOnce(
      new Error("NOGROUP No such key 'stream:opportunities' or consumer group 'coordinator-group'")
    );
    mockClient.xreadgroup.mockResolvedValue([]);

    const consumer = new StreamConsumer(mockClient as any, {
      config: GROUP_CONFIG,
      handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      blockMs: 0,
      logger: mockLogger,
    });

    consumer.start();
    await awaitOnePoll(consumer);

    expect(mockClient.createConsumerGroup).toHaveBeenCalledTimes(1);
    expect(mockClient.createConsumerGroup).toHaveBeenCalledWith(GROUP_CONFIG);
    await consumer.stop();
  });

  it('logs a warn (not an error) when the group is recreated', async () => {
    mockClient.xreadgroup.mockRejectedValueOnce(
      new Error("NOGROUP No such key 'stream:opportunities' or consumer group 'coordinator-group'")
    );
    mockClient.xreadgroup.mockResolvedValue([]);

    const consumer = new StreamConsumer(mockClient as any, {
      config: GROUP_CONFIG,
      handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      blockMs: 0,
      logger: mockLogger,
    });

    consumer.start();
    await awaitOnePoll(consumer);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Consumer group recreated'),
      expect.objectContaining({
        stream: GROUP_CONFIG.streamName,
        group: GROUP_CONFIG.groupName,
      })
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it('does not increment consecutiveErrors when NOGROUP recreation succeeds', async () => {
    mockClient.xreadgroup.mockRejectedValueOnce(
      new Error("NOGROUP No such key 'stream:opportunities' or consumer group 'coordinator-group'")
    );
    mockClient.xreadgroup.mockResolvedValue([]);

    const consumer = new StreamConsumer(mockClient as any, {
      config: GROUP_CONFIG,
      handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      blockMs: 0,
      logger: mockLogger,
    });

    consumer.start();
    await awaitOnePoll(consumer);

    // consecutiveErrors=0 means the next poll fires with minimum delay (not backed off)
    expect((consumer as any).consecutiveErrors).toBe(0);
    await consumer.stop();
  });

  it('processes messages normally after the group is recreated', async () => {
    const fakeMessage = [
      ['stream:opportunities', [['1234567890-0', ['data', '{"id":"test"}']]]],
    ];

    mockClient.xreadgroup
      .mockRejectedValueOnce(new Error("NOGROUP No such consumer group 'coordinator-group'"))
      .mockResolvedValueOnce(fakeMessage)
      .mockResolvedValue([]);

    const handler = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const consumer = new StreamConsumer(mockClient as any, {
      config: GROUP_CONFIG,
      handler,
      blockMs: 0,
      logger: mockLogger,
    });

    consumer.start();
    await awaitOnePoll(consumer); // first poll: NOGROUP → recreate group
    jest.runAllTimers();          // schedule next poll
    await awaitOnePoll(consumer); // second poll: reads message

    expect(handler).toHaveBeenCalledTimes(1);
    await consumer.stop();
  });

  it('also handles the variant error message "no such key"', async () => {
    mockClient.xreadgroup.mockRejectedValueOnce(
      new Error('ERR no such key')
    );
    mockClient.xreadgroup.mockResolvedValue([]);

    const consumer = new StreamConsumer(mockClient as any, {
      config: GROUP_CONFIG,
      handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      blockMs: 0,
      logger: mockLogger,
    });

    consumer.start();
    await awaitOnePoll(consumer);

    expect(mockClient.createConsumerGroup).toHaveBeenCalledTimes(1);
    await consumer.stop();
  });

  it('increments consecutiveErrors and logs error when recreation itself fails', async () => {
    mockClient.xreadgroup.mockRejectedValue(
      new Error("NOGROUP No such consumer group 'coordinator-group'")
    );
    mockClient.createConsumerGroup.mockRejectedValue(
      new Error('Redis connection refused')
    );

    const consumer = new StreamConsumer(mockClient as any, {
      config: GROUP_CONFIG,
      handler: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      blockMs: 0,
      logger: mockLogger,
    });

    consumer.start();
    await awaitOnePoll(consumer);

    expect((consumer as any).consecutiveErrors).toBe(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to recreate consumer group'),
      expect.objectContaining({
        stream: GROUP_CONFIG.streamName,
        group: GROUP_CONFIG.groupName,
      })
    );
    await consumer.stop();
  });
});
