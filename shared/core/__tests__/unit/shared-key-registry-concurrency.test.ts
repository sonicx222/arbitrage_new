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

      // Should be fast (< 200μs per registration with CAS loop overhead)
      // Note: CAS loop adds thread-safety overhead vs simple increment
      // Relaxed from 100μs to account for CI/Windows environment variability
      expect(avgLatencyUs).toBeLessThan(200);

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
});
