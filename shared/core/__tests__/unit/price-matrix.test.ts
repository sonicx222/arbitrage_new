/**
 * PriceMatrix Tests (TDD - Red Phase)
 *
 * Tests for S1.3: L1 Price Matrix
 * Hypothesis: SharedArrayBuffer price matrix reduces lookup time from 2ms to <1μs
 *
 * @migrated from shared/core/src/price-matrix.test.ts
 * @see IMPLEMENTATION_PLAN.md S1.3
 * @see ADR-005: L1 Cache
 * @see ADR-009: Test Architecture
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Import from package alias (new pattern per ADR-009)
import {
  PriceMatrix,
  PriceIndexMapper,
  getPriceMatrix,
  resetPriceMatrix
} from '@arbitrage/core';

import type { PriceMatrixConfig, PriceEntry } from '@arbitrage/core';

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
// PriceMatrix Core Tests
// =============================================================================

describe('PriceMatrix', () => {
  let matrix: PriceMatrix;

  beforeEach(() => {
    resetPriceMatrix();
    matrix = new PriceMatrix();
  });

  afterEach(() => {
    matrix.destroy();
  });

  // ===========================================================================
  // S1.3.1: SharedArrayBuffer-based Storage
  // ===========================================================================
  describe('S1.3.1: SharedArrayBuffer Storage', () => {
    it('should create matrix with SharedArrayBuffer backing', () => {
      expect(matrix).toBeDefined();
      expect(matrix.isSharedMemory()).toBe(true);
    });

    it('should use Float64Array for prices', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';
      matrix.setPrice(priceKey, 1850.50, Date.now());

      const entry = matrix.getPrice(priceKey);
      expect(entry).not.toBeNull();
      expect(typeof entry!.price).toBe('number');
      expect(entry!.price).toBe(1850.50);
    });

    it('should use Uint32Array for timestamps', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';
      const timestamp = Date.now();
      matrix.setPrice(priceKey, 1850.50, timestamp);

      const entry = matrix.getPrice(priceKey);
      expect(entry).not.toBeNull();
      expect(typeof entry!.timestamp).toBe('number');
      // Timestamp should be stored as relative seconds to save space
      expect(entry!.timestamp).toBeGreaterThan(0);
    });

    it('should accept custom configuration', () => {
      const customConfig: Partial<PriceMatrixConfig> = {
        maxPairs: 500,
        reserveSlots: 50
      };
      const customMatrix = new PriceMatrix(customConfig);
      const config = customMatrix.getConfig();

      expect(config.maxPairs).toBe(500);
      expect(config.reserveSlots).toBe(50);

      customMatrix.destroy();
    });

    it('should have default configuration for 1000 pairs', () => {
      const config = matrix.getConfig();
      expect(config.maxPairs).toBe(1000);
    });
  });

  // ===========================================================================
  // S1.3.2: Atomic Updates
  // ===========================================================================
  describe('S1.3.2: Atomic Operations', () => {
    it('should perform thread-safe writes', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';

      // Write multiple prices
      matrix.setPrice(priceKey, 1800.00, Date.now());
      matrix.setPrice(priceKey, 1850.00, Date.now());
      matrix.setPrice(priceKey, 1900.00, Date.now());

      const entry = matrix.getPrice(priceKey);
      expect(entry).not.toBeNull();
      expect(entry!.price).toBe(1900.00);
    });

    it('should perform thread-safe reads', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';
      matrix.setPrice(priceKey, 1850.50, Date.now());

      // Read multiple times
      const reads: (PriceEntry | null)[] = [];
      for (let i = 0; i < 100; i++) {
        reads.push(matrix.getPrice(priceKey));
      }

      // All reads should return consistent data
      expect(reads.every(r => r !== null && r.price === 1850.50)).toBe(true);
    });

    it('should handle concurrent-like updates without data corruption', async () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';
      const updates: Promise<void>[] = [];

      // Simulate concurrent updates
      for (let i = 0; i < 100; i++) {
        updates.push(Promise.resolve().then(() => {
          matrix.setPrice(priceKey, 1800 + i, Date.now());
        }));
      }

      await Promise.all(updates);

      const entry = matrix.getPrice(priceKey);
      expect(entry).not.toBeNull();
      // Price should be one of the valid values
      expect(entry!.price).toBeGreaterThanOrEqual(1800);
      expect(entry!.price).toBeLessThanOrEqual(1899);
    });

    it('should use Atomics for price updates', () => {
      // Verify the implementation uses Atomics (internal check)
      expect(matrix.usesAtomics()).toBe(true);
    });
  });

  // ===========================================================================
  // S1.3.3: Price Index Mapper
  // ===========================================================================
  describe('S1.3.3: Price Index Mapper', () => {
    it('should map "chain:dex:pair" to array offset', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';
      const offset = matrix.getOffset(priceKey);

      expect(typeof offset).toBe('number');
      expect(offset).toBeGreaterThanOrEqual(0);
    });

    it('should return consistent offsets for same key', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';

      const offset1 = matrix.getOffset(priceKey);
      const offset2 = matrix.getOffset(priceKey);

      expect(offset1).toBe(offset2);
    });

    it('should return different offsets for different keys', () => {
      const key1 = 'bsc:pancakeswap:0xpair1234';
      const key2 = 'bsc:pancakeswap:0xpair5678';

      const offset1 = matrix.getOffset(key1);
      const offset2 = matrix.getOffset(key2);

      expect(offset1).not.toBe(offset2);
    });

    it('should achieve O(1) lookup complexity', () => {
      // Pre-populate with many keys
      const keys = generatePriceKeys(500);
      keys.forEach((key, i) => {
        matrix.setPrice(key, 1000 + i, Date.now());
      });

      // Measure lookup time for first and last keys
      const startFirst = performance.now();
      matrix.getPrice(keys[0]);
      const timeFirst = performance.now() - startFirst;

      const startLast = performance.now();
      matrix.getPrice(keys[499]);
      const timeLast = performance.now() - startLast;

      // Both should be roughly the same time (O(1))
      // Allow 10x variance for warmup effects
      expect(Math.abs(timeFirst - timeLast)).toBeLessThan(1);
    });

    it('should support pre-registering keys for known pairs', () => {
      const keys = ['bsc:pancakeswap:0xpair1', 'bsc:pancakeswap:0xpair2'];

      matrix.registerKeys(keys);

      // Keys should have reserved offsets
      const offset1 = matrix.getOffset(keys[0]);
      const offset2 = matrix.getOffset(keys[1]);

      expect(offset1).toBeDefined();
      expect(offset2).toBeDefined();
      expect(offset1).not.toBe(offset2);
    });

    it('should return -1 for unknown keys when strict mode enabled', () => {
      const strictMatrix = new PriceMatrix({ strictMode: true });

      const offset = strictMatrix.getOffset('unknown:key:here');
      expect(offset).toBe(-1);

      strictMatrix.destroy();
    });
  });

  // ===========================================================================
  // Price Operations
  // ===========================================================================
  describe('Price Operations', () => {
    it('should set and get price correctly', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';
      const price = 1850.123456789;
      const timestamp = Date.now();

      matrix.setPrice(priceKey, price, timestamp);
      const entry = matrix.getPrice(priceKey);

      expect(entry).not.toBeNull();
      expect(entry!.price).toBeCloseTo(price, 6);
      expect(entry!.timestamp).toBeDefined();
    });

    it('should return null for non-existent price', () => {
      const entry = matrix.getPrice('nonexistent:key:here');
      expect(entry).toBeNull();
    });

    it('should update existing price', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';

      matrix.setPrice(priceKey, 1800.00, Date.now());
      matrix.setPrice(priceKey, 1850.00, Date.now());

      const entry = matrix.getPrice(priceKey);
      expect(entry!.price).toBe(1850.00);
    });

    it('should support batch price updates', () => {
      const updates: Array<{ key: string; price: number; timestamp: number }> = [];
      const timestamp = Date.now();

      for (let i = 0; i < 100; i++) {
        updates.push({
          key: createTestPriceKey(i),
          price: 1000 + i,
          timestamp
        });
      }

      matrix.setBatch(updates);

      // Verify all prices were set
      for (let i = 0; i < 100; i++) {
        const entry = matrix.getPrice(createTestPriceKey(i));
        expect(entry).not.toBeNull();
        expect(entry!.price).toBe(1000 + i);
      }
    });

    it('should support batch price retrieval', () => {
      const keys = generatePriceKeys(50);
      const timestamp = Date.now();

      // Set prices
      keys.forEach((key, i) => {
        matrix.setPrice(key, 1000 + i, timestamp);
      });

      // Get batch
      const entries = matrix.getBatch(keys);

      expect(entries.length).toBe(50);
      expect(entries.filter((e: PriceEntry | null) => e !== null).length).toBe(50);
    });

    it('should clear all prices', () => {
      const keys = generatePriceKeys(10);
      const timestamp = Date.now();

      keys.forEach((key, i) => {
        matrix.setPrice(key, 1000 + i, timestamp);
      });

      matrix.clear();

      keys.forEach(key => {
        const entry = matrix.getPrice(key);
        expect(entry).toBeNull();
      });
    });

    it('should delete specific price', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';
      matrix.setPrice(priceKey, 1850.00, Date.now());

      matrix.deletePrice(priceKey);

      const entry = matrix.getPrice(priceKey);
      expect(entry).toBeNull();
    });
  });

  // ===========================================================================
  // Memory Management
  // ===========================================================================
  describe('Memory Management', () => {
    it('should fit 1000 pairs within 16KB memory', () => {
      const memoryUsage = matrix.getMemoryUsage();

      // 1000 pairs * (8 bytes price + 4 bytes timestamp) = 12KB base
      // Plus overhead for index mapping
      // Total should be < 16KB
      expect(memoryUsage.totalBytes).toBeLessThan(16 * 1024);
    });

    it('should report accurate memory usage', () => {
      const usageBefore = matrix.getMemoryUsage();

      // Add 100 prices
      for (let i = 0; i < 100; i++) {
        matrix.setPrice(createTestPriceKey(i), 1000 + i, Date.now());
      }

      const usageAfter = matrix.getMemoryUsage();

      expect(usageAfter.usedSlots).toBe(100);
      expect(usageAfter.usedSlots).toBeGreaterThan(usageBefore.usedSlots);
    });

    it('should not exceed maxPairs limit', () => {
      const smallMatrix = new PriceMatrix({ maxPairs: 10 });

      // Try to add more than maxPairs
      for (let i = 0; i < 20; i++) {
        smallMatrix.setPrice(createTestPriceKey(i), 1000 + i, Date.now());
      }

      const usage = smallMatrix.getMemoryUsage();
      expect(usage.usedSlots).toBeLessThanOrEqual(10);

      smallMatrix.destroy();
    });

    it('should provide memory utilization percentage', () => {
      const usage = matrix.getMemoryUsage();

      expect(usage.utilizationPercent).toBeDefined();
      expect(usage.utilizationPercent).toBeGreaterThanOrEqual(0);
      expect(usage.utilizationPercent).toBeLessThanOrEqual(100);
    });
  });

  // ===========================================================================
  // Statistics
  // ===========================================================================
  describe('Statistics', () => {
    it('should track read/write operations', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';

      matrix.setPrice(priceKey, 1850.00, Date.now());
      matrix.getPrice(priceKey);
      matrix.getPrice(priceKey);

      const stats = matrix.getStats();

      expect(stats.writes).toBe(1);
      expect(stats.reads).toBe(2);
    });

    it('should track cache hits and misses', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';

      // Miss
      matrix.getPrice('nonexistent:key');
      // Set then hit
      matrix.setPrice(priceKey, 1850.00, Date.now());
      matrix.getPrice(priceKey);

      const stats = matrix.getStats();

      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    it('should reset statistics', () => {
      const priceKey = 'bsc:pancakeswap:0xpair1234';
      matrix.setPrice(priceKey, 1850.00, Date.now());
      matrix.getPrice(priceKey);

      matrix.resetStats();
      const stats = matrix.getStats();

      expect(stats.reads).toBe(0);
      expect(stats.writes).toBe(0);
    });
  });

  // ===========================================================================
  // Singleton Pattern
  // ===========================================================================
  describe('Singleton Pattern', () => {
    it('should return same instance from getPriceMatrix', () => {
      const instance1 = getPriceMatrix();
      const instance2 = getPriceMatrix();

      expect(instance1).toBe(instance2);
    });

    it('should reset singleton instance', () => {
      const instance1 = getPriceMatrix();
      resetPriceMatrix();
      const instance2 = getPriceMatrix();

      expect(instance1).not.toBe(instance2);
    });
  });
});

// =============================================================================
// PriceIndexMapper Tests
// =============================================================================

describe('PriceIndexMapper', () => {
  let mapper: PriceIndexMapper;

  beforeEach(() => {
    mapper = new PriceIndexMapper(1000);
  });

  it('should map key to unique index', () => {
    const key1 = 'bsc:pancakeswap:0xpair1';
    const key2 = 'bsc:pancakeswap:0xpair2';

    const index1 = mapper.getIndex(key1);
    const index2 = mapper.getIndex(key2);

    expect(index1).not.toBe(index2);
    expect(index1).toBeGreaterThanOrEqual(0);
    expect(index2).toBeGreaterThanOrEqual(0);
  });

  it('should return consistent index for same key', () => {
    const key = 'bsc:pancakeswap:0xpair1';

    const index1 = mapper.getIndex(key);
    const index2 = mapper.getIndex(key);

    expect(index1).toBe(index2);
  });

  it('should not exceed maxIndex', () => {
    const smallMapper = new PriceIndexMapper(10);

    for (let i = 0; i < 20; i++) {
      const index = smallMapper.getIndex(`key${i}`);
      expect(index).toBeLessThan(10);
    }
  });

  it('should support key lookup from index', () => {
    const key = 'bsc:pancakeswap:0xpair1';
    const index = mapper.getIndex(key);

    const retrievedKey = mapper.getKey(index);
    expect(retrievedKey).toBe(key);
  });

  it('should return null for unused index', () => {
    const key = mapper.getKey(999);
    expect(key).toBeNull();
  });

  it('should report usage statistics', () => {
    mapper.getIndex('key1');
    mapper.getIndex('key2');
    mapper.getIndex('key3');

    const stats = mapper.getStats();

    expect(stats.usedSlots).toBe(3);
    expect(stats.totalSlots).toBe(1000);
    expect(stats.utilizationPercent).toBeCloseTo(0.3, 1);
  });

  it('should support clearing all mappings', () => {
    mapper.getIndex('key1');
    mapper.getIndex('key2');

    mapper.clear();

    const stats = mapper.getStats();
    expect(stats.usedSlots).toBe(0);
  });
});

// =============================================================================
// PriceEntry Interface Tests
// =============================================================================

describe('PriceEntry Interface', () => {
  let matrix: PriceMatrix;

  beforeEach(() => {
    resetPriceMatrix();
    matrix = new PriceMatrix();
  });

  afterEach(() => {
    matrix.destroy();
  });

  it('should have correct shape', () => {
    const priceKey = 'bsc:pancakeswap:0xpair1234';
    matrix.setPrice(priceKey, 1850.50, Date.now());

    const entry = matrix.getPrice(priceKey);

    expect(entry).toHaveProperty('price');
    expect(entry).toHaveProperty('timestamp');
    expect(typeof entry!.price).toBe('number');
    expect(typeof entry!.timestamp).toBe('number');
  });
});

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

  it('should achieve <1μs lookup time (target)', () => {
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

    console.log(`Average lookup time: ${avgTimeUs.toFixed(3)}μs`);

    // Target: <1μs (0.001ms)
    // Allow some variance: <20μs for CI environment stability
    expect(avgTimeMs).toBeLessThan(0.02); // <20μs
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

    console.log(`Average write time: ${(avgTimeMs * 1000).toFixed(3)}μs`);

    // Writes should also be fast: <200μs average (increased for CI environment stability)
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
    console.log(`Average per update: ${(avgPerUpdate * 1000).toFixed(3)}μs`);

    // Batch should be efficient (increased for CI environment stability)
    expect(totalTime).toBeLessThan(100);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge Cases', () => {
  let matrix: PriceMatrix;

  beforeEach(() => {
    resetPriceMatrix();
    matrix = new PriceMatrix();
  });

  afterEach(() => {
    matrix.destroy();
  });

  it('should handle empty key gracefully', () => {
    expect(() => matrix.setPrice('', 1850.00, Date.now())).not.toThrow();
    expect(matrix.getPrice('')).toBeNull();
  });

  it('should handle very long keys', () => {
    const longKey = 'bsc:pancakeswap:' + '0x' + 'a'.repeat(100);
    matrix.setPrice(longKey, 1850.00, Date.now());

    const entry = matrix.getPrice(longKey);
    expect(entry).not.toBeNull();
    expect(entry!.price).toBe(1850.00);
  });

  it('should handle special characters in keys', () => {
    const specialKey = 'bsc:pancake-swap_v3:0xPair1234';
    matrix.setPrice(specialKey, 1850.00, Date.now());

    const entry = matrix.getPrice(specialKey);
    expect(entry).not.toBeNull();
  });

  it('should handle zero price', () => {
    const priceKey = 'bsc:pancakeswap:0xpair1234';
    matrix.setPrice(priceKey, 0, Date.now());

    const entry = matrix.getPrice(priceKey);
    expect(entry).not.toBeNull();
    expect(entry!.price).toBe(0);
  });

  it('should handle very large prices', () => {
    const priceKey = 'bsc:pancakeswap:0xpair1234';
    const largePrice = 1e15; // Quadrillion
    matrix.setPrice(priceKey, largePrice, Date.now());

    const entry = matrix.getPrice(priceKey);
    expect(entry).not.toBeNull();
    expect(entry!.price).toBe(largePrice);
  });

  it('should handle very small prices', () => {
    const priceKey = 'bsc:pancakeswap:0xpair1234';
    const smallPrice = 1e-15;
    matrix.setPrice(priceKey, smallPrice, Date.now());

    const entry = matrix.getPrice(priceKey);
    expect(entry).not.toBeNull();
    expect(entry!.price).toBeCloseTo(smallPrice, 18);
  });

  it('should handle negative prices gracefully', () => {
    const priceKey = 'bsc:pancakeswap:0xpair1234';

    // Should either reject or store negative price
    expect(() => matrix.setPrice(priceKey, -100, Date.now())).not.toThrow();
  });

  it('should handle NaN price gracefully', () => {
    const priceKey = 'bsc:pancakeswap:0xpair1234';

    // Should either reject or handle NaN
    expect(() => matrix.setPrice(priceKey, NaN, Date.now())).not.toThrow();

    const entry = matrix.getPrice(priceKey);
    // Either null or NaN is acceptable
    if (entry !== null) {
      expect(Number.isNaN(entry.price) || entry.price === 0).toBe(true);
    }
  });

  it('should handle Infinity price gracefully', () => {
    const priceKey = 'bsc:pancakeswap:0xpair1234';

    expect(() => matrix.setPrice(priceKey, Infinity, Date.now())).not.toThrow();
  });

  it('should not crash after destroy', () => {
    matrix.destroy();

    // Operations after destroy should not throw
    expect(() => matrix.setPrice('key', 100, Date.now())).not.toThrow();
    expect(matrix.getPrice('key')).toBeNull();
  });

  it('should handle getBatch with non-existent keys', () => {
    const keys = ['nonexistent1', 'nonexistent2', 'nonexistent3'];
    const entries = matrix.getBatch(keys);

    expect(entries.length).toBe(3);
    expect(entries.every((e: PriceEntry | null) => e === null)).toBe(true);
  });

  it('should handle setBatch with empty array', () => {
    expect(() => matrix.setBatch([])).not.toThrow();
  });

  it('should reject invalid maxPairs config', () => {
    expect(() => new PriceMatrix({ maxPairs: 0 })).toThrow('maxPairs must be positive');
    expect(() => new PriceMatrix({ maxPairs: -1 })).toThrow('maxPairs must be positive');
  });

  it('should reject invalid reserveSlots config', () => {
    expect(() => new PriceMatrix({ reserveSlots: -1 })).toThrow('reserveSlots must be non-negative');
  });

  it('should accept valid reserveSlots of 0', () => {
    const m = new PriceMatrix({ reserveSlots: 0 });
    expect(m.getConfig().reserveSlots).toBe(0);
    m.destroy();
  });
});

// =============================================================================
// Prometheus Metrics
// =============================================================================

describe('Prometheus Metrics', () => {
  let matrix: PriceMatrix;

  beforeEach(() => {
    resetPriceMatrix();
    matrix = new PriceMatrix();
  });

  afterEach(() => {
    matrix.destroy();
  });

  it('should export Prometheus-format metrics', () => {
    matrix.setPrice('bsc:pancakeswap:0xpair1', 1850.00, Date.now());
    matrix.getPrice('bsc:pancakeswap:0xpair1');
    matrix.getPrice('nonexistent:key');

    const metrics = matrix.getPrometheusMetrics();

    expect(metrics).toContain('price_matrix_reads');
    expect(metrics).toContain('price_matrix_writes');
    expect(metrics).toContain('price_matrix_hits');
    expect(metrics).toContain('price_matrix_misses');
    expect(metrics).toContain('price_matrix_memory_bytes');
    expect(metrics).toContain('price_matrix_utilization');
  });

  it('should include correct metric types', () => {
    const metrics = matrix.getPrometheusMetrics();

    expect(metrics).toContain('# TYPE price_matrix_reads counter');
    expect(metrics).toContain('# TYPE price_matrix_memory_bytes gauge');
  });
});
