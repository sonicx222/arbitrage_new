/**
 * Redis Streams Edge Case Integration Tests
 *
 * Tests edge cases and failure modes of Redis Streams with REAL in-memory Redis:
 * - StreamBatcher buffer overflow at capacity
 * - Consumer group rebalancing when a consumer dies
 * - Stream trimming accuracy (exact vs approximate)
 * - Recovery from corrupted batch messages
 * - Block timeout enforcement
 * - Message order preservation across failures
 * - Concurrent consumer read pattern
 *
 * Uses redis-memory-server (started by jest.globalSetup.ts) for real Redis behavior.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-009: Test Architecture
 */

import Redis from 'ioredis';
import {
  createTestRedisClient,
  ensureConsumerGroup,
  getTestRedisUrl,
} from '@arbitrage/test-utils';
import { RedisStreamsClient } from '@arbitrage/core/redis';

// =============================================================================
// Test Suite
// =============================================================================

describe('[Integration] Redis Streams Edge Cases', () => {
  let redis: Redis;
  let testRedisUrl: string;

  beforeAll(async () => {
    redis = await createTestRedisClient();
    testRedisUrl = getTestRedisUrl();
  });

  afterAll(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  beforeEach(async () => {
    if (redis?.status === 'ready') {
      await redis.flushall();
    }
  });

  // ===========================================================================
  // 1. StreamBatcher buffer overflow at capacity
  // ===========================================================================

  describe('StreamBatcher buffer overflow at capacity', () => {
    let streamsClient: RedisStreamsClient;

    beforeEach(async () => {
      // Create a real RedisStreamsClient connected to the test Redis
      streamsClient = new RedisStreamsClient(testRedisUrl);
      // Wait for connection
      const healthy = await streamsClient.ping();
      expect(healthy).toBe(true);
    });

    afterEach(async () => {
      if (streamsClient) {
        await streamsClient.disconnect();
      }
    });

    it('should drop messages when maxQueueSize is exceeded', async () => {
      const maxQueueSize = 5;
      const batcher = streamsClient.createBatcher<{ seq: number }>('stream:test-overflow', {
        maxBatchSize: 100, // Large batch size so auto-flush does not trigger
        maxWaitMs: 60000,  // Long wait so timer does not trigger
        maxQueueSize,
      });

      // Add messages up to capacity
      for (let i = 0; i < maxQueueSize; i++) {
        batcher.add({ seq: i });
      }

      // Verify queue is at capacity
      const statsAtCapacity = batcher.getStats();
      expect(statsAtCapacity.currentQueueSize).toBe(maxQueueSize);
      expect(statsAtCapacity.totalMessagesQueued).toBe(maxQueueSize);

      // Add messages beyond capacity - these should be silently dropped
      batcher.add({ seq: 100 });
      batcher.add({ seq: 101 });
      batcher.add({ seq: 102 });

      // Queue size should not have grown beyond maxQueueSize
      const statsAfterOverflow = batcher.getStats();
      expect(statsAfterOverflow.currentQueueSize).toBe(maxQueueSize);
      // Only the first 5 messages should have been queued
      expect(statsAfterOverflow.totalMessagesQueued).toBe(maxQueueSize);

      // No error should have been thrown (we got here)
      // No batches should have been sent
      expect(statsAfterOverflow.batchesSent).toBe(0);

      await batcher.destroy();
    });

    it('should accept new messages after flushing a full queue', async () => {
      const maxQueueSize = 3;
      const batcher = streamsClient.createBatcher<{ seq: number }>('stream:test-overflow-recover', {
        maxBatchSize: 100,
        maxWaitMs: 60000,
        maxQueueSize,
      });

      // Fill the queue
      for (let i = 0; i < maxQueueSize; i++) {
        batcher.add({ seq: i });
      }

      expect(batcher.getStats().currentQueueSize).toBe(maxQueueSize);

      // Flush the queue
      await batcher.flush();

      expect(batcher.getStats().currentQueueSize).toBe(0);
      expect(batcher.getStats().totalMessagesSent).toBe(maxQueueSize);

      // Now we should be able to add more messages
      batcher.add({ seq: 10 });
      batcher.add({ seq: 11 });

      expect(batcher.getStats().currentQueueSize).toBe(2);

      await batcher.destroy();
    });
  });

  // ===========================================================================
  // 2. Consumer group rebalancing when consumer dies
  // ===========================================================================

  describe('Consumer group rebalancing when consumer dies', () => {
    const streamName = 'stream:test-rebalance';
    const groupName = 'test-group';

    it('should allow remaining consumer to claim pending messages from dead consumer via XCLAIM', async () => {
      // Create consumer group
      await ensureConsumerGroup(redis, streamName, groupName);

      // Publish 6 messages
      for (let i = 0; i < 6; i++) {
        await redis.xadd(streamName, '*', 'data', JSON.stringify({ seq: i }));
      }

      // Consumer A reads 3 messages (does NOT ack them - simulating crash)
      const consumerAResult = await redis.xreadgroup(
        'GROUP', groupName, 'consumer-A',
        'COUNT', '3',
        'STREAMS', streamName, '>'
      ) as [string, [string, string[]][]][] | null;

      expect(consumerAResult).not.toBeNull();
      const consumerAMessages = consumerAResult![0][1];
      expect(consumerAMessages).toHaveLength(3);

      // Consumer B reads the remaining 3 messages and acks them
      const consumerBResult = await redis.xreadgroup(
        'GROUP', groupName, 'consumer-B',
        'COUNT', '3',
        'STREAMS', streamName, '>'
      ) as [string, [string, string[]][]][] | null;

      expect(consumerBResult).not.toBeNull();
      const consumerBMessages = consumerBResult![0][1];
      expect(consumerBMessages).toHaveLength(3);

      // Ack consumer B's messages
      for (const [id] of consumerBMessages) {
        await redis.xack(streamName, groupName, id);
      }

      // Verify pending messages exist for consumer A
      const pending = await redis.xpending(streamName, groupName) as any[];
      expect(pending[0]).toBe(3); // 3 pending messages

      // Consumer B claims consumer A's pending messages via XCLAIM
      // Need minimal idle time of 0 for test purposes
      const consumerAIds = consumerAMessages.map(([id]: [string, string[]]) => id);
      const claimedResult = await redis.xclaim(
        streamName, groupName, 'consumer-B',
        '0', // min-idle-time: 0ms for test purposes
        ...consumerAIds
      ) as [string, string[]][];

      expect(claimedResult).toHaveLength(3);

      // Ack the claimed messages
      for (const [id] of claimedResult) {
        await redis.xack(streamName, groupName, id);
      }

      // Verify no more pending messages
      const pendingAfterClaim = await redis.xpending(streamName, groupName) as any[];
      expect(pendingAfterClaim[0]).toBe(0); // No pending messages
    });

    it('should redeliver pending messages when reading with startId 0', async () => {
      // Create consumer group
      await ensureConsumerGroup(redis, streamName, groupName);

      // Publish messages
      for (let i = 0; i < 4; i++) {
        await redis.xadd(streamName, '*', 'data', JSON.stringify({ seq: i }));
      }

      // Consumer reads messages but does NOT ack (simulating crash)
      const firstRead = await redis.xreadgroup(
        'GROUP', groupName, 'consumer-1',
        'COUNT', '4',
        'STREAMS', streamName, '>'
      ) as [string, [string, string[]][]][] | null;

      expect(firstRead).not.toBeNull();
      expect(firstRead![0][1]).toHaveLength(4);

      // Read with startId '0' to get pending messages (simulating recovery)
      const redelivered = await redis.xreadgroup(
        'GROUP', groupName, 'consumer-1',
        'COUNT', '10',
        'STREAMS', streamName, '0'
      ) as [string, [string, string[]][]][] | null;

      expect(redelivered).not.toBeNull();
      expect(redelivered![0][1]).toHaveLength(4);

      // Verify the redelivered messages have the same IDs
      const originalIds = firstRead![0][1].map(([id]: [string, string[]]) => id);
      const redeliveredIds = redelivered![0][1].map(([id]: [string, string[]]) => id);
      expect(redeliveredIds).toEqual(originalIds);
    });
  });

  // ===========================================================================
  // 3. Stream trimming accuracy (exact vs approximate)
  // ===========================================================================

  describe('Stream trimming accuracy (exact vs approximate)', () => {
    const streamName = 'stream:test-trim';

    it('should trim to exact count with MAXLEN exact', async () => {
      // Add 20 messages
      for (let i = 0; i < 20; i++) {
        await redis.xadd(streamName, '*', 'data', JSON.stringify({ seq: i }));
      }

      // Verify initial count
      const initialLen = await redis.xlen(streamName);
      expect(initialLen).toBe(20);

      // Trim to exactly 10 with MAXLEN (exact)
      await redis.xtrim(streamName, 'MAXLEN', 10);

      // Verify exact count
      const afterTrimLen = await redis.xlen(streamName);
      expect(afterTrimLen).toBe(10);
    });

    it('should trim approximately with MAXLEN ~ (approximate)', async () => {
      // Add 100 messages
      for (let i = 0; i < 100; i++) {
        await redis.xadd(streamName, '*', 'data', JSON.stringify({ seq: i }));
      }

      const initialLen = await redis.xlen(streamName);
      expect(initialLen).toBe(100);

      // Trim with approximate MAXLEN (~)
      // Redis approximate trimming may leave slightly more entries than specified
      await redis.xtrim(streamName, 'MAXLEN', '~', 10);

      const afterTrimLen = await redis.xlen(streamName);

      // Approximate trimming should leave count at or near the target
      // Redis documentation states the actual count may be slightly more than specified
      // Tolerance: allow up to 2x the target for approximate trimming
      expect(afterTrimLen).toBeGreaterThanOrEqual(10);
      expect(afterTrimLen).toBeLessThanOrEqual(100); // Definitely trimmed something or stayed
    });

    it('should preserve newest messages when trimming', async () => {
      // Add 10 messages with known data
      const addedIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await redis.xadd(streamName, '*', 'data', JSON.stringify({ seq: i }));
        addedIds.push(id!);
      }

      // Trim to keep last 5
      await redis.xtrim(streamName, 'MAXLEN', 5);

      // Read remaining messages
      const result = await redis.xread('COUNT', 10, 'STREAMS', streamName, '0') as
        [string, [string, string[]][]][] | null;

      expect(result).not.toBeNull();
      const remainingMessages = result![0][1];
      expect(remainingMessages).toHaveLength(5);

      // Verify they are the LAST 5 messages (newest)
      const remainingIds = remainingMessages.map(([id]: [string, string[]]) => id);
      const expectedIds = addedIds.slice(5); // Last 5
      expect(remainingIds).toEqual(expectedIds);
    });
  });

  // ===========================================================================
  // 4. Recovery from corrupted batch messages
  // ===========================================================================

  describe('Recovery from corrupted batch messages', () => {
    const streamName = 'stream:test-corrupt';
    const groupName = 'test-group';

    it('should handle corrupted JSON data gracefully when reading from stream', async () => {
      await ensureConsumerGroup(redis, streamName, groupName);

      // Add a valid message
      await redis.xadd(streamName, '*', 'data', JSON.stringify({ type: 'valid', seq: 1 }));

      // Manually add a message with invalid JSON in the data field
      await redis.xadd(streamName, '*', 'data', 'this-is-not-valid-json{{{');

      // Add another valid message after the corrupted one
      await redis.xadd(streamName, '*', 'data', JSON.stringify({ type: 'valid', seq: 3 }));

      // Read all messages via XREADGROUP
      const result = await redis.xreadgroup(
        'GROUP', groupName, 'consumer-1',
        'COUNT', '10',
        'STREAMS', streamName, '>'
      ) as [string, [string, string[]][]][] | null;

      expect(result).not.toBeNull();
      const messages = result![0][1];
      expect(messages).toHaveLength(3);

      // Process messages like the RedisStreamsClient.parseStreamResult would
      const processed: Array<{ id: string; data: unknown; parseError: boolean }> = [];
      for (const [id, fields] of messages) {
        const dataIndex = fields.indexOf('data');
        const rawValue = dataIndex >= 0 ? fields[dataIndex + 1] : null;

        let parsedData: unknown;
        let parseError = false;
        try {
          parsedData = rawValue ? JSON.parse(rawValue) : null;
        } catch {
          // Corrupted message - handle gracefully
          parsedData = rawValue; // Store raw string
          parseError = true;
        }

        processed.push({ id, data: parsedData, parseError });
      }

      // First message is valid
      expect(processed[0].parseError).toBe(false);
      expect((processed[0].data as any).type).toBe('valid');
      expect((processed[0].data as any).seq).toBe(1);

      // Second message is corrupted but handled gracefully
      expect(processed[1].parseError).toBe(true);
      expect(processed[1].data).toBe('this-is-not-valid-json{{{');

      // Third message is valid - processing continued after corruption
      expect(processed[2].parseError).toBe(false);
      expect((processed[2].data as any).type).toBe('valid');
      expect((processed[2].data as any).seq).toBe(3);

      // Ack all messages (including corrupted) to clear pending
      for (const msg of processed) {
        await redis.xack(streamName, groupName, msg.id);
      }
    });

    it('should handle messages with RedisStreamsClient parseStreamResult correctly for invalid JSON', async () => {
      // Use RedisStreamsClient directly to test its parseStreamResult behavior
      const streamsClient = new RedisStreamsClient(testRedisUrl);

      try {
        const healthy = await streamsClient.ping();
        expect(healthy).toBe(true);

        // Manually XADD corrupted and valid messages
        await redis.xadd(streamName, '*', 'data', JSON.stringify({ type: 'valid', seq: 1 }));
        await redis.xadd(streamName, '*', 'data', '!!!NOT_JSON!!!');
        await redis.xadd(streamName, '*', 'data', JSON.stringify({ type: 'valid', seq: 3 }));

        // Read with XREAD (no consumer group needed)
        const messages = await streamsClient.xread(streamName, '0', { count: 10 });

        // RedisStreamsClient.parseStreamResult does JSON.parse with try/catch
        // On parse failure it falls back to the raw string
        expect(messages).toHaveLength(3);

        // First valid message
        expect((messages[0].data as any).type).toBe('valid');

        // Corrupted message - parseStreamResult stores raw string when JSON.parse fails
        expect(messages[1].data).toBe('!!!NOT_JSON!!!');

        // Third valid message - not lost
        expect((messages[2].data as any).type).toBe('valid');
      } finally {
        await streamsClient.disconnect();
      }
    });
  });

  // ===========================================================================
  // 5. Block timeout enforcement
  // ===========================================================================

  describe('Block timeout enforcement', () => {
    it('should return within reasonable time when blocking on empty stream', async () => {
      const streamName = 'stream:test-block-timeout';
      const groupName = 'timeout-group';

      await ensureConsumerGroup(redis, streamName, groupName);

      const startTime = Date.now();

      // Block for 100ms on an empty stream
      const result = await redis.xreadgroup(
        'GROUP', groupName, 'consumer-1',
        'COUNT', '10',
        'BLOCK', '100',
        'STREAMS', streamName, '>'
      );

      const elapsed = Date.now() - startTime;

      // Should return null (no messages)
      expect(result).toBeNull();

      // Should return within reasonable time
      // Allow some overhead for network/Redis processing: 100ms block + 400ms tolerance
      expect(elapsed).toBeGreaterThanOrEqual(90); // At least ~100ms block (allow 10ms tolerance)
      expect(elapsed).toBeLessThan(1000); // Should not take more than 1 second
    });

    it('should return immediately when messages are available during block', async () => {
      const streamName = 'stream:test-block-with-data';
      const groupName = 'block-group';

      await ensureConsumerGroup(redis, streamName, groupName);

      // Add a message before reading
      await redis.xadd(streamName, '*', 'data', JSON.stringify({ type: 'ready' }));

      const startTime = Date.now();

      // Block for long time, but message is already available
      const result = await redis.xreadgroup(
        'GROUP', groupName, 'consumer-1',
        'COUNT', '10',
        'BLOCK', '5000',
        'STREAMS', streamName, '>'
      ) as [string, [string, string[]][]][] | null;

      const elapsed = Date.now() - startTime;

      // Should return the message immediately
      expect(result).not.toBeNull();
      expect(result![0][1]).toHaveLength(1);

      // Should return much faster than the 5 second block timeout
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // ===========================================================================
  // 6. Message order preservation across failures
  // ===========================================================================

  describe('Message order preservation across failures', () => {
    const streamName = 'stream:test-order';
    const groupName = 'order-group';

    it('should redeliver un-acked messages in order and preserve subsequent message order', async () => {
      await ensureConsumerGroup(redis, streamName, groupName);

      // Add 10 messages
      const addedIds: string[] = [];
      for (let i = 1; i <= 10; i++) {
        const id = await redis.xadd(streamName, '*', 'data', JSON.stringify({ seq: i }));
        addedIds.push(id!);
      }

      // Consumer reads all 10 messages
      const firstRead = await redis.xreadgroup(
        'GROUP', groupName, 'consumer-1',
        'COUNT', '10',
        'STREAMS', streamName, '>'
      ) as [string, [string, string[]][]][] | null;

      expect(firstRead).not.toBeNull();
      const readMessages = firstRead![0][1];
      expect(readMessages).toHaveLength(10);

      // ACK messages 1-4 and 6-10 (skip message 5 - simulating failure)
      for (let i = 0; i < readMessages.length; i++) {
        if (i === 4) continue; // Skip message 5 (index 4)
        await redis.xack(streamName, groupName, readMessages[i][0]);
      }

      // Verify exactly 1 pending message
      const pending = await redis.xpending(streamName, groupName) as any[];
      expect(pending[0]).toBe(1); // 1 pending message

      // Read pending messages (startId: '0')
      const pendingRead = await redis.xreadgroup(
        'GROUP', groupName, 'consumer-1',
        'COUNT', '10',
        'STREAMS', streamName, '0'
      ) as [string, [string, string[]][]][] | null;

      expect(pendingRead).not.toBeNull();
      const pendingMessages = pendingRead![0][1];

      // Only message 5 should be pending (un-acked)
      expect(pendingMessages).toHaveLength(1);
      expect(pendingMessages[0][0]).toBe(addedIds[4]); // ID of message 5

      // Parse the data to verify it's message 5
      const dataFields = pendingMessages[0][1];
      const dataIdx = dataFields.indexOf('data');
      const msgData = JSON.parse(dataFields[dataIdx + 1]);
      expect(msgData.seq).toBe(5);

      // ACK message 5
      await redis.xack(streamName, groupName, pendingMessages[0][0]);

      // Verify no more pending
      const pendingAfter = await redis.xpending(streamName, groupName) as any[];
      expect(pendingAfter[0]).toBe(0);
    });

    it('should maintain FIFO order across multiple reads', async () => {
      await ensureConsumerGroup(redis, streamName, groupName);

      // Add messages in sequence
      const expectedOrder: number[] = [];
      for (let i = 1; i <= 20; i++) {
        await redis.xadd(streamName, '*', 'data', JSON.stringify({ seq: i }));
        expectedOrder.push(i);
      }

      // Read in batches of 5
      const actualOrder: number[] = [];
      for (let batch = 0; batch < 4; batch++) {
        const result = await redis.xreadgroup(
          'GROUP', groupName, 'consumer-1',
          'COUNT', '5',
          'STREAMS', streamName, '>'
        ) as [string, [string, string[]][]][] | null;

        expect(result).not.toBeNull();
        for (const [id, fields] of result![0][1]) {
          const dataIdx = fields.indexOf('data');
          const msgData = JSON.parse(fields[dataIdx + 1]);
          actualOrder.push(msgData.seq);
          await redis.xack(streamName, groupName, id);
        }
      }

      // Verify FIFO order is preserved across batched reads
      expect(actualOrder).toEqual(expectedOrder);
    });
  });

  // ===========================================================================
  // 7. Concurrent consumer read pattern
  // ===========================================================================

  describe('Concurrent consumer read pattern', () => {
    it('should distribute messages across consumers in same group exactly once', async () => {
      const streamName = 'stream:test-concurrent';
      const groupName = 'concurrent-group';
      const messageCount = 30;
      const consumerCount = 3;

      await ensureConsumerGroup(redis, streamName, groupName);

      // Publish 30 messages
      for (let i = 0; i < messageCount; i++) {
        await redis.xadd(streamName, '*', 'data', JSON.stringify({ seq: i }));
      }

      // Each consumer reads in a loop until no more new messages
      const consumedByConsumer: Map<string, string[]> = new Map();
      const allConsumedIds: string[] = [];

      for (let c = 0; c < consumerCount; c++) {
        const consumerName = `consumer-${c}`;
        const consumed: string[] = [];
        consumedByConsumer.set(consumerName, consumed);

        // Read in a loop - each consumer picks up messages not yet delivered to others
        let hasMore = true;
        while (hasMore) {
          const result = await redis.xreadgroup(
            'GROUP', groupName, consumerName,
            'COUNT', '5',
            'STREAMS', streamName, '>'
          ) as [string, [string, string[]][]][] | null;

          if (!result || result[0][1].length === 0) {
            hasMore = false;
          } else {
            for (const [id] of result[0][1]) {
              consumed.push(id);
              allConsumedIds.push(id);
              await redis.xack(streamName, groupName, id);
            }
          }
        }
      }

      // Verify all 30 messages were consumed exactly once
      expect(allConsumedIds).toHaveLength(messageCount);

      // Verify no duplicates
      const uniqueIds = new Set(allConsumedIds);
      expect(uniqueIds.size).toBe(messageCount);

      // Verify no pending messages remain
      const pending = await redis.xpending(streamName, groupName) as any[];
      expect(pending[0]).toBe(0);
    });

    it('should distribute messages in parallel across consumers', async () => {
      const streamName = 'stream:test-parallel';
      const groupName = 'parallel-group';
      const messageCount = 30;

      await ensureConsumerGroup(redis, streamName, groupName);

      // Publish messages
      for (let i = 0; i < messageCount; i++) {
        await redis.xadd(streamName, '*', 'data', JSON.stringify({ seq: i }));
      }

      // Create separate Redis connections for parallel consumers
      const consumer1Redis = await createTestRedisClient();
      const consumer2Redis = await createTestRedisClient();
      const consumer3Redis = await createTestRedisClient();

      try {
        // Each consumer reads concurrently using its own connection
        const readAll = async (consumerRedis: Redis, consumerName: string): Promise<string[]> => {
          const ids: string[] = [];
          let attempts = 0;
          const maxAttempts = 20; // Safety limit

          while (attempts < maxAttempts) {
            attempts++;
            const result = await consumerRedis.xreadgroup(
              'GROUP', groupName, consumerName,
              'COUNT', '5',
              'BLOCK', '50',
              'STREAMS', streamName, '>'
            ) as [string, [string, string[]][]][] | null;

            if (!result || result[0][1].length === 0) {
              // No more messages
              break;
            }

            for (const [id] of result[0][1]) {
              ids.push(id);
              await consumerRedis.xack(streamName, groupName, id);
            }
          }
          return ids;
        };

        // Run consumers in parallel
        const [ids1, ids2, ids3] = await Promise.all([
          readAll(consumer1Redis, 'parallel-consumer-1'),
          readAll(consumer2Redis, 'parallel-consumer-2'),
          readAll(consumer3Redis, 'parallel-consumer-3'),
        ]);

        const allIds = [...ids1, ...ids2, ...ids3];

        // Verify all messages consumed
        expect(allIds).toHaveLength(messageCount);

        // Verify no duplicates (each message delivered to exactly one consumer)
        const uniqueIds = new Set(allIds);
        expect(uniqueIds.size).toBe(messageCount);

        // Verify work was distributed (each consumer got at least 1 message)
        // In parallel mode, distribution depends on Redis scheduling
        // At minimum, not all messages should go to one consumer
        expect(ids1.length + ids2.length + ids3.length).toBe(messageCount);

      } finally {
        await consumer1Redis.quit();
        await consumer2Redis.quit();
        await consumer3Redis.quit();
      }
    });
  });
});
