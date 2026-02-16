/**
 * Performance Utilities Unit Tests
 *
 * Tests for caching, memoization, batch processing, object pools, and lazy init.
 * Includes regression tests for the undefined-return cache miss bug (P1 fix).
 */

import {
  createObjectCache,
  memoize,
  memoizeAsync,
  processBatches,
  processWithRateLimit,
  createFastLookupSet,
  createFastLookupMap,
  createObjectPool,
  lazy,
  lazyAsync,
} from '../../src/utils/performance-utils';

// =============================================================================
// WeakMap-Based Object Cache
// =============================================================================

describe('performance-utils', () => {
  describe('createObjectCache', () => {
    it('should store and retrieve values', () => {
      const cache = createObjectCache<object, number>();
      const key = {};

      cache.set(key, 42);
      expect(cache.get(key)).toBe(42);
      expect(cache.has(key)).toBe(true);
    });

    it('should return undefined for missing keys', () => {
      const cache = createObjectCache<object, number>();
      expect(cache.get({})).toBeUndefined();
      expect(cache.has({})).toBe(false);
    });

    it('should delete entries', () => {
      const cache = createObjectCache<object, number>();
      const key = {};

      cache.set(key, 42);
      expect(cache.delete(key)).toBe(true);
      expect(cache.has(key)).toBe(false);
    });

    describe('getOrCompute', () => {
      it('should compute and cache on first call', () => {
        const cache = createObjectCache<object, number>();
        const key = {};
        let computeCount = 0;

        const result = cache.getOrCompute(key, () => {
          computeCount++;
          return 42;
        });

        expect(result).toBe(42);
        expect(computeCount).toBe(1);
      });

      it('should return cached value on subsequent calls', () => {
        const cache = createObjectCache<object, number>();
        const key = {};
        let computeCount = 0;

        cache.getOrCompute(key, () => { computeCount++; return 42; });
        const result = cache.getOrCompute(key, () => { computeCount++; return 99; });

        expect(result).toBe(42);
        expect(computeCount).toBe(1);
      });

      it('should correctly cache undefined values (P1 regression)', () => {
        const cache = createObjectCache<object, undefined>();
        const key = {};
        let computeCount = 0;

        cache.getOrCompute(key, () => { computeCount++; return undefined; });
        cache.getOrCompute(key, () => { computeCount++; return undefined; });

        // Should only compute once — undefined is a valid cached value
        expect(computeCount).toBe(1);
      });
    });

    describe('getOrComputeAsync', () => {
      it('should compute and cache on first call', async () => {
        const cache = createObjectCache<object, number>();
        const key = {};

        const result = await cache.getOrComputeAsync(key, async () => 42);
        expect(result).toBe(42);
      });

      it('should return cached value on subsequent calls', async () => {
        const cache = createObjectCache<object, number>();
        const key = {};
        let computeCount = 0;

        await cache.getOrComputeAsync(key, async () => { computeCount++; return 42; });
        const result = await cache.getOrComputeAsync(key, async () => { computeCount++; return 99; });

        expect(result).toBe(42);
        expect(computeCount).toBe(1);
      });

      it('should correctly cache undefined values (P1 regression)', async () => {
        const cache = createObjectCache<object, undefined>();
        const key = {};
        let computeCount = 0;

        await cache.getOrComputeAsync(key, async () => { computeCount++; return undefined; });
        await cache.getOrComputeAsync(key, async () => { computeCount++; return undefined; });

        expect(computeCount).toBe(1);
      });
    });
  });

  // ===========================================================================
  // Memoize
  // ===========================================================================

  describe('memoize', () => {
    it('should cache function results', () => {
      let callCount = 0;
      const fn = memoize((x: number) => {
        callCount++;
        return x * 2;
      });

      expect(fn(5)).toBe(10);
      expect(fn(5)).toBe(10);
      expect(callCount).toBe(1);
    });

    it('should cache different keys separately', () => {
      let callCount = 0;
      const fn = memoize((x: number) => {
        callCount++;
        return x * 2;
      });

      expect(fn(5)).toBe(10);
      expect(fn(3)).toBe(6);
      expect(callCount).toBe(2);
    });

    it('should correctly cache undefined return values (P1 regression)', () => {
      let callCount = 0;
      const fn = memoize((_x: string) => {
        callCount++;
        return undefined;
      });

      fn('key');
      fn('key');

      // Should only call once — undefined is a valid cached result
      expect(callCount).toBe(1);
    });

    it('should correctly cache null return values', () => {
      let callCount = 0;
      const fn = memoize((_x: string): null => {
        callCount++;
        return null;
      });

      fn('key');
      fn('key');

      expect(callCount).toBe(1);
    });

    it('should evict oldest entry when cache is full (FIFO)', () => {
      let callCount = 0;
      const fn = memoize((x: number) => {
        callCount++;
        return x * 2;
      }, 2);

      fn(1); // cache: {1}
      fn(2); // cache: {1, 2}
      fn(3); // cache: {2, 3} — evicts 1

      callCount = 0;
      fn(1); // re-computed (evicted), cache: {3, 1} — evicts 2
      expect(callCount).toBe(1);

      callCount = 0;
      fn(3); // still cached
      expect(callCount).toBe(0);
    });

    it('should use custom key function', () => {
      let callCount = 0;
      const fn = memoize(
        (obj: { id: number; name: string }) => {
          callCount++;
          return obj.name.toUpperCase();
        },
        100,
        (obj) => String(obj.id)
      );

      expect(fn({ id: 1, name: 'alice' })).toBe('ALICE');
      expect(fn({ id: 1, name: 'bob' })).toBe('ALICE'); // same id, cached
      expect(callCount).toBe(1);

      expect(fn({ id: 2, name: 'bob' })).toBe('BOB'); // different id
      expect(callCount).toBe(2);
    });
  });

  // ===========================================================================
  // MemoizeAsync
  // ===========================================================================

  describe('memoizeAsync', () => {
    it('should cache async function results', async () => {
      let callCount = 0;
      const fn = memoizeAsync(async (x: number) => {
        callCount++;
        return x * 2;
      });

      expect(await fn(5)).toBe(10);
      expect(await fn(5)).toBe(10);
      expect(callCount).toBe(1);
    });

    it('should share promise for concurrent calls with same key', async () => {
      let callCount = 0;
      const fn = memoizeAsync(async (x: number) => {
        callCount++;
        return x * 2;
      });

      const [a, b] = await Promise.all([fn(5), fn(5)]);
      expect(a).toBe(10);
      expect(b).toBe(10);
      expect(callCount).toBe(1);
    });

    it('should clean up cache on rejection to allow retry', async () => {
      let callCount = 0;
      const fn = memoizeAsync(async (x: number) => {
        callCount++;
        if (callCount === 1) throw new Error('first call fails');
        return x * 2;
      });

      await expect(fn(5)).rejects.toThrow('first call fails');

      // Allow microtask for catch handler to clean up
      await new Promise(resolve => setTimeout(resolve, 0));

      // Retry should work
      expect(await fn(5)).toBe(10);
      expect(callCount).toBe(2);
    });

    it('should evict oldest entry when cache is full', async () => {
      let callCount = 0;
      const fn = memoizeAsync(async (x: number) => {
        callCount++;
        return x * 2;
      }, 2);

      await fn(1);
      await fn(2);
      await fn(3); // evicts 1

      callCount = 0;
      await fn(1); // re-computed
      expect(callCount).toBe(1);
    });
  });

  // ===========================================================================
  // Batch Processing
  // ===========================================================================

  describe('processBatches', () => {
    it('should process all items', async () => {
      const items = [1, 2, 3, 4, 5];
      const results = await processBatches(items, async (x) => x * 2, 2);
      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it('should handle empty array', async () => {
      const results = await processBatches([], async (x: number) => x * 2);
      expect(results).toEqual([]);
    });

    it('should process in batches of specified size', async () => {
      const concurrentCounts: number[] = [];
      let active = 0;

      const items = [1, 2, 3, 4, 5];
      await processBatches(items, async (x) => {
        active++;
        concurrentCounts.push(active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        return x;
      }, 2);

      // Max concurrent should be batch size (2)
      expect(Math.max(...concurrentCounts)).toBeLessThanOrEqual(2);
    });

    it('should reject if any item fails', async () => {
      const items = [1, 2, 3];
      await expect(
        processBatches(items, async (x) => {
          if (x === 2) throw new Error('failed');
          return x;
        }, 2)
      ).rejects.toThrow('failed');
    });
  });

  describe('processWithRateLimit', () => {
    it('should process all items sequentially', async () => {
      const items = [1, 2, 3];
      const results = await processWithRateLimit(items, async (x) => x * 2, 0);
      expect(results).toEqual([2, 4, 6]);
    });

    it('should handle empty array', async () => {
      const results = await processWithRateLimit([], async (x: number) => x * 2);
      expect(results).toEqual([]);
    });

    it('should enforce minimum delay between items', async () => {
      const timestamps: number[] = [];
      const items = [1, 2, 3];

      await processWithRateLimit(items, async (x) => {
        timestamps.push(Date.now());
        return x;
      }, 50);

      // Second and third calls should be at least 40ms apart (allowing jitter)
      if (timestamps.length >= 2) {
        expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(40);
      }
    });
  });

  // ===========================================================================
  // Fast Lookup Structures
  // ===========================================================================

  describe('createFastLookupSet', () => {
    it('should provide case-insensitive lookups', () => {
      const set = createFastLookupSet(['Alice', 'BOB', 'charlie']);

      expect(set.has('alice')).toBe(true);
      expect(set.has('ALICE')).toBe(true);
      expect(set.has('Bob')).toBe(true);
      expect(set.has('CHARLIE')).toBe(true);
      expect(set.has('dave')).toBe(false);
    });

    it('should track size correctly', () => {
      const set = createFastLookupSet(['a', 'b', 'c']);
      expect(set.size).toBe(3);
    });

    it('should deduplicate case-insensitive entries', () => {
      const set = createFastLookupSet(['Alice', 'alice', 'ALICE']);
      expect(set.size).toBe(1);
    });

    it('should handle empty array', () => {
      const set = createFastLookupSet([]);
      expect(set.size).toBe(0);
      expect(set.has('anything')).toBe(false);
    });
  });

  describe('createFastLookupMap', () => {
    it('should provide case-insensitive lookups', () => {
      const map = createFastLookupMap([
        ['Alice', 1],
        ['BOB', 2],
      ]);

      expect(map.get('alice')).toBe(1);
      expect(map.get('ALICE')).toBe(1);
      expect(map.get('Bob')).toBe(2);
      expect(map.has('alice')).toBe(true);
      expect(map.has('charlie')).toBe(false);
      expect(map.get('charlie')).toBeUndefined();
    });

    it('should track size correctly', () => {
      const map = createFastLookupMap([['a', 1], ['b', 2]]);
      expect(map.size).toBe(2);
    });

    it('should handle empty entries', () => {
      const map = createFastLookupMap<number>([]);
      expect(map.size).toBe(0);
    });
  });

  // ===========================================================================
  // Object Pool
  // ===========================================================================

  describe('createObjectPool', () => {
    it('should create new objects when pool is empty', () => {
      let createCount = 0;
      const pool = createObjectPool(() => {
        createCount++;
        return { x: 0, y: 0 };
      });

      const obj = pool.acquire();
      expect(obj).toEqual({ x: 0, y: 0 });
      expect(createCount).toBe(1);
    });

    it('should reuse released objects', () => {
      let createCount = 0;
      const pool = createObjectPool(() => {
        createCount++;
        return { x: 0, y: 0 };
      });

      const obj1 = pool.acquire();
      obj1.x = 100;
      pool.release(obj1);

      const obj2 = pool.acquire();
      expect(createCount).toBe(1); // reused, not created
      expect(obj2).toBe(obj1); // same object reference
      expect(obj2.x).toBe(100); // not reset (no reset function)
    });

    it('should call reset function on release', () => {
      const pool = createObjectPool(
        () => ({ x: 0, y: 0 }),
        (obj) => { obj.x = 0; obj.y = 0; }
      );

      const obj = pool.acquire();
      obj.x = 100;
      obj.y = 200;
      pool.release(obj);

      const reused = pool.acquire();
      expect(reused.x).toBe(0);
      expect(reused.y).toBe(0);
    });

    it('should not exceed maxSize', () => {
      const pool = createObjectPool(() => ({}), undefined, 2);

      const a = pool.acquire();
      const b = pool.acquire();
      const c = pool.acquire();

      pool.release(a);
      pool.release(b);
      pool.release(c); // exceeds max, should be discarded

      expect(pool.stats().poolSize).toBe(2);
    });

    it('should report stats', () => {
      const pool = createObjectPool(() => ({}), undefined, 50);

      expect(pool.stats()).toEqual({ poolSize: 0, maxSize: 50 });

      const obj = pool.acquire();
      pool.release(obj);

      expect(pool.stats()).toEqual({ poolSize: 1, maxSize: 50 });
    });

    it('should clear the pool', () => {
      const pool = createObjectPool(() => ({}));
      const obj = pool.acquire();
      pool.release(obj);

      pool.clear();
      expect(pool.stats().poolSize).toBe(0);
    });
  });

  // ===========================================================================
  // Lazy Initialization
  // ===========================================================================

  describe('lazy', () => {
    it('should compute value on first access', () => {
      let initCount = 0;
      const getValue = lazy(() => {
        initCount++;
        return 42;
      });

      expect(initCount).toBe(0);
      expect(getValue()).toBe(42);
      expect(initCount).toBe(1);
    });

    it('should return cached value on subsequent access', () => {
      let initCount = 0;
      const getValue = lazy(() => {
        initCount++;
        return 42;
      });

      getValue();
      getValue();
      getValue();

      expect(initCount).toBe(1);
    });

    it('should handle undefined return value', () => {
      let initCount = 0;
      const getValue = lazy(() => {
        initCount++;
        return undefined;
      });

      expect(getValue()).toBeUndefined();
      getValue();

      // The initialized flag ensures only one call
      expect(initCount).toBe(1);
    });
  });

  describe('lazyAsync', () => {
    it('should compute value on first access', async () => {
      let initCount = 0;
      const getValue = lazyAsync(async () => {
        initCount++;
        return 42;
      });

      expect(await getValue()).toBe(42);
      expect(initCount).toBe(1);
    });

    it('should share promise for concurrent access', async () => {
      let initCount = 0;
      const getValue = lazyAsync(async () => {
        initCount++;
        return 42;
      });

      const [a, b] = await Promise.all([getValue(), getValue()]);
      expect(a).toBe(42);
      expect(b).toBe(42);
      expect(initCount).toBe(1);
    });

    it('should return cached value on subsequent access', async () => {
      let initCount = 0;
      const getValue = lazyAsync(async () => {
        initCount++;
        return 42;
      });

      await getValue();
      await getValue();

      expect(initCount).toBe(1);
    });

    it('should allow retry after rejection (P2 fix)', async () => {
      let initCount = 0;
      const getValue = lazyAsync(async () => {
        initCount++;
        if (initCount === 1) throw new Error('init failed');
        return 42;
      });

      // First call fails
      await expect(getValue()).rejects.toThrow('init failed');

      // Second call should retry and succeed
      expect(await getValue()).toBe(42);
      expect(initCount).toBe(2);
    });

    it('should cache successfully after a failed retry', async () => {
      let initCount = 0;
      const getValue = lazyAsync(async () => {
        initCount++;
        if (initCount <= 2) throw new Error('still failing');
        return 42;
      });

      await expect(getValue()).rejects.toThrow('still failing');
      await expect(getValue()).rejects.toThrow('still failing');
      expect(await getValue()).toBe(42);
      // After success, should be cached
      expect(await getValue()).toBe(42);
      expect(initCount).toBe(3);
    });
  });
});
