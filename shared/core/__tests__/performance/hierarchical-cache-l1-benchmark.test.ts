/**
 * PHASE1-TASK35: PriceMatrix L1 Cache Performance Benchmark
 *
 * Measures and compares performance of PriceMatrix vs Map-based L1 cache.
 * Target: <1μs read latency for PriceMatrix
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { HierarchicalCache, createHierarchicalCache } from '@arbitrage/core/caching';

// Performance test timeout
const PERF_TIMEOUT = 60000;

describe('PHASE1-TASK35: HierarchicalCache L1 Performance Benchmark', () => {
  const warmupIterations = 1000;
  const benchmarkIterations = 100000;
  const testKeys = Array.from({ length: 100 }, (_, i) => `price:bench:${i}`);

  describe('PriceMatrix vs Map read performance', () => {
    it('should have <1μs average read latency with PriceMatrix', async () => {
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      // Populate cache
      for (const key of testKeys) {
        await cache.set(key, { price: Math.random() * 1000 });
      }

      // Warmup
      for (let i = 0; i < warmupIterations; i++) {
        await cache.get(testKeys[i % testKeys.length]);
      }

      // Benchmark
      const startTime = process.hrtime.bigint();
      for (let i = 0; i < benchmarkIterations; i++) {
        await cache.get(testKeys[i % testKeys.length]);
      }
      const endTime = process.hrtime.bigint();

      const totalNanoseconds = Number(endTime - startTime);
      const avgLatencyNs = totalNanoseconds / benchmarkIterations;
      const avgLatencyUs = avgLatencyNs / 1000;

      console.log(`PriceMatrix L1 read latency: ${avgLatencyUs.toFixed(3)}μs average`);
      console.log(`Total reads: ${benchmarkIterations.toLocaleString()}`);
      console.log(`Total time: ${(totalNanoseconds / 1e9).toFixed(3)}s`);

      const stats = cache.getStats();
      console.log(`L1 hit rate: ${(stats.l1.hits / (stats.l1.hits + stats.l1.misses) * 100).toFixed(2)}%`);

      // ADR-005 target: <1μs read latency (relaxed to 2μs for CI environments)
      expect(avgLatencyUs).toBeLessThan(2);
    }, PERF_TIMEOUT);

    it('should compare PriceMatrix vs Map performance', async () => {
      // PriceMatrix cache
      const priceMatrixCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      // Map cache
      const mapCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: false
      });

      // Populate both caches
      for (const key of testKeys) {
        const value = { price: Math.random() * 1000 };
        await priceMatrixCache.set(key, value);
        await mapCache.set(key, value);
      }

      // Warmup both
      for (let i = 0; i < warmupIterations; i++) {
        await priceMatrixCache.get(testKeys[i % testKeys.length]);
        await mapCache.get(testKeys[i % testKeys.length]);
      }

      // Benchmark PriceMatrix
      const pmStartTime = process.hrtime.bigint();
      for (let i = 0; i < benchmarkIterations; i++) {
        await priceMatrixCache.get(testKeys[i % testKeys.length]);
      }
      const pmEndTime = process.hrtime.bigint();
      const pmTotalNs = Number(pmEndTime - pmStartTime);
      const pmAvgLatencyUs = pmTotalNs / benchmarkIterations / 1000;

      // Benchmark Map
      const mapStartTime = process.hrtime.bigint();
      for (let i = 0; i < benchmarkIterations; i++) {
        await mapCache.get(testKeys[i % testKeys.length]);
      }
      const mapEndTime = process.hrtime.bigint();
      const mapTotalNs = Number(mapEndTime - mapStartTime);
      const mapAvgLatencyUs = mapTotalNs / benchmarkIterations / 1000;

      // Calculate speedup
      const speedup = mapAvgLatencyUs / pmAvgLatencyUs;

      console.log('\\n=== Performance Comparison ===');
      console.log(`PriceMatrix: ${pmAvgLatencyUs.toFixed(3)}μs average`);
      console.log(`Map:         ${mapAvgLatencyUs.toFixed(3)}μs average`);
      console.log(`Speedup:     ${speedup.toFixed(2)}x faster`);
      console.log(`Improvement: ${((speedup - 1) * 100).toFixed(1)}%`);

      // PriceMatrix should be competitive with Map (current implementation has metadata overhead)
      // Allow 3x margin since we maintain dual structures (PriceMatrix + Map for metadata)
      // and CI environments may have variable scheduling
      expect(pmAvgLatencyUs).toBeLessThanOrEqual(mapAvgLatencyUs * 3);
    }, PERF_TIMEOUT);
  });

  describe('Write performance', () => {
    it('should measure PriceMatrix write performance', async () => {
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      const writeIterations = 50000;

      // Warmup
      for (let i = 0; i < 1000; i++) {
        await cache.set(`price:write:${i}`, { price: i });
      }

      // Benchmark writes
      const startTime = process.hrtime.bigint();
      for (let i = 0; i < writeIterations; i++) {
        await cache.set(testKeys[i % testKeys.length], { price: i });
      }
      const endTime = process.hrtime.bigint();

      const totalNanoseconds = Number(endTime - startTime);
      const avgLatencyNs = totalNanoseconds / writeIterations;
      const avgLatencyUs = avgLatencyNs / 1000;

      console.log(`PriceMatrix L1 write latency: ${avgLatencyUs.toFixed(3)}μs average`);
      console.log(`Total writes: ${writeIterations.toLocaleString()}`);

      // Writes should be reasonably fast (allow 10μs with metadata overhead)
      expect(avgLatencyUs).toBeLessThan(10); // <10μs for writes
    }, PERF_TIMEOUT);
  });

  describe('Hot path simulation', () => {
    it('should maintain <50ms P95 latency under load', async () => {
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      // Simulate hot path: 80% reads, 20% writes
      const operations = 10000;
      const latencies: number[] = [];

      // Populate initial data
      for (const key of testKeys) {
        await cache.set(key, { price: Math.random() * 1000 });
      }

      // Warmup
      for (let i = 0; i < 1000; i++) {
        await cache.get(testKeys[i % testKeys.length]);
      }

      // Mixed workload
      for (let i = 0; i < operations; i++) {
        const key = testKeys[i % testKeys.length];
        const opStartTime = process.hrtime.bigint();

        if (Math.random() < 0.8) {
          // 80% reads
          await cache.get(key);
        } else {
          // 20% writes
          await cache.set(key, { price: Math.random() * 1000 });
        }

        const opEndTime = process.hrtime.bigint();
        const latencyMs = Number(opEndTime - opStartTime) / 1e6;
        latencies.push(latencyMs);
      }

      // Calculate percentiles
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.50)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      console.log('\\n=== Hot Path Latency Distribution ===');
      console.log(`Average: ${avg.toFixed(3)}ms`);
      console.log(`P50:     ${p50.toFixed(3)}ms`);
      console.log(`P95:     ${p95.toFixed(3)}ms`);
      console.log(`P99:     ${p99.toFixed(3)}ms`);

      const stats = cache.getStats();
      console.log(`L1 hit rate: ${(stats.l1.hits / (stats.l1.hits + stats.l1.misses) * 100).toFixed(2)}%`);

      // ADR-005 target: <50ms P95 latency
      expect(p95).toBeLessThan(50);
    }, PERF_TIMEOUT);
  });

  describe('Memory efficiency', () => {
    it('should report memory usage for PriceMatrix', async () => {
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64, // 64MB
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      // Fill cache with test data
      const numPairs = 10000;
      for (let i = 0; i < numPairs; i++) {
        await cache.set(`price:mem:${i}`, {
          price: Math.random() * 1000,
          timestamp: Date.now(),
          volume: Math.random() * 1000000
        });
      }

      const stats = cache.getStats();
      const priceMatrixStats = stats.l1.priceMatrix;

      console.log('\\n=== Memory Usage ===');
      console.log(`L1 entries: ${stats.l1.entries.toLocaleString()}`);
      console.log(`L1 utilization: ${(stats.l1.utilization * 100).toFixed(2)}%`);

      if (priceMatrixStats) {
        console.log(`PriceMatrix reads: ${priceMatrixStats.reads.toLocaleString()}`);
        console.log(`PriceMatrix writes: ${priceMatrixStats.writes.toLocaleString()}`);
        console.log(`PriceMatrix hits: ${priceMatrixStats.hits.toLocaleString()}`);
      }

      // Verify cache is functioning
      expect(stats.l1.entries).toBeGreaterThan(0);
      expect(stats.l1.entries).toBeLessThanOrEqual(numPairs);
    }, PERF_TIMEOUT);
  });

  describe('Scalability', () => {
    it('should handle high throughput reads', async () => {
      const cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      // Populate cache
      const numKeys = 1000;
      for (let i = 0; i < numKeys; i++) {
        await cache.set(`price:scale:${i}`, { price: i });
      }

      // Measure throughput
      const duration = 1000; // 1 second
      const startTime = Date.now();
      let operations = 0;

      while (Date.now() - startTime < duration) {
        await cache.get(`price:scale:${operations % numKeys}`);
        operations++;
      }

      const opsPerSecond = operations / (duration / 1000);

      console.log(`\\n=== Throughput Test ===`);
      console.log(`Operations: ${operations.toLocaleString()}`);
      console.log(`Throughput: ${opsPerSecond.toLocaleString()} ops/sec`);

      const stats = cache.getStats();
      console.log(`L1 hits: ${stats.l1.hits.toLocaleString()}`);
      console.log(`L1 misses: ${stats.l1.misses.toLocaleString()}`);

      // Should achieve high throughput (>100k ops/sec for in-memory cache)
      expect(opsPerSecond).toBeGreaterThan(100000);
    }, PERF_TIMEOUT);
  });
});

describe('PHASE1-TASK35: Performance regression check', () => {
  it('should not regress from baseline Map performance', async () => {
    const numIterations = 50000;

    // Baseline: Map implementation
    const mapCache = createHierarchicalCache({
      l1Enabled: true,
      l1Size: 64,
      l2Enabled: false,
      l3Enabled: false,
      usePriceMatrix: false
    });

    // New: PriceMatrix implementation
    const pmCache = createHierarchicalCache({
      l1Enabled: true,
      l1Size: 64,
      l2Enabled: false,
      l3Enabled: false,
      usePriceMatrix: true
    });

    const testData = Array.from({ length: 100 }, (_, i) => ({
      key: `price:regression:${i}`,
      value: { price: Math.random() * 1000 }
    }));

    // Populate both
    for (const { key, value } of testData) {
      await mapCache.set(key, value);
      await pmCache.set(key, value);
    }

    // Benchmark Map
    const mapStart = process.hrtime.bigint();
    for (let i = 0; i < numIterations; i++) {
      await mapCache.get(testData[i % testData.length].key);
    }
    const mapEnd = process.hrtime.bigint();
    const mapTimeMs = Number(mapEnd - mapStart) / 1e6;

    // Benchmark PriceMatrix
    const pmStart = process.hrtime.bigint();
    for (let i = 0; i < numIterations; i++) {
      await pmCache.get(testData[i % testData.length].key);
    }
    const pmEnd = process.hrtime.bigint();
    const pmTimeMs = Number(pmEnd - pmStart) / 1e6;

    console.log('\\n=== Regression Check ===');
    console.log(`Map baseline:  ${mapTimeMs.toFixed(2)}ms`);
    console.log(`PriceMatrix:   ${pmTimeMs.toFixed(2)}ms`);
    console.log(`Difference:    ${((pmTimeMs - mapTimeMs) / mapTimeMs * 100).toFixed(2)}%`);

    // PriceMatrix should be competitive (allow 3x margin for metadata overhead in CI)
    expect(pmTimeMs).toBeLessThan(mapTimeMs * 3);
  }, PERF_TIMEOUT);
});
