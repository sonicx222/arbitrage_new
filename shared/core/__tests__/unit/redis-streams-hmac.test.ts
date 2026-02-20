/**
 * Redis Streams HMAC Signing/Verification Tests (Task 3.2)
 *
 * Tests the S-5 HMAC message authentication feature:
 * - Messages signed with STREAM_SIGNING_KEY are verified successfully
 * - Tampered messages are rejected via crypto.timingSafeEqual failure
 * - Unsigned messages are rejected when signing is enabled
 * - Signing disabled (no key) passes messages through unsigned
 * - Malformed messages (sig present but no data) are rejected
 *
 * @see shared/core/src/redis-streams.ts (signMessage, verifySignature, parseStreamResult)
 * @see docs/reports/IMPLEMENTATION_PLAN.md - Wave 3, Task 3.2
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { RedisStreamsClient, RedisStreamsClientDeps, RedisStreamsConstructor } from '@arbitrage/core';
import { RedisStreams } from '@arbitrage/types';

// =============================================================================
// Mock Redis for HMAC Tests
// =============================================================================

type MockRedisInstance = any;

function createMockRedisInstance(): MockRedisInstance {
  const emitter = new EventEmitter();
  const instance: MockRedisInstance = {};

  instance.on = jest.fn((event: string, handler: (...args: any[]) => void) => {
    emitter.on(event, handler);
    return instance;
  });

  instance.removeAllListeners = jest.fn((event?: string) => {
    if (event) emitter.removeAllListeners(event);
    else emitter.removeAllListeners();
    return instance;
  });

  instance.connect = jest.fn(() => Promise.resolve());
  instance.disconnect = jest.fn(() => Promise.resolve());
  instance.quit = jest.fn(() => Promise.resolve());
  instance.status = 'ready';

  // XADD mock: stores fields for later retrieval
  instance._messages = new Map<string, any[]>();
  instance.xadd = jest.fn((...args: any[]) => {
    // Parse args to extract stream name and fields
    const streamName = args[0];
    // Find 'data' and 'sig' fields from args
    const fields: string[] = [];
    let started = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'data' || args[i] === 'sig') started = true;
      if (started) fields.push(args[i]);
    }
    if (!instance._messages.has(streamName)) {
      instance._messages.set(streamName, []);
    }
    const id = `${Date.now()}-0`;
    instance._messages.get(streamName)!.push([id, fields]);
    return Promise.resolve(id);
  });

  // XREAD mock: returns stored messages in Redis format
  instance.xread = jest.fn((...args: any[]) => {
    // Find stream name (after 'STREAMS' keyword)
    let streamName = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'STREAMS') {
        streamName = args[i + 1];
        break;
      }
    }
    const messages = instance._messages.get(streamName) ?? [];
    if (messages.length === 0) return Promise.resolve(null);
    return Promise.resolve([[streamName, messages]]);
  });

  // Emit connect event so constructor doesn't hang
  instance.__emitter = emitter;

  return instance;
}

function createMockRedisConstructor(instance: MockRedisInstance): RedisStreamsConstructor {
  return jest.fn(() => instance) as unknown as RedisStreamsConstructor;
}

/**
 * Compute HMAC-SHA256 for test assertions (mirrors RedisStreamsClient.signMessage).
 * OP-18 FIX: Now includes stream name prefix for replay protection.
 */
function computeHmac(key: string, data: string, streamName?: string): string {
  const input = streamName ? `${streamName}:${data}` : data;
  return crypto.createHmac('sha256', key).update(input).digest('hex');
}

// =============================================================================
// Tests
// =============================================================================

describe('Redis Streams HMAC Signing/Verification (Task 3.2)', () => {
  const TEST_SIGNING_KEY = 'test-hmac-secret-key-256-bits-long';
  const TEST_STREAM = RedisStreams.OPPORTUNITIES;
  let mockRedis: MockRedisInstance;

  beforeEach(() => {
    mockRedis = createMockRedisInstance();
    jest.clearAllMocks();
  });

  // =========================================================================
  // xadd signing behavior
  // =========================================================================
  describe('xadd signing', () => {
    it('should sign messages with HMAC-SHA256 when signing key is configured', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: TEST_SIGNING_KEY,
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      const message = { foo: 'bar', num: 42 };
      await client.xadd(TEST_STREAM, message);

      // Verify xadd was called with 'sig' field
      expect(mockRedis.xadd).toHaveBeenCalledTimes(1);
      const callArgs = (mockRedis.xadd as jest.Mock).mock.calls[0] as any[];

      // Find the 'sig' field in args
      let sigValue: string | undefined;
      for (let i = 0; i < callArgs.length; i++) {
        if (callArgs[i] === 'sig') {
          sigValue = callArgs[i + 1];
          break;
        }
      }
      expect(sigValue).toBeDefined();

      // Verify the signature matches expected HMAC
      // OP-18 FIX: Signature now includes stream name for replay protection
      const serialized = JSON.stringify(message);
      const expectedSig = computeHmac(TEST_SIGNING_KEY, serialized, TEST_STREAM);
      expect(sigValue).toBe(expectedSig);
    });

    it('should NOT include sig field when signing key is not configured', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        // No signingKey
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      const message = { foo: 'bar' };
      await client.xadd(TEST_STREAM, message);

      expect(mockRedis.xadd).toHaveBeenCalledTimes(1);
      const callArgs = (mockRedis.xadd as jest.Mock).mock.calls[0] as any[];

      // Verify no 'sig' field in args
      let hasSig = false;
      for (let i = 0; i < callArgs.length; i++) {
        if (callArgs[i] === 'sig') {
          hasSig = true;
          break;
        }
      }
      expect(hasSig).toBe(false);
    });
  });

  // =========================================================================
  // xread verification behavior (via parseStreamResult)
  // =========================================================================
  describe('xread verification', () => {
    it('should accept messages with valid HMAC signatures', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: TEST_SIGNING_KEY,
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      // Simulate a properly signed message in Redis
      const messageData = JSON.stringify({ opportunity: 'cross-dex', profit: 100 });
      const validSig = computeHmac(TEST_SIGNING_KEY, messageData);

      // Mock xread to return a message with valid signature
      mockRedis.xread = jest.fn(() =>
        Promise.resolve([
          [TEST_STREAM, [
            ['1-0', ['data', messageData, 'sig', validSig]],
          ]],
        ])
      );

      const messages = await client.xread(TEST_STREAM, '0');
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('1-0');
      expect(messages[0].data).toEqual({ opportunity: 'cross-dex', profit: 100 });
    });

    it('should reject messages with tampered data (invalid HMAC)', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: TEST_SIGNING_KEY,
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      // Sign the original data
      const originalData = JSON.stringify({ opportunity: 'cross-dex', profit: 100 });
      const validSig = computeHmac(TEST_SIGNING_KEY, originalData);

      // Tamper with the data after signing
      const tamperedData = JSON.stringify({ opportunity: 'cross-dex', profit: 999999 });

      mockRedis.xread = jest.fn(() =>
        Promise.resolve([
          [TEST_STREAM, [
            ['1-0', ['data', tamperedData, 'sig', validSig]],
          ]],
        ])
      );

      const messages = await client.xread(TEST_STREAM, '0');
      // Tampered message should be rejected (empty result)
      expect(messages).toHaveLength(0);
    });

    it('should reject messages with wrong signing key', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: TEST_SIGNING_KEY,
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      const messageData = JSON.stringify({ opportunity: 'cross-dex' });
      // Sign with a DIFFERENT key
      const wrongSig = computeHmac('wrong-secret-key', messageData);

      mockRedis.xread = jest.fn(() =>
        Promise.resolve([
          [TEST_STREAM, [
            ['1-0', ['data', messageData, 'sig', wrongSig]],
          ]],
        ])
      );

      const messages = await client.xread(TEST_STREAM, '0');
      expect(messages).toHaveLength(0);
    });

    it('should reject unsigned messages when signing is enabled', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: TEST_SIGNING_KEY,
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      const messageData = JSON.stringify({ opportunity: 'unsigned' });

      // Message WITHOUT 'sig' field
      mockRedis.xread = jest.fn(() =>
        Promise.resolve([
          [TEST_STREAM, [
            ['1-0', ['data', messageData]],
          ]],
        ])
      );

      const messages = await client.xread(TEST_STREAM, '0');
      expect(messages).toHaveLength(0);
    });

    it('should reject malformed messages with sig but no data field', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: TEST_SIGNING_KEY,
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      // Message with sig but NO data field (S-NEW-3 fix)
      mockRedis.xread = jest.fn(() =>
        Promise.resolve([
          [TEST_STREAM, [
            ['1-0', ['sig', 'some-signature-value', 'other_field', 'value']],
          ]],
        ])
      );

      const messages = await client.xread(TEST_STREAM, '0');
      expect(messages).toHaveLength(0);
    });

    it('should pass through unsigned messages when signing is disabled', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        // No signingKey — dev mode
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      const messageData = JSON.stringify({ opportunity: 'unsigned-ok' });

      // Message without sig field
      mockRedis.xread = jest.fn(() =>
        Promise.resolve([
          [TEST_STREAM, [
            ['1-0', ['data', messageData]],
          ]],
        ])
      );

      const messages = await client.xread(TEST_STREAM, '0');
      expect(messages).toHaveLength(1);
      expect(messages[0].data).toEqual({ opportunity: 'unsigned-ok' });
    });

    it('should strip sig field from parsed message output', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: TEST_SIGNING_KEY,
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      const messageData = JSON.stringify({ profit: 42 });
      const validSig = computeHmac(TEST_SIGNING_KEY, messageData);

      mockRedis.xread = jest.fn(() =>
        Promise.resolve([
          [TEST_STREAM, [
            ['1-0', ['data', messageData, 'sig', validSig]],
          ]],
        ])
      );

      const messages = await client.xread(TEST_STREAM, '0');
      expect(messages).toHaveLength(1);
      // sig field should NOT appear in parsed data
      expect((messages[0].data as any).sig).toBeUndefined();
    });
  });

  // =========================================================================
  // Round-trip (xadd -> xread)
  // =========================================================================
  describe('round-trip signing', () => {
    it('should successfully round-trip: xadd signs, xread verifies', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: TEST_SIGNING_KEY,
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      const message = { type: 'cross-dex', chain: 'ethereum', profit: 55.5 };

      // xadd will store the message with sig via mock
      await client.xadd(TEST_STREAM, message);

      // xread uses the mock's stored messages (which include sig from xadd)
      const messages = await client.xread(TEST_STREAM, '0');
      expect(messages).toHaveLength(1);
      expect(messages[0].data).toEqual(message);
    });

    it('should reject round-trip messages if signing key changes between write and read', async () => {
      // Writer uses key A
      const writerDeps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: 'writer-key-alpha',
      };
      const writer = new RedisStreamsClient('redis://localhost:6379', undefined, writerDeps);

      // Reader uses key B (key rotation scenario)
      const readerDeps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: 'reader-key-beta',
      };
      const reader = new RedisStreamsClient('redis://localhost:6379', undefined, readerDeps);

      const message = { profit: 100 };
      await writer.xadd(TEST_STREAM, message);

      // Reader should reject because sig was created with different key
      const messages = await reader.xread(TEST_STREAM, '0');
      expect(messages).toHaveLength(0);
    });

    it('should handle multiple messages with mixed validity', async () => {
      const deps: RedisStreamsClientDeps = {
        RedisImpl: createMockRedisConstructor(mockRedis),
        signingKey: TEST_SIGNING_KEY,
      };
      const client = new RedisStreamsClient('redis://localhost:6379', undefined, deps);

      const validData = JSON.stringify({ id: 'valid', profit: 50 });
      const validSig = computeHmac(TEST_SIGNING_KEY, validData);

      const tamperedData = JSON.stringify({ id: 'tampered', profit: 0 });
      const wrongSig = computeHmac('wrong-key', tamperedData);

      const unsignedData = JSON.stringify({ id: 'unsigned' });

      mockRedis.xread = jest.fn(() =>
        Promise.resolve([
          [TEST_STREAM, [
            ['1-0', ['data', validData, 'sig', validSig]],        // Valid
            ['2-0', ['data', tamperedData, 'sig', wrongSig]],     // Invalid sig
            ['3-0', ['data', unsignedData]],                       // No sig
          ]],
        ])
      );

      const messages = await client.xread(TEST_STREAM, '0');
      // Only the valid message should pass
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe('1-0');
      expect(messages[0].data).toEqual({ id: 'valid', profit: 50 });
    });
  });
});
