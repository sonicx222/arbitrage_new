/**
 * Redis Streams HMAC Signing E2E Integration Tests
 *
 * Tests HMAC-SHA256 message signing and verification with REAL Redis Streams:
 * - Signed publish + consume round-trip
 * - Unsigned message rejection when signing is enabled
 * - Wrong key rejection
 * - Key rotation (current + previous key)
 * - Cross-stream replay protection (OP-18)
 * - Consumer groups with HMAC signing
 *
 * Uses redis-memory-server (started by jest.globalSetup.ts) for real Redis behavior.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see S-5: HMAC message authentication
 * @see OP-17: Key rotation support
 * @see OP-18: Cross-stream replay protection
 */

import Redis from 'ioredis';
import {
  createTestRedisClient,
  getTestRedisUrl,
} from '@arbitrage/test-utils';
import { RedisStreamsClient } from '@arbitrage/core/redis';

// Integration tests need longer timeouts for Redis operations
jest.setTimeout(30000);

// =============================================================================
// Test Suite
// =============================================================================

describe('[Integration] Redis Streams HMAC Signing E2E', () => {
  let redis: Redis;
  let testRedisUrl: string;
  const clients: RedisStreamsClient[] = [];

  /** Helper to create a RedisStreamsClient and track it for cleanup */
  function createClient(opts?: {
    signingKey?: string;
    previousSigningKey?: string;
  }): RedisStreamsClient {
    const client = new RedisStreamsClient(testRedisUrl, undefined, {
      signingKey: opts?.signingKey,
      previousSigningKey: opts?.previousSigningKey,
    });
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    // Ensure NODE_ENV is 'test' so clients without signing keys don't throw
    process.env.NODE_ENV = 'test';
    redis = await createTestRedisClient();
    testRedisUrl = getTestRedisUrl();
  });

  afterAll(async () => {
    // Disconnect all tracked clients
    for (const client of clients) {
      try {
        await client.disconnect();
      } catch {
        // Ignore disconnect errors during cleanup
      }
    }
    clients.length = 0;

    if (redis) {
      await redis.quit();
    }
  });

  beforeEach(async () => {
    // Clean only stream:hmac-* keys (not flushall) to avoid clobbering
    // other workers' data when integration tests run in parallel.
    if (redis?.status === 'ready') {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'stream:hmac-*', 'COUNT', 200);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== '0');
    }
  });

  // ===========================================================================
  // 1. Signed publish + consume round-trip
  // ===========================================================================

  describe('Signed publish + consume round-trip', () => {
    const signingKey = 'test-hmac-secret-key-256-bits-long!';
    const streamName = 'stream:hmac-roundtrip';

    it('should publish a signed message and consume it successfully', async () => {
      const publisher = createClient({ signingKey });
      const consumer = createClient({ signingKey });

      // Verify both clients are connected
      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      // Publish a signed message
      const payload = { type: 'price_update', pair: 'ETH/USDC', price: 3500.42 };
      const messageId = await publisher.xadd(streamName, payload);
      expect(messageId).toBeTruthy();

      // Consume via xread
      const messages = await consumer.xread(streamName, '0', { count: 10 });

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(messageId);
      expect(messages[0].data).toEqual(payload);
    });

    it('should not expose the sig field in parsed output', async () => {
      const publisher = createClient({ signingKey });
      const consumer = createClient({ signingKey });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      const payload = { action: 'swap', amount: 100 };
      await publisher.xadd(streamName, payload);

      const messages = await consumer.xread(streamName, '0', { count: 10 });
      expect(messages).toHaveLength(1);

      // The sig field should NOT be in the parsed data
      const data = messages[0].data as Record<string, unknown>;
      expect(data).not.toHaveProperty('sig');
      expect(data).toEqual(payload);

      // But verify the raw Redis entry DOES contain a sig field
      const rawResult = await redis.xread('COUNT', 10, 'STREAMS', streamName, '0') as
        [string, [string, string[]][]][] | null;
      expect(rawResult).not.toBeNull();
      const rawFields = rawResult![0][1][0][1];
      const fieldNames: string[] = [];
      for (let i = 0; i < rawFields.length; i += 2) {
        fieldNames.push(rawFields[i]);
      }
      expect(fieldNames).toContain('sig');
      expect(fieldNames).toContain('data');
    });

    it('should handle multiple signed messages in sequence', async () => {
      const publisher = createClient({ signingKey });
      const consumer = createClient({ signingKey });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      const payloads = [
        { seq: 1, chain: 'bsc' },
        { seq: 2, chain: 'ethereum' },
        { seq: 3, chain: 'arbitrum' },
      ];

      for (const payload of payloads) {
        await publisher.xadd(streamName, payload);
      }

      const messages = await consumer.xread(streamName, '0', { count: 10 });
      expect(messages).toHaveLength(3);

      for (let i = 0; i < payloads.length; i++) {
        expect(messages[i].data).toEqual(payloads[i]);
      }
    });
  });

  // ===========================================================================
  // 2. Unsigned message rejection
  // ===========================================================================

  describe('Unsigned message rejection', () => {
    const streamName = 'stream:hmac-unsigned';
    const signingKey = 'consumer-requires-signing-key!!!';

    it('should reject unsigned messages when consumer has signing enabled', async () => {
      // Publisher without signing key
      const publisher = createClient();
      // Consumer with signing key
      const consumer = createClient({ signingKey });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      // Publish an unsigned message
      const payload = { type: 'unsigned', value: 42 };
      await publisher.xadd(streamName, payload);

      // Verify message exists in Redis
      const rawLen = await redis.xlen(streamName);
      expect(rawLen).toBe(1);

      // Consumer with signing enabled should reject the unsigned message
      const messages = await consumer.xread(streamName, '0', { count: 10 });
      expect(messages).toHaveLength(0);
    });

    it('should accept unsigned messages when consumer has no signing key', async () => {
      // Both without signing key
      const publisher = createClient();
      const consumer = createClient();

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      const payload = { type: 'unsigned-ok', value: 99 };
      await publisher.xadd(streamName, payload);

      const messages = await consumer.xread(streamName, '0', { count: 10 });
      expect(messages).toHaveLength(1);
      expect(messages[0].data).toEqual(payload);
    });
  });

  // ===========================================================================
  // 3. Wrong key rejection
  // ===========================================================================

  describe('Wrong key rejection', () => {
    const streamName = 'stream:hmac-wrong-key';

    it('should reject messages signed with a different key', async () => {
      const publisherKey = 'publisher-secret-key-aaa-bbb-ccc';
      const consumerKey = 'consumer-different-key-xxx-yyy-zzz';

      const publisher = createClient({ signingKey: publisherKey });
      const consumer = createClient({ signingKey: consumerKey });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      // Publish with key A
      const payload = { type: 'secret', data: 'sensitive-info' };
      await publisher.xadd(streamName, payload);

      // Verify message exists in Redis
      const rawLen = await redis.xlen(streamName);
      expect(rawLen).toBe(1);

      // Consumer with key B should reject the message
      const messages = await consumer.xread(streamName, '0', { count: 10 });
      expect(messages).toHaveLength(0);
    });

    it('should accept messages when keys match', async () => {
      const sharedKey = 'shared-secret-key-for-both-sides!';

      const publisher = createClient({ signingKey: sharedKey });
      const consumer = createClient({ signingKey: sharedKey });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      const payload = { type: 'verified', data: 'trusted-info' };
      await publisher.xadd(streamName, payload);

      const messages = await consumer.xread(streamName, '0', { count: 10 });
      expect(messages).toHaveLength(1);
      expect(messages[0].data).toEqual(payload);
    });
  });

  // ===========================================================================
  // 4. Key rotation
  // ===========================================================================

  describe('Key rotation', () => {
    const streamName = 'stream:hmac-rotation';
    const oldKey = 'old-signing-key-being-rotated-out!';
    const newKey = 'new-signing-key-replacing-old-one!';

    it('should accept messages signed with new key when consumer has new key', async () => {
      const publisher = createClient({ signingKey: newKey });
      const consumer = createClient({
        signingKey: newKey,
        previousSigningKey: oldKey,
      });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      const payload = { type: 'new-key-msg', seq: 1 };
      await publisher.xadd(streamName, payload);

      const messages = await consumer.xread(streamName, '0', { count: 10 });
      expect(messages).toHaveLength(1);
      expect(messages[0].data).toEqual(payload);
    });

    it('should accept messages signed with old key during rotation window', async () => {
      // Publisher still using the OLD key (hasn't been updated yet)
      const publisher = createClient({ signingKey: oldKey });
      // Consumer has rotated to new key but still accepts old key
      const consumer = createClient({
        signingKey: newKey,
        previousSigningKey: oldKey,
      });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      const payload = { type: 'old-key-msg', seq: 2 };
      await publisher.xadd(streamName, payload);

      const messages = await consumer.xread(streamName, '0', { count: 10 });
      expect(messages).toHaveLength(1);
      expect(messages[0].data).toEqual(payload);
    });

    it('should reject messages signed with unrelated key even during rotation', async () => {
      const unrelatedKey = 'completely-unrelated-key-xyzxyzxyz';

      const publisher = createClient({ signingKey: unrelatedKey });
      const consumer = createClient({
        signingKey: newKey,
        previousSigningKey: oldKey,
      });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      const payload = { type: 'unrelated-key-msg', seq: 3 };
      await publisher.xadd(streamName, payload);

      // Consumer should reject: neither new key nor old key matches
      const messages = await consumer.xread(streamName, '0', { count: 10 });
      expect(messages).toHaveLength(0);
    });

    it('should handle mixed old and new key messages in the same stream', async () => {
      // Two publishers: one with old key, one with new key
      const oldPublisher = createClient({ signingKey: oldKey });
      const newPublisher = createClient({ signingKey: newKey });
      const consumer = createClient({
        signingKey: newKey,
        previousSigningKey: oldKey,
      });

      expect(await oldPublisher.ping()).toBe(true);
      expect(await newPublisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      // Interleave old-key and new-key messages
      await oldPublisher.xadd(streamName, { src: 'old', seq: 1 });
      await newPublisher.xadd(streamName, { src: 'new', seq: 2 });
      await oldPublisher.xadd(streamName, { src: 'old', seq: 3 });
      await newPublisher.xadd(streamName, { src: 'new', seq: 4 });

      const messages = await consumer.xread(streamName, '0', { count: 10 });
      // All 4 should be accepted (consumer knows both keys)
      expect(messages).toHaveLength(4);
      expect((messages[0].data as Record<string, unknown>).src).toBe('old');
      expect((messages[1].data as Record<string, unknown>).src).toBe('new');
      expect((messages[2].data as Record<string, unknown>).src).toBe('old');
      expect((messages[3].data as Record<string, unknown>).src).toBe('new');
    });
  });

  // ===========================================================================
  // 5. Cross-stream replay protection (OP-18)
  // ===========================================================================

  describe('Cross-stream replay protection (OP-18)', () => {
    const signingKey = 'replay-protection-signing-key-ok!';
    const streamA = 'stream:hmac-replay-A';
    const streamB = 'stream:hmac-replay-B';

    it('should reject messages replayed from another stream', async () => {
      const publisher = createClient({ signingKey });
      const consumer = createClient({ signingKey });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      // Publish a signed message to stream A
      const payload = { type: 'replay-test', secret: 'sensitive-data' };
      await publisher.xadd(streamA, payload);

      // Read the raw data and sig fields from stream A
      const rawResult = await redis.xread('COUNT', 1, 'STREAMS', streamA, '0') as
        [string, [string, string[]][]][] | null;
      expect(rawResult).not.toBeNull();

      const rawFields = rawResult![0][1][0][1];
      let rawData: string | undefined;
      let rawSig: string | undefined;
      for (let i = 0; i < rawFields.length; i += 2) {
        if (rawFields[i] === 'data') rawData = rawFields[i + 1];
        if (rawFields[i] === 'sig') rawSig = rawFields[i + 1];
      }
      expect(rawData).toBeDefined();
      expect(rawSig).toBeDefined();

      // Manually copy the raw data and sig to stream B (replay attack)
      await redis.xadd(streamB, '*', 'data', rawData!, 'sig', rawSig!);

      // Verify the replayed message exists in stream B
      const streamBLen = await redis.xlen(streamB);
      expect(streamBLen).toBe(1);

      // Consumer reads stream B — should reject the replayed message
      // because the HMAC was computed with streamA as part of the input
      const messagesB = await consumer.xread(streamB, '0', { count: 10 });
      expect(messagesB).toHaveLength(0);

      // Consumer reads stream A — should accept the original message
      const messagesA = await consumer.xread(streamA, '0', { count: 10 });
      expect(messagesA).toHaveLength(1);
      expect(messagesA[0].data).toEqual(payload);
    });

    it('should accept the same payload on different streams when properly signed', async () => {
      const publisher = createClient({ signingKey });
      const consumer = createClient({ signingKey });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      // Same payload, but published (and signed) correctly on each stream
      const payload = { type: 'multi-stream', value: 42 };
      await publisher.xadd(streamA, payload);
      await publisher.xadd(streamB, payload);

      const messagesA = await consumer.xread(streamA, '0', { count: 10 });
      const messagesB = await consumer.xread(streamB, '0', { count: 10 });

      expect(messagesA).toHaveLength(1);
      expect(messagesA[0].data).toEqual(payload);
      expect(messagesB).toHaveLength(1);
      expect(messagesB[0].data).toEqual(payload);

      // Verify the signatures are different (stream name is part of HMAC input)
      const rawA = await redis.xread('COUNT', 1, 'STREAMS', streamA, '0') as
        [string, [string, string[]][]][] | null;
      const rawB = await redis.xread('COUNT', 1, 'STREAMS', streamB, '0') as
        [string, [string, string[]][]][] | null;

      const getSig = (raw: [string, [string, string[]][]][] | null): string => {
        const fields = raw![0][1][0][1];
        for (let i = 0; i < fields.length; i += 2) {
          if (fields[i] === 'sig') return fields[i + 1];
        }
        return '';
      };

      const sigA = getSig(rawA);
      const sigB = getSig(rawB);
      expect(sigA).toBeTruthy();
      expect(sigB).toBeTruthy();
      // Same data, different stream names -> different signatures
      expect(sigA).not.toBe(sigB);
    });
  });

  // ===========================================================================
  // 6. Consumer groups with HMAC
  // ===========================================================================

  describe('Consumer groups with HMAC', () => {
    const signingKey = 'consumer-group-hmac-signing-key!!';
    const streamName = 'stream:hmac-consumer-group';
    const groupName = 'hmac-test-group';
    const consumerName = 'hmac-consumer-1';

    it('should publish signed messages and consume via xreadgroup', async () => {
      const publisher = createClient({ signingKey });
      const consumer = createClient({ signingKey });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      // Create consumer group
      await consumer.createConsumerGroup({
        streamName,
        groupName,
        consumerName,
        startId: '0',
      });

      // Publish signed messages
      const payloads = [
        { type: 'opportunity', pair: 'WETH/USDC', profit: 150 },
        { type: 'opportunity', pair: 'WBTC/USDT', profit: 300 },
        { type: 'opportunity', pair: 'LINK/ETH', profit: 50 },
      ];

      for (const payload of payloads) {
        await publisher.xadd(streamName, payload);
      }

      // Consume via xreadgroup
      const config = { streamName, groupName, consumerName };
      const messages = await consumer.xreadgroup(config, {
        count: 10,
        startId: '>',
      });

      expect(messages).toHaveLength(3);
      for (let i = 0; i < payloads.length; i++) {
        expect(messages[i].data).toEqual(payloads[i]);
        // Sig field should not be in parsed output
        expect(messages[i].data).not.toHaveProperty('sig');
      }

      // ACK the messages
      for (const msg of messages) {
        await consumer.xack(streamName, groupName, msg.id);
      }

      // Verify no pending messages
      const pending = await consumer.xpending(streamName, groupName);
      expect(pending.total).toBe(0);
    });

    it('should reject wrong-key messages in consumer group and auto-ACK them (OP-9)', async () => {
      const wrongKey = 'completely-wrong-key-for-consumer!';

      const publisher = createClient({ signingKey: wrongKey });
      const consumer = createClient({ signingKey });

      expect(await publisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      // Create consumer group
      await consumer.createConsumerGroup({
        streamName,
        groupName,
        consumerName,
        startId: '0',
      });

      // Publish with wrong key
      await publisher.xadd(streamName, { type: 'bad', seq: 1 });
      await publisher.xadd(streamName, { type: 'bad', seq: 2 });

      // Verify messages exist in the stream
      const rawLen = await redis.xlen(streamName);
      expect(rawLen).toBe(2);

      // Consumer reads via xreadgroup - should reject both and auto-ACK
      const messages = await consumer.xreadgroup(
        { streamName, groupName, consumerName },
        { count: 10, startId: '>' },
      );

      // No valid messages returned
      expect(messages).toHaveLength(0);

      // OP-9: Rejected messages should be auto-ACKed to prevent PEL growth
      // Give Redis a moment to process
      const pending = await consumer.xpending(streamName, groupName);
      expect(pending.total).toBe(0);
    });

    it('should handle mixed valid and invalid messages in consumer group', async () => {
      const validPublisher = createClient({ signingKey });
      const invalidPublisher = createClient({ signingKey: 'invalid-key-does-not-match!!!!!' });
      const consumer = createClient({ signingKey });

      expect(await validPublisher.ping()).toBe(true);
      expect(await invalidPublisher.ping()).toBe(true);
      expect(await consumer.ping()).toBe(true);

      // Create consumer group
      await consumer.createConsumerGroup({
        streamName,
        groupName,
        consumerName,
        startId: '0',
      });

      // Publish a mix of valid and invalid messages
      await validPublisher.xadd(streamName, { valid: true, seq: 1 });
      await invalidPublisher.xadd(streamName, { valid: false, seq: 2 });
      await validPublisher.xadd(streamName, { valid: true, seq: 3 });

      // Consumer should only return valid messages
      const messages = await consumer.xreadgroup(
        { streamName, groupName, consumerName },
        { count: 10, startId: '>' },
      );

      // Only the 2 valid messages should pass
      expect(messages).toHaveLength(2);
      expect((messages[0].data as Record<string, unknown>).seq).toBe(1);
      expect((messages[1].data as Record<string, unknown>).seq).toBe(3);

      // ACK valid messages
      for (const msg of messages) {
        await consumer.xack(streamName, groupName, msg.id);
      }

      // All messages should be ACKed (valid ones by us, invalid by OP-9 auto-ACK)
      const pending = await consumer.xpending(streamName, groupName);
      expect(pending.total).toBe(0);
    });
  });
});
