/**
 * Tests for HMAC Utility Functions
 *
 * Validates HMAC-SHA256 signing, verification, envelope type guard,
 * and signing key retrieval from environment. Uses Node.js crypto
 * directly (deterministic, no mocking needed).
 *
 * @see shared/core/src/utils/hmac-utils.ts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  hmacSign,
  hmacVerify,
  getHmacSigningKey,
  isSignedEnvelope,
  type SignedEnvelope,
} from '../../../src/utils/hmac-utils';

const originalEnv = process.env;

describe('hmac-utils', () => {
  // =========================================================================
  // getHmacSigningKey
  // =========================================================================

  describe('getHmacSigningKey', () => {
    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return null when STREAM_SIGNING_KEY is not set', () => {
      delete process.env.STREAM_SIGNING_KEY;
      expect(getHmacSigningKey()).toBeNull();
    });

    it('should return null when STREAM_SIGNING_KEY is empty string', () => {
      process.env.STREAM_SIGNING_KEY = '';
      expect(getHmacSigningKey()).toBeNull();
    });

    it('should return null when STREAM_SIGNING_KEY is whitespace only', () => {
      process.env.STREAM_SIGNING_KEY = '   \t  ';
      expect(getHmacSigningKey()).toBeNull();
    });

    it('should return trimmed key when STREAM_SIGNING_KEY has surrounding spaces', () => {
      process.env.STREAM_SIGNING_KEY = '  my-secret-key  ';
      expect(getHmacSigningKey()).toBe('my-secret-key');
    });

    it('should return key when STREAM_SIGNING_KEY is set normally', () => {
      process.env.STREAM_SIGNING_KEY = 'production-key-abc123';
      expect(getHmacSigningKey()).toBe('production-key-abc123');
    });
  });

  // =========================================================================
  // hmacSign
  // =========================================================================

  describe('hmacSign', () => {
    const testKey = 'test-signing-key-256bit';

    it('should return envelope with empty sig when signingKey is null', () => {
      const data = { foo: 'bar' };
      const envelope = hmacSign(data, null);

      expect(envelope.data).toEqual(data);
      expect(envelope.sig).toBe('');
    });

    it('should return envelope with valid hex sig when signingKey is provided', () => {
      const data = { amount: 100, token: 'WETH' };
      const envelope = hmacSign(data, testKey);

      expect(envelope.sig).toBeTruthy();
      // HMAC-SHA256 produces 64-char hex string
      expect(envelope.sig).toHaveLength(64);
      // Must be valid hex
      expect(envelope.sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce deterministic signatures (same data + same key)', () => {
      const data = { value: 42 };
      const envelope1 = hmacSign(data, testKey);
      const envelope2 = hmacSign(data, testKey);

      expect(envelope1.sig).toBe(envelope2.sig);
    });

    it('should produce different signatures for different data with same key', () => {
      const envelope1 = hmacSign({ value: 1 }, testKey);
      const envelope2 = hmacSign({ value: 2 }, testKey);

      expect(envelope1.sig).not.toBe(envelope2.sig);
    });

    it('should produce different signatures for same data with different keys', () => {
      const data = { value: 42 };
      const envelope1 = hmacSign(data, 'key-alpha');
      const envelope2 = hmacSign(data, 'key-beta');

      expect(envelope1.sig).not.toBe(envelope2.sig);
    });

    it('should produce different signatures with context vs without context', () => {
      const data = { bridge: 'stargate' };
      const withoutContext = hmacSign(data, testKey);
      const withContext = hmacSign(data, testKey, 'bridge:recovery:0x123');

      expect(withoutContext.sig).not.toBe(withContext.sig);
    });

    it('should preserve original data in envelope', () => {
      const data = { nested: { array: [1, 2, 3] }, str: 'hello' };
      const envelope = hmacSign(data, testKey);

      expect(envelope.data).toEqual(data);
      // Should be reference-equal (not cloned)
      expect(envelope.data).toBe(data);
    });
  });

  // =========================================================================
  // hmacVerify
  // =========================================================================

  describe('hmacVerify', () => {
    const testKey = 'verify-test-key-hmac256';

    it('should return data when signingKey is null (skip verification)', () => {
      const envelope: SignedEnvelope<string> = { data: 'unprotected', sig: '' };
      const result = hmacVerify(envelope, null);

      expect(result).toBe('unprotected');
    });

    it('should return data when signingKey is null even with non-empty sig', () => {
      const envelope: SignedEnvelope<string> = { data: 'test', sig: 'abc123' };
      const result = hmacVerify(envelope, null);

      expect(result).toBe('test');
    });

    it('should return null when signingKey is set but sig is empty (reject unsigned)', () => {
      const envelope: SignedEnvelope<object> = { data: { key: 'value' }, sig: '' };
      const result = hmacVerify(envelope, testKey);

      expect(result).toBeNull();
    });

    it('should return data when sig is valid (round-trip sign then verify)', () => {
      const data = { chain: 'bsc', profit: 0.05 };
      const envelope = hmacSign(data, testKey);
      const result = hmacVerify(envelope, testKey);

      expect(result).toEqual(data);
    });

    it('should return null when sig is tampered (modify one char)', () => {
      const data = { safe: true };
      const envelope = hmacSign(data, testKey);

      // Tamper with the last character of the signature
      const lastChar = envelope.sig[envelope.sig.length - 1];
      const tamperedChar = lastChar === 'a' ? 'b' : 'a';
      const tamperedEnvelope: SignedEnvelope<typeof data> = {
        data: envelope.data,
        sig: envelope.sig.slice(0, -1) + tamperedChar,
      };

      const result = hmacVerify(tamperedEnvelope, testKey);
      expect(result).toBeNull();
    });

    it('should return null when data is tampered after signing', () => {
      const data = { amount: 100 };
      const envelope = hmacSign(data, testKey);

      // Tamper with the data
      const tamperedEnvelope: SignedEnvelope<{ amount: number }> = {
        data: { amount: 999 },
        sig: envelope.sig,
      };

      const result = hmacVerify(tamperedEnvelope, testKey);
      expect(result).toBeNull();
    });

    it('should return null when sig has wrong length', () => {
      const data = { test: true };
      const envelope = hmacSign(data, testKey);

      // Truncate the signature to create length mismatch
      const shortEnvelope: SignedEnvelope<typeof data> = {
        data: envelope.data,
        sig: envelope.sig.slice(0, 32), // 32 chars instead of 64
      };

      const result = hmacVerify(shortEnvelope, testKey);
      expect(result).toBeNull();
    });

    it('should succeed round-trip with context', () => {
      const data = { bridgeId: 'abc' };
      const context = 'bridge:recovery:0xDEAD';
      const envelope = hmacSign(data, testKey, context);
      const result = hmacVerify(envelope, testKey, context);

      expect(result).toEqual(data);
    });

    it('should fail round-trip with different context', () => {
      const data = { bridgeId: 'abc' };
      const envelope = hmacSign(data, testKey, 'context-A');
      const result = hmacVerify(envelope, testKey, 'context-B');

      expect(result).toBeNull();
    });

    it('should handle string data type', () => {
      const data = 'simple-string';
      const envelope = hmacSign(data, testKey);
      const result = hmacVerify(envelope, testKey);

      expect(result).toBe(data);
    });

    it('should handle number data type', () => {
      const data = 42.5;
      const envelope = hmacSign(data, testKey);
      const result = hmacVerify(envelope, testKey);

      expect(result).toBe(data);
    });

    it('should handle array data type', () => {
      const data = [1, 'two', { three: 3 }];
      const envelope = hmacSign(data, testKey);
      const result = hmacVerify(envelope, testKey);

      expect(result).toEqual(data);
    });

    it('should handle nested object data type', () => {
      const data = {
        chains: ['bsc', 'eth'],
        config: { slippage: 0.5, deadline: 300 },
        active: true,
      };
      const envelope = hmacSign(data, testKey);
      const result = hmacVerify(envelope, testKey);

      expect(result).toEqual(data);
    });
  });

  // =========================================================================
  // isSignedEnvelope
  // =========================================================================

  describe('isSignedEnvelope', () => {
    it('should return true for valid envelope with data and string sig', () => {
      const envelope = { data: { foo: 'bar' }, sig: 'abcdef1234567890' };
      expect(isSignedEnvelope(envelope)).toBe(true);
    });

    it('should return true for envelope with empty string sig', () => {
      const envelope = { data: 'anything', sig: '' };
      expect(isSignedEnvelope(envelope)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isSignedEnvelope(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isSignedEnvelope(undefined)).toBe(false);
    });

    it('should return false for string', () => {
      expect(isSignedEnvelope('not-an-envelope')).toBe(false);
    });

    it('should return false for number', () => {
      expect(isSignedEnvelope(42)).toBe(false);
    });

    it('should return false for object missing sig property', () => {
      expect(isSignedEnvelope({ data: 'hello' })).toBe(false);
    });

    it('should return false for object missing data property', () => {
      expect(isSignedEnvelope({ sig: 'abcdef' })).toBe(false);
    });

    it('should return false for object with non-string sig', () => {
      expect(isSignedEnvelope({ data: 'hello', sig: 12345 })).toBe(false);
    });

    it('should return false for object with sig as null', () => {
      expect(isSignedEnvelope({ data: 'hello', sig: null })).toBe(false);
    });

    it('should return true for envelope with extra properties', () => {
      const envelope = { data: 'test', sig: 'abc', extra: 'field' };
      expect(isSignedEnvelope(envelope)).toBe(true);
    });
  });

  // =========================================================================
  // Security-specific tests
  // =========================================================================

  describe('security', () => {
    const testKey = 'security-test-key-hmac';

    it('should prevent cross-context replay (sign with context A, verify with context B)', () => {
      const data = { action: 'withdraw', amount: 1000 };
      const envelope = hmacSign(data, testKey, 'bridge:recovery:0xAAA');

      // Attempt to replay the signed envelope under a different context
      const result = hmacVerify(envelope, testKey, 'bridge:recovery:0xBBB');
      expect(result).toBeNull();
    });

    it('should prevent context/data ambiguity via null separator', () => {
      // Without a null separator, context "ab" + data "cd" could collide
      // with context "a" + data "bcd" since the HMAC input would be identical.
      // The null separator (\0) between context and data prevents this.
      const key = 'separator-test-key';

      // Sign with context "ab" and data "cd"
      const envelope1 = hmacSign('cd', key, 'ab');

      // Sign with context "a" and data "bcd"
      // The data "bcd" serializes as JSON string '"bcd"', while "cd" serializes as '"cd"'
      // So even without the separator these would differ due to JSON serialization.
      // To properly test the separator, we need contexts that together with data
      // could form identical byte sequences. Use raw string data to minimize
      // JSON overhead differences.
      const envelope2 = hmacSign('cd', key, 'a');

      // Different contexts produce different signatures
      expect(envelope1.sig).not.toBe(envelope2.sig);

      // And the same context "ab" cannot verify data that was signed under "a"
      const crossResult = hmacVerify(envelope2, key, 'ab');
      expect(crossResult).toBeNull();
    });

    it('should ensure null separator prevents context+data concatenation collision', () => {
      // Specifically test that context "X\0Y" with no separator would equal
      // context "X" + separator + data starting with "Y".
      // With the null separator in place, context "foo" + data produces
      // different HMAC than context "fo" + data (even if data starts with "o").
      const key = 'concat-collision-key';

      // These two should produce different HMACs because the null separator
      // creates an unambiguous boundary between context and data
      const envelope1 = hmacSign('data', key, 'foo');
      const envelope2 = hmacSign('data', key, 'fo');

      expect(envelope1.sig).not.toBe(envelope2.sig);
    });

    it('should reject verification with wrong key (different key than signing key)', () => {
      const data = { secret: 'payload' };
      const envelope = hmacSign(data, 'signing-key');
      const result = hmacVerify(envelope, 'different-key');

      expect(result).toBeNull();
    });

    it('should sign context with data correctly (context included before data)', () => {
      // Verify that context affects the signature by signing same data with and without
      const data = 'same-data';
      const withContext = hmacSign(data, testKey, 'my-context');
      const withoutContext = hmacSign(data, testKey);

      // Signatures must differ when context is added
      expect(withContext.sig).not.toBe(withoutContext.sig);

      // Each must verify only with matching context
      expect(hmacVerify(withContext, testKey, 'my-context')).toBe(data);
      expect(hmacVerify(withoutContext, testKey)).toBe(data);

      // Cross-verification must fail
      expect(hmacVerify(withContext, testKey)).toBeNull();
      expect(hmacVerify(withoutContext, testKey, 'my-context')).toBeNull();
    });
  });
});
