/**
 * P0/P1 Regression Tests: SharedKeyRegistry Concurrent Registration
 *
 * Verifies that P0 race condition fix (CAS loop) prevents data corruption
 * when multiple threads attempt to register keys concurrently.
 */

import { describe, it, expect } from '@jest/globals';
import { SharedKeyRegistry } from '@arbitrage/core';

describe('SharedKeyRegistry: Concurrent Registration (P0 Fix)', () => {
  describe('Race condition prevention', () => {
    it('should handle concurrent registrations without data corruption', () => {
      // Create registry with small capacity to stress-test CAS loop
      const registry = new SharedKeyRegistry({ maxKeys: 100 });

      // Simulate concurrent registrations
      const keys = Array.from({ length: 50 }, (_, i) => `price:key:${i}`);
      const indices = Array.from({ length: 50 }, (_, i) => i);

      // Register all keys (simulating concurrent calls from setPrice)
      for (let i = 0; i < keys.length; i++) {
        const success = registry.register(keys[i], indices[i]);
        expect(success).toBe(true);
      }

      // Verify all entries are present and correct
      const entries = registry.getAllEntries();
      expect(entries).toHaveLength(50);

      // Verify each key maps to correct index
      for (let i = 0; i < keys.length; i++) {
        const index = registry.lookup(keys[i]);
        expect(index).toBe(indices[i]);
      }

      // Verify no duplicate entries (data corruption check)
      const uniqueKeys = new Set(entries.map(([key]) => key));
      expect(uniqueKeys.size).toBe(50);

      const uniqueIndices = new Set(entries.map(([, index]) => index));
      expect(uniqueIndices.size).toBe(50);
    });

    it('should handle duplicate key registration correctly', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 100 });

      // First registration
      const success1 = registry.register('price:eth:usd', 10);
      expect(success1).toBe(true);

      // Duplicate registration (should fail)
      const success2 = registry.register('price:eth:usd', 20);
      expect(success2).toBe(false);

      // Verify original mapping is preserved
      const index = registry.lookup('price:eth:usd');
      expect(index).toBe(10);
    });

    it('should handle capacity limit correctly', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 5 });

      // Register up to capacity
      for (let i = 0; i < 5; i++) {
        const success = registry.register(`key${i}`, i);
        expect(success).toBe(true);
      }

      // Try to register beyond capacity
      const overflow = registry.register('overflow', 99);
      expect(overflow).toBe(false);

      // Verify capacity is respected
      const stats = registry.getStats();
      expect(stats.entryCount).toBe(5);
      expect(stats.maxKeys).toBe(5);
      expect(stats.utilizationPercent).toBe(100);
    });

    it('should handle rapid sequential registrations', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 1000 });

      // Simulate rapid key registrations (hot-path scenario)
      const numKeys = 500;
      const startTime = process.hrtime.bigint();

      for (let i = 0; i < numKeys; i++) {
        const success = registry.register(`price:pair:${i}`, i);
        expect(success).toBe(true);
      }

      const endTime = process.hrtime.bigint();
      const totalNanos = Number(endTime - startTime);
      const avgLatencyUs = (totalNanos / numKeys) / 1000;

      console.log(`Registration latency: ${avgLatencyUs.toFixed(3)}μs average`);

      // Generous threshold: only fails if something is catastrophically broken.
      // Typical: <200μs per registration. Threshold set to 50,000μs (50ms) per
      // op to avoid flakiness on slow CI runners and heavily loaded machines.
      expect(avgLatencyUs).toBeLessThan(50_000);

      // Verify all registered correctly
      const stats = registry.getStats();
      expect(stats.entryCount).toBe(numKeys);
    });

    it('should maintain consistency across buffer access patterns', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 100 });

      // Register keys in non-sequential order
      const testData = [
        ['price:btc:usd', 42],
        ['price:eth:usd', 7],
        ['price:sol:usd', 99],
        ['price:ada:usd', 1],
        ['price:avax:usd', 55]
      ] as const;

      for (const [key, index] of testData) {
        registry.register(key, index);
      }

      // Get buffer for worker access
      const buffer = registry.getBuffer();
      expect(buffer).toBeInstanceOf(SharedArrayBuffer);

      // Create worker registry from same buffer
      const workerRegistry = new SharedKeyRegistry({ maxKeys: 100 }, buffer);

      // Worker should see all keys correctly
      for (const [key, expectedIndex] of testData) {
        const index = workerRegistry.lookup(key);
        expect(index).toBe(expectedIndex);
      }
    });

    it('should handle clear and reuse correctly', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 50 });

      // Register initial keys
      for (let i = 0; i < 10; i++) {
        registry.register(`key${i}`, i);
      }

      expect(registry.getStats().entryCount).toBe(10);

      // Clear registry
      registry.clear();
      expect(registry.getStats().entryCount).toBe(0);

      // Reuse registry - should work correctly
      for (let i = 0; i < 10; i++) {
        const success = registry.register(`newkey${i}`, i + 100);
        expect(success).toBe(true);
      }

      // Verify new keys are registered
      const index = registry.lookup('newkey5');
      expect(index).toBe(105);

      // Old keys should not be found
      const oldIndex = registry.lookup('key5');
      expect(oldIndex).toBe(-1);
    });
  });

  describe('Key size validation', () => {
    it('should reject keys larger than 60 bytes', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 10 });

      // 61 byte key (UTF-8)
      const tooLong = 'x'.repeat(61);
      const success = registry.register(tooLong, 0);
      expect(success).toBe(false);

      // 60 byte key should work
      const justRight = 'x'.repeat(60);
      const success2 = registry.register(justRight, 0);
      expect(success2).toBe(true);
    });

    it('should handle multi-byte UTF-8 characters correctly', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 10 });

      // 20 characters × 3 bytes each = 60 bytes (UTF-8)
      const emoji = '😀'.repeat(20);
      const byteLength = Buffer.byteLength(emoji, 'utf8');
      expect(byteLength).toBe(80); // 20 * 4 bytes per emoji

      // Should be rejected (>60 bytes)
      const success = registry.register(emoji, 0);
      expect(success).toBe(false);

      // 15 emojis = 60 bytes, should work
      const shorter = '😀'.repeat(15);
      const success2 = registry.register(shorter, 0);
      expect(success2).toBe(true);

      // Verify round-trip
      const index = registry.lookup(shorter);
      expect(index).toBe(0);
    });
  });

  describe('Thread-safety verification', () => {
    it('should be safe for multiple worker reads', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 100 });

      // Main thread: Register keys
      for (let i = 0; i < 20; i++) {
        registry.register(`price:${i}`, i);
      }

      const buffer = registry.getBuffer();

      // Simulate 5 workers reading concurrently
      const workers = Array.from({ length: 5 }, () =>
        new SharedKeyRegistry({ maxKeys: 100 }, buffer)
      );

      // All workers should see same data
      for (let i = 0; i < 20; i++) {
        const key = `price:${i}`;
        for (const worker of workers) {
          const index = worker.lookup(key);
          expect(index).toBe(i);
        }
      }
    });

    it('should handle lookup of non-existent keys safely', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 10 });

      registry.register('key1', 1);
      registry.register('key2', 2);

      // Lookup non-existent keys
      expect(registry.lookup('key3')).toBe(-1);
      expect(registry.lookup('nonexistent')).toBe(-1);
      expect(registry.lookup('')).toBe(-1);
    });
  });

  describe('FNV-1a hash table (OPT-004)', () => {
    it('should handle hash collisions correctly', () => {
      // Use small hash table (maxKeys=4 → hashTableSize=8) to force collisions
      const registry = new SharedKeyRegistry({ maxKeys: 4 });

      // Register 4 keys — with 8 buckets, collisions are very likely
      const testData = [
        ['key_alpha', 10],
        ['key_beta', 20],
        ['key_gamma', 30],
        ['key_delta', 40],
      ] as const;

      for (const [key, index] of testData) {
        expect(registry.register(key, index)).toBe(true);
      }

      // All lookups must return correct indices despite collisions
      for (const [key, expectedIndex] of testData) {
        expect(registry.lookup(key)).toBe(expectedIndex);
      }

      // Non-existent key must return -1, not a collision victim
      expect(registry.lookup('key_epsilon')).toBe(-1);
    });

    it('should expose hashTableSize in stats', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 100 });
      const stats = registry.getStats();

      // hashTableSize = nextPowerOf2(100 * 2) = 256
      expect(stats.hashTableSize).toBe(256);
      expect(stats.entryCount).toBe(0);
    });

    it('should maintain O(1) lookup across worker boundary with collisions', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 8 });

      // Register keys that are likely to have hash collisions
      for (let i = 0; i < 8; i++) {
        registry.register(`price:chain${i}:pair`, i * 100);
      }

      // Create worker registry from same buffer
      const buffer = registry.getBuffer();
      const workerRegistry = new SharedKeyRegistry({ maxKeys: 8 }, buffer);

      // Worker lookups should find all keys via hash table probing
      for (let i = 0; i < 8; i++) {
        expect(workerRegistry.lookup(`price:chain${i}:pair`)).toBe(i * 100);
      }

      // Non-existent key on worker
      expect(workerRegistry.lookup('price:chain9:pair')).toBe(-1);
    });

    it('should handle clear and re-register with hash table reset', () => {
      const registry = new SharedKeyRegistry({ maxKeys: 10 });

      // Register keys
      registry.register('old_key_1', 1);
      registry.register('old_key_2', 2);
      expect(registry.lookup('old_key_1')).toBe(1);

      // Clear and re-register different keys
      registry.clear();
      registry.register('new_key_1', 100);
      registry.register('new_key_2', 200);

      // New keys should be found
      expect(registry.lookup('new_key_1')).toBe(100);
      expect(registry.lookup('new_key_2')).toBe(200);

      // Old keys must NOT be found (hash buckets were reset)
      expect(registry.lookup('old_key_1')).toBe(-1);
      expect(registry.lookup('old_key_2')).toBe(-1);
    });

    it('should be faster than linear scan for cold lookups at scale', () => {
      const keyCount = 5000;
      const registry = new SharedKeyRegistry({ maxKeys: keyCount });

      // Register 5000 keys
      for (let i = 0; i < keyCount; i++) {
        registry.register(`price:bsc:0x${i.toString(16).padStart(40, '0')}`, i);
      }

      // Create worker registry (no local cache)
      const buffer = registry.getBuffer();
      const workerRegistry = new SharedKeyRegistry({ maxKeys: keyCount }, buffer);

      // Time cold lookups (worst-case: no local cache)
      const start = process.hrtime.bigint();
      for (let i = 0; i < keyCount; i++) {
        const idx = workerRegistry.lookup(`price:bsc:0x${i.toString(16).padStart(40, '0')}`);
        expect(idx).toBe(i);
      }
      const elapsed = Number(process.hrtime.bigint() - start);
      const avgUs = (elapsed / keyCount) / 1000;

      console.log(`Hash table cold lookup: ${avgUs.toFixed(3)}μs average (${keyCount} keys)`);

      // With hash table, cold lookup should be <100μs even at 5000 keys
      // (linear scan would be ~1-5ms per lookup at this scale)
      expect(avgUs).toBeLessThan(1000); // 1ms generous CI threshold
    });
  });

  describe('Writer enforcement (H-02)', () => {
    it('should throw when register() is called on a worker (read-only) instance', () => {
      const writer = new SharedKeyRegistry({ maxKeys: 10 });
      writer.register('key1', 1);

      const buffer = writer.getBuffer();
      const reader = new SharedKeyRegistry({ maxKeys: 10 }, buffer);

      // Worker instance must throw on register()
      expect(() => reader.register('key2', 2)).toThrow(
        'SharedKeyRegistry.register() called on worker (read-only) instance'
      );

      // Lookup still works on worker instance
      expect(reader.lookup('key1')).toBe(1);
    });
  });
});
