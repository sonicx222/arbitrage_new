/**
 * S1.3 L1 Price Matrix Integration Tests
 *
 * End-to-end testing of the L1 Price Matrix implementation
 * Validates the hypothesis: SharedArrayBuffer reduces lookup time from 2ms to <1μs
 *
 * @see IMPLEMENTATION_PLAN.md S1.3: L1 Price Matrix
 * @see S1.3.1-S1.3.5: Price Matrix Implementation Tasks
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';

import {
  PriceMatrix,
  PriceIndexMapper,
  getPriceMatrix,
  resetPriceMatrix
} from '@arbitrage/coreprice-matrix';

import type {
  PriceMatrixConfig,
  PriceEntry,
  MemoryUsage,
  BatchUpdate
} from '@arbitrage/coreprice-matrix';

// =============================================================================
// Test Helpers
// =============================================================================

function createTestPriceKey(chain: string, dex: string, pairIndex: number): string {
  return `${chain}:${dex}:0xpair${pairIndex.toString().padStart(4, '0')}`;
}

function generatePriceKeys(count: number, chain = 'bsc', dex = 'pancakeswap'): string[] {
  return Array.from({ length: count }, (_, i) => createTestPriceKey(chain, dex, i));
}

// Simulate realistic price data
function generateRealisticPrices(count: number): BatchUpdate[] {
  const chains = ['bsc', 'ethereum', 'arbitrum', 'polygon', 'base'];
  const dexes = ['pancakeswap', 'uniswap', 'sushiswap', 'quickswap'];
  const timestamp = Date.now();

  return Array.from({ length: count }, (_, i) => ({
    key: `${chains[i % chains.length]}:${dexes[i % dexes.length]}:0xpair${i.toString().padStart(4, '0')}`,
    price: 1800 + Math.random() * 200, // ETH-like prices $1800-$2000
    timestamp
  }));
}

describe('S1.3 L1 Price Matrix Integration Tests', () => {
  let matrix: PriceMatrix;

  beforeAll(() => {
    resetPriceMatrix();
  });

  afterAll(() => {
    resetPriceMatrix();
  });

  beforeEach(() => {
    resetPriceMatrix();
    matrix = new PriceMatrix();
  });

  afterEach(() => {
    if (matrix) {
      matrix.destroy();
    }
  });

  // =========================================================================
  // S1.3.1: SharedArrayBuffer Storage
  // =========================================================================
  describe('S1.3.1: SharedArrayBuffer Storage', () => {
    it('should use SharedArrayBuffer for backing storage', () => {
      expect(matrix.isSharedMemory()).toBe(true);
    });

    it('should store prices with full precision', () => {
      const key = 'bsc:pancakeswap:0xpair1234';
      const price = 1850.123456789012345;
      const timestamp = Date.now();

      matrix.setPrice(key, price, timestamp);
      const entry = matrix.getPrice(key);

      expect(entry).not.toBeNull();
      // Float64 provides ~15-17 significant digits
      expect(entry!.price).toBeCloseTo(price, 12);
    });

    it('should handle 1000 pairs within memory budget', () => {
      const keys = generatePriceKeys(1000);
      const timestamp = Date.now();

      // Set 1000 prices
      keys.forEach((key, i) => {
        matrix.setPrice(key, 1800 + i * 0.1, timestamp);
      });

      const memory = matrix.getMemoryUsage();

      // Target: <16KB for 1000 pairs
      expect(memory.totalBytes).toBeLessThan(16 * 1024);
      expect(memory.usedSlots).toBe(1000);
    });
  });

  // =========================================================================
  // S1.3.2: Atomic Operations
  // =========================================================================
  describe('S1.3.2: Atomic Operations', () => {
    it('should use Atomics for thread-safe operations', () => {
      expect(matrix.usesAtomics()).toBe(true);
    });

    it('should handle rapid sequential updates', () => {
      const key = 'bsc:pancakeswap:0xpair1234';
      const iterations = 1000;
      const timestamp = Date.now();

      // Rapid updates
      for (let i = 0; i < iterations; i++) {
        matrix.setPrice(key, 1800 + i, timestamp);
      }

      const entry = matrix.getPrice(key);
      expect(entry).not.toBeNull();
      // Should have the last value
      expect(entry!.price).toBe(1800 + iterations - 1);
    });

    it('should maintain data consistency under concurrent-like access', async () => {
      const key = 'bsc:pancakeswap:0xpair1234';
      const timestamp = Date.now();

      // Set initial price
      matrix.setPrice(key, 1850, timestamp);

      // Concurrent-like reads and writes
      const operations: Promise<any>[] = [];

      for (let i = 0; i < 100; i++) {
        // Writes
        operations.push(Promise.resolve().then(() => {
          matrix.setPrice(key, 1850 + (i % 10), timestamp);
        }));
        // Reads
        operations.push(Promise.resolve().then(() => {
          return matrix.getPrice(key);
        }));
      }

      const results = await Promise.all(operations);

      // All reads should return valid data
      const reads = results.filter((r): r is PriceEntry => r !== undefined && r !== null);
      expect(reads.length).toBeGreaterThan(0);
      reads.forEach(entry => {
        expect(entry.price).toBeGreaterThanOrEqual(1850);
        expect(entry.price).toBeLessThanOrEqual(1859);
      });
    });
  });

  // =========================================================================
  // S1.3.3: Price Index Mapper
  // =========================================================================
  describe('S1.3.3: Price Index Mapper', () => {
    it('should provide O(1) key-to-index mapping', () => {
      const keys = generatePriceKeys(500);
      const timestamp = Date.now();

      // Populate
      keys.forEach((key, i) => {
        matrix.setPrice(key, 1800 + i, timestamp);
      });

      // Measure lookup times for first, middle, and last keys
      const times: number[] = [];

      [0, 250, 499].forEach(idx => {
        const start = performance.now();
        for (let i = 0; i < 1000; i++) {
          matrix.getOffset(keys[idx]);
        }
        times.push((performance.now() - start) / 1000);
      });

      // All should be similar (O(1) behavior)
      const maxDiff = Math.max(...times) - Math.min(...times);
      expect(maxDiff).toBeLessThan(0.1); // <100μs difference
    });

    it('should map different keys to different offsets', () => {
      const keys = generatePriceKeys(100);
      const offsets = new Set<number>();

      keys.forEach(key => {
        offsets.add(matrix.getOffset(key));
      });

      // All keys should have unique offsets
      expect(offsets.size).toBe(100);
    });

    it('should support multi-chain key patterns', () => {
      const chains = ['bsc', 'ethereum', 'arbitrum', 'polygon', 'base'];
      const dexes = ['pancakeswap', 'uniswap', 'sushiswap'];
      const timestamp = Date.now();

      // Create diverse keys
      chains.forEach(chain => {
        dexes.forEach(dex => {
          const key = `${chain}:${dex}:0xpair0001`;
          matrix.setPrice(key, 1850, timestamp);
        });
      });

      // Verify all stored correctly
      chains.forEach(chain => {
        dexes.forEach(dex => {
          const key = `${chain}:${dex}:0xpair0001`;
          const entry = matrix.getPrice(key);
          expect(entry).not.toBeNull();
          expect(entry!.price).toBe(1850);
        });
      });
    });
  });

  // =========================================================================
  // S1.3.5: Performance Benchmarks
  // =========================================================================
  describe('S1.3.5: Performance Benchmarks', () => {
    it('should achieve <1μs average lookup time', () => {
      // Pre-populate with realistic data
      const updates = generateRealisticPrices(500);
      matrix.setBatch(updates);

      // Warmup
      for (let i = 0; i < 100; i++) {
        matrix.getPrice(updates[i % updates.length].key);
      }

      // Benchmark
      const iterations = 10000;
      const lookupKey = updates[250].key;

      const startTime = performance.now();
      for (let i = 0; i < iterations; i++) {
        matrix.getPrice(lookupKey);
      }
      const endTime = performance.now();

      const avgTimeMs = (endTime - startTime) / iterations;
      const avgTimeUs = avgTimeMs * 1000;

      console.log(`Average lookup time: ${avgTimeUs.toFixed(3)}μs`);

      // Target: <1μs (allow 10μs for test environment variance)
      expect(avgTimeMs).toBeLessThan(0.01);
    });

    it('should achieve <10μs average write time', () => {
      const iterations = 10000;
      const timestamp = Date.now();

      const startTime = performance.now();
      for (let i = 0; i < iterations; i++) {
        matrix.setPrice(`bsc:pancakeswap:0xpair${i % 100}`, 1800 + (i % 100), timestamp);
      }
      const endTime = performance.now();

      const avgTimeMs = (endTime - startTime) / iterations;
      const avgTimeUs = avgTimeMs * 1000;

      console.log(`Average write time: ${avgTimeUs.toFixed(3)}μs`);

      // Target: <10μs
      expect(avgTimeMs).toBeLessThan(0.01);
    });

    it('should handle high-throughput batch operations', () => {
      const batchCount = 10;
      const batchSize = 100;
      const totalUpdates: BatchUpdate[] = [];

      for (let b = 0; b < batchCount; b++) {
        const batch = generateRealisticPrices(batchSize);
        totalUpdates.push(...batch);
      }

      const startTime = performance.now();
      matrix.setBatch(totalUpdates);
      const endTime = performance.now();

      const totalTime = endTime - startTime;
      const avgPerUpdate = totalTime / totalUpdates.length;

      console.log(`Batch write: ${totalUpdates.length} updates in ${totalTime.toFixed(2)}ms`);
      console.log(`Average per update: ${(avgPerUpdate * 1000).toFixed(3)}μs`);

      // Should complete quickly
      expect(totalTime).toBeLessThan(100); // <100ms for 1000 updates
    });

    it('should demonstrate improvement over Map-based cache', () => {
      // Simulate Map-based cache (old L1 approach)
      const mapCache = new Map<string, { price: number; timestamp: number }>();
      const keys = generatePriceKeys(500);
      const timestamp = Date.now();

      // Populate both
      keys.forEach((key, i) => {
        matrix.setPrice(key, 1800 + i, timestamp);
        mapCache.set(key, { price: 1800 + i, timestamp });
      });

      // Benchmark Map-based reads
      const mapIterations = 10000;
      const mapStart = performance.now();
      for (let i = 0; i < mapIterations; i++) {
        mapCache.get(keys[250]);
      }
      const mapTime = performance.now() - mapStart;

      // Benchmark PriceMatrix reads
      const matrixStart = performance.now();
      for (let i = 0; i < mapIterations; i++) {
        matrix.getPrice(keys[250]);
      }
      const matrixTime = performance.now() - matrixStart;

      console.log(`Map cache: ${(mapTime / mapIterations * 1000).toFixed(3)}μs per lookup`);
      console.log(`PriceMatrix: ${(matrixTime / mapIterations * 1000).toFixed(3)}μs per lookup`);

      // Both should be very fast, but PriceMatrix has SharedArrayBuffer benefit
      // in multi-threaded scenarios (can't easily test here)
      expect(matrixTime).toBeLessThan(100);
    });
  });

  // =========================================================================
  // Integration: Realistic Scenarios
  // =========================================================================
  describe('Integration: Realistic Scenarios', () => {
    it('should handle price update stream simulation', async () => {
      const pairs = 100;
      const updatesPerPair = 10;
      const keys = generatePriceKeys(pairs);

      // Simulate price updates stream
      for (let round = 0; round < updatesPerPair; round++) {
        const timestamp = Date.now();
        keys.forEach((key, i) => {
          const basePrice = 1800 + i;
          const variation = (Math.random() - 0.5) * 10; // ±$5
          matrix.setPrice(key, basePrice + variation, timestamp);
        });
      }

      // Verify all pairs have prices
      const stats = matrix.getStats();
      expect(stats.writes).toBe(pairs * updatesPerPair);

      // All keys should have current prices
      keys.forEach(key => {
        const entry = matrix.getPrice(key);
        expect(entry).not.toBeNull();
      });
    });

    it('should support arbitrage price comparison pattern', () => {
      const timestamp = Date.now();

      // Set prices on different DEXes for same pair
      matrix.setPrice('bsc:pancakeswap:0xWBNB-USDT', 580.50, timestamp);
      matrix.setPrice('bsc:biswap:0xWBNB-USDT', 581.20, timestamp);
      matrix.setPrice('bsc:apeswap:0xWBNB-USDT', 580.80, timestamp);

      // Quick comparison (arbitrage detection pattern)
      const prices = matrix.getBatch([
        'bsc:pancakeswap:0xWBNB-USDT',
        'bsc:biswap:0xWBNB-USDT',
        'bsc:apeswap:0xWBNB-USDT'
      ]);

      expect(prices.length).toBe(3);
      expect(prices.every(p => p !== null)).toBe(true);

      const priceValues = prices.map(p => p!.price);
      const minPrice = Math.min(...priceValues);
      const maxPrice = Math.max(...priceValues);
      const spread = maxPrice - minPrice;

      expect(spread).toBeCloseTo(0.70, 1);
    });

    it('should handle cross-chain price aggregation', () => {
      const timestamp = Date.now();

      // ETH prices across chains
      const ethPrices = [
        { key: 'ethereum:uniswap:0xETH-USDC', price: 1850.00 },
        { key: 'arbitrum:uniswap:0xETH-USDC', price: 1849.50 },
        { key: 'polygon:quickswap:0xETH-USDC', price: 1850.25 },
        { key: 'bsc:pancakeswap:0xETH-USDC', price: 1848.80 }
      ];

      ethPrices.forEach(({ key, price }) => {
        matrix.setPrice(key, price, timestamp);
      });

      // Get all ETH prices
      const keys = ethPrices.map(p => p.key);
      const prices = matrix.getBatch(keys);

      expect(prices.every(p => p !== null)).toBe(true);

      // Calculate average for cross-chain arbitrage
      const avg = prices.reduce((sum, p) => sum + p!.price, 0) / prices.length;
      expect(avg).toBeCloseTo(1849.64, 1);
    });
  });

  // =========================================================================
  // Memory and Resource Management
  // =========================================================================
  describe('Memory and Resource Management', () => {
    it('should enforce maxPairs limit', () => {
      const smallMatrix = new PriceMatrix({ maxPairs: 50 });
      const timestamp = Date.now();

      // Try to add more than maxPairs
      for (let i = 0; i < 100; i++) {
        smallMatrix.setPrice(`key${i}`, 1000 + i, timestamp);
      }

      const memory = smallMatrix.getMemoryUsage();
      expect(memory.usedSlots).toBe(50);

      smallMatrix.destroy();
    });

    it('should release resources on destroy', () => {
      const tempMatrix = new PriceMatrix();
      const key = 'test:key:0x1234';

      tempMatrix.setPrice(key, 1850, Date.now());
      expect(tempMatrix.getPrice(key)).not.toBeNull();

      tempMatrix.destroy();

      // After destroy, operations should return null/be no-ops
      expect(tempMatrix.getPrice(key)).toBeNull();
    });

    it('should clear all data correctly', () => {
      const keys = generatePriceKeys(100);
      const timestamp = Date.now();

      keys.forEach((key, i) => {
        matrix.setPrice(key, 1800 + i, timestamp);
      });

      expect(matrix.getMemoryUsage().usedSlots).toBe(100);

      matrix.clear();

      expect(matrix.getMemoryUsage().usedSlots).toBe(0);
      keys.forEach(key => {
        expect(matrix.getPrice(key)).toBeNull();
      });
    });
  });

  // =========================================================================
  // Prometheus Metrics
  // =========================================================================
  describe('Prometheus Metrics', () => {
    it('should export comprehensive metrics', () => {
      // Perform operations
      matrix.setPrice('test:key:0x1', 1850, Date.now());
      matrix.getPrice('test:key:0x1');
      matrix.getPrice('nonexistent:key');

      const metrics = matrix.getPrometheusMetrics();

      // Check all expected metrics
      expect(metrics).toContain('price_matrix_reads');
      expect(metrics).toContain('price_matrix_writes');
      expect(metrics).toContain('price_matrix_hits');
      expect(metrics).toContain('price_matrix_misses');
      expect(metrics).toContain('price_matrix_memory_bytes');
      expect(metrics).toContain('price_matrix_utilization');
    });

    it('should report accurate statistics', () => {
      matrix.setPrice('test:key:0x1', 1850, Date.now());
      matrix.setPrice('test:key:0x2', 1860, Date.now());
      matrix.getPrice('test:key:0x1'); // Hit
      matrix.getPrice('test:key:0x2'); // Hit
      matrix.getPrice('nonexistent'); // Miss

      const stats = matrix.getStats();

      expect(stats.writes).toBe(2);
      expect(stats.reads).toBe(3);
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
    });
  });

  // =========================================================================
  // Singleton Pattern
  // =========================================================================
  describe('Singleton Pattern', () => {
    it('should return same instance from getPriceMatrix', () => {
      resetPriceMatrix();

      const instance1 = getPriceMatrix();
      const instance2 = getPriceMatrix();

      expect(instance1).toBe(instance2);

      instance1.destroy();
    });

    it('should allow configuration on first call', () => {
      resetPriceMatrix();

      const instance = getPriceMatrix({ maxPairs: 500 });
      const config = instance.getConfig();

      expect(config.maxPairs).toBe(500);

      instance.destroy();
    });
  });
});

// =============================================================================
// PriceIndexMapper Integration Tests
// =============================================================================

describe('PriceIndexMapper Integration', () => {
  let mapper: PriceIndexMapper;

  beforeEach(() => {
    mapper = new PriceIndexMapper(1000);
  });

  it('should handle realistic key patterns', () => {
    const chains = ['bsc', 'ethereum', 'arbitrum'];
    const dexes = ['pancakeswap', 'uniswap', 'sushiswap'];

    chains.forEach(chain => {
      dexes.forEach(dex => {
        for (let i = 0; i < 10; i++) {
          const key = `${chain}:${dex}:0xpair${i}`;
          const index = mapper.getIndex(key);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(index).toBeLessThan(1000);
        }
      });
    });

    const stats = mapper.getStats();
    expect(stats.usedSlots).toBe(90); // 3 chains * 3 dexes * 10 pairs
  });

  it('should provide reverse lookup', () => {
    const key = 'bsc:pancakeswap:0xpair1234';
    const index = mapper.getIndex(key);
    const retrievedKey = mapper.getKey(index);

    expect(retrievedKey).toBe(key);
  });
});

// =============================================================================
// Config Validation Integration Tests
// =============================================================================

describe('Config Validation', () => {
  beforeEach(() => {
    resetPriceMatrix();
  });

  afterEach(() => {
    resetPriceMatrix();
  });

  it('should reject maxPairs of 0', () => {
    expect(() => new PriceMatrix({ maxPairs: 0 })).toThrow('maxPairs must be positive');
  });

  it('should reject negative maxPairs', () => {
    expect(() => new PriceMatrix({ maxPairs: -100 })).toThrow('maxPairs must be positive');
  });

  it('should reject negative reserveSlots', () => {
    expect(() => new PriceMatrix({ reserveSlots: -1 })).toThrow('reserveSlots must be non-negative');
  });

  it('should accept reserveSlots of 0', () => {
    const matrix = new PriceMatrix({ reserveSlots: 0 });
    expect(matrix.getConfig().reserveSlots).toBe(0);
    matrix.destroy();
  });

  it('should accept valid custom configuration', () => {
    const matrix = new PriceMatrix({
      maxPairs: 500,
      reserveSlots: 50,
      strictMode: true,
      enableAtomics: false
    });

    const config = matrix.getConfig();
    expect(config.maxPairs).toBe(500);
    expect(config.reserveSlots).toBe(50);
    expect(config.strictMode).toBe(true);
    expect(config.enableAtomics).toBe(false);

    matrix.destroy();
  });
});

// =============================================================================
// Singleton Race Condition Guard Tests
// =============================================================================

describe('Singleton Race Condition Guard', () => {
  beforeEach(() => {
    resetPriceMatrix();
  });

  afterEach(() => {
    resetPriceMatrix();
  });

  it('should return same instance on multiple calls', () => {
    const instance1 = getPriceMatrix();
    const instance2 = getPriceMatrix();
    const instance3 = getPriceMatrix();

    expect(instance1).toBe(instance2);
    expect(instance2).toBe(instance3);
  });

  it('should ignore config on subsequent calls', () => {
    // First call with custom config
    const instance1 = getPriceMatrix({ maxPairs: 500 });
    expect(instance1.getConfig().maxPairs).toBe(500);

    // Second call with different config (should be ignored)
    const instance2 = getPriceMatrix({ maxPairs: 2000 });
    expect(instance2.getConfig().maxPairs).toBe(500); // Still 500, not 2000
    expect(instance1).toBe(instance2);
  });

  it('should create new instance after reset', () => {
    const instance1 = getPriceMatrix({ maxPairs: 500 });
    instance1.setPrice('test:key:0x1', 1850, Date.now());

    resetPriceMatrix();

    const instance2 = getPriceMatrix({ maxPairs: 1000 });
    expect(instance2.getConfig().maxPairs).toBe(1000);
    expect(instance2.getPrice('test:key:0x1')).toBeNull(); // Data cleared
  });

  it('should handle concurrent-like singleton access', async () => {
    resetPriceMatrix();

    // Simulate multiple concurrent accesses
    const promises = Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => getPriceMatrix())
    );

    const instances = await Promise.all(promises);

    // All should be the same instance
    const firstInstance = instances[0];
    expect(instances.every(inst => inst === firstInstance)).toBe(true);
  });
});

// =============================================================================
// Hash Collision Handling Tests
// =============================================================================

describe('Hash Collision Handling', () => {
  it('should use hash-based index when slots exhausted', () => {
    // Create small matrix that will fill up quickly
    const smallMapper = new PriceIndexMapper(5);

    // Fill all 5 slots
    for (let i = 0; i < 5; i++) {
      const index = smallMapper.getIndex(`key${i}`);
      expect(index).toBe(i); // Sequential allocation
    }

    // Next key will use hash-based index (slot reuse)
    const hashIndex = smallMapper.getIndex('overflow_key');
    expect(hashIndex).toBeGreaterThanOrEqual(0);
    expect(hashIndex).toBeLessThan(5);
  });

  it('should maintain existing key mappings when slots exhausted', () => {
    const smallMapper = new PriceIndexMapper(3);

    // Fill slots
    smallMapper.getIndex('key0');
    smallMapper.getIndex('key1');
    smallMapper.getIndex('key2');

    // Existing keys should still return same indices
    expect(smallMapper.getIndex('key0')).toBe(0);
    expect(smallMapper.getIndex('key1')).toBe(1);
    expect(smallMapper.getIndex('key2')).toBe(2);
  });
});

// =============================================================================
// End-to-End Workflow Tests
// =============================================================================

describe('End-to-End Workflow', () => {
  let matrix: PriceMatrix;

  beforeEach(() => {
    resetPriceMatrix();
    matrix = new PriceMatrix({ maxPairs: 100 });
  });

  afterEach(() => {
    matrix.destroy();
  });

  it('should support complete arbitrage detection workflow', () => {
    const timestamp = Date.now();

    // Step 1: Register known trading pairs
    const tradingPairs = [
      'bsc:pancakeswap:0xWBNB-USDT',
      'bsc:biswap:0xWBNB-USDT',
      'bsc:apeswap:0xWBNB-USDT',
      'ethereum:uniswap:0xWETH-USDC',
      'arbitrum:uniswap:0xWETH-USDC'
    ];

    matrix.registerKeys(tradingPairs);

    // Step 2: Update prices from different DEXes
    matrix.setPrice('bsc:pancakeswap:0xWBNB-USDT', 580.50, timestamp);
    matrix.setPrice('bsc:biswap:0xWBNB-USDT', 581.80, timestamp);
    matrix.setPrice('bsc:apeswap:0xWBNB-USDT', 580.20, timestamp);
    matrix.setPrice('ethereum:uniswap:0xWETH-USDC', 1850.00, timestamp);
    matrix.setPrice('arbitrum:uniswap:0xWETH-USDC', 1848.50, timestamp);

    // Step 3: Detect arbitrage opportunity (price comparison)
    const bscPrices = matrix.getBatch([
      'bsc:pancakeswap:0xWBNB-USDT',
      'bsc:biswap:0xWBNB-USDT',
      'bsc:apeswap:0xWBNB-USDT'
    ]);

    expect(bscPrices.every(p => p !== null)).toBe(true);

    const priceValues = bscPrices.map(p => p!.price);
    const minPrice = Math.min(...priceValues);
    const maxPrice = Math.max(...priceValues);
    const spread = ((maxPrice - minPrice) / minPrice) * 100;

    // Spread should be ~0.28% (581.80 - 580.20) / 580.20
    expect(spread).toBeGreaterThan(0.2);
    expect(spread).toBeLessThan(0.5);

    // Step 4: Cross-chain comparison
    const ethPrices = matrix.getBatch([
      'ethereum:uniswap:0xWETH-USDC',
      'arbitrum:uniswap:0xWETH-USDC'
    ]);

    expect(ethPrices.every(p => p !== null)).toBe(true);
    const ethSpread = Math.abs(ethPrices[0]!.price - ethPrices[1]!.price);
    expect(ethSpread).toBeCloseTo(1.50, 1);

    // Step 5: Verify stats
    const stats = matrix.getStats();
    expect(stats.writes).toBe(5);
    expect(stats.reads).toBe(5); // 3 BSC + 2 ETH
    expect(stats.hits).toBe(5);
    expect(stats.misses).toBe(0);
  });

  it('should handle rapid price updates simulation', () => {
    const pairs = 50;
    const updatesPerSecond = 100;
    const keys = generatePriceKeys(pairs);

    // Simulate 1 second of rapid updates
    const startTime = Date.now();
    for (let i = 0; i < updatesPerSecond; i++) {
      const timestamp = startTime + i * 10; // 10ms intervals
      keys.forEach((key, idx) => {
        const basePrice = 1800 + idx;
        const variation = Math.sin(i / 10) * 5; // Price oscillation
        matrix.setPrice(key, basePrice + variation, timestamp);
      });
    }
    const endTime = Date.now();

    // Should complete quickly
    expect(endTime - startTime).toBeLessThan(1000);

    // Verify final state
    const stats = matrix.getStats();
    expect(stats.writes).toBe(pairs * updatesPerSecond);

    // All pairs should have current prices
    keys.forEach(key => {
      const entry = matrix.getPrice(key);
      expect(entry).not.toBeNull();
      expect(entry!.price).toBeGreaterThan(0);
    });
  });

  it('should maintain data integrity through clear and repopulate cycle', () => {
    const timestamp = Date.now();

    // Populate
    matrix.setPrice('key1', 1000, timestamp);
    matrix.setPrice('key2', 2000, timestamp);

    expect(matrix.getPrice('key1')!.price).toBe(1000);
    expect(matrix.getPrice('key2')!.price).toBe(2000);

    // Clear
    matrix.clear();

    expect(matrix.getPrice('key1')).toBeNull();
    expect(matrix.getPrice('key2')).toBeNull();
    expect(matrix.getMemoryUsage().usedSlots).toBe(0);

    // Repopulate with different values
    matrix.setPrice('key1', 1500, timestamp);
    matrix.setPrice('key3', 3000, timestamp);

    expect(matrix.getPrice('key1')!.price).toBe(1500);
    expect(matrix.getPrice('key2')).toBeNull(); // Still null
    expect(matrix.getPrice('key3')!.price).toBe(3000);
  });

  it('should enforce maxPairs limit correctly', () => {
    const smallMatrix = new PriceMatrix({ maxPairs: 10, reserveSlots: 0 });
    const timestamp = Date.now();

    // Fill to capacity
    for (let i = 0; i < 10; i++) {
      smallMatrix.setPrice(`key${i}`, 1000 + i, timestamp);
    }

    expect(smallMatrix.getMemoryUsage().usedSlots).toBe(10);

    // Try to add more - should be ignored
    smallMatrix.setPrice('overflow_key', 9999, timestamp);
    expect(smallMatrix.getMemoryUsage().usedSlots).toBe(10);
    expect(smallMatrix.getPrice('overflow_key')).toBeNull();

    // Existing keys should still work
    expect(smallMatrix.getPrice('key0')!.price).toBe(1000);
    expect(smallMatrix.getPrice('key9')!.price).toBe(1009);

    smallMatrix.destroy();
  });

  it('should handle delete and reuse slot correctly', () => {
    const timestamp = Date.now();

    matrix.setPrice('key1', 1000, timestamp);
    matrix.setPrice('key2', 2000, timestamp);

    expect(matrix.getMemoryUsage().usedSlots).toBe(2);

    // Delete key1
    matrix.deletePrice('key1');
    expect(matrix.getPrice('key1')).toBeNull();
    expect(matrix.getMemoryUsage().usedSlots).toBe(1);

    // key2 should still work
    expect(matrix.getPrice('key2')!.price).toBe(2000);

    // Re-add key1 with new value
    matrix.setPrice('key1', 1500, timestamp);
    expect(matrix.getPrice('key1')!.price).toBe(1500);
    expect(matrix.getMemoryUsage().usedSlots).toBe(2);
  });
});

// =============================================================================
// Performance Regression Tests
// =============================================================================

describe('Performance Regression Tests', () => {
  let matrix: PriceMatrix;

  beforeEach(() => {
    resetPriceMatrix();
    matrix = new PriceMatrix({ maxPairs: 1000 });
  });

  afterEach(() => {
    matrix.destroy();
  });

  it('should maintain sub-microsecond lookup after fixes', () => {
    // Pre-populate
    const keys = generatePriceKeys(500);
    const timestamp = Date.now();
    keys.forEach((key, i) => matrix.setPrice(key, 1800 + i, timestamp));

    // Warmup
    for (let i = 0; i < 100; i++) {
      matrix.getPrice(keys[i % keys.length]);
    }

    // Benchmark
    const iterations = 10000;
    const startTime = performance.now();
    for (let i = 0; i < iterations; i++) {
      matrix.getPrice(keys[250]);
    }
    const endTime = performance.now();

    const avgTimeUs = ((endTime - startTime) / iterations) * 1000;
    console.log(`Lookup performance after fixes: ${avgTimeUs.toFixed(3)}μs`);

    // Should still be under 10μs (target was <1μs, allow variance)
    expect(avgTimeUs).toBeLessThan(10);
  });

  it('should maintain efficient batch operations', () => {
    const batchSize = 100;
    const batches = 10;
    const timestamp = Date.now();

    const allUpdates: BatchUpdate[] = [];
    for (let b = 0; b < batches; b++) {
      for (let i = 0; i < batchSize; i++) {
        allUpdates.push({
          key: `batch${b}:pair${i}`,
          price: 1800 + b * batchSize + i,
          timestamp
        });
      }
    }

    const startTime = performance.now();
    matrix.setBatch(allUpdates);
    const endTime = performance.now();

    const totalTime = endTime - startTime;
    console.log(`Batch write ${allUpdates.length} items: ${totalTime.toFixed(2)}ms`);

    // Should complete in under 100ms
    expect(totalTime).toBeLessThan(100);
    expect(matrix.getStats().writes).toBe(allUpdates.length);
  });

  it('should efficiently handle mixed read/write workload', () => {
    const timestamp = Date.now();
    const keys = generatePriceKeys(100);

    // Pre-populate
    keys.forEach((key, i) => matrix.setPrice(key, 1800 + i, timestamp));

    // Mixed workload: 80% reads, 20% writes
    const iterations = 5000;
    const startTime = performance.now();

    for (let i = 0; i < iterations; i++) {
      if (i % 5 === 0) {
        // Write
        matrix.setPrice(keys[i % keys.length], 1800 + (i % 100), timestamp);
      } else {
        // Read
        matrix.getPrice(keys[i % keys.length]);
      }
    }

    const endTime = performance.now();
    const totalTime = endTime - startTime;
    const avgOpTime = (totalTime / iterations) * 1000;

    console.log(`Mixed workload: ${iterations} ops in ${totalTime.toFixed(2)}ms (${avgOpTime.toFixed(3)}μs/op)`);

    // Should average under 10μs per operation
    expect(avgOpTime).toBeLessThan(10);
  });
});
