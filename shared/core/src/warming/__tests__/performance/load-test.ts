/**
 * Load Testing Suite (Day 12)
 *
 * Tests warming infrastructure under production-scale load.
 *
 * @package @arbitrage/core
 * @module warming/performance
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  createTopNWarming,
  createAdaptiveWarming,
  WarmingComponents,
} from '../../container/warming.container';
import { HierarchicalCache } from '../../../caching/hierarchical-cache';

describe('Load Testing - Production Scale', () => {
  let cache: HierarchicalCache;
  let components: WarmingComponents;

  beforeAll(async () => {
    cache = new HierarchicalCache({
      l1Size: 256, // Production size
      l2Enabled: true,
      usePriceMatrix: true,
    });

    components = createAdaptiveWarming(cache, 0.97, 10);

    // Pre-populate cache with production-like data
    console.log('Pre-populating cache with test data...');
    for (let i = 0; i < 1000; i++) {
      await cache.set(`price:ethereum:0x${i.toString(16).padStart(40, '0')}`, {
        price: 1.0 + Math.random(),
        reserve0: (1000000 + Math.random() * 1000000).toString(),
        reserve1: (1000000 + Math.random() * 1000000).toString(),
        blockNumber: 1000000 + i,
      });
    }
    console.log('Cache pre-population complete');
  });

  afterAll(async () => {
    await cache.clear();
  });

  describe('Sustained Load Test', () => {
    it('should handle 10,000 price updates/sec for 10 seconds', async () => {
      const updatesPerSecond = 10000;
      const durationSeconds = 10;
      const totalUpdates = updatesPerSecond * durationSeconds;
      const uniquePairs = 500;

      console.log(`\nLoad Test: ${totalUpdates} updates over ${durationSeconds}s`);

      const start = performance.now();
      let completed = 0;
      const durations: number[] = [];
      const errors: number[] = [];

      for (let i = 0; i < totalUpdates; i++) {
        const pairIndex = i % uniquePairs;
        const pairAddress = `0x${pairIndex.toString(16).padStart(40, '0')}`;
        const timestamp = Date.now() + i;

        const result = components.tracker.recordPriceUpdate(pairAddress, timestamp);

        if (result.success) {
          completed++;
          if (result.durationUs) {
            durations.push(result.durationUs);
          }
        } else {
          errors.push(i);
        }

        // Brief pause every 100 updates to avoid blocking event loop
        if (i % 100 === 0 && i > 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      const elapsed = performance.now() - start;
      const actualRate = (completed / elapsed) * 1000;

      // Calculate statistics
      durations.sort((a, b) => a - b);
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const p50 = durations[Math.floor(durations.length * 0.5)];
      const p95 = durations[Math.floor(durations.length * 0.95)];
      const p99 = durations[Math.floor(durations.length * 0.99)];
      const max = durations[durations.length - 1];

      console.log('\n=== Load Test Results ===');
      console.log(`Total Updates: ${totalUpdates}`);
      console.log(`Completed: ${completed} (${((completed / totalUpdates) * 100).toFixed(2)}%)`);
      console.log(`Errors: ${errors.length}`);
      console.log(`Duration: ${elapsed.toFixed(0)}ms (${(elapsed / 1000).toFixed(2)}s)`);
      console.log(`Actual Rate: ${actualRate.toFixed(0)} updates/sec`);
      console.log('\n=== Latency Statistics ===');
      console.log(`Average: ${avg.toFixed(1)}μs`);
      console.log(`P50: ${p50.toFixed(1)}μs`);
      console.log(`P95: ${p95.toFixed(1)}μs`);
      console.log(`P99: ${p99.toFixed(1)}μs`);
      console.log(`Max: ${max.toFixed(1)}μs`);

      // Assertions
      expect(completed).toBeGreaterThan(totalUpdates * 0.99); // >99% success rate
      expect(errors.length).toBeLessThan(totalUpdates * 0.01); // <1% errors
      expect(avg).toBeLessThan(100); // Average <100μs
      expect(p95).toBeLessThan(200); // P95 <200μs
      expect(p99).toBeLessThan(500); // P99 <500μs
    }, 30000); // 30s timeout

    it('should handle 1,000 warming operations/sec for 10 seconds', async () => {
      const warmingsPerSecond = 1000;
      const durationSeconds = 10;
      const totalWarmings = warmingsPerSecond * durationSeconds;
      const uniquePairs = 100;

      console.log(`\nWarming Load Test: ${totalWarmings} operations over ${durationSeconds}s`);

      // Build correlations first
      console.log('Building correlations...');
      const now = Date.now();
      for (let i = 0; i < uniquePairs; i++) {
        for (let j = 0; j < 10; j++) {
          const pairAddress = `0x${i.toString(16).padStart(40, '0')}`;
          components.tracker.recordPriceUpdate(pairAddress, now + j * 100);
        }
      }
      console.log('Correlations built');

      const start = performance.now();
      let completed = 0;
      const durations: number[] = [];
      const errors: string[] = [];

      // Batch warming operations
      const batchSize = 10;
      for (let i = 0; i < totalWarmings; i += batchSize) {
        const promises = [];

        for (let j = 0; j < batchSize && i + j < totalWarmings; j++) {
          const pairIndex = (i + j) % uniquePairs;
          const pairAddress = `0x${pairIndex.toString(16).padStart(40, '0')}`;

          promises.push(
            components.warmer.warmForPair(pairAddress).then(result => {
              if (result.success) {
                completed++;
                durations.push(result.durationMs);
              } else {
                errors.push(result.error || 'Unknown error');
              }
              return result;
            })
          );
        }

        await Promise.all(promises);

        // Brief pause to avoid overwhelming the system
        if (i % 100 === 0 && i > 0) {
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      }

      const elapsed = performance.now() - start;
      const actualRate = (completed / elapsed) * 1000;

      // Calculate statistics
      durations.sort((a, b) => a - b);
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const p50 = durations[Math.floor(durations.length * 0.5)];
      const p95 = durations[Math.floor(durations.length * 0.95)];
      const p99 = durations[Math.floor(durations.length * 0.99)];
      const max = durations[durations.length - 1];

      console.log('\n=== Warming Load Test Results ===');
      console.log(`Total Warmings: ${totalWarmings}`);
      console.log(`Completed: ${completed} (${((completed / totalWarmings) * 100).toFixed(2)}%)`);
      console.log(`Errors: ${errors.length}`);
      console.log(`Duration: ${elapsed.toFixed(0)}ms (${(elapsed / 1000).toFixed(2)}s)`);
      console.log(`Actual Rate: ${actualRate.toFixed(0)} warmings/sec`);
      console.log('\n=== Latency Statistics ===');
      console.log(`Average: ${avg.toFixed(2)}ms`);
      console.log(`P50: ${p50.toFixed(2)}ms`);
      console.log(`P95: ${p95.toFixed(2)}ms`);
      console.log(`P99: ${p99.toFixed(2)}ms`);
      console.log(`Max: ${max.toFixed(2)}ms`);

      // Assertions
      expect(completed).toBeGreaterThan(totalWarmings * 0.95); // >95% success rate
      expect(errors.length).toBeLessThan(totalWarmings * 0.05); // <5% errors
      expect(avg).toBeLessThan(15); // Average <15ms
      expect(p95).toBeLessThan(25); // P95 <25ms
      expect(p99).toBeLessThan(50); // P99 <50ms
    }, 60000); // 60s timeout
  });

  describe('Spike Load Test', () => {
    it('should handle sudden spike in traffic (10x normal)', async () => {
      const normalRate = 1000; // updates/sec
      const spikeRate = 10000; // 10x spike
      const spikeDuration = 5000; // 5 seconds
      const uniquePairs = 200;

      console.log(`\nSpike Test: ${normalRate} → ${spikeRate} updates/sec for ${spikeDuration}ms`);

      const results = {
        normal: { completed: 0, errors: 0, durations: [] as number[] },
        spike: { completed: 0, errors: 0, durations: [] as number[] },
      };

      // Normal load phase (2 seconds)
      console.log('Phase 1: Normal load...');
      let start = performance.now();
      for (let i = 0; i < normalRate * 2; i++) {
        const pairIndex = i % uniquePairs;
        const pairAddress = `0x${pairIndex.toString(16).padStart(40, '0')}`;
        const result = components.tracker.recordPriceUpdate(pairAddress, Date.now());

        if (result.success) {
          results.normal.completed++;
          if (result.durationUs) results.normal.durations.push(result.durationUs);
        } else {
          results.normal.errors++;
        }

        if (i % 100 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      let normalElapsed = performance.now() - start;

      // Spike load phase (5 seconds)
      console.log('Phase 2: Spike load (10x)...');
      start = performance.now();
      for (let i = 0; i < (spikeRate * spikeDuration) / 1000; i++) {
        const pairIndex = i % uniquePairs;
        const pairAddress = `0x${pairIndex.toString(16).padStart(40, '0')}`;
        const result = components.tracker.recordPriceUpdate(pairAddress, Date.now());

        if (result.success) {
          results.spike.completed++;
          if (result.durationUs) results.spike.durations.push(result.durationUs);
        } else {
          results.spike.errors++;
        }

        if (i % 100 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      let spikeElapsed = performance.now() - start;

      // Calculate statistics
      const normalAvg =
        results.normal.durations.reduce((a, b) => a + b, 0) / results.normal.durations.length;
      const spikeAvg =
        results.spike.durations.reduce((a, b) => a + b, 0) / results.spike.durations.length;

      results.spike.durations.sort((a, b) => a - b);
      const spikeP95 = results.spike.durations[Math.floor(results.spike.durations.length * 0.95)];

      console.log('\n=== Spike Test Results ===');
      console.log(`Normal Phase: ${results.normal.completed} updates, avg ${normalAvg.toFixed(1)}μs`);
      console.log(`Spike Phase: ${results.spike.completed} updates, avg ${spikeAvg.toFixed(1)}μs`);
      console.log(`Spike P95: ${spikeP95.toFixed(1)}μs`);
      console.log(`Degradation: ${((spikeAvg / normalAvg - 1) * 100).toFixed(1)}%`);

      // Assertions
      expect(results.spike.errors).toBeLessThan(results.spike.completed * 0.05); // <5% errors during spike
      expect(spikeAvg).toBeLessThan(normalAvg * 3); // <3x degradation
      expect(spikeP95).toBeLessThan(500); // P95 stays <500μs
    }, 30000);
  });

  describe('Endurance Test', () => {
    it('should maintain performance over 60 seconds', async () => {
      const durationMs = 60000; // 1 minute
      const updateRate = 5000; // updates/sec
      const interval = 1000; // Measure every 1s
      const uniquePairs = 300;

      console.log(`\nEndurance Test: ${updateRate} updates/sec for ${durationMs / 1000}s`);

      const measurements: Array<{
        timestamp: number;
        avgLatency: number;
        p95Latency: number;
        completed: number;
      }> = [];

      const startTime = Date.now();
      let totalCompleted = 0;

      while (Date.now() - startTime < durationMs) {
        const intervalStart = performance.now();
        const durations: number[] = [];
        let intervalCompleted = 0;

        // Run updates for 1 second
        for (let i = 0; i < updateRate; i++) {
          const pairIndex = (totalCompleted + i) % uniquePairs;
          const pairAddress = `0x${pairIndex.toString(16).padStart(40, '0')}`;
          const result = components.tracker.recordPriceUpdate(pairAddress, Date.now());

          if (result.success) {
            intervalCompleted++;
            if (result.durationUs) durations.push(result.durationUs);
          }

          if (i % 100 === 0) {
            await new Promise(resolve => setImmediate(resolve));
          }
        }

        totalCompleted += intervalCompleted;

        // Calculate interval statistics
        if (durations.length > 0) {
          durations.sort((a, b) => a - b);
          const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
          const p95 = durations[Math.floor(durations.length * 0.95)];

          measurements.push({
            timestamp: Date.now() - startTime,
            avgLatency: avg,
            p95Latency: p95,
            completed: intervalCompleted,
          });
        }

        // Wait until next interval
        const elapsed = performance.now() - intervalStart;
        if (elapsed < interval) {
          await new Promise(resolve => setTimeout(resolve, interval - elapsed));
        }
      }

      // Analyze endurance results
      const avgLatencies = measurements.map(m => m.avgLatency);
      const p95Latencies = measurements.map(m => m.p95Latency);

      const initialAvg = avgLatencies.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      const finalAvg = avgLatencies.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const degradation = ((finalAvg - initialAvg) / initialAvg) * 100;

      console.log('\n=== Endurance Test Results ===');
      console.log(`Total Completed: ${totalCompleted}`);
      console.log(`Measurements: ${measurements.length}`);
      console.log(`Initial Avg Latency: ${initialAvg.toFixed(1)}μs`);
      console.log(`Final Avg Latency: ${finalAvg.toFixed(1)}μs`);
      console.log(`Degradation: ${degradation.toFixed(1)}%`);
      console.log(
        `P95 Range: ${Math.min(...p95Latencies).toFixed(1)}μs - ${Math.max(...p95Latencies).toFixed(1)}μs`
      );

      // Assertions
      expect(totalCompleted).toBeGreaterThan((durationMs / 1000) * updateRate * 0.95); // >95% completion
      expect(degradation).toBeLessThan(20); // <20% degradation over time
      expect(finalAvg).toBeLessThan(150); // Final avg <150μs
      expect(Math.max(...p95Latencies)).toBeLessThan(300); // Max P95 <300μs
    }, 120000); // 2 minute timeout
  });

  describe('Memory Pressure Test', () => {
    it('should handle large number of tracked pairs', async () => {
      const totalPairs = 5000; // Production scale
      const updatesPerPair = 10;

      console.log(`\nMemory Pressure Test: ${totalPairs} pairs, ${updatesPerPair} updates each`);

      const memBefore = process.memoryUsage();
      const start = performance.now();

      // Track many unique pairs
      for (let i = 0; i < totalPairs; i++) {
        const pairAddress = `0x${i.toString(16).padStart(40, '0')}`;

        for (let j = 0; j < updatesPerPair; j++) {
          components.tracker.recordPriceUpdate(pairAddress, Date.now() + j * 100);
        }

        if (i % 100 === 0 && i > 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      const elapsed = performance.now() - start;
      const memAfter = process.memoryUsage();

      const stats = components.tracker.getStats();

      const heapIncrease = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;
      const memPerPair = heapIncrease / totalPairs;

      console.log('\n=== Memory Pressure Results ===');
      console.log(`Total Pairs Tracked: ${stats.totalPairs}`);
      console.log(`Total Updates: ${stats.totalUpdates}`);
      console.log(`Duration: ${elapsed.toFixed(0)}ms`);
      console.log(`Heap Before: ${(memBefore.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Heap After: ${(memAfter.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Heap Increase: ${heapIncrease.toFixed(2)}MB`);
      console.log(`Memory per Pair: ${(memPerPair * 1024).toFixed(2)}KB`);

      // Assertions
      expect(stats.totalPairs).toBeGreaterThanOrEqual(totalPairs * 0.9); // Track >90% of pairs
      expect(heapIncrease).toBeLessThan(50); // <50MB total increase
      expect(memPerPair).toBeLessThan(0.02); // <20KB per pair
    }, 60000);
  });

  describe('Concurrent Operations Test', () => {
    it('should handle concurrent warming operations', async () => {
      const concurrency = 50;
      const operationsPerWorker = 20;

      console.log(`\nConcurrency Test: ${concurrency} concurrent workers, ${operationsPerWorker} ops each`);

      // Build correlations
      for (let i = 0; i < 100; i++) {
        for (let j = 0; j < 10; j++) {
          components.tracker.recordPriceUpdate(`0x${i.toString(16).padStart(40, '0')}`, Date.now());
        }
      }

      const start = performance.now();
      const workers: Promise<any>[] = [];

      // Spawn concurrent workers
      for (let w = 0; w < concurrency; w++) {
        workers.push(
          (async () => {
            const results = [];

            for (let i = 0; i < operationsPerWorker; i++) {
              const pairAddress = `0x${((w * operationsPerWorker + i) % 100).toString(16).padStart(40, '0')}`;
              const result = await components.warmer.warmForPair(pairAddress);
              results.push(result);
            }

            return results;
          })()
        );
      }

      const allResults = await Promise.all(workers);
      const elapsed = performance.now() - start;

      // Flatten results
      const results = allResults.flat();
      const successful = results.filter(r => r.success).length;
      const durations = results.map(r => r.durationMs);
      const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;

      console.log('\n=== Concurrency Test Results ===');
      console.log(`Total Operations: ${results.length}`);
      console.log(`Successful: ${successful} (${((successful / results.length) * 100).toFixed(2)}%)`);
      console.log(`Total Duration: ${elapsed.toFixed(0)}ms`);
      console.log(`Avg Operation Duration: ${avgDuration.toFixed(2)}ms`);
      console.log(`Throughput: ${((results.length / elapsed) * 1000).toFixed(0)} ops/sec`);

      // Assertions
      expect(successful).toBeGreaterThan(results.length * 0.95); // >95% success
      expect(avgDuration).toBeLessThan(20); // Avg <20ms even with concurrency
    }, 60000);
  });
});
