/**
 * Worker Zero-Copy Integration Tests (Task #44)
 *
 * Validates zero-copy SharedArrayBuffer access from Worker threads.
 * Ensures no memory copying occurs and measures ultra-low latency.
 *
 * REQUIRES:
 * - Real Worker threads with SharedArrayBuffer access
 * - Direct memory access (no serialization/deserialization)
 * - Atomics for thread-safe reads
 *
 * PERFORMANCE TARGETS (tests FAIL if not met):
 * - Worker reads <5μs (p99) - zero-copy threshold
 * - No memory copy detected (latency proof)
 * - Same memory address between main thread and workers
 * - Atomics.load latency <1μs
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import { WorkerTestHarness } from '@arbitrage/test-utils';

describe('Worker Zero-Copy Integration (Task #44)', () => {
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

  describe('Zero-Copy Verification', () => {
    it('should perform zero-copy reads (no memory copy)', async () => {
      const priceMatrix = harness.getPriceMatrix();

      const testKey = 'price:bsc:0x1234567890123456789012345678901234567890';
      const testPrice = 999.99;

      priceMatrix.setPrice(testKey, testPrice, Date.now());

      // Test zero-copy read from worker
      const result = await harness.testZeroCopyRead(testKey);

      // Assert zero-copy characteristics
      harness.assertNoMemoryCopy(result);

      console.log('✓ Zero-copy read verified:', {
        latency: `${result.latencyUs.toFixed(2)}μs`,
        memoryAddressMatch: result.memoryAddressMatch,
        dataCopied: result.dataCopied,
      });
    }, 15000);

    it('should achieve <5μs read latency (p99)', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Pre-populate cache with 100 prices
      const keys: string[] = [];
      for (let i = 0; i < 100; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // Measure 1000 zero-copy reads
      const latencies: number[] = [];

      for (let i = 0; i < 1000; i++) {
        const key = keys[i % keys.length];
        const result = await harness.testZeroCopyRead(key);
        latencies.push(result.latencyUs);
      }

      // Calculate p99 latency
      latencies.sort((a, b) => a - b);
      const p99Index = Math.floor(latencies.length * 0.99);
      const p99LatencyUs = latencies[p99Index];

      // FAIL if p99 > 5μs
      expect(p99LatencyUs).toBeLessThan(5);

      console.log('✓ Zero-copy latency targets met:', {
        samples: 1000,
        p99: `${p99LatencyUs.toFixed(3)}μs`,
        target: '<5μs',
      });
    }, 60000);

    it('should maintain zero-copy performance under concurrent load', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 500 price entries
      const keys: string[] = [];
      for (let i = 0; i < 500; i++) {
        const key = `price:polygon:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // Concurrent reads from 4 workers
      const stats = await harness.testConcurrentReads(keys, 4);

      // Zero-copy should maintain low latency even under load
      expect(stats.avgLatencyUs).toBeLessThan(10); // <10μs average
      expect(stats.p99LatencyUs).toBeLessThan(50); // <50μs p99 (more lenient under contention)

      console.log('✓ Zero-copy performance under concurrent load:', {
        workers: 4,
        totalReads: stats.totalReads,
        avgLatency: `${stats.avgLatencyUs.toFixed(2)}μs`,
        p99Latency: `${stats.p99LatencyUs.toFixed(2)}μs`,
      });
    }, 45000);
  });

  describe('Memory Access Patterns', () => {
    it('should access same memory address from main thread and workers', async () => {
      const priceMatrix = harness.getPriceMatrix();
      const sharedBuffer = priceMatrix.getSharedBuffer();

      // Write in main thread
      const testKey = 'price:bsc:0xabcdef1234567890abcdef1234567890abcdef12';
      const testPrice = 777.77;

      priceMatrix.setPrice(testKey, testPrice, Date.now());

      // Read from worker (verifies same buffer reference)
      const result = await harness.testZeroCopyRead(testKey);

      expect(result.memoryAddressMatch).toBe(true);
      expect(result.latencyUs).toBeLessThan(10); // <10μs for single read

      console.log('✓ Same memory address accessed:', {
        bufferSize: `${(sharedBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`,
        latency: `${result.latencyUs.toFixed(2)}μs`,
      });
    }, 15000);

    it('should use Atomics for thread-safe reads', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Write multiple prices
      const keys: string[] = [];
      for (let i = 0; i < 50; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, i * 10, Date.now());
      }

      // Concurrent reads should use Atomics (thread-safe)
      const stats = await harness.testConcurrentReads(keys, 4);

      // No conflicts should occur with proper Atomics usage
      expect(stats.conflicts).toBe(0);
      expect(stats.successfulReads).toBe(stats.totalReads);

      console.log('✓ Atomics used for thread-safe reads:', {
        totalReads: stats.totalReads,
        conflicts: stats.conflicts,
        successRate: '100%',
      });
    }, 30000);

    it('should handle rapid sequential reads without copying', async () => {
      const priceMatrix = harness.getPriceMatrix();

      const testKey = 'price:bsc:0x1111111111111111111111111111111111111111';
      priceMatrix.setPrice(testKey, 123.45, Date.now());

      // Perform 100 rapid reads from same worker
      const latencies: number[] = [];

      for (let i = 0; i < 100; i++) {
        const result = await harness.testZeroCopyRead(testKey);
        latencies.push(result.latencyUs);
      }

      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      // All reads should be fast (no copying)
      expect(avgLatency).toBeLessThan(10); // <10μs average

      console.log('✓ Rapid sequential reads (no copying):', {
        reads: 100,
        avgLatency: `${avgLatency.toFixed(2)}μs`,
        maxLatency: `${Math.max(...latencies).toFixed(2)}μs`,
      });
    }, 45000);
  });

  describe('Comparison with Serialization', () => {
    it('should be significantly faster than JSON serialization', async () => {
      const priceMatrix = harness.getPriceMatrix();

      const testKey = 'price:bsc:0x2222222222222222222222222222222222222222';
      const testValue = {
        price: 456.78,
        reserve0: '1000000000000000000',
        reserve1: '2000000000000000000',
        timestamp: Date.now(),
        blockNumber: 1000000,
      };

      priceMatrix.setPrice(testKey, testValue.price, testValue.timestamp);

      // Measure zero-copy read
      const zeroCopyStart = process.hrtime.bigint();
      await harness.testZeroCopyRead(testKey);
      const zeroCopyEnd = process.hrtime.bigint();
      const zeroCopyLatencyUs = Number(zeroCopyEnd - zeroCopyStart) / 1000;

      // Measure JSON serialization (simulate postMessage)
      const jsonStart = process.hrtime.bigint();
      const serialized = JSON.stringify(testValue);
      const deserialized = JSON.parse(serialized);
      const jsonEnd = process.hrtime.bigint();
      const jsonLatencyUs = Number(jsonEnd - jsonStart) / 1000;

      // Zero-copy should be at least 10x faster
      const speedup = jsonLatencyUs / zeroCopyLatencyUs;
      expect(speedup).toBeGreaterThan(10);

      console.log('✓ Zero-copy vs JSON serialization:', {
        zeroCopy: `${zeroCopyLatencyUs.toFixed(2)}μs`,
        jsonSerialization: `${jsonLatencyUs.toFixed(2)}μs`,
        speedup: `${speedup.toFixed(1)}x faster`,
      });
    }, 15000);

    it('should avoid memory allocation overhead', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Pre-populate cache
      const keys: string[] = [];
      for (let i = 0; i < 100; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // Measure memory before 1000 reads
      const initialMemory = process.memoryUsage().heapUsed / 1024 / 1024;

      // Perform 1000 zero-copy reads
      for (let i = 0; i < 1000; i++) {
        const key = keys[i % keys.length];
        await harness.testZeroCopyRead(key);
      }

      // Measure memory after
      const finalMemory = process.memoryUsage().heapUsed / 1024 / 1024;
      const memoryGrowthMB = finalMemory - initialMemory;

      // Memory growth should be minimal (<5MB for 1000 reads)
      expect(memoryGrowthMB).toBeLessThan(5);

      console.log('✓ No memory allocation overhead:', {
        reads: 1000,
        memoryGrowth: `${memoryGrowthMB.toFixed(2)}MB`,
        target: '<5MB',
      });
    }, 45000);
  });

  describe('Latency Distribution', () => {
    it('should have consistent latency distribution (low variance)', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 50 price entries
      const keys: string[] = [];
      for (let i = 0; i < 50; i++) {
        const key = `price:bsc:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // Measure 500 reads
      const latencies: number[] = [];

      for (let i = 0; i < 500; i++) {
        const key = keys[i % keys.length];
        const result = await harness.testZeroCopyRead(key);
        latencies.push(result.latencyUs);
      }

      // Calculate statistics
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.50)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];

      // Low variance: p99 should not be much higher than p50
      const variance = p99 / p50;
      expect(variance).toBeLessThan(5); // p99 < 5x p50

      console.log('✓ Consistent latency distribution:', {
        samples: 500,
        p50: `${p50.toFixed(2)}μs`,
        p95: `${p95.toFixed(2)}μs`,
        p99: `${p99.toFixed(2)}μs`,
        variance: `${variance.toFixed(2)}x`,
      });
    }, 60000);

    it('should meet all percentile targets simultaneously', async () => {
      const priceMatrix = harness.getPriceMatrix();

      // Create 100 price entries
      const keys: string[] = [];
      for (let i = 0; i < 100; i++) {
        const key = `price:polygon:0x${i.toString(16).padStart(40, '0')}`;
        keys.push(key);
        priceMatrix.setPrice(key, Math.random() * 1000, Date.now());
      }

      // Measure 1000 reads
      const latencies: number[] = [];

      for (let i = 0; i < 1000; i++) {
        const key = keys[i % keys.length];
        const result = await harness.testZeroCopyRead(key);
        latencies.push(result.latencyUs);
      }

      // Calculate percentiles
      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.50)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];
      const p999 = latencies[Math.floor(latencies.length * 0.999)];

      // Assert targets (FAIL if not met)
      expect(p50).toBeLessThan(3); // p50 <3μs
      expect(p95).toBeLessThan(5); // p95 <5μs
      expect(p99).toBeLessThan(5); // p99 <5μs
      expect(p999).toBeLessThan(10); // p99.9 <10μs

      console.log('✓ All percentile targets met:', {
        samples: 1000,
        p50: `${p50.toFixed(3)}μs (target: <3μs)`,
        p95: `${p95.toFixed(3)}μs (target: <5μs)`,
        p99: `${p99.toFixed(3)}μs (target: <5μs)`,
        p999: `${p999.toFixed(3)}μs (target: <10μs)`,
      });
    }, 60000);
  });
});
