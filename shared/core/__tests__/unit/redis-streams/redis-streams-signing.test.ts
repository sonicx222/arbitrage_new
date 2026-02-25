/**
 * Redis Streams HMAC Message Signing Tests (S-5)
 *
 * Tests for HMAC-SHA256 message authentication:
 * - Sign/verify cycle works correctly
 * - Invalid signature is rejected
 * - Missing signature when signing enabled is rejected
 * - No signing when key not provided (dev mode)
 * - Batch messages include signatures
 * - Tampered message data fails verification
 * - Different signing keys produce different signatures
 * - Constant-time comparison via timingSafeEqual
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 */

import crypto from 'crypto';
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RedisStreamsClient } from '@arbitrage/core/redis';
import type { RedisStreamsConstructor } from '@arbitrage/core/redis';
import { createMockRedisConstructor } from './test-helpers';

describe('RedisStreamsClient - HMAC Message Signing (S-5)', () => {
  const SIGNING_KEY = crypto.randomBytes(32).toString('hex');
  const DIFFERENT_KEY = crypto.randomBytes(32).toString('hex');

  let client: RedisStreamsClient;
  let mockRedis: any;
  let MockRedis: RedisStreamsConstructor;
  let getMockInstance: () => any;

  function createClient(signingKey?: string): RedisStreamsClient {
    const mocks = createMockRedisConstructor();
    MockRedis = mocks.MockRedis;
    getMockInstance = mocks.getMockInstance;

    const newClient = new RedisStreamsClient('redis://localhost:6379', undefined, {
      RedisImpl: MockRedis,
      signingKey
    });

    mockRedis = getMockInstance();
    return newClient;
  }

  afterEach(async () => {
    if (client && mockRedis) {
      mockRedis.disconnect.mockResolvedValue(undefined);
      await client.disconnect();
    }
  });

  describe('xadd with signing enabled', () => {
    beforeEach(() => {
      client = createClient(SIGNING_KEY);
    });

    it('should include sig field in XADD when signing key is configured', async () => {
      const streamName = 'stream:price-updates';
      const message = { type: 'price', chain: 'bsc', price: '100.5' };
      const expectedId = '1234567890-0';

      mockRedis.xadd.mockResolvedValue(expectedId);

      const messageId = await client.xadd(streamName, message);

      expect(messageId).toBe(expectedId);
      // Verify xadd was called with 'data', serialized, 'sig', signature
      expect(mockRedis.xadd).toHaveBeenCalledTimes(1);
      const callArgs = mockRedis.xadd.mock.calls[0];
      // Find 'sig' field in args
      const sigIndex = callArgs.indexOf('sig');
      expect(sigIndex).toBeGreaterThan(-1);
      // Verify signature is a 64-character hex string (SHA-256 digest)
      const sigValue = callArgs[sigIndex + 1];
      expect(sigValue).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should produce valid HMAC-SHA256 signature for serialized data', async () => {
      const streamName = 'stream:test';
      const message = { type: 'test', value: 42 };

      mockRedis.xadd.mockResolvedValue('1234-0');

      await client.xadd(streamName, message);

      const callArgs = mockRedis.xadd.mock.calls[0];
      const dataIndex = callArgs.indexOf('data');
      const serialized = callArgs[dataIndex + 1];
      const sigIndex = callArgs.indexOf('sig');
      const actualSig = callArgs[sigIndex + 1];

      // Independently compute expected signature
      const expectedSig = crypto
        .createHmac('sha256', SIGNING_KEY)
        .update(serialized)
        .digest('hex');

      expect(actualSig).toBe(expectedSig);
    });

    it('should include sig field when MAXLEN is used', async () => {
      const streamName = 'stream:test';
      const message = { data: 'test' };

      mockRedis.xadd.mockResolvedValue('1234-0');

      await client.xadd(streamName, message, '*', { maxLen: 1000 });

      const callArgs = mockRedis.xadd.mock.calls[0];
      const sigIndex = callArgs.indexOf('sig');
      expect(sigIndex).toBeGreaterThan(-1);
      expect(callArgs[sigIndex + 1]).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should include sig field when exact MAXLEN is used', async () => {
      const streamName = 'stream:test';
      const message = { data: 'test' };

      mockRedis.xadd.mockResolvedValue('1234-0');

      await client.xadd(streamName, message, '*', { maxLen: 500, approximate: false });

      const callArgs = mockRedis.xadd.mock.calls[0];
      const sigIndex = callArgs.indexOf('sig');
      expect(sigIndex).toBeGreaterThan(-1);
      expect(callArgs[sigIndex + 1]).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('xadd without signing key (dev mode)', () => {
    beforeEach(() => {
      client = createClient(undefined);
    });

    it('should NOT include sig field when no signing key is configured', async () => {
      const streamName = 'stream:test';
      const message = { type: 'price', chain: 'bsc' };

      mockRedis.xadd.mockResolvedValue('1234-0');

      await client.xadd(streamName, message);

      const callArgs = mockRedis.xadd.mock.calls[0];
      const sigIndex = callArgs.indexOf('sig');
      expect(sigIndex).toBe(-1);
    });

    it('should call xadd with only data field (no sig)', async () => {
      const streamName = 'stream:test';
      const message = { value: 'no-signing' };

      mockRedis.xadd.mockResolvedValue('5678-0');

      await client.xadd(streamName, message);

      expect(mockRedis.xadd).toHaveBeenCalledWith(
        streamName,
        '*',
        'data',
        JSON.stringify(message)
      );
    });
  });

  describe('parseStreamResult with signing enabled (verification)', () => {
    beforeEach(() => {
      client = createClient(SIGNING_KEY);
    });

    it('should accept messages with valid signatures', async () => {
      const streamName = 'stream:test';
      const rawData = JSON.stringify({ type: 'test', value: 1 });
      const validSig = crypto
        .createHmac('sha256', SIGNING_KEY)
        .update(rawData)
        .digest('hex');

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', rawData, 'sig', validSig]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1234-0');
      expect(result[0].data).toEqual({ type: 'test', value: 1 });
    });

    it('should reject messages with invalid signatures', async () => {
      const streamName = 'stream:test';
      const rawData = JSON.stringify({ type: 'test', value: 1 });
      const invalidSig = 'a'.repeat(64); // Wrong signature

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', rawData, 'sig', invalidSig]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      // Message should be rejected
      expect(result).toHaveLength(0);
    });

    it('should reject unsigned messages when signing is enabled', async () => {
      const streamName = 'stream:test';
      const rawData = JSON.stringify({ type: 'test', value: 1 });

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', rawData]]  // No 'sig' field
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      // Message should be rejected
      expect(result).toHaveLength(0);
    });

    it('should reject tampered message data', async () => {
      const streamName = 'stream:test';
      const originalData = JSON.stringify({ type: 'test', value: 1 });
      const tamperedData = JSON.stringify({ type: 'test', value: 999 });
      // Sign original, but data was tampered
      const sigForOriginal = crypto
        .createHmac('sha256', SIGNING_KEY)
        .update(originalData)
        .digest('hex');

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', tamperedData, 'sig', sigForOriginal]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      expect(result).toHaveLength(0);
    });

    it('should accept valid messages and reject invalid in the same batch', async () => {
      const streamName = 'stream:test';
      const validData = JSON.stringify({ type: 'test', value: 'good' });
      const invalidData = JSON.stringify({ type: 'test', value: 'bad' });
      const validSig = crypto
        .createHmac('sha256', SIGNING_KEY)
        .update(validData)
        .digest('hex');
      const invalidSig = 'b'.repeat(64);

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', validData, 'sig', validSig]],
          ['1234-1', ['data', invalidData, 'sig', invalidSig]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1234-0');
      expect(result[0].data).toEqual({ type: 'test', value: 'good' });
    });

    it('should not include sig field in parsed message data', async () => {
      const streamName = 'stream:test';
      const rawData = JSON.stringify({ type: 'test', secret: 'hidden' });
      const validSig = crypto
        .createHmac('sha256', SIGNING_KEY)
        .update(rawData)
        .digest('hex');

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', rawData, 'sig', validSig]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      expect(result).toHaveLength(1);
      // 'sig' should not appear in parsed data
      expect((result[0].data as any).sig).toBeUndefined();
    });
  });

  describe('parseStreamResult without signing key (dev mode)', () => {
    beforeEach(() => {
      client = createClient(undefined);
    });

    it('should accept unsigned messages when no signing key is configured', async () => {
      const streamName = 'stream:test';
      const rawData = JSON.stringify({ type: 'test', value: 1 });

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', rawData]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      expect(result).toHaveLength(1);
      expect(result[0].data).toEqual({ type: 'test', value: 1 });
    });

    it('should accept signed messages even when signing is disabled (passthrough)', async () => {
      const streamName = 'stream:test';
      const rawData = JSON.stringify({ type: 'test', value: 1 });
      const someSig = 'c'.repeat(64);

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', rawData, 'sig', someSig]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      expect(result).toHaveLength(1);
      expect(result[0].data).toEqual({ type: 'test', value: 1 });
    });
  });

  describe('different signing keys', () => {
    it('should produce different signatures for the same data with different keys', () => {
      const data = JSON.stringify({ type: 'test', value: 42 });

      const sig1 = crypto.createHmac('sha256', SIGNING_KEY).update(data).digest('hex');
      const sig2 = crypto.createHmac('sha256', DIFFERENT_KEY).update(data).digest('hex');

      expect(sig1).not.toBe(sig2);
    });

    it('should reject messages signed with a different key', async () => {
      // Client uses SIGNING_KEY
      client = createClient(SIGNING_KEY);

      const streamName = 'stream:test';
      const rawData = JSON.stringify({ type: 'test', value: 1 });
      // Sign with DIFFERENT_KEY
      const wrongKeySig = crypto
        .createHmac('sha256', DIFFERENT_KEY)
        .update(rawData)
        .digest('hex');

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', rawData, 'sig', wrongKeySig]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      expect(result).toHaveLength(0);
    });
  });

  describe('xreadgroup with signing enabled', () => {
    beforeEach(() => {
      client = createClient(SIGNING_KEY);
    });

    it('should verify signatures in consumer group reads', async () => {
      const rawData = JSON.stringify({ type: 'opportunity', profit: 500 });
      const validSig = crypto
        .createHmac('sha256', SIGNING_KEY)
        .update(rawData)
        .digest('hex');

      mockRedis.xgroup.mockResolvedValue('OK');
      mockRedis.xreadgroup.mockResolvedValue([
        ['stream:opportunities', [
          ['1234-0', ['data', rawData, 'sig', validSig]]
        ]]
      ]);

      await client.createConsumerGroup({
        streamName: 'stream:opportunities',
        groupName: 'test-group',
        consumerName: 'worker-1'
      });

      const result = await client.xreadgroup({
        streamName: 'stream:opportunities',
        groupName: 'test-group',
        consumerName: 'worker-1'
      });

      expect(result).toHaveLength(1);
      expect(result[0].data).toEqual({ type: 'opportunity', profit: 500 });
    });

    it('should reject invalid signatures in consumer group reads', async () => {
      const rawData = JSON.stringify({ type: 'opportunity', profit: 500 });

      mockRedis.xgroup.mockResolvedValue('OK');
      mockRedis.xreadgroup.mockResolvedValue([
        ['stream:opportunities', [
          ['1234-0', ['data', rawData, 'sig', 'deadbeef'.repeat(8)]]
        ]]
      ]);

      await client.createConsumerGroup({
        streamName: 'stream:opportunities',
        groupName: 'test-group',
        consumerName: 'worker-1'
      });

      const result = await client.xreadgroup({
        streamName: 'stream:opportunities',
        groupName: 'test-group',
        consumerName: 'worker-1'
      });

      expect(result).toHaveLength(0);
    });
  });

  describe('batch messages with signing', () => {
    beforeEach(() => {
      client = createClient(SIGNING_KEY);
    });

    it('should sign batch envelope messages from StreamBatcher', async () => {
      mockRedis.xadd.mockResolvedValue('batch-1234-0');

      // Simulate what StreamBatcher.flush() does: it calls xadd with a batch envelope
      const batchEnvelope = {
        type: 'batch',
        count: 2,
        messages: [
          { chain: 'bsc', price: 100 },
          { chain: 'eth', price: 200 }
        ],
        timestamp: Date.now()
      };

      await client.xadd('stream:price-updates', batchEnvelope);

      const callArgs = mockRedis.xadd.mock.calls[0];
      const sigIndex = callArgs.indexOf('sig');
      expect(sigIndex).toBeGreaterThan(-1);

      // Verify it is a valid HMAC for the serialized batch envelope
      const dataIndex = callArgs.indexOf('data');
      const serialized = callArgs[dataIndex + 1];
      const expectedSig = crypto
        .createHmac('sha256', SIGNING_KEY)
        .update(serialized)
        .digest('hex');
      expect(callArgs[sigIndex + 1]).toBe(expectedSig);
    });
  });

  describe('constant-time comparison', () => {
    it('should reject signatures of different length', async () => {
      client = createClient(SIGNING_KEY);

      const streamName = 'stream:test';
      const rawData = JSON.stringify({ type: 'test' });
      // Short signature (wrong length)
      const shortSig = 'abc123';

      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['1234-0', ['data', rawData, 'sig', shortSig]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      // Should be rejected due to length mismatch (before timingSafeEqual)
      expect(result).toHaveLength(0);
    });
  });

  describe('end-to-end sign and verify cycle', () => {
    it('should successfully round-trip: sign on xadd, verify on xread', async () => {
      client = createClient(SIGNING_KEY);

      const streamName = 'stream:test';
      const message = { type: 'price', chain: 'arbitrum', price: 42.5 };
      const serialized = JSON.stringify(message);
      const expectedSig = crypto
        .createHmac('sha256', SIGNING_KEY)
        .update(serialized)
        .digest('hex');

      // Mock xadd to capture the signature
      mockRedis.xadd.mockResolvedValue('9999-0');
      await client.xadd(streamName, message);

      // Now simulate reading back the same message from Redis
      // with the signature that was written
      mockRedis.xread.mockResolvedValue([
        [streamName, [
          ['9999-0', ['data', serialized, 'sig', expectedSig]]
        ]]
      ]);

      const result = await client.xread(streamName, '0');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('9999-0');
      expect(result[0].data).toEqual(message);
    });
  });
});
