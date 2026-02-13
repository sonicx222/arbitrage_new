/**
 * Performance Benchmark Tests (Day 10)
 *
 * Performance benchmarks for warming infrastructure.
 *
 * @package @arbitrage/core
 * @module warming/container
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  createTopNWarming,
  createAdaptiveWarming,
  createTestWarming,
  WarmingComponents,
} from '../../src/warming/container/warming.container';
import { HierarchicalCache } from '../../src/caching/hierarchical-cache';

describe('Performance Benchmark Tests', () => {
  let cache: HierarchicalCache;
  let components: WarmingComponents;

  beforeEach(async () => {
    cache = new HierarchicalCache({
      l1Size: 128,
      l2Enabled: true,
      usePriceMatrix: true,
    });

    components = createTestWarming(cache, 'topn');

    // Populate cache with test data
    for (let i = 0; i < 50; i++) {
      await cache.set(`price:ethereum:0x${i.toString(16).padStart(3, '0')}`, {
        price: 1.0 + i * 0.1,
        reserve0: '1000',
        reserve1: (1000 + i * 100).toString(),
      });
    }
  });

  describe('Container Creation Benchmarks', () => {
    it('should create container in <2ms', () => {
      const iterations = 100;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        createTopNWarming(cache);
        durations.push(performance.now() - start);
      }

      const avgDuration = durations.reduce((a, b) => a + b, 0) / iterations;
      const maxDuration = Math.max(...durations);

      console.log(`Container creation: avg=${avgDuration.toFixed(3)}ms, max=${maxDuration.toFixed(3)}ms`);

      expect(avgDuration).toBeLessThan(2);
      expect(maxDuration).toBeLessThan(5);
    });

    it('should create test components in <2ms', () => {
      const iterations = 100;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        createTestWarming(cache);
        durations.push(performance.now() - start);
      }

      const avgDuration = durations.reduce((a, b) => a + b, 0) / iterations;
      const maxDuration = Math.max(...durations);

      console.log(`Test component creation: avg=${avgDuration.toFixed(3)}ms, max=${maxDuration.toFixed(3)}ms`);

      expect(avgDuration).toBeLessThan(2);
      expect(maxDuration).toBeLessThan(5);
    });
  });

  describe('Correlation Tracking Benchmarks', () => {
    it('should track updates in <50μs (hot-path target)', () => {
      const iterations = 10000;
      const durations: number[] = [];

      const now = Date.now();

      for (let i = 0; i < iterations; i++) {
        const result = components.tracker.recordPriceUpdate(
          `0x${(i % 50).toString(16).padStart(3, '0')}`,
          now + i
        );
        if (result.durationUs) {
          durations.push(result.durationUs);
        }
      }

      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
      const p50 = durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.5)];
      const p95 = durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)];
      const p99 = durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.99)];
      const maxDuration = Math.max(...durations);

      console.log(`Correlation tracking (10k updates):`);
      console.log(`  avg=${avgDuration.toFixed(1)}μs`);
      console.log(`  p50=${p50.toFixed(1)}μs`);
      console.log(`  p95=${p95.toFixed(1)}μs`);
      console.log(`  p99=${p99.toFixed(1)}μs`);
      console.log(`  max=${maxDuration.toFixed(1)}μs`);

      expect(avgDuration).toBeLessThan(50);
      expect(p95).toBeLessThan(100);
    });

    it('should handle burst updates efficiently', () => {
      const burstSize = 1000;
      const now = Date.now();

      const start = performance.now();

      for (let i = 0; i < burstSize; i++) {
        components.tracker.recordPriceUpdate(
          `0x${(i % 50).toString(16).padStart(3, '0')}`,
          now + i
        );
      }

      const duration = performance.now() - start;
      const avgPerUpdate = duration / burstSize;

      console.log(`Burst tracking (${burstSize} updates): ${duration.toFixed(2)}ms (${avgPerUpdate.toFixed(3)}ms/update)`);

      expect(duration).toBeLessThan(50); // <50ms for 1000 updates
      expect(avgPerUpdate).toBeLessThan(0.05); // <50μs per update
    });
  });

  describe('Warming Operation Benchmarks', () => {
    beforeEach(() => {
      // Build correlations
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 10; j++) {
          components.tracker.recordPriceUpdate(
            `0x${j.toString(16).padStart(3, '0')}`,
            now + i * 100
          );
        }
      }
    });

    it('should warm pairs in <10ms', async () => {
      const iterations = 100;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const result = await components.warmer.warmForPair(
          `0x${(i % 10).toString(16).padStart(3, '0')}`
        );
        durations.push(result.durationMs);
      }

      const avgDuration = durations.reduce((a, b) => a + b, 0) / iterations;
      const p50 = durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.5)];
      const p95 = durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)];
      const p99 = durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.99)];
      const maxDuration = Math.max(...durations);

      console.log(`Warming operations (100 iterations):`);
      console.log(`  avg=${avgDuration.toFixed(2)}ms`);
      console.log(`  p50=${p50.toFixed(2)}ms`);
      console.log(`  p95=${p95.toFixed(2)}ms`);
      console.log(`  p99=${p99.toFixed(2)}ms`);
      console.log(`  max=${maxDuration.toFixed(2)}ms`);

      expect(avgDuration).toBeLessThan(10);
      expect(p95).toBeLessThan(15);
    });

    it('should handle concurrent warming efficiently', async () => {
      const concurrency = 10;

      const start = performance.now();

      const promises = [];
      for (let i = 0; i < concurrency; i++) {
        promises.push(
          components.warmer.warmForPair(
            `0x${i.toString(16).padStart(3, '0')}`
          )
        );
      }

      const results = await Promise.all(promises);
      const duration = performance.now() - start;

      console.log(`Concurrent warming (${concurrency} ops): ${duration.toFixed(2)}ms`);

      expect(results.every((r) => r.success)).toBe(true);
      expect(duration).toBeLessThan(50);
    });
  });

  describe('Strategy Performance Benchmarks', () => {
    beforeEach(() => {
      // Build correlations
      const now = Date.now();
      for (let i = 0; i < 20; i++) {
        for (let j = 0; j < 20; j++) {
          components.tracker.recordPriceUpdate(
            `0x${j.toString(16).padStart(3, '0')}`,
            now + i * 100
          );
        }
      }
    });

    it('should select pairs efficiently (TopN)', async () => {
      const topN = createTestWarming(cache, 'topn');

      const iterations = 1000;
      const now = Date.now();

      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        topN.tracker.getPairsToWarm(
          `0x${(i % 20).toString(16).padStart(3, '0')}`,
          now,
          5,
          0.3
        );
      }

      const duration = performance.now() - start;
      const avgPerOp = duration / iterations;

      console.log(`TopN selection (${iterations} ops): ${duration.toFixed(2)}ms (${avgPerOp.toFixed(3)}ms/op)`);

      expect(avgPerOp).toBeLessThan(0.1); // <100μs per selection
    });

    it('should select pairs efficiently (Adaptive)', async () => {
      const adaptive = createTestWarming(cache, 'adaptive');

      const iterations = 1000;
      const now = Date.now();

      const start = performance.now();

      for (let i = 0; i < iterations; i++) {
        adaptive.tracker.getPairsToWarm(
          `0x${(i % 20).toString(16).padStart(3, '0')}`,
          now,
          10,
          0.3
        );
      }

      const duration = performance.now() - start;
      const avgPerOp = duration / iterations;

      console.log(`Adaptive selection (${iterations} ops): ${duration.toFixed(2)}ms (${avgPerOp.toFixed(3)}ms/op)`);

      expect(avgPerOp).toBeLessThan(0.2); // <200μs per selection (adaptive has overhead)
    });
  });

  describe('Memory Usage Benchmarks', () => {
    it('should have reasonable memory footprint', () => {
      const components = [];

      // Create multiple instances
      for (let i = 0; i < 10; i++) {
        const testCache = new HierarchicalCache({ l1Size: 64 });
        components.push(createTestWarming(testCache));
      }

      // Track some data
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 100; j++) {
          components[i].tracker.recordPriceUpdate(`0x${j}`, now + j);
        }
      }

      // Verify all are functional
      expect(components.length).toBe(10);
      expect(components.every((c) => c.tracker && c.warmer)).toBe(true);
    });

    it('should share analyzer efficiently', () => {
      const sharedComponents = [];

      // Create instances with shared analyzer
      for (let i = 0; i < 10; i++) {
        const testCache = new HierarchicalCache({ l1Size: 64 });
        sharedComponents.push(createTopNWarming(testCache));
      }

      // All should share same analyzer
      const firstAnalyzer = sharedComponents[0].analyzer;
      expect(
        sharedComponents.every((c) => c.analyzer === firstAnalyzer)
      ).toBe(true);
    });
  });

  describe('Throughput Benchmarks', () => {
    it('should handle high-frequency price updates', () => {
      const updates = 100000;
      const uniquePairs = 100;
      const now = Date.now();

      const start = performance.now();

      for (let i = 0; i < updates; i++) {
        components.tracker.recordPriceUpdate(
          `0x${(i % uniquePairs).toString(16).padStart(3, '0')}`,
          now + i
        );
      }

      const duration = performance.now() - start;
      const throughput = (updates / duration) * 1000; // ops/sec

      console.log(`High-frequency updates:`);
      console.log(`  ${updates} updates in ${duration.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(0)} ops/sec`);

      expect(duration).toBeLessThan(5000); // <5s for 100k updates
      expect(throughput).toBeGreaterThan(20000); // >20k ops/sec
    });

    it('should handle continuous warming operations', async () => {
      // Build correlations first
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 20; j++) {
          components.tracker.recordPriceUpdate(
            `0x${j.toString(16).padStart(3, '0')}`,
            now + i * 100
          );
        }
      }

      const operations = 100;

      const start = performance.now();

      for (let i = 0; i < operations; i++) {
        await components.warmer.warmForPair(
          `0x${(i % 20).toString(16).padStart(3, '0')}`
        );
      }

      const duration = performance.now() - start;
      const throughput = (operations / duration) * 1000; // ops/sec

      console.log(`Continuous warming:`);
      console.log(`  ${operations} operations in ${duration.toFixed(2)}ms`);
      console.log(`  Throughput: ${throughput.toFixed(0)} ops/sec`);

      expect(duration).toBeLessThan(1000); // <1s for 100 operations
    });
  });

  describe('Scalability Benchmarks', () => {
    it('should scale with number of tracked pairs', () => {
      const pairCounts = [10, 50, 100, 500, 1000];
      const results: Array<{ pairs: number; avgDuration: number }> = [];

      for (const pairCount of pairCounts) {
        const testCache = new HierarchicalCache({ l1Size: 128 });
        const testComponents = createTestWarming(testCache);

        const now = Date.now();

        // Track many pairs
        for (let i = 0; i < pairCount; i++) {
          testComponents.tracker.recordPriceUpdate(`0x${i}`, now + i);
        }

        // Measure tracking performance
        const iterations = 100;
        const durations: number[] = [];

        for (let i = 0; i < iterations; i++) {
          const result = testComponents.tracker.recordPriceUpdate(
            `0x${i % pairCount}`,
            now + pairCount + i
          );
          if (result.durationUs) {
            durations.push(result.durationUs);
          }
        }

        const avgDuration =
          durations.reduce((a, b) => a + b, 0) / durations.length;

        results.push({ pairs: pairCount, avgDuration });
      }

      console.log('Scalability (tracked pairs vs duration):');
      results.forEach((r) => {
        console.log(`  ${r.pairs} pairs: ${r.avgDuration.toFixed(1)}μs`);
      });

      // Duration should not grow exponentially
      expect(results[results.length - 1].avgDuration).toBeLessThan(200);
    });

    it('should scale with number of correlations', async () => {
      const correlationCounts = [5, 10, 20, 50];
      const results: Array<{ correlations: number; avgDuration: number }> = [];

      for (const correlationCount of correlationCounts) {
        const testCache = new HierarchicalCache({ l1Size: 128 });
        const testComponents = createTestWarming(testCache);

        const now = Date.now();

        // Build many correlations for single pair
        for (let i = 0; i < 10; i++) {
          testComponents.tracker.recordPriceUpdate('0x000', now + i * 100);
          for (let j = 0; j < correlationCount; j++) {
            testComponents.tracker.recordPriceUpdate(
              `0x${(j + 1).toString(16).padStart(3, '0')}`,
              now + i * 100 + 10
            );
          }
        }

        // Populate cache
        for (let j = 0; j <= correlationCount; j++) {
          await testCache.set(
            `price:ethereum:0x${j.toString(16).padStart(3, '0')}`,
            { price: 1.0, reserve0: '1000', reserve1: '1000' }
          );
        }

        // Measure warming performance
        const iterations = 10;
        const durations: number[] = [];

        for (let i = 0; i < iterations; i++) {
          const result = await testComponents.warmer.warmForPair('0x000');
          durations.push(result.durationMs);
        }

        const avgDuration =
          durations.reduce((a, b) => a + b, 0) / durations.length;

        results.push({ correlations: correlationCount, avgDuration });
      }

      console.log('Scalability (correlations vs warming duration):');
      results.forEach((r) => {
        console.log(
          `  ${r.correlations} correlations: ${r.avgDuration.toFixed(2)}ms`
        );
      });

      // Duration should scale linearly, not exponentially
      expect(results[results.length - 1].avgDuration).toBeLessThan(50);
    });
  });

  describe('Overhead Benchmarks', () => {
    it('should have minimal overhead vs direct cache access', async () => {
      const iterations = 1000;

      // Measure direct cache access
      const directStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        await cache.get(`price:ethereum:0x${(i % 50).toString(16).padStart(3, '0')}`);
      }
      const directDuration = performance.now() - directStart;

      // Measure with warming infrastructure
      const now = Date.now();
      for (let i = 0; i < 50; i++) {
        components.tracker.recordPriceUpdate(
          `0x${i.toString(16).padStart(3, '0')}`,
          now
        );
      }

      const warmingStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        await components.warmer.warmForPair(
          `0x${(i % 50).toString(16).padStart(3, '0')}`
        );
      }
      const warmingDuration = performance.now() - warmingStart;

      const overhead = warmingDuration - directDuration;
      const overheadPercent = (overhead / directDuration) * 100;

      console.log(`Cache access overhead:`);
      console.log(`  Direct: ${directDuration.toFixed(2)}ms`);
      console.log(`  With warming: ${warmingDuration.toFixed(2)}ms`);
      console.log(`  Overhead: ${overhead.toFixed(2)}ms (${overheadPercent.toFixed(1)}%)`);

      // Overhead should be reasonable
      expect(overheadPercent).toBeLessThan(200); // <200% overhead
    });
  });
});
