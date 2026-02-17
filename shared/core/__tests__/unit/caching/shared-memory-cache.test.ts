/**
 * Shared Memory Cache Tests
 *
 * Tests for the SharedMemoryCache implementation including:
 * - Constructor: initialization with config, default values
 * - get/set: store and retrieve values, missing keys, key validation
 * - has: existence checks
 * - delete: key removal
 * - clear: remove all entries
 * - size: entry count tracking
 * - keys: key enumeration
 * - stats: cache statistics
 * - increment: atomic numeric increment
 * - compareAndSet: conditional update
 * - TTL: entry expiration
 * - Factory/singleton functions
 * - destroy / cleanup lifecycle
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../../src/logger');

import {
  SharedMemoryCache,
  createSharedMemoryCache,
} from '../../../src/caching/shared-memory-cache';

// SharedArrayBuffer availability check
const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';

// Skip entire suite if SharedArrayBuffer is not available
const describeIfSAB = hasSharedArrayBuffer ? describe : describe.skip;

describeIfSAB('SharedMemoryCache', () => {
  let cache: SharedMemoryCache;

  beforeEach(() => {
    jest.useFakeTimers();
    // Use small size (1 MB) for tests to keep memory usage low
    cache = new SharedMemoryCache({
      size: 1,
      enableCompression: false,
      enableEncryption: false,
      enableAtomicOperations: true,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should create instance with valid config', () => {
      const c = new SharedMemoryCache({
        size: 2,
        enableCompression: false,
        enableEncryption: false,
        enableAtomicOperations: true,
      });
      expect(c).toBeInstanceOf(SharedMemoryCache);
      expect(c.size()).toBe(0);
    });

    it('should use default values when no config provided', () => {
      const c = new SharedMemoryCache();
      expect(c).toBeInstanceOf(SharedMemoryCache);
      const s = c.stats();
      expect(s.size).toBe(64); // default 64MB (Fix #17: reduced from 256MB)
      expect(s.compressionEnabled).toBe(false);
      expect(s.encryptionEnabled).toBe(false);
      expect(s.atomicOperationsEnabled).toBe(true);
    });

    it('should use partial config with defaults for missing fields', () => {
      const c = new SharedMemoryCache({ size: 4 });
      const s = c.stats();
      expect(s.size).toBe(4);
      expect(s.compressionEnabled).toBe(false);
    });

    it('should default enableAtomicOperations to true', () => {
      const c = new SharedMemoryCache({ size: 1 });
      expect(c.stats().atomicOperationsEnabled).toBe(true);
    });

    it('should allow disabling atomic operations', () => {
      const c = new SharedMemoryCache({ size: 1, enableAtomicOperations: false });
      expect(c.stats().atomicOperationsEnabled).toBe(false);
    });

    it('should expose the shared buffer', () => {
      const buffer = cache.getSharedBuffer();
      expect(buffer).toBeInstanceOf(SharedArrayBuffer);
    });

    it('should allocate buffer of correct total size', () => {
      const c = new SharedMemoryCache({ size: 2 }); // 2 MB
      const buffer = c.getSharedBuffer();
      expect(buffer.byteLength).toBe(2 * 1024 * 1024);
    });
  });

  // ==========================================================================
  // set (write operations)
  // ==========================================================================

  describe('set', () => {
    it('should return true when setting a value with valid key', () => {
      expect(cache.set('key1', 'hello')).toBe(true);
    });

    it('should return true for numeric values', () => {
      expect(cache.set('num', 42)).toBe(true);
    });

    it('should return true for object values', () => {
      expect(cache.set('obj', { chain: 'bsc', price: 1.05 })).toBe(true);
    });

    it('should return true for array values', () => {
      expect(cache.set('arr', [1, 2, 3])).toBe(true);
    });

    it('should return true for boolean values', () => {
      expect(cache.set('flag', true)).toBe(true);
    });

    it('should return true for null values', () => {
      expect(cache.set('nullable', null)).toBe(true);
    });

    it('should reject empty string keys', () => {
      expect(cache.set('', 'value')).toBe(false);
    });

    it('should reject keys with null bytes', () => {
      expect(cache.set('key\0bad', 'value')).toBe(false);
    });

    it('should reject keys exceeding max length', () => {
      const longKey = 'x'.repeat(257); // exceeds default maxKeyLength of 256
      expect(cache.set(longKey, 'value')).toBe(false);
    });

    it('should accept keys at max length boundary', () => {
      const boundaryKey = 'x'.repeat(256);
      expect(cache.set(boundaryKey, 'value')).toBe(true);
    });

    it('should increment entry count on successful set', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.size()).toBe(2);
    });
  });

  // ==========================================================================
  // get (read operations)
  // ==========================================================================

  describe('get', () => {
    it('should return null for missing keys', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('should return null for empty string key', () => {
      expect(cache.get('')).toBeNull();
    });

    it('should return null for key with null bytes', () => {
      expect(cache.get('key\0bad')).toBeNull();
    });

    it('should return stored string value after set', () => {
      cache.set('key1', 'hello');
      expect(cache.get('key1')).toBe('hello');
    });

    it('should return stored numeric value after set', () => {
      cache.set('num', 42);
      expect(cache.get('num')).toBe(42);
    });

    it('should return stored object value after set', () => {
      cache.set('obj', { chain: 'bsc', price: 1.05 });
      expect(cache.get('obj')).toEqual({ chain: 'bsc', price: 1.05 });
    });

    it('should return stored array value after set', () => {
      cache.set('arr', [1, 2, 3]);
      expect(cache.get('arr')).toEqual([1, 2, 3]);
    });

    it('should return stored boolean value after set', () => {
      cache.set('flag', true);
      expect(cache.get('flag')).toBe(true);
    });

    it('should return stored null value after set', () => {
      cache.set('nullable', null);
      expect(cache.get('nullable')).toBeNull();
    });

    it('should return updated value after overwrite', () => {
      cache.set('key', 'first');
      cache.set('key', 'second');
      expect(cache.get('key')).toBe('second');
    });
  });

  // ==========================================================================
  // has
  // ==========================================================================

  describe('has', () => {
    it('should return false for missing keys', () => {
      expect(cache.has('absent')).toBe(false);
    });

    it('should return false for invalid keys', () => {
      expect(cache.has('')).toBe(false);
    });

    it('should return true for stored keys', () => {
      cache.set('present', 'yes');
      expect(cache.has('present')).toBe(true);
    });

    it('should return false after key is deleted', () => {
      cache.set('temp', 'value');
      cache.delete('temp');
      expect(cache.has('temp')).toBe(false);
    });
  });

  // ==========================================================================
  // delete
  // ==========================================================================

  describe('delete', () => {
    it('should return false for non-existent key', () => {
      expect(cache.delete('nope')).toBe(false);
    });

    it('should return false for invalid key', () => {
      expect(cache.delete('')).toBe(false);
    });

    it('should return true and remove stored key', () => {
      cache.set('toDelete', 'value');
      expect(cache.delete('toDelete')).toBe(true);
      expect(cache.has('toDelete')).toBe(false);
      expect(cache.get('toDelete')).toBeNull();
    });

    it('should decrement size after deletion', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.size()).toBe(2);
      cache.delete('a');
      expect(cache.size()).toBe(1);
    });

    it('should return false for already-deleted key', () => {
      cache.set('once', 'value');
      cache.delete('once');
      expect(cache.delete('once')).toBe(false);
    });
  });

  // ==========================================================================
  // clear
  // ==========================================================================

  describe('clear', () => {
    it('should reset entry count to zero', () => {
      cache.set('x', 1);
      cache.set('y', 2);
      cache.set('z', 3);
      expect(cache.size()).toBe(3);
      cache.clear();
      expect(cache.size()).toBe(0);
    });

    it('should be safe to call on empty cache', () => {
      expect(() => cache.clear()).not.toThrow();
      expect(cache.size()).toBe(0);
    });

    it('should be safe to call multiple times', () => {
      cache.set('a', 1);
      cache.clear();
      cache.clear();
      expect(cache.size()).toBe(0);
    });

    it('should make keys inaccessible after clear', () => {
      cache.set('key', 'value');
      cache.clear();
      expect(cache.get('key')).toBeNull();
      expect(cache.has('key')).toBe(false);
    });
  });

  // ==========================================================================
  // size
  // ==========================================================================

  describe('size', () => {
    it('should return 0 for empty cache', () => {
      expect(cache.size()).toBe(0);
    });

    it('should return correct count after additions', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      expect(cache.size()).toBe(3);
    });

    it('should return 0 after clear', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      expect(cache.size()).toBe(0);
    });

    it('should not increment size for duplicate key set', () => {
      cache.set('key', 'first');
      cache.set('key', 'second');
      expect(cache.size()).toBe(1);
    });
  });

  // ==========================================================================
  // keys
  // ==========================================================================

  describe('keys', () => {
    it('should return empty array for empty cache', () => {
      expect(cache.keys()).toEqual([]);
    });

    it('should return correct key names', () => {
      cache.set('alpha', 1);
      cache.set('beta', 2);
      const keys = cache.keys();
      expect(keys.length).toBe(2);
      expect(keys).toContain('alpha');
      expect(keys).toContain('beta');
    });

    it('should not include deleted keys', () => {
      cache.set('keep', 1);
      cache.set('remove', 2);
      cache.delete('remove');
      const keys = cache.keys();
      expect(keys).toEqual(['keep']);
    });
  });

  // ==========================================================================
  // stats
  // ==========================================================================

  describe('stats', () => {
    it('should return configuration-derived stats', () => {
      const s = cache.stats();
      expect(s.size).toBe(1); // 1MB configured
      expect(s.entries).toBe(0);
      expect(typeof s.utilization).toBe('number');
      expect(s.compressionEnabled).toBe(false);
      expect(s.encryptionEnabled).toBe(false);
      expect(s.atomicOperationsEnabled).toBe(true);
    });

    it('should reflect entry count after additions', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      const s = cache.stats();
      expect(s.entries).toBe(2);
    });

    it('should return utilization as a number between 0 and 1', () => {
      const s = cache.stats();
      expect(s.utilization).toBeGreaterThanOrEqual(0);
      expect(s.utilization).toBeLessThanOrEqual(1);
    });

    it('should return 0 entries after clear', () => {
      cache.set('a', 1);
      cache.clear();
      expect(cache.stats().entries).toBe(0);
    });
  });

  // ==========================================================================
  // increment
  // ==========================================================================

  describe('increment', () => {
    it('should initialize and return delta for non-existent key', () => {
      const result = cache.increment('counter', 5);
      expect(result).toBe(5);
    });

    it('should use default delta of 1', () => {
      const result = cache.increment('counter');
      expect(result).toBe(1);
    });

    it('should create entry when key does not exist', () => {
      cache.increment('counter', 10);
      expect(cache.size()).toBe(1);
    });

    it('should not create duplicate entries on repeated increment', () => {
      cache.increment('counter', 1);
      cache.increment('counter', 1);
      expect(cache.size()).toBe(1);
    });
  });

  // ==========================================================================
  // compareAndSet
  // ==========================================================================

  describe('compareAndSet', () => {
    it('should fail for non-existent key when expected is non-null', () => {
      const result = cache.compareAndSet('missing', 'something', 'new');
      expect(result).toBe(false);
    });

    it('should succeed when expected value is null and key does not exist', () => {
      const result = cache.compareAndSet('newkey', null, 'created');
      expect(result).toBe(true);
    });

    it('should succeed when expected value matches stored value', () => {
      cache.set('key', 'value');
      const result = cache.compareAndSet('key', 'value', 'new');
      expect(result).toBe(true);
      expect(cache.get('key')).toBe('new');
    });

    it('should fail when expected value does not match stored value', () => {
      cache.set('key', 'value');
      const result = cache.compareAndSet('key', 'wrong', 'new');
      expect(result).toBe(false);
      expect(cache.get('key')).toBe('value');
    });
  });

  // ==========================================================================
  // compareAndSet (with atomic operations disabled)
  // ==========================================================================

  describe('compareAndSet (non-atomic)', () => {
    let nonAtomicCache: SharedMemoryCache;

    beforeEach(() => {
      nonAtomicCache = new SharedMemoryCache({
        size: 1,
        enableCompression: false,
        enableEncryption: false,
        enableAtomicOperations: false,
      });
    });

    it('should succeed when expected is null and key does not exist', () => {
      const result = nonAtomicCache.compareAndSet('newkey', null, 'created');
      expect(result).toBe(true);
    });

    it('should fail when expected is non-null and key does not exist', () => {
      const result = nonAtomicCache.compareAndSet('missing', 'expected', 'new');
      expect(result).toBe(false);
    });

    it('should succeed when expected value matches stored value', () => {
      nonAtomicCache.set('key', 'value');
      const result = nonAtomicCache.compareAndSet('key', 'value', 'updated');
      expect(result).toBe(true);
      expect(nonAtomicCache.get('key')).toBe('updated');
    });
  });

  // ==========================================================================
  // increment (with atomic operations disabled)
  // ==========================================================================

  describe('increment (non-atomic)', () => {
    let nonAtomicCache: SharedMemoryCache;

    beforeEach(() => {
      nonAtomicCache = new SharedMemoryCache({
        size: 1,
        enableCompression: false,
        enableEncryption: false,
        enableAtomicOperations: false,
      });
    });

    it('should initialize and return delta for non-existent key', () => {
      // Non-atomic path: get() returns null, so (null ?? 0) + delta = delta
      const result = nonAtomicCache.increment('counter', 5);
      expect(result).toBe(5);
    });

    it('should use default delta of 1 when not specified', () => {
      const result = nonAtomicCache.increment('counter');
      expect(result).toBe(1);
    });

    it('should accumulate increments correctly', () => {
      nonAtomicCache.increment('counter', 5);
      const result = nonAtomicCache.increment('counter', 3);
      expect(result).toBe(8);
    });
  });

  // ==========================================================================
  // TTL (Time-To-Live)
  // ==========================================================================

  describe('TTL', () => {
    it('should return value before TTL expires', () => {
      cache.set('ttl-key', 'temporary', 2); // 2 second TTL
      expect(cache.get('ttl-key')).toBe('temporary');
    });

    it('should return null after TTL expires', () => {
      cache.set('ttl-key', 'temporary', 2); // 2 second TTL
      jest.advanceTimersByTime(3000);
      expect(cache.get('ttl-key')).toBeNull();
    });

    it('should store entry with TTL (set returns true)', () => {
      expect(cache.set('ttl-key', 'alive', 10)).toBe(true);
    });

    it('should store entry without TTL (set returns true)', () => {
      expect(cache.set('permanent', 'forever')).toBe(true);
    });

    it('should not expire entries without TTL', () => {
      cache.set('permanent', 'forever');
      jest.advanceTimersByTime(100000);
      expect(cache.get('permanent')).toBe('forever');
    });
  });

  // ==========================================================================
  // Factory functions
  // ==========================================================================

  describe('createSharedMemoryCache', () => {
    it('should create a new cache instance', () => {
      const c = createSharedMemoryCache({ size: 1 });
      expect(c).toBeInstanceOf(SharedMemoryCache);
    });

    it('should create instances with default config', () => {
      const c = createSharedMemoryCache();
      expect(c).toBeInstanceOf(SharedMemoryCache);
    });

    it('should create independent instances with separate buffers', () => {
      const c1 = createSharedMemoryCache({ size: 1 });
      const c2 = createSharedMemoryCache({ size: 1 });
      expect(c1.getSharedBuffer()).not.toBe(c2.getSharedBuffer());
    });

    it('should create instances that do not share state', () => {
      const c1 = createSharedMemoryCache({ size: 1 });
      const c2 = createSharedMemoryCache({ size: 1 });
      c1.set('key', 'val1');
      // c2 starts at 0 entries regardless of c1 operations
      expect(c2.size()).toBe(0);
    });
  });

  // ==========================================================================
  // destroy
  // ==========================================================================

  describe('destroy', () => {
    it('should reset entry count to zero', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.destroy();
      expect(cache.size()).toBe(0);
    });

    it('should not throw on destroy of empty cache', () => {
      expect(() => cache.destroy()).not.toThrow();
    });

    it('should not throw when called multiple times', () => {
      cache.set('a', 1);
      cache.destroy();
      expect(() => cache.destroy()).not.toThrow();
    });
  });

  // ==========================================================================
  // cleanup
  // ==========================================================================

  describe('cleanup', () => {
    it('should not throw when no entries exist', () => {
      expect(() => cache.cleanup()).not.toThrow();
    });

    it('should not throw when entries exist', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      expect(() => cache.cleanup()).not.toThrow();
    });

    it('should remove expired entries', () => {
      cache.set('expired', 'old', 1); // 1 second TTL
      cache.set('alive', 'new', 60); // 60 second TTL
      jest.advanceTimersByTime(2000);
      cache.cleanup();
      expect(cache.has('expired')).toBe(false);
      expect(cache.has('alive')).toBe(true);
    });

    it('should not remove entries without TTL', () => {
      cache.set('permanent', 'forever');
      jest.advanceTimersByTime(100000);
      cache.cleanup();
      expect(cache.has('permanent')).toBe(true);
    });

    it('should update size after cleanup', () => {
      cache.set('expired1', 'old1', 1);
      cache.set('expired2', 'old2', 1);
      cache.set('alive', 'new');
      expect(cache.size()).toBe(3);
      jest.advanceTimersByTime(2000);
      cache.cleanup();
      expect(cache.size()).toBe(1);
    });
  });

  // ==========================================================================
  // Compression / Encryption config
  // ==========================================================================

  describe('compression config', () => {
    it('should create cache with compression enabled', () => {
      const compressedCache = new SharedMemoryCache({
        size: 1,
        enableCompression: true,
      });
      expect(compressedCache.stats().compressionEnabled).toBe(true);
    });

    it('should set values with compression enabled without throwing', () => {
      const compressedCache = new SharedMemoryCache({
        size: 1,
        enableCompression: true,
      });
      expect(compressedCache.set('comp-key', { data: 'hello world' })).toBe(true);
    });
  });

  describe('encryption config', () => {
    it('should create cache with encryption enabled', () => {
      const encryptedCache = new SharedMemoryCache({
        size: 1,
        enableEncryption: true,
      });
      expect(encryptedCache.stats().encryptionEnabled).toBe(true);
    });

    it('should set values with encryption enabled without throwing', () => {
      const encryptedCache = new SharedMemoryCache({
        size: 1,
        enableEncryption: true,
      });
      expect(encryptedCache.set('enc-key', { secret: 'classified' })).toBe(true);
    });
  });

  // ==========================================================================
  // Regression: multi-entry update must not corrupt other entries
  // ==========================================================================

  describe('multi-entry update regression', () => {
    it('should not corrupt data when updating a non-last entry with multiple entries present', () => {
      // Regression test for tombstone + write-cursor fix.
      // Previously, updating "first" would tombstone it (keyLen=0) and the
      // scan loop used keyLen to compute entry size, landing at the wrong
      // offset for subsequent entries and corrupting their headers.
      cache.set('first', 'aaa');
      cache.set('second', 'bbb');
      cache.set('third', 'ccc');

      // Update the first entry — this tombstones old "first" and appends new
      cache.set('first', 'updated');

      expect(cache.get('first')).toBe('updated');
      expect(cache.get('second')).toBe('bbb');
      expect(cache.get('third')).toBe('ccc');
      expect(cache.size()).toBe(3);
    });

    it('should handle multiple sequential updates to different keys', () => {
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.set('d', 4);

      // Update non-last entries in various orders
      cache.set('b', 20);
      cache.set('a', 10);
      cache.set('c', 30);

      expect(cache.get('a')).toBe(10);
      expect(cache.get('b')).toBe(20);
      expect(cache.get('c')).toBe(30);
      expect(cache.get('d')).toBe(4);
      expect(cache.size()).toBe(4);
    });

    it('should handle delete then re-create of a key among multiple entries', () => {
      cache.set('x', 'one');
      cache.set('y', 'two');
      cache.set('z', 'three');

      cache.delete('y');
      expect(cache.size()).toBe(2);

      cache.set('y', 'revived');
      expect(cache.get('x')).toBe('one');
      expect(cache.get('y')).toBe('revived');
      expect(cache.get('z')).toBe('three');
      expect(cache.size()).toBe(3);
    });
  });

  // ==========================================================================
  // Key validation edge cases
  // ==========================================================================

  describe('key validation', () => {
    it('should accept single character keys', () => {
      expect(cache.set('x', 1)).toBe(true);
    });

    it('should accept keys with special characters', () => {
      expect(cache.set('chain:bsc:pair:0x1234', 'data')).toBe(true);
    });

    it('should accept keys with unicode characters', () => {
      expect(cache.set('key-with-unicode', 'value')).toBe(true);
    });

    it('should reject non-string keys passed as empty string', () => {
      expect(cache.set('', 'value')).toBe(false);
    });
  });
});
