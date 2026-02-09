/**
 * Stability Testing Suite (Day 12)
 *
 * Long-running stability tests and memory leak detection.
 *
 * @package @arbitrage/core
 * @module warming/performance
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  createAdaptiveWarming,
  WarmingComponents,
} from '../../container/warming.container';
import { HierarchicalCache } from '../../../caching/hierarchical-cache';

describe('Stability Tests - Long Running', () => {
  let cache: HierarchicalCache;
  let components: WarmingComponents;

  beforeAll(async () => {
    cache = new HierarchicalCache({
      l1Size: 256,
      l2Enabled: true,
      usePriceMatrix: true,
    });

    components = createAdaptiveWarming(cache, 0.97, 10);

    // Pre-populate cache
    for (let i = 0; i < 500; i++) {
      await cache.set(`price:ethereum:0x${i.toString(16).padStart(40, '0')}`, {
        price: 1.0 + Math.random(),
        reserve0: (1000000 + Math.random() * 1000000).toString(),
        reserve1: (1000000 + Math.random() * 1000000).toString(),
      });
    }
  });

  afterAll(async () => {
    await cache.clear();
  });

  describe('Memory Leak Detection', () => {
    it('should not leak memory over sustained operations', async () => {
      const iterations = 10;
      const operationsPerIteration = 10000;
      const uniquePairs = 200;

      console.log(
        `\nMemory Leak Test: ${iterations} iterations × ${operationsPerIteration} ops`
      );

      const measurements: Array<{
        iteration: number;
        heapUsed: number;
        heapTotal: number;
        external: number;
        rss: number;
      }> = [];

      // Force GC if available
      if (global.gc) {
        global.gc();
      }

      for (let iter = 0; iter < iterations; iter++) {
        // Perform operations
        for (let i = 0; i < operationsPerIteration; i++) {
          const pairIndex = i % uniquePairs;
          const pairAddress = `0x${pairIndex.toString(16).padStart(40, '0')}`;

          components.tracker.recordPriceUpdate(pairAddress, Date.now());

          if (i % 1000 === 0 && i > 0) {
            await new Promise(resolve => setImmediate(resolve));
          }
        }

        // Measure memory after each iteration
        if (global.gc) {
          global.gc();
        }

        const mem = process.memoryUsage();
        measurements.push({
          iteration: iter,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
          rss: mem.rss,
        });

        console.log(
          `Iteration ${iter + 1}/${iterations}: Heap ${(mem.heapUsed / 1024 / 1024).toFixed(2)}MB`
        );

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Analyze memory trend
      const heapUsages = measurements.map(m => m.heapUsed);
      const firstThree = heapUsages.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
      const lastThree = heapUsages.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const growth = ((lastThree - firstThree) / firstThree) * 100;

      console.log('\n=== Memory Leak Analysis ===');
      console.log(`Initial Heap (avg of first 3): ${(firstThree / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Final Heap (avg of last 3): ${(lastThree / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Growth: ${growth.toFixed(2)}%`);
      console.log(`Growth per Iteration: ${(growth / iterations).toFixed(2)}%`);

      // Check for linear growth (indicates leak)
      const growthPerIteration = heapUsages.map((usage, i) => {
        if (i === 0) return 0;
        return ((usage - heapUsages[i - 1]) / heapUsages[i - 1]) * 100;
      });

      const avgGrowthPerIter =
        growthPerIteration.slice(1).reduce((a, b) => a + b, 0) / (growthPerIteration.length - 1);

      console.log(`Avg Growth per Iteration: ${avgGrowthPerIter.toFixed(3)}%`);

      // Assertions
      expect(growth).toBeLessThan(50); // <50% total growth
      expect(avgGrowthPerIter).toBeLessThan(2); // <2% per iteration
      expect(lastThree).toBeLessThan(firstThree * 2); // <2x final heap
    }, 180000); // 3 minute timeout
  });

  describe('Long-Running Stability', () => {
    it('should maintain stable performance over 5 minutes', async () => {
      const durationMs = 300000; // 5 minutes
      const measurementInterval = 10000; // Measure every 10s
      const operationsPerInterval = 50000;
      const uniquePairs = 250;

      console.log(
        `\nLong-Running Stability Test: ${durationMs / 1000}s (${durationMs / 60000} minutes)`
      );

      const measurements: Array<{
        timestamp: number;
        avgLatency: number;
        p95Latency: number;
        p99Latency: number;
        completed: number;
        errors: number;
        heapUsed: number;
      }> = [];

      const startTime = Date.now();
      let totalCompleted = 0;
      let totalErrors = 0;

      while (Date.now() - startTime < durationMs) {
        const intervalStart = performance.now();
        const durations: number[] = [];
        let intervalCompleted = 0;
        let intervalErrors = 0;

        for (let i = 0; i < operationsPerInterval; i++) {
          const pairIndex = (totalCompleted + i) % uniquePairs;
          const pairAddress = `0x${pairIndex.toString(16).padStart(40, '0')}`;
          const result = components.tracker.recordPriceUpdate(pairAddress, Date.now());

          if (result.success) {
            intervalCompleted++;
            if (result.durationUs) durations.push(result.durationUs);
          } else {
            intervalErrors++;
          }

          if (i % 1000 === 0) {
            await new Promise(resolve => setImmediate(resolve));
          }
        }

        totalCompleted += intervalCompleted;
        totalErrors += intervalErrors;

        // Calculate statistics
        if (durations.length > 0) {
          durations.sort((a, b) => a - b);
          const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
          const p95 = durations[Math.floor(durations.length * 0.95)];
          const p99 = durations[Math.floor(durations.length * 0.99)];

          const mem = process.memoryUsage();

          measurements.push({
            timestamp: Date.now() - startTime,
            avgLatency: avg,
            p95Latency: p95,
            p99Latency: p99,
            completed: intervalCompleted,
            errors: intervalErrors,
            heapUsed: mem.heapUsed,
          });

          console.log(
            `[${((Date.now() - startTime) / 1000).toFixed(0)}s] Avg: ${avg.toFixed(1)}μs, P95: ${p95.toFixed(1)}μs, Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(2)}MB`
          );
        }

        // Wait for next interval
        const elapsed = performance.now() - intervalStart;
        if (elapsed < measurementInterval) {
          await new Promise(resolve => setTimeout(resolve, measurementInterval - elapsed));
        }
      }

      // Analyze stability
      const avgLatencies = measurements.map(m => m.avgLatency);
      const p95Latencies = measurements.map(m => m.p95Latency);
      const heapUsages = measurements.map(m => m.heapUsed);

      const firstQuarter = avgLatencies.slice(0, Math.floor(measurements.length / 4));
      const lastQuarter = avgLatencies.slice(-Math.floor(measurements.length / 4));

      const initialAvg = firstQuarter.reduce((a, b) => a + b, 0) / firstQuarter.length;
      const finalAvg = lastQuarter.reduce((a, b) => a + b, 0) / lastQuarter.length;
      const perfDegradation = ((finalAvg - initialAvg) / initialAvg) * 100;

      const initialHeap = heapUsages.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
      const finalHeap = heapUsages.slice(-3).reduce((a, b) => a + b, 0) / 3;
      const heapGrowth = ((finalHeap - initialHeap) / initialHeap) * 100;

      console.log('\n=== Stability Test Results ===');
      console.log(`Total Completed: ${totalCompleted}`);
      console.log(`Total Errors: ${totalErrors} (${((totalErrors / totalCompleted) * 100).toFixed(3)}%)`);
      console.log(`Measurements: ${measurements.length}`);
      console.log('\n=== Performance Stability ===');
      console.log(`Initial Avg Latency: ${initialAvg.toFixed(1)}μs`);
      console.log(`Final Avg Latency: ${finalAvg.toFixed(1)}μs`);
      console.log(`Performance Degradation: ${perfDegradation.toFixed(2)}%`);
      console.log(`P95 Range: ${Math.min(...p95Latencies).toFixed(1)}μs - ${Math.max(...p95Latencies).toFixed(1)}μs`);
      console.log('\n=== Memory Stability ===');
      console.log(`Initial Heap: ${(initialHeap / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Final Heap: ${(finalHeap / 1024 / 1024).toFixed(2)}MB`);
      console.log(`Heap Growth: ${heapGrowth.toFixed(2)}%`);

      // Assertions
      expect(totalErrors).toBeLessThan(totalCompleted * 0.001); // <0.1% error rate
      expect(perfDegradation).toBeLessThan(25); // <25% performance degradation
      expect(heapGrowth).toBeLessThan(50); // <50% heap growth
      expect(finalAvg).toBeLessThan(200); // Final latency <200μs
      expect(Math.max(...p95Latencies)).toBeLessThan(400); // Max P95 <400μs
    }, 360000); // 6 minute timeout
  });

  describe('Resource Exhaustion Recovery', () => {
    it('should recover from temporary resource exhaustion', async () => {
      const normalLoad = 5000;
      const exhaustLoad = 50000; // 10x overload
      const uniquePairs = 300;

      console.log(`\nResource Exhaustion Recovery Test`);

      // Phase 1: Normal load
      console.log('Phase 1: Normal load...');
      let phase1Errors = 0;
      for (let i = 0; i < normalLoad; i++) {
        const result = components.tracker.recordPriceUpdate(
          `0x${(i % uniquePairs).toString(16).padStart(40, '0')}`,
          Date.now()
        );
        if (!result.success) phase1Errors++;

        if (i % 1000 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      // Phase 2: Exhaust resources (sudden 10x spike)
      console.log('Phase 2: Resource exhaustion (10x spike)...');
      let phase2Errors = 0;
      const phase2Start = performance.now();
      for (let i = 0; i < exhaustLoad; i++) {
        const result = components.tracker.recordPriceUpdate(
          `0x${(i % uniquePairs).toString(16).padStart(40, '0')}`,
          Date.now()
        );
        if (!result.success) phase2Errors++;

        if (i % 1000 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }
      const phase2Duration = performance.now() - phase2Start;

      // Phase 3: Recovery (back to normal)
      console.log('Phase 3: Recovery (back to normal)...');
      await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause

      let phase3Errors = 0;
      const phase3Durations: number[] = [];
      for (let i = 0; i < normalLoad; i++) {
        const result = components.tracker.recordPriceUpdate(
          `0x${(i % uniquePairs).toString(16).padStart(40, '0')}`,
          Date.now()
        );

        if (!result.success) {
          phase3Errors++;
        } else if (result.durationUs) {
          phase3Durations.push(result.durationUs);
        }

        if (i % 1000 === 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      const phase3Avg =
        phase3Durations.reduce((a, b) => a + b, 0) / phase3Durations.length;

      console.log('\n=== Recovery Test Results ===');
      console.log(`Phase 1 Errors: ${phase1Errors}/${normalLoad} (${((phase1Errors / normalLoad) * 100).toFixed(3)}%)`);
      console.log(`Phase 2 Errors: ${phase2Errors}/${exhaustLoad} (${((phase2Errors / exhaustLoad) * 100).toFixed(3)}%)`);
      console.log(`Phase 2 Duration: ${phase2Duration.toFixed(0)}ms`);
      console.log(`Phase 3 Errors: ${phase3Errors}/${normalLoad} (${((phase3Errors / normalLoad) * 100).toFixed(3)}%)`);
      console.log(`Phase 3 Avg Latency: ${phase3Avg.toFixed(1)}μs`);

      // Assertions
      expect(phase1Errors).toBeLessThan(normalLoad * 0.01); // Phase 1: <1% errors
      expect(phase2Errors).toBeLessThan(exhaustLoad * 0.1); // Phase 2: <10% errors (under stress)
      expect(phase3Errors).toBeLessThan(normalLoad * 0.02); // Phase 3: <2% errors (recovered)
      expect(phase3Avg).toBeLessThan(150); // Recovery: <150μs avg
    }, 60000);
  });

  describe('Graceful Degradation', () => {
    it('should degrade gracefully under extreme load', async () => {
      const loadLevels = [1000, 5000, 10000, 20000, 50000];
      const uniquePairs = 200;

      console.log(`\nGraceful Degradation Test: ${loadLevels.join(' → ')} operations`);

      const results: Array<{
        load: number;
        avgLatency: number;
        p95Latency: number;
        errorRate: number;
      }> = [];

      for (const load of loadLevels) {
        const durations: number[] = [];
        let errors = 0;

        console.log(`Testing ${load} operations...`);

        for (let i = 0; i < load; i++) {
          const result = components.tracker.recordPriceUpdate(
            `0x${(i % uniquePairs).toString(16).padStart(40, '0')}`,
            Date.now()
          );

          if (result.success && result.durationUs) {
            durations.push(result.durationUs);
          } else {
            errors++;
          }

          if (i % 1000 === 0) {
            await new Promise(resolve => setImmediate(resolve));
          }
        }

        durations.sort((a, b) => a - b);
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        const p95 = durations[Math.floor(durations.length * 0.95)];
        const errorRate = (errors / load) * 100;

        results.push({
          load,
          avgLatency: avg,
          p95Latency: p95,
          errorRate,
        });

        console.log(
          `  Avg: ${avg.toFixed(1)}μs, P95: ${p95.toFixed(1)}μs, Errors: ${errorRate.toFixed(3)}%`
        );

        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log('\n=== Degradation Analysis ===');

      // Check that degradation is sub-linear
      const latencyIncrease: number[] = [];
      for (let i = 1; i < results.length; i++) {
        const increase =
          ((results[i].avgLatency - results[i - 1].avgLatency) / results[i - 1].avgLatency) * 100;
        latencyIncrease.push(increase);
        console.log(
          `${results[i - 1].load} → ${results[i].load}: +${increase.toFixed(1)}% latency`
        );
      }

      // Check error rates stay reasonable
      const maxErrorRate = Math.max(...results.map(r => r.errorRate));
      const finalErrorRate = results[results.length - 1].errorRate;

      console.log(`\nMax Error Rate: ${maxErrorRate.toFixed(3)}%`);
      console.log(`Final Error Rate: ${finalErrorRate.toFixed(3)}%`);

      // Assertions
      expect(maxErrorRate).toBeLessThan(5); // <5% errors even at extreme load
      expect(results[results.length - 1].avgLatency).toBeLessThan(500); // <500μs even at 50k ops
      expect(latencyIncrease.every(inc => inc < 200)).toBe(true); // No single jump >200%
    }, 120000);
  });

  describe('Cache Eviction Behavior', () => {
    it('should handle cache evictions correctly', async () => {
      const totalPairs = 1000; // Exceed L1 size
      const updatesPerPair = 5;

      console.log(`\nCache Eviction Test: ${totalPairs} pairs (exceeds L1 cache size)`);

      const memBefore = process.memoryUsage();

      // Track more pairs than L1 can hold
      for (let i = 0; i < totalPairs; i++) {
        const pairAddress = `0x${i.toString(16).padStart(40, '0')}`;

        for (let j = 0; j < updatesPerPair; j++) {
          components.tracker.recordPriceUpdate(pairAddress, Date.now() + j * 100);
        }

        if (i % 100 === 0 && i > 0) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }

      const memAfter = process.memoryUsage();
      const stats = components.tracker.getStats();

      // Check that evictions occurred but tracking continues
      const heapIncrease = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

      console.log('\n=== Cache Eviction Results ===');
      console.log(`Pairs Tracked: ${stats.totalPairs}`);
      console.log(`Total Updates: ${stats.totalUpdates}`);
      console.log(`Expected Updates: ${totalPairs * updatesPerPair}`);
      console.log(`Heap Increase: ${heapIncrease.toFixed(2)}MB`);

      // Assertions
      expect(stats.totalUpdates).toBeGreaterThanOrEqual(totalPairs * updatesPerPair * 0.95); // >95% tracked
      expect(heapIncrease).toBeLessThan(100); // <100MB for 1000 pairs
    }, 60000);
  });
});
