/**
 * Hot-Path Profiling Tests (Task #46)
 *
 * CPU profiling for hot-path operations with flame graph generation.
 * Profiles critical paths: cache writes, cache reads, price updates.
 *
 * REQUIRES:
 * - v8-profiler-next package (npm install --save-dev v8-profiler-next)
 * - Run with NODE_ENV=production for accurate profiling
 *
 * PROFILING OUTPUTS:
 * - .cpuprofile files (Chrome DevTools format)
 * - Flame graph HTML (with Speedscope instructions)
 * - Performance metrics and sample counts
 *
 * VIEW PROFILES:
 * - Chrome DevTools: Performance tab → Load profile
 * - Speedscope: speedscope .cpuprofile or https://www.speedscope.app
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { V8Profiler, profileHotPath } from '@arbitrage/core/monitoring';
import { CacheTestHarness } from '@arbitrage/test-utils';

describe('Hot-Path Profiling (Task #46)', () => {
  let profiler: V8Profiler;
  let cacheHarness: CacheTestHarness;

  beforeAll(async () => {
    profiler = new V8Profiler({
      outputDir: '.profiler-output/unified-detector',
      sampleInterval: 1000, // 1ms sampling
    });

    cacheHarness = new CacheTestHarness();

    if (!profiler.isAvailable()) {
      console.warn('⚠ V8 profiler not available. Install v8-profiler-next:');
      console.warn('  npm install --save-dev v8-profiler-next');
    }
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

  describe('Cache Write Hot-Path', () => {
    it('should profile 10,000 cache writes', async () => {
      if (!profiler.isAvailable()) {
        console.log('⚠ Skipping profiling test (v8-profiler-next not available)');
        return;
      }

      const cache = cacheHarness.getCache();

      // Profile hot-path: cache.set()
      const { result, profileResult } = await profiler.profile(
        'cache-write-hotpath',
        async () => {
          const writes = 10000;
          let successfulWrites = 0;

          for (let i = 0; i < writes; i++) {
            const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
            await cache.set(key, {
              price: Math.random() * 1000,
              timestamp: Date.now(),
            });
            successfulWrites++;
          }

          return { writes, successfulWrites };
        },
        {
          exportProfile: true,
          generateFlameGraph: true,
        }
      );

      expect(result.successfulWrites).toBe(result.writes);
      expect(profileResult.samples).toBeGreaterThan(0);

      console.log('✓ Profiled cache writes:', {
        writes: result.writes,
        duration: `${(profileResult.duration / 1000).toFixed(2)}ms`,
        samples: profileResult.samples,
        samplingRate: `${(profileResult.samples / (profileResult.duration / 1000)).toFixed(2)} samples/ms`,
        outputDir: profiler.getOutputDir(),
      });
    }, 60000);

    it('should profile cache writes under load (1000 writes/sec)', async () => {
      if (!profiler.isAvailable()) {
        console.log('⚠ Skipping profiling test');
        return;
      }

      const cache = cacheHarness.getCache();

      const { result, profileResult } = await profiler.profile(
        'cache-write-load',
        async () => {
          const durationMs = 5000; // 5 seconds
          const targetWps = 1000; // writes per second
          const intervalMs = 1000 / targetWps;

          const startTime = Date.now();
          let writes = 0;

          while (Date.now() - startTime < durationMs) {
            const key = `price:polygon:0x${writes.toString(16).padStart(40, '0')}`;
            await cache.set(key, {
              price: Math.random() * 1000,
              timestamp: Date.now(),
            });
            writes++;

            // Maintain write rate
            const nextWriteTime = startTime + (writes + 1) * intervalMs;
            const waitTime = nextWriteTime - Date.now();
            if (waitTime > 0) {
              await new Promise(resolve => setTimeout(resolve, waitTime));
            }
          }

          return { writes, actualWps: writes / (durationMs / 1000) };
        },
        {
          exportProfile: true,
          generateFlameGraph: true,
        }
      );

      expect(result.actualWps).toBeGreaterThan(900); // Allow 10% variance

      console.log('✓ Profiled writes under load:', {
        writes: result.writes,
        targetRate: '1000 writes/sec',
        actualRate: `${result.actualWps.toFixed(2)} writes/sec`,
        duration: `${(profileResult.duration / 1000000).toFixed(2)}s`,
        samples: profileResult.samples,
      });
    }, 30000);
  });

  describe('Cache Read Hot-Path', () => {
    it('should profile 10,000 cache reads', async () => {
      if (!profiler.isAvailable()) {
        console.log('⚠ Skipping profiling test');
        return;
      }

      const cache = cacheHarness.getCache();

      // Pre-populate cache
      for (let i = 0; i < 1000; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
      }

      // Profile hot-path: cache.get()
      const { result, profileResult } = await profiler.profile(
        'cache-read-hotpath',
        async () => {
          const reads = 10000;
          let hits = 0;

          for (let i = 0; i < reads; i++) {
            const key = `price:bsc:0x${(i % 1000).toString(16).padStart(40, '0')}`;
            const value = await cache.get(key);
            if (value) hits++;
          }

          return { reads, hits, hitRate: (hits / reads) * 100 };
        },
        {
          exportProfile: true,
          generateFlameGraph: true,
        }
      );

      expect(result.hitRate).toBeGreaterThan(95);

      console.log('✓ Profiled cache reads:', {
        reads: result.reads,
        hits: result.hits,
        hitRate: `${result.hitRate.toFixed(2)}%`,
        duration: `${(profileResult.duration / 1000).toFixed(2)}ms`,
        samples: profileResult.samples,
      });
    }, 60000);

    it('should profile mixed read/write workload', async () => {
      if (!profiler.isAvailable()) {
        console.log('⚠ Skipping profiling test');
        return;
      }

      const cache = cacheHarness.getCache();

      const { result, profileResult } = await profiler.profile(
        'cache-mixed-workload',
        async () => {
          const operations = 10000;
          let reads = 0;
          let writes = 0;
          let hits = 0;

          for (let i = 0; i < operations; i++) {
            const key = `price:polygon:0x${(i % 500).toString(16).padStart(40, '0')}`;

            // 70% reads, 30% writes
            if (Math.random() < 0.7) {
              const value = await cache.get(key);
              reads++;
              if (value) hits++;
            } else {
              await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
              writes++;
            }
          }

          return { operations, reads, writes, hits, hitRate: (hits / reads) * 100 };
        },
        {
          exportProfile: true,
          generateFlameGraph: true,
        }
      );

      console.log('✓ Profiled mixed workload:', {
        totalOps: result.operations,
        reads: result.reads,
        writes: result.writes,
        hitRate: `${result.hitRate.toFixed(2)}%`,
        duration: `${(profileResult.duration / 1000).toFixed(2)}ms`,
        samples: profileResult.samples,
      });
    }, 60000);
  });

  describe('PriceMatrix Operations', () => {
    it('should profile direct PriceMatrix writes', async () => {
      if (!profiler.isAvailable()) {
        console.log('⚠ Skipping profiling test');
        return;
      }

      const cache = cacheHarness.getCache();
      const priceMatrix = (cache as any).l1;

      if (!priceMatrix || typeof priceMatrix.setPrice !== 'function') {
        console.log('⚠ PriceMatrix not available in cache');
        return;
      }

      const { result, profileResult } = await profiler.profile(
        'pricematrix-write-direct',
        async () => {
          const writes = 10000;

          for (let i = 0; i < writes; i++) {
            const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
            priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
          }

          return { writes };
        },
        {
          exportProfile: true,
          generateFlameGraph: true,
        }
      );

      console.log('✓ Profiled PriceMatrix writes:', {
        writes: result.writes,
        duration: `${(profileResult.duration / 1000).toFixed(2)}ms`,
        avgLatency: `${(profileResult.duration / 1000 / result.writes).toFixed(3)}ms per write`,
        samples: profileResult.samples,
      });
    }, 60000);

    it('should profile direct PriceMatrix reads', async () => {
      if (!profiler.isAvailable()) {
        console.log('⚠ Skipping profiling test');
        return;
      }

      const cache = cacheHarness.getCache();
      const priceMatrix = (cache as any).l1;

      if (!priceMatrix) {
        console.log('⚠ PriceMatrix not available');
        return;
      }

      // Pre-populate
      for (let i = 0; i < 1000; i++) {
        const key = `price:polygon:0x${i.toString(16).padStart(40, '0')}`;
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      const { result, profileResult } = await profiler.profile(
        'pricematrix-read-direct',
        async () => {
          const reads = 10000;
          let hits = 0;

          for (let i = 0; i < reads; i++) {
            const key = `price:polygon:0x${(i % 1000).toString(16).padStart(40, '0')}`;
            const value = priceMatrix.getPrice(key);
            if (value) hits++;
          }

          return { reads, hits };
        },
        {
          exportProfile: true,
          generateFlameGraph: true,
        }
      );

      console.log('✓ Profiled PriceMatrix reads:', {
        reads: result.reads,
        hits: result.hits,
        duration: `${(profileResult.duration / 1000).toFixed(2)}ms`,
        avgLatency: `${(profileResult.duration / 1000 / result.reads).toFixed(3)}ms per read`,
        samples: profileResult.samples,
      });
    }, 60000);
  });

  describe('Bottleneck Identification', () => {
    it('should identify L1 vs L2 latency bottlenecks', async () => {
      if (!profiler.isAvailable()) {
        console.log('⚠ Skipping profiling test');
        return;
      }

      const cache = cacheHarness.getCache();

      // Profile L1 hits (hot keys)
      await profiler.startProfiling('l1-hits-only');

      let l1Hits = 0;
      for (let i = 0; i < 1000; i++) {
        const key = `price:hot:0x${(i % 10).toString(16).padStart(40, '0')}`; // Only 10 keys = L1 hits
        await cache.get(key);
        l1Hits++;
      }

      const l1Profile = await profiler.stopProfiling();
      await profiler.exportProfile(l1Profile);

      // Profile L2 fallback (cold keys, not in L1)
      await profiler.startProfiling('l2-fallback');

      let l2Fallbacks = 0;
      for (let i = 0; i < 1000; i++) {
        const key = `price:cold:0x${i.toString(16).padStart(40, '0')}`; // All unique = L2 fallback
        await cache.get(key);
        l2Fallbacks++;
      }

      const l2Profile = await profiler.stopProfiling();
      await profiler.exportProfile(l2Profile);

      const l1LatencyPerOp = l1Profile.duration / l1Hits;
      const l2LatencyPerOp = l2Profile.duration / l2Fallbacks;
      const l2Overhead = ((l2LatencyPerOp - l1LatencyPerOp) / l1LatencyPerOp) * 100;

      expect(l2Overhead).toBeGreaterThan(0); // L2 should be slower

      console.log('✓ Identified L1 vs L2 bottleneck:', {
        l1AvgLatency: `${(l1LatencyPerOp / 1000).toFixed(3)}ms`,
        l2AvgLatency: `${(l2LatencyPerOp / 1000).toFixed(3)}ms`,
        l2Overhead: `${l2Overhead.toFixed(2)}%`,
        recommendation: l2Overhead > 500 ? 'Increase L1 cache size' : 'L2 performance acceptable',
      });
    }, 60000);
  });

  describe('Convenience Profiling', () => {
    it('should use profileHotPath convenience function', async () => {
      if (!profiler.isAvailable()) {
        console.log('⚠ Skipping profiling test');
        return;
      }

      const cache = cacheHarness.getCache();

      // Use convenience function
      const { result, profileResult } = await profileHotPath('convenience-test', async () => {
        let operations = 0;

        for (let i = 0; i < 5000; i++) {
          const key = `price:test:0x${i.toString(16).padStart(40, '0')}`;
          await cache.set(key, { price: Math.random() * 1000, timestamp: Date.now() });
          operations++;
        }

        return { operations };
      });

      if (profileResult) {
        console.log('✓ Convenience profiling completed:', {
          operations: result.operations,
          duration: `${(profileResult.duration / 1000).toFixed(2)}ms`,
          samples: profileResult.samples,
          outputDir: profiler.getOutputDir(),
        });
      } else {
        console.log('✓ Profiling not available, ran without profiling');
      }
    }, 60000);
  });
});
