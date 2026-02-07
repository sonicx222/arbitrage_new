/**
 * Cache Load Performance Tests (Task #45)
 *
 * Load testing for HierarchicalCache under production-scale event rates.
 * Tests 500 events/sec sustained throughput with performance validation.
 *
 * REQUIRES:
 * - Real HierarchicalCache with PriceMatrix L1
 * - Real in-memory Redis
 * - LoadTestHarness for metrics collection
 *
 * PERFORMANCE TARGETS (tests FAIL if not met):
 * - Sustained throughput: 500 events/sec for 5 minutes
 * - p99 latency: <50ms per event
 * - Memory growth: <5MB/min
 * - GC pauses: p99 <100ms
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { LoadTestHarness, CacheTestHarness, PerformanceFixtures } from '@arbitrage/test-utils';

describe('Cache Load Performance (Task #45)', () => {
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
      enableTimingMetrics: false,
    });
  });

  afterEach(async () => {
    await cacheHarness.teardown();
  });

  describe('Target Load: 500 events/sec', () => {
    it('should sustain 500 events/sec for 5 minutes', async () => {
      const cache = cacheHarness.getCache();

      // Event handler: cache.set() for each event
      const eventHandler = async (event: any) => {
        await cache.set(event.key, {
          price: event.price,
          reserve0: event.reserve0,
          reserve1: event.reserve1,
          timestamp: event.timestamp,
          blockNumber: event.blockNumber,
        });
      };

      // Run load test (500 eps for 5 minutes = 150,000 events)
      const result = await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 300, // 5 minutes
          description: 'Target production load (500 eps, 5 min)',
        },
        eventHandler
      );

      // Assert sustained throughput (FAIL if <500 eps)
      loadHarness.assertSustainedThroughput(500);

      // Assert latency targets (FAIL if p99 >50ms)
      loadHarness.assertLatencyUnder(50, 99);

      // Assert memory stability (FAIL if growth >5MB/min)
      loadHarness.assertMemoryStable(5);

      // Assert GC pauses acceptable (FAIL if p99 >100ms)
      if (global.gc) {
        loadHarness.assertGCPausesAcceptable(100);
      }

      console.log('✓ Target load sustained (500 eps, 5 min):', {
        totalEvents: result.events,
        duration: `${(result.duration / 1000).toFixed(2)}s`,
        throughput: `${result.metrics.throughput.eventsPerSec.toFixed(2)} eps`,
        p99Latency: `${result.metrics.latency.p99.toFixed(2)}ms`,
        memoryGrowth: `${result.metrics.memory.growthRateMBPerMin.toFixed(2)}MB/min`,
        gcP99: result.metrics.gc.p99PauseMs
          ? `${result.metrics.gc.p99PauseMs.toFixed(2)}ms`
          : 'N/A',
      });
    }, 320000); // 5 min + buffer

    it('should handle burst load (1000 eps for 1 minute)', async () => {
      const cache = cacheHarness.getCache();

      const eventHandler = async (event: any) => {
        await cache.set(event.key, {
          price: event.price,
          timestamp: event.timestamp,
        });
      };

      // Burst load: 2x target throughput
      const result = await loadHarness.runLoad(
        {
          eventsPerSec: 1000,
          durationSec: 60,
          description: 'Burst load (1000 eps, 1 min)',
        },
        eventHandler
      );

      // More lenient targets for burst
      loadHarness.assertSustainedThroughput(900); // Allow 10% degradation
      loadHarness.assertLatencyUnder(100, 99); // Allow 2x latency

      console.log('✓ Burst load handled (1000 eps, 1 min):', {
        totalEvents: result.events,
        throughput: `${result.metrics.throughput.eventsPerSec.toFixed(2)} eps`,
        p99Latency: `${result.metrics.latency.p99.toFixed(2)}ms`,
      });
    }, 80000);

    it('should recover after load spike', async () => {
      const cache = cacheHarness.getCache();

      const eventHandler = async (event: any) => {
        await cache.set(event.key, {
          price: event.price,
          timestamp: event.timestamp,
        });
      };

      // Spike: 2000 eps for 10 seconds
      const spikeResult = await loadHarness.runLoad(
        {
          eventsPerSec: 2000,
          durationSec: 10,
          description: 'Load spike (2000 eps)',
        },
        eventHandler
      );

      // Recovery: back to 500 eps for 1 minute
      const recoveryResult = await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 60,
          description: 'Recovery period (500 eps)',
        },
        eventHandler
      );

      // Recovery should meet normal targets
      loadHarness.assertSustainedThroughput(500);
      loadHarness.assertLatencyUnder(50, 99);

      console.log('✓ Recovered after load spike:', {
        spike: `${spikeResult.metrics.throughput.eventsPerSec.toFixed(2)} eps`,
        recovery: `${recoveryResult.metrics.throughput.eventsPerSec.toFixed(2)} eps`,
        recoveryP99: `${recoveryResult.metrics.latency.p99.toFixed(2)}ms`,
      });
    }, 90000);
  });

  describe('Cache Performance Under Load', () => {
    it('should maintain L1 hit rate >95% under load', async () => {
      const cache = cacheHarness.getCache();

      // Pre-populate cache with hot data (simulates warm cache)
      const hotKeys: string[] = [];
      for (let i = 0; i < 1000; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        hotKeys.push(key);
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
      }

      // Event handler: 80% reads from hot keys, 20% writes to new keys
      let eventIndex = 0;
      const eventHandler = async () => {
        if (Math.random() < 0.8) {
          // Read from hot keys
          const key = hotKeys[Math.floor(Math.random() * hotKeys.length)];
          await cache.get(key);
        } else {
          // Write new key
          const key = `price:bsc:0x${(1000 + eventIndex).toString(16).padStart(40, '0')}`;
          await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
          eventIndex++;
        }
      };

      // Run load test (500 eps for 2 minutes)
      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 120,
        },
        eventHandler
      );

      // Verify hit rate
      cacheHarness.assertHitRate(95, 5); // 95% ±5%

      console.log('✓ L1 hit rate maintained under load:', {
        hitRate: `${(cacheHarness.getMetrics().hitRate * 100).toFixed(2)}%`,
        target: '>95%',
      });
    }, 150000);

    it('should handle cache eviction gracefully under load', async () => {
      const cache = cacheHarness.getCache();

      // Event handler: write unique keys (will trigger eviction)
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:polygon:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load test with more writes than cache capacity
      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 60, // 30,000 events (exceeds L1 capacity)
        },
        eventHandler
      );

      // Verify eviction rate is reasonable
      cacheHarness.assertEvictionRate(10); // <10%/sec

      console.log('✓ Cache eviction handled gracefully:', {
        evictionRate: `${(cacheHarness.getMetrics().evictionRate * 100).toFixed(2)}%/sec`,
        target: '<10%/sec',
      });
    }, 80000);

    it('should maintain write throughput with L2 Redis', async () => {
      const cache = cacheHarness.getCache();
      const redis = cacheHarness.getRedis();

      // Event handler: write to both L1 and L2
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load test
      const result = await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 60,
        },
        eventHandler
      );

      // Verify throughput maintained with L2 writes
      loadHarness.assertSustainedThroughput(500);
      loadHarness.assertLatencyUnder(50, 99); // Should still meet p99 target

      // Verify data is in Redis
      const sampleKey = `price:bsc:0x${(10).toString(16).padStart(40, '0')}`;
      const redisValue = await redis.get(sampleKey);
      expect(redisValue).not.toBeNull();

      console.log('✓ Write throughput maintained with L2:', {
        throughput: `${result.metrics.throughput.eventsPerSec.toFixed(2)} eps`,
        p99Latency: `${result.metrics.latency.p99.toFixed(2)}ms`,
        l2Verified: 'Yes',
      });
    }, 80000);
  });

  describe('Baseline Comparison', () => {
    it('should meet or exceed ADR-005 target baseline', async () => {
      const cache = cacheHarness.getCache();

      // Capture baseline before load
      const baseline = await cacheHarness.captureMetricsSnapshot();

      // Event handler
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load test
      await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 60,
        },
        eventHandler
      );

      // Compare with baseline
      const comparison = await cacheHarness.compareWithBaseline(baseline);

      // Assert no significant regression
      expect(comparison.passed).toBe(true);

      console.log('✓ Baseline comparison passed:', {
        hitRateDelta: `${comparison.hitRateDelta.toFixed(2)}%`,
        latencyDelta: `${comparison.latencyDelta.toFixed(2)}μs`,
        memoryDelta: `${comparison.memoryDelta.toFixed(2)}MB`,
        failures: comparison.failures,
      });
    }, 80000);

    it('should achieve ADR-005 target metrics', async () => {
      const cache = cacheHarness.getCache();

      // ADR-005 targets from PerformanceFixtures
      const targets = PerformanceFixtures.baselines.target();

      // Event handler
      let eventIndex = 0;
      const eventHandler = async () => {
        const key = `price:bsc:0x${eventIndex.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
        eventIndex++;
      };

      // Run load test
      const result = await loadHarness.runLoad(
        {
          eventsPerSec: 500,
          durationSec: 120, // 2 minutes
        },
        eventHandler
      );

      // Assert ADR-005 targets
      expect(result.metrics.latency.p99).toBeLessThan(targets.latency.p99);
      expect(result.metrics.memory.growthRateMBPerMin).toBeLessThan(targets.memory.growthRateMBPerMin);
      expect(result.metrics.throughput.eventsPerSec).toBeGreaterThan(targets.throughput.minEventsPerSec);

      console.log('✓ ADR-005 target metrics achieved:', {
        p99Latency: `${result.metrics.latency.p99.toFixed(2)}ms (target: <${targets.latency.p99}ms)`,
        memoryGrowth: `${result.metrics.memory.growthRateMBPerMin.toFixed(2)}MB/min (target: <${targets.memory.growthRateMBPerMin}MB/min)`,
        throughput: `${result.metrics.throughput.eventsPerSec.toFixed(2)} eps (target: >${targets.throughput.minEventsPerSec} eps)`,
      });
    }, 150000);
  });
});
