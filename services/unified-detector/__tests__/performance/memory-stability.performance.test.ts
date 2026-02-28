/**
 * Memory Stability Performance Tests (Task #45)
 *
 * Focused testing on memory behavior, growth rates, and leak detection.
 * Validates memory-critical requirements from ADR-005.
 *
 * REQUIRES:
 * - Real HierarchicalCache + PriceMatrix
 * - Memory monitoring every 1 second
 * - Long-running tests for leak detection
 *
 * PERFORMANCE TARGETS (tests FAIL if not met):
 * - Memory growth <5MB/min sustained
 * - No memory leaks detected
 * - Stable RSS and heap usage
 * - ArrayBuffer usage within bounds
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { LoadTestHarness, CacheTestHarness } from '@arbitrage/test-utils';

describe('Memory Stability Performance (Task #45)', () => {
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

  describe('Memory Growth Rate', () => {
    it('should maintain <5MB/min memory growth', async () => {
      const cache = cacheHarness.getCache();

      // Event handler (continuous unique writes)
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run 5-minute load test
      const result = await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 300,
        },
        eventHandler
      );

      // Assert memory growth rate
      loadHarness.assertMemoryStable(5); // <5MB/min

      console.log('✓ Memory growth rate acceptable:', {
        duration: '5 minutes',
        growthRate: `${result.metrics.memory.growthRateMBPerMin.toFixed(2)}MB/min`,
        target: '<5MB/min',
        totalGrowth: `${(result.metrics.memory.growthRateMBPerMin * 5).toFixed(2)}MB`,
      });
    }, 320000);

    it('should show linear memory growth (no leaks)', async () => {
      const cache = cacheHarness.getCache();

      // Event handler
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:polygon:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load test with memory tracking
      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 180, // 3 minutes
        },
        eventHandler
      );

      // Analyze memory samples
      const memorySamples = loadHarness.trackMemoryGrowth();

      // Calculate growth rate for each minute
      const growthRates: number[] = [];
      for (let i = 60; i < memorySamples.length; i += 60) {
        const prevSample = memorySamples[i - 60];
        const currSample = memorySamples[i];
        const growthRate = currSample.heapUsedMB - prevSample.heapUsedMB;
        growthRates.push(growthRate);
      }

      // Growth rates should be similar (linear, not exponential)
      const avgGrowthRate = growthRates.reduce((a, b) => a + b, 0) / growthRates.length;
      const variance =
        growthRates.reduce((sum, rate) => sum + Math.pow(rate - avgGrowthRate, 2), 0) / growthRates.length;
      const stdDev = Math.sqrt(variance);
      const cv = (stdDev / avgGrowthRate) * 100;

      // CV should be <50% (linear growth pattern)
      expect(cv).toBeLessThan(50);

      console.log('✓ Linear memory growth (no leaks):', {
        avgGrowthRate: `${avgGrowthRate.toFixed(2)}MB/min`,
        stdDev: `${stdDev.toFixed(2)}MB/min`,
        cv: `${cv.toFixed(2)}%`,
      });
    }, 200000);

    it('should stabilize memory after warming cache', async () => {
      const cache = cacheHarness.getCache();

      // Phase 1: Warm cache (write 1000 unique keys)
      let eventIndex = 0;
      const warmupHandler = async () => {
        const key = `price:bsc:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 2, // 1000 events
        },
        warmupHandler
      );

      // Capture memory after warmup
      const memoryAfterWarmup = await cacheHarness.captureMetricsSnapshot();

      // Phase 2: Steady-state (update existing keys)
      const steadyStateHandler = async () => {
        const key = `price:bsc:0x${(eventIndex % 1000).toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 120, // 2 minutes
        },
        steadyStateHandler
      );

      // Compare memory (should be stable after warmup)
      const comparison = await cacheHarness.compareWithBaseline(memoryAfterWarmup);
      expect(comparison.memoryDelta).toBeLessThan(10); // <10MB growth in steady-state

      console.log('✓ Memory stabilized after warmup:', {
        afterWarmup: `${memoryAfterWarmup.performanceMetrics.memory.heapUsedMB.toFixed(2)}MB`,
        afterSteadyState: `${(memoryAfterWarmup.performanceMetrics.memory.heapUsedMB + comparison.memoryDelta).toFixed(2)}MB`,
        steadyStateDelta: `${comparison.memoryDelta.toFixed(2)}MB`,
      });
    }, 150000);
  });

  describe('Heap Pressure', () => {
    it('should handle high write rate without excessive heap growth', async () => {
      const cache = cacheHarness.getCache();

      // Baseline memory
      const baseline = await cacheHarness.captureMetricsSnapshot();

      // High write rate (1000 eps for 1 minute = 60,000 writes)
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${(eventIndex % 2000).toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      await loadHarness.runLoad(
        {
          eventsPerSec: 1000,
          durationSec: 60,
        },
        eventHandler
      );

      // Compare memory
      const comparison = await cacheHarness.compareWithBaseline(baseline);

      // Memory growth should be reasonable despite high rate
      expect(comparison.memoryDelta).toBeLessThan(40); // <40MB for 60K writes

      console.log('✓ High write rate handled:', {
        writeRate: '1000 eps',
        totalWrites: 60000,
        memoryGrowth: `${comparison.memoryDelta.toFixed(2)}MB`,
      });
    }, 80000);

    it('should maintain stable heap size under mixed workload', async () => {
      const cache = cacheHarness.getCache();

      // Mixed workload: writes, reads, updates, deletes
      let eventIndex = 0;
      const eventHandler = async () => {
        const rand = Math.random();

        if (rand < 0.5) {
          // 50% writes
          const key = `price:polygon:0x${(eventIndex % 1000).toString(16).padStart(40, '0')}`;
          await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        } else if (rand < 0.8) {
          // 30% reads
          const key = `price:polygon:0x${Math.floor(Math.random() * 1000).toString(16).padStart(40, '0')}`;
          await cache.get(key);
        } else if (rand < 0.95) {
          // 15% updates
          const key = `price:polygon:0x${Math.floor(Math.random() * 1000).toString(16).padStart(40, '0')}`;
          await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        } else {
          // 5% deletes
          const key = `price:polygon:0x${Math.floor(Math.random() * 1000).toString(16).padStart(40, '0')}`;
          await cache.delete(key);
        }

        eventIndex++;
      };

      // Run 3-minute mixed workload
      const result = await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 180,
        },
        eventHandler
      );

      // Memory should remain stable
      loadHarness.assertMemoryStable(5);

      console.log('✓ Mixed workload stable:', {
        operations: result.events,
        memoryGrowth: `${result.metrics.memory.growthRateMBPerMin.toFixed(2)}MB/min`,
        peakHeap: `${result.metrics.memory.peakHeapUsedMB.toFixed(2)}MB`,
      });
    }, 200000);
  });

  describe('ArrayBuffer Usage', () => {
    it('should maintain stable ArrayBuffer memory', async () => {
      const cache = cacheHarness.getCache();

      // Track ArrayBuffer memory before load
      const initialMem = process.memoryUsage();
      const initialArrayBuffers = (initialMem as any).arrayBuffers ?? 0;

      // Event handler
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${(eventIndex % 1000).toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load test
      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 120, // 2 minutes
        },
        eventHandler
      );

      // Track ArrayBuffer memory after load
      const finalMem = process.memoryUsage();
      const finalArrayBuffers = (finalMem as any).arrayBuffers ?? 0;

      const arrayBufferGrowthMB = (finalArrayBuffers - initialArrayBuffers) / 1024 / 1024;

      // ArrayBuffer should not grow excessively (SharedArrayBuffer is fixed size)
      expect(arrayBufferGrowthMB).toBeLessThan(20); // <20MB growth

      console.log('✓ ArrayBuffer memory stable:', {
        initial: `${(initialArrayBuffers / 1024 / 1024).toFixed(2)}MB`,
        final: `${(finalArrayBuffers / 1024 / 1024).toFixed(2)}MB`,
        growth: `${arrayBufferGrowthMB.toFixed(2)}MB`,
      });
    }, 150000);

    it('should not leak SharedArrayBuffers', async () => {
      const cache = cacheHarness.getCache();

      // Get SharedArrayBuffer references
      const priceMatrix = (cache as any).l1;
      const sharedBuffer = priceMatrix?.getSharedBuffer?.();
      const keyRegistry = priceMatrix?.getKeyRegistryBuffer?.();

      expect(sharedBuffer).toBeInstanceOf(SharedArrayBuffer);
      expect(keyRegistry).toBeInstanceOf(SharedArrayBuffer);

      // Event handler
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:polygon:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load
      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 60,
        },
        eventHandler
      );

      // Verify SharedArrayBuffers still intact (same references)
      const sharedBufferAfter = priceMatrix?.getSharedBuffer?.();
      const keyRegistryAfter = priceMatrix?.getKeyRegistryBuffer?.();

      expect(sharedBufferAfter).toBe(sharedBuffer); // Same reference
      expect(keyRegistryAfter).toBe(keyRegistry); // Same reference

      console.log('✓ No SharedArrayBuffer leaks:', {
        priceBufferSize: `${(sharedBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`,
        keyRegistrySize: `${(keyRegistry.byteLength / 1024).toFixed(2)}KB`,
        sameReferences: true,
      });
    }, 80000);
  });

  describe('Memory Recovery', () => {
    it('should recover memory after cache eviction', async () => {
      const cache = cacheHarness.getCache();

      // Phase 1: Fill cache beyond capacity
      let eventIndex = 0;
      const fillHandler = async () => {
        const key = `price:bsc:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 40, // 20,000 writes (exceeds capacity)
        },
        fillHandler
      );

      const memoryAfterFill = await cacheHarness.captureMetricsSnapshot();

      // Phase 2: Continue writes (should trigger evictions and memory recovery)
      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 60,
        },
        fillHandler
      );

      const memoryAfterEvictions = await cacheHarness.captureMetricsSnapshot();

      // Memory growth should slow down after evictions start
      const fillGrowth = memoryAfterFill.performanceMetrics.memory.heapUsedMB;
      const evictionGrowth = memoryAfterEvictions.performanceMetrics.memory.heapUsedMB - fillGrowth;

      expect(evictionGrowth).toBeLessThan(fillGrowth * 0.3); // <30% of initial growth

      console.log('✓ Memory recovered after eviction:', {
        fillPhase: `${fillGrowth.toFixed(2)}MB`,
        evictionPhase: `${evictionGrowth.toFixed(2)}MB`,
        ratio: `${((evictionGrowth / fillGrowth) * 100).toFixed(2)}%`,
      });
    }, 120000);

    it('should release memory after clearing cache', async () => {
      const cache = cacheHarness.getCache();

      // Fill cache
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:polygon:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 20, // 10,000 writes
        },
        eventHandler
      );

      const memoryBeforeClear = process.memoryUsage().heapUsed / 1024 / 1024;

      // Clear cache if method exists
      if (typeof (cache as any).clear === 'function') {
        await (cache as any).clear();
      }

      // Force GC if available
      if (global.gc) {
        global.gc();
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const memoryAfterClear = process.memoryUsage().heapUsed / 1024 / 1024;
      const memoryFreed = memoryBeforeClear - memoryAfterClear;

      // Some memory should be freed (>0MB)
      expect(memoryFreed).toBeGreaterThan(0);

      console.log('✓ Memory released after cache clear:', {
        beforeClear: `${memoryBeforeClear.toFixed(2)}MB`,
        afterClear: `${memoryAfterClear.toFixed(2)}MB`,
        freed: `${memoryFreed.toFixed(2)}MB`,
      });
    }, 60000);
  });

  describe('Long-Term Memory Stability', () => {
    it('should maintain stable memory over 10 minutes', async () => {
      const cache = cacheHarness.getCache();

      // Event handler (realistic workload)
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${(eventIndex % 1000).toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Track memory every minute
      const memorySnapshots: Array<{ minute: number; heapMB: number }> = [];

      for (let minute = 0; minute < 10; minute++) {
        await loadHarness.runLoad(
          {
            eventsPerSec: 500,
            durationSec: 60,
          },
          eventHandler
        );

        const snapshot = await cacheHarness.captureMetricsSnapshot();
        memorySnapshots.push({
          minute: minute + 1,
          heapMB: snapshot.performanceMetrics.memory.heapUsedMB,
        });
      }

      // Memory should not grow unbounded
      const initialHeap = memorySnapshots[0].heapMB;
      const finalHeap = memorySnapshots[9].heapMB;
      const totalGrowth = finalHeap - initialHeap;

      expect(totalGrowth).toBeLessThan(50); // <50MB over 10 minutes

      console.log('✓ Long-term memory stability (10 min):', {
        initial: `${initialHeap.toFixed(2)}MB`,
        final: `${finalHeap.toFixed(2)}MB`,
        totalGrowth: `${totalGrowth.toFixed(2)}MB`,
        avgGrowthRate: `${(totalGrowth / 10).toFixed(2)}MB/min`,
      });

      console.log('  Memory per minute:');
      memorySnapshots.forEach(snap => {
        console.log(`    Minute ${snap.minute}: ${snap.heapMB.toFixed(2)}MB`);
      });
    }, 650000); // 10 min + buffer
  });
});
