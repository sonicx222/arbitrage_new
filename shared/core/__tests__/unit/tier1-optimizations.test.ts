/**
 * Tier 1 Optimizations Unit Tests
 *
 * Tests for Tier 1 performance optimizations not covered by dedicated test files:
 * - T1.1: Token Pair Indexing for O(1) lookups
 * - T1.4: O(1) LRU Queue Operations
 *
 * Removed (covered elsewhere):
 * - T1.2: Dynamic Slippage — see cross-dex-triangular-arbitrage.test.ts
 * - T1.3: Event Batch Timeout — see event-batcher.test.ts
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ===========================================================================
// T1.4: LRU Queue Tests
// ===========================================================================

// Import LRUQueue directly for isolated testing
import { LRUQueue } from '../../src/caching/hierarchical-cache';

describe('T1.4: O(1) LRU Queue', () => {
  let queue: LRUQueue;

  beforeEach(() => {
    queue = new LRUQueue();
  });

  describe('Basic Operations', () => {
    it('should start with size 0', () => {
      expect(queue.size).toBe(0);
    });

    it('should add keys correctly', () => {
      queue.add('key1');
      queue.add('key2');
      queue.add('key3');
      expect(queue.size).toBe(3);
    });

    it('should check if key exists with has()', () => {
      queue.add('key1');
      expect(queue.has('key1')).toBe(true);
      expect(queue.has('key2')).toBe(false);
    });

    it('should handle duplicate adds by touching', () => {
      queue.add('key1');
      queue.add('key2');
      queue.add('key1'); // Should move to end, not duplicate
      expect(queue.size).toBe(2);
      expect(queue.keys()).toEqual(['key2', 'key1']);
    });

    it('should remove keys correctly', () => {
      queue.add('key1');
      queue.add('key2');
      queue.add('key3');

      expect(queue.remove('key2')).toBe(true);
      expect(queue.size).toBe(2);
      expect(queue.has('key2')).toBe(false);
      expect(queue.keys()).toEqual(['key1', 'key3']);
    });

    it('should return false when removing non-existent key', () => {
      queue.add('key1');
      expect(queue.remove('nonexistent')).toBe(false);
      expect(queue.size).toBe(1);
    });

    it('should clear all entries', () => {
      queue.add('key1');
      queue.add('key2');
      queue.add('key3');

      queue.clear();
      expect(queue.size).toBe(0);
      expect(queue.has('key1')).toBe(false);
    });
  });

  describe('LRU Eviction', () => {
    it('should evict oldest key first', () => {
      queue.add('oldest');
      queue.add('middle');
      queue.add('newest');

      const evicted = queue.evictOldest();
      expect(evicted).toBe('oldest');
      expect(queue.size).toBe(2);
      expect(queue.has('oldest')).toBe(false);
    });

    it('should return null when evicting from empty queue', () => {
      expect(queue.evictOldest()).toBe(null);
    });

    it('should evict in correct order after touches', () => {
      queue.add('key1');
      queue.add('key2');
      queue.add('key3');

      // Touch key1, making it most recently used
      queue.touch('key1');

      // Now order should be: key2 (oldest), key3, key1 (newest)
      expect(queue.evictOldest()).toBe('key2');
      expect(queue.evictOldest()).toBe('key3');
      expect(queue.evictOldest()).toBe('key1');
      expect(queue.evictOldest()).toBe(null);
    });

    it('should handle complex touch sequence', () => {
      queue.add('a');
      queue.add('b');
      queue.add('c');
      queue.add('d');

      queue.touch('b'); // Move b to end
      queue.touch('a'); // Move a to end

      // Order should be: c, d, b, a
      expect(queue.keys()).toEqual(['c', 'd', 'b', 'a']);
    });
  });

  describe('O(1) Performance Verification', () => {
    it('should maintain O(1) operations with large data', () => {
      const count = 10000;

      // Add many items
      const addStart = performance.now();
      for (let i = 0; i < count; i++) {
        queue.add(`key${i}`);
      }
      const addTime = performance.now() - addStart;

      // Touch middle items (should be O(1))
      const touchStart = performance.now();
      for (let i = count / 4; i < count / 2; i++) {
        queue.touch(`key${i}`);
      }
      const touchTime = performance.now() - touchStart;

      // Remove random items (should be O(1))
      const removeStart = performance.now();
      for (let i = 0; i < count / 4; i++) {
        queue.remove(`key${i * 3}`);
      }
      const removeTime = performance.now() - removeStart;

      // Evict remaining items (should be O(1) per eviction)
      // BUG FIX: Track eviction count before loop since queue.size will be 0 after
      const evictCount = queue.size;
      const evictStart = performance.now();
      while (queue.evictOldest() !== null) {
        // Continue evicting
      }
      const evictTime = performance.now() - evictStart;

      // Log performance for analysis
      console.log(`LRU Performance (${count} items):`);
      console.log(`  Add:    ${addTime.toFixed(2)}ms (${(addTime / count * 1000).toFixed(3)}μs/op)`);
      console.log(`  Touch:  ${touchTime.toFixed(2)}ms (${(touchTime / (count / 4) * 1000).toFixed(3)}μs/op)`);
      console.log(`  Remove: ${removeTime.toFixed(2)}ms (${(removeTime / (count / 4) * 1000).toFixed(3)}μs/op)`);
      console.log(`  Evict:  ${evictTime.toFixed(2)}ms (${(evictTime / evictCount * 1000).toFixed(3)}μs/op)`);

      // All operations should complete in reasonable time
      // With O(1) operations, 10k items should take < 100ms each
      expect(addTime).toBeLessThan(500);
      expect(touchTime).toBeLessThan(500);
      expect(removeTime).toBeLessThan(500);
    });
  });

  describe('Edge Cases', () => {
    it('should handle touch on non-existent key', () => {
      queue.add('key1');
      queue.touch('nonexistent'); // Should not throw
      expect(queue.size).toBe(1);
    });

    it('should handle repeated evictions', () => {
      queue.add('key1');
      expect(queue.evictOldest()).toBe('key1');
      expect(queue.evictOldest()).toBe(null);
      expect(queue.evictOldest()).toBe(null);
      expect(queue.size).toBe(0);
    });

    it('should maintain consistency after mixed operations', () => {
      queue.add('a');
      queue.add('b');
      queue.touch('a');
      queue.add('c');
      queue.remove('b');
      queue.add('d');
      queue.touch('c');
      queue.evictOldest(); // Should evict 'a'

      expect(queue.keys()).toEqual(['d', 'c']);
      expect(queue.size).toBe(2);
    });
  });
});

// T1.2 (Dynamic Slippage) removed — fully covered by cross-dex-triangular-arbitrage.test.ts
// T1.3 (Event Batch Timeout) removed — fully covered by event-batcher.test.ts

// ===========================================================================
// T1.1: Token Pair Indexing Tests
// ===========================================================================

describe('T1.1: Token Pair Indexing', () => {
  describe('Token Pair Key Generation', () => {
    // Test the key generation algorithm (simulated since method is protected)
    const getTokenPairKey = (token0: string, token1: string): string => {
      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      return t0 < t1 ? `${t0}_${t1}` : `${t1}_${t0}`;
    };

    it('should generate consistent keys regardless of token order', () => {
      const tokenA = '0xAAAA';
      const tokenB = '0xBBBB';

      const key1 = getTokenPairKey(tokenA, tokenB);
      const key2 = getTokenPairKey(tokenB, tokenA);

      expect(key1).toBe(key2);
    });

    it('should handle case insensitivity', () => {
      const key1 = getTokenPairKey('0xAAAA', '0xBBBB');
      const key2 = getTokenPairKey('0xaaaa', '0xbbbb');
      const key3 = getTokenPairKey('0xAaAa', '0xBbBb');

      expect(key1).toBe(key2);
      expect(key2).toBe(key3);
    });

    it('should sort tokens alphabetically', () => {
      // Tokens starting with 0x1... should come before 0x9...
      const key = getTokenPairKey('0x9999', '0x1111');
      expect(key).toBe('0x1111_0x9999');
    });
  });

  describe('Index Performance', () => {
    it('should enable O(1) pair lookup', () => {
      // Simulate the token pair index structure
      const pairsByTokens = new Map<string, any[]>();

      const getTokenPairKey = (t0: string, t1: string) => {
        const a = t0.toLowerCase();
        const b = t1.toLowerCase();
        return a < b ? `${a}_${b}` : `${b}_${a}`;
      };

      // Add many pairs
      const pairCount = 1000;
      for (let i = 0; i < pairCount; i++) {
        const pair = { address: `0x${i.toString(16).padStart(4, '0')}` };
        const key = getTokenPairKey(`token${i % 10}`, `token${(i + 1) % 10}`);

        if (!pairsByTokens.has(key)) {
          pairsByTokens.set(key, []);
        }
        pairsByTokens.get(key)!.push(pair);
      }

      // Time lookup operations
      const lookupStart = performance.now();
      for (let i = 0; i < 10000; i++) {
        const key = getTokenPairKey('token0', 'token1');
        pairsByTokens.get(key);
      }
      const lookupTime = performance.now() - lookupStart;

      console.log(`Token pair index lookup: ${lookupTime.toFixed(2)}ms for 10k lookups (${(lookupTime / 10).toFixed(3)}μs/op)`);

      // 10k Map lookups should complete in < 150ms (increased for CI environment stability)
      expect(lookupTime).toBeLessThan(150);
    });
  });
});
