/**
 * Performance Utilities
 *
 * Collection of performance optimization utilities for hot paths.
 *
 * Contents:
 * - WeakMap-based caches for object-keyed scenarios
 * - Memoization utilities
 * - Fast lookup structures
 * - Memory-efficient patterns
 */

// =============================================================================
// WeakMap-Based Object Cache
// =============================================================================

/**
 * Create a WeakMap-backed cache for object-keyed data.
 * Unlike Map, entries are automatically garbage collected when
 * the key object is no longer referenced elsewhere.
 *
 * Use cases:
 * - Caching computed data derived from objects
 * - Storing metadata for objects without preventing GC
 * - Object-to-result memoization
 *
 * @example
 * ```typescript
 * const cache = createObjectCache<Contract, bigint>();
 *
 * async function getBalance(contract: Contract): Promise<bigint> {
 *   const cached = cache.get(contract);
 *   if (cached !== undefined) return cached;
 *
 *   const balance = await contract.getBalance();
 *   cache.set(contract, balance);
 *   return balance;
 * }
 * ```
 */
export function createObjectCache<K extends object, V>() {
  const cache = new WeakMap<K, V>();

  return {
    get(key: K): V | undefined {
      return cache.get(key);
    },

    set(key: K, value: V): void {
      cache.set(key, value);
    },

    has(key: K): boolean {
      return cache.has(key);
    },

    delete(key: K): boolean {
      return cache.delete(key);
    },

    /**
     * Get or compute a value if not cached.
     * Useful for lazy computation patterns.
     */
    getOrCompute(key: K, compute: () => V): V {
      if (cache.has(key)) {
        return cache.get(key) as V;
      }
      const value = compute();
      cache.set(key, value);
      return value;
    },

    /**
     * Get or compute async.
     */
    async getOrComputeAsync(key: K, compute: () => Promise<V>): Promise<V> {
      if (cache.has(key)) {
        return cache.get(key) as V;
      }
      const value = await compute();
      cache.set(key, value);
      return value;
    },
  };
}

// =============================================================================
// Fast Memoization
// =============================================================================

/**
 * Evict the oldest entry from a Map (FIFO order).
 * Shared by memoize() and memoizeAsync() to avoid duplication.
 */
function evictOldest<V>(cache: Map<string, V>): void {
  const firstKey = cache.keys().next().value;
  if (firstKey !== undefined) {
    cache.delete(firstKey);
  }
}

/**
 * Create a memoized version of a single-argument function.
 * Uses Map with automatic size limiting to prevent memory leaks.
 *
 * @param fn - Function to memoize
 * @param maxSize - Maximum cache size (default: 1000)
 * @param keyFn - Optional key extraction function (default: identity)
 */
export function memoize<T, R>(
  fn: (arg: T) => R,
  maxSize: number = 1000,
  keyFn?: (arg: T) => string
): (arg: T) => R {
  const cache = new Map<string, R>();
  const keyExtractor = keyFn ?? ((x: T) => String(x));

  return (arg: T): R => {
    const key = keyExtractor(arg);

    if (cache.has(key)) {
      return cache.get(key) as R;
    }

    const result = fn(arg);

    if (cache.size >= maxSize) {
      evictOldest(cache);
    }

    cache.set(key, result);
    return result;
  };
}

/**
 * Create a memoized async function.
 * Handles concurrent calls to the same key by sharing the promise.
 */
export function memoizeAsync<T, R>(
  fn: (arg: T) => Promise<R>,
  maxSize: number = 1000,
  keyFn?: (arg: T) => string
): (arg: T) => Promise<R> {
  const cache = new Map<string, Promise<R>>();
  const keyExtractor = keyFn ?? ((x: T) => String(x));

  return (arg: T): Promise<R> => {
    const key = keyExtractor(arg);

    if (cache.has(key)) {
      return cache.get(key) as Promise<R>;
    }

    const promise = fn(arg);

    if (cache.size >= maxSize) {
      evictOldest(cache);
    }

    cache.set(key, promise);

    // Clean up on rejection to allow retry.
    // P3-28: Intentionally silent — this is a cache-cleanup side-effect handler,
    // not an error handler. The rejection still propagates to the original caller
    // who is responsible for error handling/logging.
    promise.catch(() => {
      if (cache.get(key) === promise) {
        cache.delete(key);
      }
    });

    return promise;
  };
}

// =============================================================================
// Batch Processing Utilities
// =============================================================================

/**
 * Process items in batches with configurable concurrency.
 * More memory-efficient than Promise.all for large arrays.
 *
 * @param items - Items to process
 * @param processor - Async function to process each item
 * @param batchSize - Number of items to process concurrently
 */
export async function processBatches<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  batchSize: number = 10
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const end = Math.min(i + batchSize, items.length);
    const promises: Promise<R>[] = [];
    for (let j = i; j < end; j++) {
      promises.push(processor(items[j]));
    }
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
  }

  return results;
}

/**
 * Process items with rate limiting.
 * Ensures at least `minDelayMs` between each operation.
 */
export async function processWithRateLimit<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  minDelayMs: number = 100
): Promise<R[]> {
  const results: R[] = [];
  let lastTime = 0;

  for (const item of items) {
    const now = performance.now();
    const elapsed = now - lastTime;

    if (elapsed < minDelayMs && lastTime > 0) {
      await sleep(minDelayMs - elapsed);
    }

    lastTime = performance.now();
    results.push(await processor(item));
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// Fast Lookup Structures
// =============================================================================

/**
 * Create an O(1) lookup set from an array.
 * Normalizes strings to lowercase for case-insensitive lookups.
 */
export function createFastLookupSet(items: string[]): {
  has: (item: string) => boolean;
  size: number;
} {
  const set = new Set(items.map(s => s.toLowerCase()));
  return {
    has: (item: string) => set.has(item.toLowerCase()),
    size: set.size,
  };
}

/**
 * Create an O(1) lookup map from key-value pairs.
 * Normalizes keys to lowercase for case-insensitive lookups.
 */
export function createFastLookupMap<V>(
  entries: [string, V][]
): {
  get: (key: string) => V | undefined;
  has: (key: string) => boolean;
  size: number;
} {
  const map = new Map(entries.map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: (key: string) => map.get(key.toLowerCase()),
    has: (key: string) => map.has(key.toLowerCase()),
    size: map.size,
  };
}

// =============================================================================
// Object Pool (Reuse objects to reduce GC pressure)
// =============================================================================

/**
 * Create an object pool for frequently allocated objects.
 * Reduces garbage collection pressure in hot paths.
 *
 * @example
 * ```typescript
 * interface Point { x: number; y: number; }
 * const pointPool = createObjectPool<Point>(() => ({ x: 0, y: 0 }));
 *
 * const point = pointPool.acquire();
 * point.x = 100;
 * point.y = 200;
 * // Use point...
 * pointPool.release(point);
 * ```
 */
export function createObjectPool<T>(
  factory: () => T,
  reset?: (obj: T) => void,
  maxSize: number = 100
) {
  const pool: T[] = [];

  return {
    acquire(): T {
      return pool.pop() ?? factory();
    },

    release(obj: T): void {
      if (pool.length < maxSize) {
        if (reset) {
          reset(obj);
        }
        pool.push(obj);
      }
    },

    stats() {
      return {
        poolSize: pool.length,
        maxSize,
      };
    },

    clear() {
      pool.length = 0;
    },
  };
}

// =============================================================================
// Lazy Initialization
// =============================================================================

/**
 * Create a lazily-initialized value.
 * The initializer is only called once on first access.
 */
export function lazy<T>(initializer: () => T): () => T {
  let value: T | undefined;
  let initialized = false;

  return () => {
    if (!initialized) {
      value = initializer();
      initialized = true;
    }
    return value as T;
  };
}

/**
 * Create a lazily-initialized async value.
 * Handles concurrent access by sharing the initialization promise.
 * On rejection, clears the cached promise to allow retry on next call.
 */
export function lazyAsync<T>(initializer: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;

  return () => {
    if (promise === undefined) {
      promise = initializer().catch((err) => {
        // Clear cached promise so next call retries initialization
        promise = undefined;
        throw err;
      });
    }
    return promise;
  };
}
