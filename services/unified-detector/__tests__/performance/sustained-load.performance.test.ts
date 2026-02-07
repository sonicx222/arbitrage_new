/**
 * Sustained Load Performance Tests (Task #45)
 *
 * Long-duration load testing to validate system stability over time.
 * Tests memory leaks, GC behavior, and performance degradation.
 *
 * REQUIRES:
 * - Real HierarchicalCache + PriceMatrix
 * - LoadTestHarness with memory/GC monitoring
 * - Long test timeouts (10+ minutes)
 *
 * PERFORMANCE TARGETS (tests FAIL if not met):
 * - No memory leaks (stable growth rate)
 * - No performance degradation over time
 * - Consistent latency distribution
 * - GC pauses remain acceptable
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { LoadTestHarness, CacheTestHarness } from '@arbitrage/test-utils';

describe('Sustained Load Performance (Task #45)', () => {
  let loadHarness: LoadTestHarness;
  let cacheHarness: CacheTestHarness;

  beforeAll(async () => {
    loadHarness = new LoadTestHarness();
    cacheHarness = new CacheTestHarness();
  });

  afterAll(async () => {
    if (cacheHarness) {
      await cacheHarness.teardown();
    }
  });

  beforeEach(async () => {
    await cacheHarness.setup({
      l1SizeMB: 64,
      l2TtlSec: 300,
      usePriceMatrix: true,
    });
  });

  afterEach(async () => {
    await cacheHarness.teardown();
  });

  describe('Long-Duration Stability', () => {
    it('should sustain 500 eps for 10 minutes without degradation', async () => {
      const cache = cacheHarness.getCache();

      // Track performance over time
      const performanceSnapshots: Array<{
        minute: number;
        throughput: number;
        p99Latency: number;
        memoryMB: number;
      }> = [];

      // Event handler
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${(eventIndex % 1000).toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run 10 consecutive 1-minute load tests
      for (let minute = 0; minute < 10; minute++) {
        const result = await loadHarness.runLoad(
          {
            eventsPerSec: 500,
            durationSec: 60,
            description: `Minute ${minute + 1}`,
          },
          eventHandler
        );

        performanceSnapshots.push({
          minute: minute + 1,
          throughput: result.metrics.throughput.eventsPerSec,
          p99Latency: result.metrics.latency.p99,
          memoryMB: result.metrics.memory.heapUsedMB,
        });
      }

      // Analyze performance over time
      const firstMinute = performanceSnapshots[0];
      const lastMinute = performanceSnapshots[9];

      // Throughput should not degrade >10%
      const throughputDegradation =
        ((firstMinute.throughput - lastMinute.throughput) / firstMinute.throughput) * 100;
      expect(throughputDegradation).toBeLessThan(10);

      // Latency should not increase >50%
      const latencyIncrease = ((lastMinute.p99Latency - firstMinute.p99Latency) / firstMinute.p99Latency) * 100;
      expect(latencyIncrease).toBeLessThan(50);

      // Memory growth should be linear (no leaks)
      const memoryGrowth = lastMinute.memoryMB - firstMinute.memoryMB;
      expect(memoryGrowth).toBeLessThan(50); // <50MB over 10 minutes

      console.log('✓ 10-minute sustained load (500 eps):', {
        throughputDegradation: `${throughputDegradation.toFixed(2)}%`,
        latencyIncrease: `${latencyIncrease.toFixed(2)}%`,
        memoryGrowth: `${memoryGrowth.toFixed(2)}MB`,
      });

      console.log('  Performance over time:');
      performanceSnapshots.forEach(snap => {
        console.log(
          `    Minute ${snap.minute}: ${snap.throughput.toFixed(0)} eps, ` +
            `${snap.p99Latency.toFixed(2)}ms p99, ${snap.memoryMB.toFixed(2)}MB heap`
        );
      });
    }, 650000); // 10 min + buffer

    it('should maintain stable memory usage over 5 minutes', async () => {
      const cache = cacheHarness.getCache();

      // Event handler
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:polygon:0x${(eventIndex % 500).toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load test with memory tracking
      const result = await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 300, // 5 minutes
        },
        eventHandler
      );

      // Assert memory stability
      loadHarness.assertMemoryStable(5); // <5MB/min growth

      // Track memory samples over time
      const memorySamples = loadHarness.trackMemoryGrowth();
      const initialMemory = memorySamples[0].heapUsedMB;
      const finalMemory = memorySamples[memorySamples.length - 1].heapUsedMB;

      console.log('✓ Memory stability over 5 minutes:', {
        initialMemory: `${initialMemory.toFixed(2)}MB`,
        finalMemory: `${finalMemory.toFixed(2)}MB`,
        growth: `${(finalMemory - initialMemory).toFixed(2)}MB`,
        growthRate: `${result.metrics.memory.growthRateMBPerMin.toFixed(2)}MB/min`,
      });
    }, 320000);

    it('should handle continuous operation for 15 minutes', async () => {
      const cache = cacheHarness.getCache();

      // Event handler (realistic mixed workload)
      let eventIndex = 0;
      const eventHandler = async () => {
        // 70% writes, 30% reads
        if (Math.random() < 0.7) {
          const key = `price:bsc:0x${(eventIndex % 1000).toString(16).padStart(40, '0')}`;
          await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
          eventIndex++;
        } else {
          const key = `price:bsc:0x${Math.floor(Math.random() * 1000).toString(16).padStart(40, '0')}`;
          await cache.get(key);
        }
      };

      // Run 15-minute load test
      const result = await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 900, // 15 minutes
        },
        eventHandler
      );

      // Assert system remains healthy
      expect(result.passed).toBe(true);
      expect(result.metrics.throughput.eventsPerSec).toBeGreaterThan(480); // Allow 4% degradation

      console.log('✓ 15-minute continuous operation:', {
        totalEvents: result.events,
        avgThroughput: `${result.metrics.throughput.eventsPerSec.toFixed(2)} eps`,
        p99Latency: `${result.metrics.latency.p99.toFixed(2)}ms`,
        passed: result.passed,
      });
    }, 920000); // 15 min + buffer
  });

  describe('Memory Leak Detection', () => {
    it('should not leak memory under sustained writes', async () => {
      const cache = cacheHarness.getCache();

      // Baseline memory snapshot
      const baseline = await cacheHarness.captureMetricsSnapshot();

      // Event handler (continuous unique writes)
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load test (3 minutes of writes)
      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 180,
        },
        eventHandler
      );

      // Compare memory with baseline
      const comparison = await cacheHarness.compareWithBaseline(baseline);

      // Memory growth should be within acceptable range
      expect(comparison.memoryDelta).toBeLessThan(30); // <30MB over 3 minutes

      console.log('✓ No memory leaks detected:', {
        baseline: `${baseline.performanceMetrics.memory.heapUsedMB.toFixed(2)}MB`,
        final: `${(baseline.performanceMetrics.memory.heapUsedMB + comparison.memoryDelta).toFixed(2)}MB`,
        delta: `${comparison.memoryDelta.toFixed(2)}MB`,
      });
    }, 200000);

    it('should stabilize memory after cache eviction', async () => {
      const cache = cacheHarness.getCache();

      // Event handler (write beyond cache capacity)
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:polygon:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load test (10,000 writes = trigger evictions)
      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 20,
        },
        eventHandler
      );

      // Capture memory after evictions start
      const memoryAfterEvictions = await cacheHarness.captureMetricsSnapshot();

      // Continue load (another 10,000 writes)
      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 20,
        },
        eventHandler
      );

      // Memory should stabilize (not grow linearly)
      const comparison = await cacheHarness.compareWithBaseline(memoryAfterEvictions);
      expect(comparison.memoryDelta).toBeLessThan(10); // <10MB growth after stabilization

      console.log('✓ Memory stabilized after eviction:', {
        afterEvictions: `${memoryAfterEvictions.performanceMetrics.memory.heapUsedMB.toFixed(2)}MB`,
        afterContinued: `${(memoryAfterEvictions.performanceMetrics.memory.heapUsedMB + comparison.memoryDelta).toFixed(2)}MB`,
        delta: `${comparison.memoryDelta.toFixed(2)}MB`,
      });
    }, 60000);
  });

  describe('GC Behavior Under Load', () => {
    it('should maintain acceptable GC pause times', async () => {
      if (!global.gc) {
        console.log('⚠ GC monitoring unavailable (run with --expose-gc)');
        return;
      }

      const cache = cacheHarness.getCache();

      // Event handler
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${(eventIndex % 1000).toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load test with GC monitoring
      const result = await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 180, // 3 minutes
        },
        eventHandler
      );

      // Assert GC pauses
      loadHarness.assertGCPausesAcceptable(100); // p99 <100ms

      console.log('✓ GC behavior acceptable:', {
        totalPauses: result.metrics.gc.totalPauses,
        avgPause: `${result.metrics.gc.avgPauseMs.toFixed(2)}ms`,
        maxPause: `${result.metrics.gc.maxPauseMs.toFixed(2)}ms`,
        p99Pause: `${result.metrics.gc.p99PauseMs.toFixed(2)}ms`,
        totalGCTime: `${result.metrics.gc.totalGCTimeMs.toFixed(2)}ms`,
      });
    }, 200000);

    it('should recover quickly after major GC', async () => {
      if (!global.gc) {
        console.log('⚠ GC monitoring unavailable (run with --expose-gc)');
        return;
      }

      const cache = cacheHarness.getCache();

      // Event handler
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${(eventIndex % 500).toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load, force GC, continue load
      await loadHarness.runLoad({ eventsPerSec: 500, durationSec: 30 }, eventHandler);

      // Force major GC
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 100));

      // Resume load
      const resultAfterGC = await loadHarness.runLoad(
        { eventsPerSec: 500, durationSec: 30 },
        eventHandler
      );

      // Performance should recover
      loadHarness.assertSustainedThroughput(480); // Allow 4% degradation
      loadHarness.assertLatencyUnder(60, 99); // Slightly more lenient

      console.log('✓ Recovered after major GC:', {
        throughput: `${resultAfterGC.metrics.throughput.eventsPerSec.toFixed(2)} eps`,
        p99Latency: `${resultAfterGC.metrics.latency.p99.toFixed(2)}ms`,
      });
    }, 80000);
  });

  describe('Performance Consistency', () => {
    it('should maintain consistent latency distribution over time', async () => {
      const cache = cacheHarness.getCache();

      // Event handler
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:polygon:0x${(eventIndex % 800).toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run 5 consecutive load tests
      const latencyResults: Array<{
        run: number;
        p50: number;
        p95: number;
        p99: number;
      }> = [];

      for (let run = 0; run < 5; run++) {
        const result = await loadHarness.runLoad(
          {
            eventsPerSec: 500,
            durationSec: 60,
          },
          eventHandler
        );

        latencyResults.push({
          run: run + 1,
          p50: result.metrics.latency.p50,
          p95: result.metrics.latency.p95,
          p99: result.metrics.latency.p99,
        });
      }

      // Calculate coefficient of variation for p99
      const p99Values = latencyResults.map(r => r.p99);
      const avgP99 = p99Values.reduce((a, b) => a + b, 0) / p99Values.length;
      const variance = p99Values.reduce((sum, p99) => sum + Math.pow(p99 - avgP99, 2), 0) / p99Values.length;
      const stdDev = Math.sqrt(variance);
      const cv = (stdDev / avgP99) * 100;

      // CV should be <20% (consistent)
      expect(cv).toBeLessThan(20);

      console.log('✓ Consistent latency distribution:', {
        runs: 5,
        avgP99: `${avgP99.toFixed(2)}ms`,
        stdDev: `${stdDev.toFixed(2)}ms`,
        cv: `${cv.toFixed(2)}%`,
      });

      console.log('  Latency distribution per run:');
      latencyResults.forEach(r => {
        console.log(
          `    Run ${r.run}: p50=${r.p50.toFixed(2)}ms, p95=${r.p95.toFixed(2)}ms, p99=${r.p99.toFixed(2)}ms`
        );
      });
    }, 350000);
  });
});
