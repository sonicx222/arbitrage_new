/**
 * Data Structures Benchmark Suite
 *
 * Performance benchmarks for core data structures used in the arbitrage system.
 * Run with: npm run test:performance -- --testPathPattern=data-structures.perf
 *
 * These benchmarks validate that data structures meet performance expectations
 * for their intended use cases (queue management, caching, partial sorting).
 *
 * @see ADR-022 (Hot-Path Performance Rules)
 */

import { CircularBuffer, createFifoBuffer, createRollingWindow } from '../../src/data-structures/circular-buffer';
import { LRUCache } from '../../src/data-structures/lru-cache';
import { MinHeap, findKSmallest, findKLargest } from '../../src/data-structures/min-heap';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Measure execution time of a function over multiple iterations.
 * Returns average time per operation in microseconds.
 */
function benchmark(fn: () => void, iterations: number): { avgUs: number; totalMs: number } {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const totalMs = performance.now() - start;
  const avgUs = (totalMs / iterations) * 1000;
  return { avgUs, totalMs };
}

// =============================================================================
// CircularBuffer Benchmarks
// =============================================================================

describe('CircularBuffer benchmarks', () => {
  const CAPACITY = 1000;
  const ITERATIONS = 10_000;

  it('push O(1) - should sustain high throughput', () => {
    const buffer = createFifoBuffer<number>(CAPACITY);
    const result = benchmark(() => {
      buffer.push(42);
      if (buffer.isFull) {
        buffer.shift();
      }
    }, ITERATIONS);

     
    console.log(`CircularBuffer push: ${result.avgUs.toFixed(2)} us/op (${ITERATIONS} ops in ${result.totalMs.toFixed(1)} ms)`);
    // O(1) push should be well under 10us per operation
    expect(result.avgUs).toBeLessThan(100);
  });

  it('pushOverwrite O(1) - rolling window throughput', () => {
    const buffer = createRollingWindow<number>(CAPACITY);
    const result = benchmark(() => {
      buffer.pushOverwrite(Math.random());
    }, ITERATIONS);

     
    console.log(`CircularBuffer pushOverwrite: ${result.avgUs.toFixed(2)} us/op (${ITERATIONS} ops in ${result.totalMs.toFixed(1)} ms)`);
    expect(result.avgUs).toBeLessThan(100);
  });

  it('countWhere O(n) - predicate scan on full buffer', () => {
    const buffer = createRollingWindow<number>(CAPACITY);
    for (let i = 0; i < CAPACITY; i++) {
      buffer.pushOverwrite(Math.random());
    }

    const result = benchmark(() => {
      buffer.countWhere(v => v > 0.5);
    }, 1000);

     
    console.log(`CircularBuffer countWhere (n=${CAPACITY}): ${result.avgUs.toFixed(2)} us/op`);
    // O(n) scan of 1000 items should be under 1ms
    expect(result.avgUs).toBeLessThan(1000);
  });

  it('toArray O(n) - snapshot on full buffer', () => {
    const buffer = createRollingWindow<number>(CAPACITY);
    for (let i = 0; i < CAPACITY; i++) {
      buffer.pushOverwrite(i);
    }

    const result = benchmark(() => {
      buffer.toArray();
    }, 1000);

     
    console.log(`CircularBuffer toArray (n=${CAPACITY}): ${result.avgUs.toFixed(2)} us/op`);
    expect(result.avgUs).toBeLessThan(1000);
  });
});

// =============================================================================
// LRUCache Benchmarks
// =============================================================================

describe('LRUCache benchmarks', () => {
  const CACHE_SIZE = 1000;
  const ITERATIONS = 10_000;

  it('set O(1) - insert and evict throughput', () => {
    const cache = new LRUCache<number, string>(CACHE_SIZE);
    let key = 0;

    const result = benchmark(() => {
      cache.set(key++, 'value');
    }, ITERATIONS);

     
    console.log(`LRUCache set: ${result.avgUs.toFixed(2)} us/op (${ITERATIONS} ops in ${result.totalMs.toFixed(1)} ms)`);
    expect(result.avgUs).toBeLessThan(100);
  });

  it('get O(1) - cache hit throughput', () => {
    const cache = new LRUCache<number, string>(CACHE_SIZE);
    for (let i = 0; i < CACHE_SIZE; i++) {
      cache.set(i, `value-${i}`);
    }

    let key = 0;
    const result = benchmark(() => {
      cache.get(key % CACHE_SIZE);
      key++;
    }, ITERATIONS);

     
    console.log(`LRUCache get (hit): ${result.avgUs.toFixed(2)} us/op (${ITERATIONS} ops in ${result.totalMs.toFixed(1)} ms)`);
    expect(result.avgUs).toBeLessThan(100);
  });

  it('get O(1) - cache miss throughput', () => {
    const cache = new LRUCache<number, string>(CACHE_SIZE);
    for (let i = 0; i < CACHE_SIZE; i++) {
      cache.set(i, `value-${i}`);
    }

    let key = CACHE_SIZE; // All misses
    const result = benchmark(() => {
      cache.get(key++);
    }, ITERATIONS);

     
    console.log(`LRUCache get (miss): ${result.avgUs.toFixed(2)} us/op (${ITERATIONS} ops in ${result.totalMs.toFixed(1)} ms)`);
    expect(result.avgUs).toBeLessThan(100);
  });
});

// =============================================================================
// MinHeap Benchmarks
// =============================================================================

describe('MinHeap benchmarks', () => {
  const numericCompare = (a: number, b: number) => a - b;

  it('push O(log n) - insert throughput', () => {
    const heap = new MinHeap<number>(numericCompare);
    const ITERATIONS = 10_000;

    const result = benchmark(() => {
      heap.push(Math.random() * 10000);
    }, ITERATIONS);

     
    console.log(`MinHeap push: ${result.avgUs.toFixed(2)} us/op (${ITERATIONS} ops in ${result.totalMs.toFixed(1)} ms)`);
    expect(result.avgUs).toBeLessThan(100);
  });

  it('pop O(log n) - extract min throughput', () => {
    const HEAP_SIZE = 10_000;
    const heap = new MinHeap<number>(numericCompare);
    for (let i = 0; i < HEAP_SIZE; i++) {
      heap.push(Math.random() * 10000);
    }

    const result = benchmark(() => {
      heap.pop();
    }, HEAP_SIZE);

     
    console.log(`MinHeap pop (n=${HEAP_SIZE}): ${result.avgUs.toFixed(2)} us/op`);
    expect(result.avgUs).toBeLessThan(100);
  });

  it('findKSmallest O(n log k) - partial sort performance', () => {
    const N = 10_000;
    const K = 100;
    const data = Array.from({ length: N }, () => Math.random() * 10000);

    const result = benchmark(() => {
      findKSmallest(data, K, numericCompare);
    }, 100);

     
    console.log(`findKSmallest (n=${N}, k=${K}): ${result.avgUs.toFixed(2)} us/op`);
    // Should be significantly faster than full sort
    expect(result.avgUs).toBeLessThan(50_000);
  });

  it('findKLargest O(n log k) - partial sort performance', () => {
    const N = 10_000;
    const K = 100;
    const data = Array.from({ length: N }, () => Math.random() * 10000);

    const result = benchmark(() => {
      findKLargest(data, K, numericCompare);
    }, 100);

     
    console.log(`findKLargest (n=${N}, k=${K}): ${result.avgUs.toFixed(2)} us/op`);
    expect(result.avgUs).toBeLessThan(50_000);
  });

  it('findKSmallest vs full sort - efficiency comparison', () => {
    const N = 10_000;
    const K = 100;
    const data = Array.from({ length: N }, () => Math.random() * 10000);

    const heapResult = benchmark(() => {
      findKSmallest(data, K, numericCompare);
    }, 50);

    const sortResult = benchmark(() => {
      const sorted = [...data].sort(numericCompare);
      sorted.slice(0, K);
    }, 50);

     
    console.log(`findKSmallest: ${heapResult.avgUs.toFixed(2)} us/op vs full sort: ${sortResult.avgUs.toFixed(2)} us/op (${(sortResult.avgUs / heapResult.avgUs).toFixed(1)}x faster)`);

    // Heap-based approach should be faster than full sort for small k
    // Not asserting ratio since it depends on V8 optimizations
  });
});
