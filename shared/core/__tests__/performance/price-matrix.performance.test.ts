/**
 * PriceMatrix Performance Benchmarks
 *
 * Extracted from price-matrix.test.ts to isolate timing-sensitive tests.
 *
 * @see shared/core/__tests__/unit/price-matrix.test.ts - functional tests
 * @see ADR-005: L1 Cache
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

import { PriceMatrix, resetPriceMatrix } from '@arbitrage/core/caching';

// =============================================================================
// Test Helpers
// =============================================================================

function createTestPriceKey(index: number): string {
  return `bsc:pancakeswap:0xpair${index.toString().padStart(4, '0')}`;
}

function generatePriceKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => createTestPriceKey(i));
}

// =============================================================================
// Performance Benchmarks
// =============================================================================

describe('Performance Benchmarks', () => {
  let matrix: PriceMatrix;

  beforeEach(() => {
    resetPriceMatrix();
    matrix = new PriceMatrix();
  });

  afterEach(() => {
    matrix.destroy();
  });

  it('should achieve <1us lookup time (target)', () => {
    // Pre-populate with 500 prices
    const keys = generatePriceKeys(500);
    const timestamp = Date.now();

    keys.forEach((key, i) => {
      matrix.setPrice(key, 1000 + i, timestamp);
    });

    // Warmup
    for (let i = 0; i < 100; i++) {
      matrix.getPrice(keys[i % keys.length]);
    }

    // Benchmark
    const iterations = 10000;
    const lookupKey = keys[250]; // Middle key

    const startTime = performance.now();
    for (let i = 0; i < iterations; i++) {
      matrix.getPrice(lookupKey);
    }
    const endTime = performance.now();

    const avgTimeMs = (endTime - startTime) / iterations;
    const avgTimeUs = avgTimeMs * 1000;

    console.log(`Average lookup time: ${avgTimeUs.toFixed(3)}us`);

    // Target: <1us (0.001ms)
    // Allow some variance: <20us for CI environment stability
    expect(avgTimeMs).toBeLessThan(0.02); // <20us
  });

  it('should handle 1000 concurrent lookups efficiently', async () => {
    // Pre-populate
    const keys = generatePriceKeys(100);
    const timestamp = Date.now();

    keys.forEach((key, i) => {
      matrix.setPrice(key, 1000 + i, timestamp);
    });

    const startTime = performance.now();

    // Simulate concurrent lookups
    const lookups = Array.from({ length: 1000 }, (_, i) =>
      Promise.resolve(matrix.getPrice(keys[i % keys.length]))
    );

    await Promise.all(lookups);

    const endTime = performance.now();
    const totalTime = endTime - startTime;

    console.log(`1000 concurrent lookups: ${totalTime.toFixed(2)}ms`);

    // Should complete in <100ms
    expect(totalTime).toBeLessThan(100);
  });

  it('should maintain performance under high write load', () => {
    const iterations = 1000;
    const timestamp = Date.now();

    const startTime = performance.now();
    for (let i = 0; i < iterations; i++) {
      matrix.setPrice(createTestPriceKey(i % 100), 1000 + i, timestamp);
    }
    const endTime = performance.now();

    const avgTimeMs = (endTime - startTime) / iterations;

    console.log(`Average write time: ${(avgTimeMs * 1000).toFixed(3)}us`);

    // Writes should also be fast: <200us average (increased for CI environment stability)
    expect(avgTimeMs).toBeLessThan(0.2);
  });

  it('should batch operations efficiently', () => {
    const batchSize = 100;
    const batches = 10;
    const timestamp = Date.now();

    const totalUpdates: Array<{ key: string; price: number; timestamp: number }> = [];
    for (let b = 0; b < batches; b++) {
      for (let i = 0; i < batchSize; i++) {
        totalUpdates.push({
          key: createTestPriceKey(b * batchSize + i),
          price: 1000 + b * batchSize + i,
          timestamp
        });
      }
    }

    const startTime = performance.now();
    matrix.setBatch(totalUpdates);
    const endTime = performance.now();

    const totalTime = endTime - startTime;
    const avgPerUpdate = totalTime / totalUpdates.length;

    console.log(`Batch update: ${totalUpdates.length} updates in ${totalTime.toFixed(2)}ms`);
    console.log(`Average per update: ${(avgPerUpdate * 1000).toFixed(3)}us`);

    // Batch should be efficient (increased for CI environment stability)
    expect(totalTime).toBeLessThan(100);
  });
});
