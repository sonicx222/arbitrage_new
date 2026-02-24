/**
 * Worker Concurrent Reads Integration Tests (Task #44)
 *
 * Large-scale concurrent read testing with multiple workers.
 * Validates scalability, throughput, and latency under high concurrency.
 *
 * REQUIRES:
 * - Real Worker threads (4-8 workers)
 * - Large datasets (1000+ price entries)
 * - High-throughput scenarios (1000+ concurrent reads)
 *
 * PERFORMANCE TARGETS (tests FAIL if not met):
 * - 1000 concurrent reads complete successfully
 * - >95% success rate under high concurrency
 * - Average latency <100μs per read
 * - Throughput >10,000 reads/sec
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { WorkerTestHarness } from '@arbitrage/test-utils';

describe('Worker Concurrent Reads Integration (Task #44)', () => {
  let harness: WorkerTestHarness;

  beforeAll(async () => {
    harness = new WorkerTestHarness();
  });

  afterAll(async () => {
    if (harness) {
      await harness.terminateAll();
    }
  });

  beforeEach(async () => {
    await harness.setup({
      workerCount: 4,
      sharedBufferSizeMB: 64,
    });
    await harness.spawnWorkers();
  });

  afterEach(async () => {
    await harness.terminateAll();
  });

  describe('High-Volume Concurrent Reads', () => {
    it('should handle 1000 concurrent reads from 4 workers', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 1000 price entries
      const keys: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // Concurrent reads from 4 workers
      const startTime = performance.now();
      const stats = await harness.testConcurrentReads(keys, 4);
      const duration = performance.now() - startTime;

      // Assert success rate (FAIL if <95%)
      expect(stats.successfulReads).toBeGreaterThan(950); // >95%

      // Calculate throughput
      const throughput = (stats.totalReads / duration) * 1000; // reads/sec

      console.log('✓ 1000 concurrent reads completed:', {
        workers: 4,
        totalReads: stats.totalReads,
        successful: stats.successfulReads,
        successRate: `${((stats.successfulReads / stats.totalReads) * 100).toFixed(2)}%`,
        duration: `${duration.toFixed(2)}ms`,
        throughput: `${throughput.toFixed(0)} reads/sec`,
      });
    }, 60000);

    it('should achieve >10,000 reads/sec throughput', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 500 price entries (smaller dataset for high-frequency access)
      const keys: string[] = [];
      for (let i = 0; i < 500; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // Perform 2000 reads (4x dataset size)
      const readKeys = Array(2000)
        .fill(null)
        .map((_, i) => keys[i % keys.length]);

      const startTime = performance.now();
      const stats = await harness.testConcurrentReads(readKeys, 4);
      const duration = performance.now() - startTime;

      const throughput = (stats.totalReads / duration) * 1000; // reads/sec

      // FAIL if throughput <10,000 reads/sec
      expect(throughput).toBeGreaterThan(10000);

      console.log('✓ High throughput achieved:', {
        reads: stats.totalReads,
        duration: `${duration.toFixed(2)}ms`,
        throughput: `${throughput.toFixed(0)} reads/sec`,
        target: '>10,000 reads/sec',
      });
    }, 60000);

    it('should maintain low latency under high concurrency', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 800 price entries
      const keys: string[] = [];
      for (let i = 0; i < 800; i++) {
        const key = `price:polygon:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // Concurrent reads from 4 workers
      const stats = await harness.testConcurrentReads(keys, 4);

      // Assert latency targets (FAIL if not met)
      expect(stats.avgLatencyUs).toBeLessThan(100); // <100μs average
      expect(stats.p99LatencyUs).toBeLessThan(500); // <500μs p99

      console.log('✓ Low latency under high concurrency:', {
        concurrentReads: stats.totalReads,
        avgLatency: `${stats.avgLatencyUs.toFixed(2)}μs`,
        p99Latency: `${stats.p99LatencyUs.toFixed(2)}μs`,
      });
    }, 60000);
  });

  describe('Scalability Testing', () => {
    it('should scale linearly with worker count (1 → 4 → 8 workers)', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 400 price entries
      const keys: string[] = [];
      for (let i = 0; i < 400; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // Test with 1 worker
      const start1 = performance.now();
      const stats1 = await harness.testConcurrentReads(keys, 1);
      const duration1 = performance.now() - start1;
      const throughput1 = (stats1.totalReads / duration1) * 1000;

      // Test with 4 workers
      const start4 = performance.now();
      const stats4 = await harness.testConcurrentReads(keys, 4);
      const duration4 = performance.now() - start4;
      const throughput4 = (stats4.totalReads / duration4) * 1000;

      // Test with 8 workers
      await harness.terminateAll();
      await harness.spawnWorkers(8);

      const start8 = performance.now();
      const stats8 = await harness.testConcurrentReads(keys, 8);
      const duration8 = performance.now() - start8;
      const throughput8 = (stats8.totalReads / duration8) * 1000;

      // Throughput should increase with worker count
      expect(throughput4).toBeGreaterThan(throughput1 * 1.5); // 4 workers >1.5x faster
      expect(throughput8).toBeGreaterThan(throughput4 * 1.3); // 8 workers >1.3x faster than 4

      console.log('✓ Linear scaling with worker count:', {
        '1 worker': `${throughput1.toFixed(0)} reads/sec`,
        '4 workers': `${throughput4.toFixed(0)} reads/sec (${(throughput4 / throughput1).toFixed(2)}x)`,
        '8 workers': `${throughput8.toFixed(0)} reads/sec (${(throughput8 / throughput1).toFixed(2)}x)`,
      });
    }, 90000);

    it('should handle varying dataset sizes efficiently', async () => {
      const priceMatrix = harness.getPriceMatrix();

      const results: Array<{ size: number; throughput: number; latency: number }> = [];

      for (const datasetSize of [100, 500, 1000, 2000]) {
        // Create dataset
        const keys: string[] = [];
        for (let i = 0; i < datasetSize; i++) {
          const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
          keys.push(key);
          priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
        }

        // Measure performance
        const startTime = performance.now();
        const stats = await harness.testConcurrentReads(keys, 4);
        const duration = performance.now() - startTime;

        const throughput = (stats.totalReads / duration) * 1000;

        results.push({
          size: datasetSize,
          throughput,
          latency: stats.avgLatencyUs,
        });
      }

      // Performance should remain consistent across dataset sizes
      const throughputs = results.map(r => r.throughput);
      const variance = Math.max(...throughputs) / Math.min(...throughputs);

      expect(variance).toBeLessThan(3); // <3x variance across dataset sizes

      console.log('✓ Efficient handling of varying dataset sizes:');
      results.forEach(r => {
        console.log(
          `  ${r.size} keys: ${r.throughput.toFixed(0)} reads/sec, ${r.latency.toFixed(2)}μs latency`
        );
      });
    }, 120000);

    it('should maintain performance with hot/cold data mix', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 1000 keys total
      const hotKeys: string[] = []; // 10% hot (frequently accessed)
      const coldKeys: string[] = []; // 90% cold (rarely accessed)

      for (let i = 0; i < 100; i++) {
        const key = `price:hot:0x${i.toString(16).padStart(40, '0')}`;
        hotKeys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      for (let i = 0; i < 900; i++) {
        const key = `price:cold:0x${i.toString(16).padStart(40, '0')}`;
        coldKeys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // 80% reads from hot keys, 20% from cold keys (realistic distribution)
      const readKeys: string[] = [];
      for (let i = 0; i < 1000; i++) {
        if (Math.random() < 0.8) {
          readKeys.push(hotKeys[Math.floor(Math.random() * hotKeys.length)]);
        } else {
          readKeys.push(coldKeys[Math.floor(Math.random() * coldKeys.length)]);
        }
      }

      const stats = await harness.testConcurrentReads(readKeys, 4);

      // Should maintain good performance despite data access patterns
      expect(stats.successfulReads).toBeGreaterThan(950); // >95%
      expect(stats.avgLatencyUs).toBeLessThan(100); // <100μs

      console.log('✓ Performance with hot/cold data mix:', {
        hotKeys: hotKeys.length,
        coldKeys: coldKeys.length,
        totalReads: stats.totalReads,
        successRate: `${((stats.successfulReads / stats.totalReads) * 100).toFixed(2)}%`,
        avgLatency: `${stats.avgLatencyUs.toFixed(2)}μs`,
      });
    }, 60000);
  });

  describe('Stress Testing', () => {
    it('should handle 5000 concurrent reads without failure', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 1000 price entries (5x reads over dataset)
      const keys: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // Generate 5000 read operations
      const readKeys = Array(5000)
        .fill(null)
        .map((_, i) => keys[i % keys.length]);

      const stats = await harness.testConcurrentReads(readKeys, 4);

      // Assert high success rate
      expect(stats.successfulReads).toBeGreaterThan(4750); // >95%

      console.log('✓ 5000 concurrent reads handled:', {
        totalReads: stats.totalReads,
        successful: stats.successfulReads,
        failed: stats.failedReads,
        successRate: `${((stats.successfulReads / stats.totalReads) * 100).toFixed(2)}%`,
      });
    }, 90000);

    it('should maintain stability under continuous load (2 minutes)', async () => {
      const priceMatrix = harness.getPriceMatrix();

      const durationMs = 2 * 60 * 1000; // 2 minutes
      const startTime = Date.now();

      // Create 500 price entries
      const keys: string[] = [];
      for (let i = 0; i < 500; i++) {
        const key = `price:polygon:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      let totalReads = 0;
      let totalSuccessful = 0;
      const latencies: number[] = [];

      while (Date.now() - startTime < durationMs) {
        const batchKeys = Array(200)
          .fill(null)
          .map((_, i) => keys[i % keys.length]);

        const stats = await harness.testConcurrentReads(batchKeys, 4);

        totalReads += stats.totalReads;
        totalSuccessful += stats.successfulReads;
        latencies.push(stats.avgLatencyUs);

        // Small breather between batches
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const successRate = (totalSuccessful / totalReads) * 100;

      // Should maintain high success rate over time
      expect(successRate).toBeGreaterThan(95);
      expect(avgLatency).toBeLessThan(150); // <150μs under sustained load

      console.log('✓ Stability under continuous load (2 min):', {
        duration: '2 minutes',
        totalReads,
        successRate: `${successRate.toFixed(2)}%`,
        avgLatency: `${avgLatency.toFixed(2)}μs`,
      });
    }, 130000); // 2 min + buffer

    it('should recover from intermittent failures gracefully', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 300 price entries
      const keys: string[] = [];
      for (let i = 0; i < 300; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // First batch (should succeed)
      const stats1 = await harness.testConcurrentReads(keys, 4);
      expect(stats1.successfulReads).toBeGreaterThan(285); // >95%

      // Simulate failure (terminate workers)
      await harness.terminateAll();

      // Respawn workers
      await harness.spawnWorkers();

      // Second batch (should recover)
      const stats2 = await harness.testConcurrentReads(keys, 4);
      expect(stats2.successfulReads).toBeGreaterThan(285); // >95%

      console.log('✓ Recovery from intermittent failures:', {
        beforeFailure: `${stats1.successfulReads}/${stats1.totalReads}`,
        afterRecovery: `${stats2.successfulReads}/${stats2.totalReads}`,
      });
    }, 45000);
  });

  describe('Performance Consistency', () => {
    it('should have consistent performance across multiple runs', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 500 price entries
      const keys: string[] = [];
      for (let i = 0; i < 500; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      const runs = 5;
      const results: Array<{ throughput: number; latency: number }> = [];

      for (let run = 0; run < runs; run++) {
        const startTime = performance.now();
        const stats = await harness.testConcurrentReads(keys, 4);
        const duration = performance.now() - startTime;

        const throughput = (stats.totalReads / duration) * 1000;

        results.push({
          throughput,
          latency: stats.avgLatencyUs,
        });

        // Small delay between runs
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Calculate coefficient of variation
      const throughputs = results.map(r => r.throughput);
      const avgThroughput = throughputs.reduce((a, b) => a + b, 0) / throughputs.length;
      const variance =
        throughputs.reduce((sum, t) => sum + Math.pow(t - avgThroughput, 2), 0) / throughputs.length;
      const stdDev = Math.sqrt(variance);
      const cv = (stdDev / avgThroughput) * 100; // Coefficient of variation (%)

      // CV should be <20% (consistent performance)
      expect(cv).toBeLessThan(20);

      console.log('✓ Consistent performance across runs:', {
        runs,
        avgThroughput: `${avgThroughput.toFixed(0)} reads/sec`,
        stdDev: `${stdDev.toFixed(0)} reads/sec`,
        cv: `${cv.toFixed(2)}%`,
      });
    }, 60000);

    it('should have predictable latency distribution', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 600 price entries
      const keys: string[] = [];
      for (let i = 0; i < 600; i++) {
        const key = `price:polygon:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      const stats = await harness.testConcurrentReads(keys, 4);

      // Latency should be predictable (p99/p50 ratio <10)
      const p99ToP50Ratio = stats.p99LatencyUs / (stats.avgLatencyUs * 1.5); // Approximate p50 from avg

      expect(p99ToP50Ratio).toBeLessThan(10);

      console.log('✓ Predictable latency distribution:', {
        avgLatency: `${stats.avgLatencyUs.toFixed(2)}μs`,
        p99Latency: `${stats.p99LatencyUs.toFixed(2)}μs`,
        p99ToP50Ratio: `${p99ToP50Ratio.toFixed(2)}x`,
      });
    }, 45000);
  });

  describe('Real-World Scenarios', () => {
    it('should handle typical production workload (500 keys, 2000 reads)', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Simulate production: 500 active trading pairs
      const keys: string[] = [];
      for (let i = 0; i < 500; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // 2000 reads (4x dataset, realistic read amplification)
      const readKeys = Array(2000)
        .fill(null)
        .map((_, i) => keys[i % keys.length]);

      const startTime = performance.now();
      const stats = await harness.testConcurrentReads(readKeys, 4);
      const duration = performance.now() - startTime;

      const throughput = (stats.totalReads / duration) * 1000;

      // Production targets
      expect(stats.successfulReads).toBeGreaterThan(1900); // >95%
      expect(throughput).toBeGreaterThan(10000); // >10K reads/sec
      expect(stats.avgLatencyUs).toBeLessThan(100); // <100μs

      console.log('✓ Production workload handled:', {
        tradingPairs: 500,
        reads: stats.totalReads,
        successRate: `${((stats.successfulReads / stats.totalReads) * 100).toFixed(2)}%`,
        throughput: `${throughput.toFixed(0)} reads/sec`,
        avgLatency: `${stats.avgLatencyUs.toFixed(2)}μs`,
      });
    }, 60000);
  });
});
