/**
 * LRU Cache Tests
 *
 * Tests for the LRU cache implementation including:
 * - Basic get/set operations
 * - LRU eviction behavior
 * - peek() for read-only access (P1-1 hot-path fix)
 */

import { LRUCache, createLRUCache } from '../../../src/data-structures/lru-cache';

describe('LRUCache', () => {
  // ==========================================================================
  // Basic Operations
  // ==========================================================================

  describe('constructor', () => {
    it('should create cache with valid maxSize', () => {
      const cache = new LRUCache<string, number>(100);
      expect(cache.capacity).toBe(100);
      expect(cache.size).toBe(0);
    });

    it('should throw for non-positive maxSize', () => {
      expect(() => new LRUCache<string, number>(0)).toThrow('LRUCache maxSize must be a positive integer');
      expect(() => new LRUCache<string, number>(-1)).toThrow('LRUCache maxSize must be a positive integer');
    });
  });

  describe('set and get', () => {
    it('should store and retrieve values', () => {
      const cache = new LRUCache<string, number>(10);
      cache.set('a', 1);
      cache.set('b', 2);

      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toBe(2);
    });

    it('should return undefined for missing keys', () => {
      const cache = new LRUCache<string, number>(10);
      expect(cache.get('missing')).toBeUndefined();
    });

    it('should update existing keys', () => {
      const cache = new LRUCache<string, number>(10);
      cache.set('a', 1);
      cache.set('a', 100);

      expect(cache.get('a')).toBe(100);
      expect(cache.size).toBe(1);
    });
  });

  // ==========================================================================
  // LRU Eviction
  // ==========================================================================

  describe('LRU eviction', () => {
    it('should evict oldest entry when at capacity', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // Cache is full: [a, b, c]
      expect(cache.size).toBe(3);

      // Add new item, should evict 'a' (oldest)
      cache.set('d', 4);

      expect(cache.size).toBe(3);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('should update LRU order on get()', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // Access 'a' to make it most recently used
      cache.get('a');

      // Add new item, should evict 'b' (now oldest)
      cache.set('d', 4);

      expect(cache.has('a')).toBe(true); // Was accessed, moved to end
      expect(cache.has('b')).toBe(false); // Was oldest, evicted
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('should update LRU order on set() for existing keys', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // Update 'a' to make it most recently used
      cache.set('a', 100);

      // Add new item, should evict 'b' (now oldest)
      cache.set('d', 4);

      expect(cache.has('a')).toBe(true);
      expect(cache.get('a')).toBe(100);
      expect(cache.has('b')).toBe(false);
    });
  });

  // ==========================================================================
  // peek() - P1-1 Hot-Path Fix
  // ==========================================================================

  describe('peek() - read without LRU update', () => {
    it('should return value without updating LRU order', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      // peek() should not change order
      const value = cache.peek('a');
      expect(value).toBe(1);

      // Add new item - 'a' should still be oldest and evicted
      cache.set('d', 4);

      expect(cache.has('a')).toBe(false); // Evicted because peek() didn't update LRU
      expect(cache.has('b')).toBe(true);
      expect(cache.has('c')).toBe(true);
      expect(cache.has('d')).toBe(true);
    });

    it('should return undefined for missing keys', () => {
      const cache = new LRUCache<string, number>(10);
      expect(cache.peek('missing')).toBeUndefined();
    });

    it('should not affect hit/miss counters', () => {
      const cache = new LRUCache<string, number>(10);
      cache.set('a', 1);

      // Multiple peeks should not affect stats
      cache.peek('a');
      cache.peek('a');
      cache.peek('missing');

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('should be O(1) for hot-path usage', () => {
      // Large cache to verify peek() is efficient
      const cache = new LRUCache<string, number>(100000);

      // Fill cache
      for (let i = 0; i < 100000; i++) {
        cache.set(`key${i}`, i);
      }

      // Measure peek() performance (should be <1ms for 10000 operations)
      const start = performance.now();
      for (let i = 0; i < 10000; i++) {
        cache.peek(`key${i % 100000}`);
      }
      const elapsed = performance.now() - start;

      // 10000 peek() operations should take <10ms (generous for CI)
      expect(elapsed).toBeLessThan(10);
    });

    it('should work correctly after multiple get() and set() operations', () => {
      const cache = new LRUCache<string, number>(5);

      // Complex sequence of operations
      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a'); // Move 'a' to end
      cache.set('c', 3);
      cache.set('d', 4);
      cache.set('e', 5);

      // Order is now: [b, a, c, d, e]

      // peek() should still work correctly
      expect(cache.peek('a')).toBe(1);
      expect(cache.peek('b')).toBe(2);
      expect(cache.peek('c')).toBe(3);
      expect(cache.peek('d')).toBe(4);
      expect(cache.peek('e')).toBe(5);

      // Add new item - 'b' should be evicted (oldest after 'a' was accessed)
      cache.set('f', 6);

      expect(cache.has('b')).toBe(false); // Evicted
      expect(cache.peek('a')).toBe(1); // Still there
      expect(cache.peek('f')).toBe(6); // New entry
    });
  });

  // ==========================================================================
  // Statistics
  // ==========================================================================

  describe('statistics', () => {
    it('should track hits and misses for get()', () => {
      const cache = new LRUCache<string, number>(10);
      cache.set('a', 1);

      cache.get('a'); // Hit
      cache.get('a'); // Hit
      cache.get('missing'); // Miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRatio).toBeCloseTo(2 / 3);
    });

    it('should reset statistics', () => {
      const cache = new LRUCache<string, number>(10);
      cache.set('a', 1);
      cache.get('a');
      cache.get('missing');

      cache.resetStats();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRatio).toBeNaN();
    });
  });

  // ==========================================================================
  // Undefined Value Handling (Fix #2 regression test)
  // ==========================================================================

  describe('undefined value handling', () => {
    it('should correctly handle stored undefined values', () => {
      const cache = new LRUCache<string, undefined>(3);
      cache.set('a', undefined);
      cache.set('b', undefined);

      // get() should treat stored undefined as a cache hit
      expect(cache.get('a')).toBeUndefined();
      expect(cache.has('a')).toBe(true);
      expect(cache.size).toBe(2);

      // Nonexistent key should be a miss
      expect(cache.get('nonexistent')).toBeUndefined();

      // Stats should reflect 1 hit (a) and 1 miss (nonexistent)
      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    it('should update LRU order when getting stored undefined values', () => {
      const cache = new LRUCache<string, undefined>(2);
      cache.set('a', undefined);
      cache.set('b', undefined);

      // Access 'a' to promote it in LRU order
      cache.get('a');

      // Adding 'c' should evict 'b' (oldest), not 'a' (recently accessed)
      cache.set('c', undefined);
      expect(cache.has('a')).toBe(true);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(true);
    });
  });

  // ==========================================================================
  // delete() and clear() (Fix #8 regression tests)
  // ==========================================================================

  describe('delete', () => {
    it('should delete an existing key and return true', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);

      expect(cache.delete('a')).toBe(true);
      expect(cache.has('a')).toBe(false);
      expect(cache.size).toBe(1);
    });

    it('should return false for non-existent key', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);

      expect(cache.delete('missing')).toBe(false);
      expect(cache.size).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.has('a')).toBe(false);
      expect(cache.has('b')).toBe(false);
      expect(cache.has('c')).toBe(false);
    });

    it('should allow reuse after clearing', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();

      cache.set('x', 10);
      cache.set('y', 20);

      expect(cache.size).toBe(2);
      expect(cache.get('x')).toBe(10);
      expect(cache.get('y')).toBe(20);
    });
  });

  // ==========================================================================
  // entries() and forEach() (Fix #22 test gaps)
  // ==========================================================================

  describe('entries and forEach', () => {
    it('should return entries in LRU order', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a'); // Move 'a' to end

      const entries = cache.entries();
      expect(entries).toEqual([['b', 2], ['a', 1]]);
    });

    it('should iterate with forEach in LRU order', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);

      const collected: Array<{ key: string; value: number }> = [];
      cache.forEach((value, key) => {
        collected.push({ key, value });
      });

      expect(collected).toEqual([
        { key: 'a', value: 1 },
        { key: 'b', value: 2 },
      ]);
    });
  });

  // ==========================================================================
  // Factory Function
  // ==========================================================================

  describe('createLRUCache', () => {
    it('should create cache via factory function', () => {
      const cache = createLRUCache<string, number>(50);
      expect(cache.capacity).toBe(50);
      expect(cache).toBeInstanceOf(LRUCache);
    });
  });

  // ==========================================================================
  // Iteration
  // ==========================================================================

  describe('iteration', () => {
    it('should iterate entries in LRU order (oldest to newest)', () => {
      const cache = new LRUCache<string, number>(5);
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.get('a'); // Move 'a' to end

      // Order should be: [b, c, a]
      const keys = cache.keys();
      expect(keys).toEqual(['b', 'c', 'a']);

      const values = cache.values();
      expect(values).toEqual([2, 3, 1]);
    });

    it('should support for...of iteration', () => {
      const cache = new LRUCache<string, number>(3);
      cache.set('a', 1);
      cache.set('b', 2);

      const entries: [string, number][] = [];
      for (const entry of cache) {
        entries.push(entry);
      }

      expect(entries).toEqual([['a', 1], ['b', 2]]);
    });
  });
});
