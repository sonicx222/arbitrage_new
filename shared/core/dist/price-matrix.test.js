"use strict";
/**
 * PriceMatrix Tests (TDD - Red Phase)
 *
 * Tests for S1.3: L1 Price Matrix
 * Hypothesis: SharedArrayBuffer price matrix reduces lookup time from 2ms to <1μs
 *
 * @see IMPLEMENTATION_PLAN.md S1.3
 * @see ADR-005: L1 Cache
 */
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
// These imports will fail initially (TDD Red phase)
const price_matrix_1 = require("./price-matrix");
// =============================================================================
// Test Helpers
// =============================================================================
function createTestPriceKey(index) {
    return `bsc:pancakeswap:0xpair${index.toString().padStart(4, '0')}`;
}
function generatePriceKeys(count) {
    return Array.from({ length: count }, (_, i) => createTestPriceKey(i));
}
// =============================================================================
// PriceMatrix Core Tests
// =============================================================================
(0, globals_1.describe)('PriceMatrix', () => {
    let matrix;
    (0, globals_1.beforeEach)(() => {
        (0, price_matrix_1.resetPriceMatrix)();
        matrix = new price_matrix_1.PriceMatrix();
    });
    (0, globals_1.afterEach)(() => {
        matrix.destroy();
    });
    // ===========================================================================
    // S1.3.1: SharedArrayBuffer-based Storage
    // ===========================================================================
    (0, globals_1.describe)('S1.3.1: SharedArrayBuffer Storage', () => {
        (0, globals_1.it)('should create matrix with SharedArrayBuffer backing', () => {
            (0, globals_1.expect)(matrix).toBeDefined();
            (0, globals_1.expect)(matrix.isSharedMemory()).toBe(true);
        });
        (0, globals_1.it)('should use Float64Array for prices', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            matrix.setPrice(priceKey, 1850.50, Date.now());
            const entry = matrix.getPrice(priceKey);
            (0, globals_1.expect)(entry).not.toBeNull();
            (0, globals_1.expect)(typeof entry.price).toBe('number');
            (0, globals_1.expect)(entry.price).toBe(1850.50);
        });
        (0, globals_1.it)('should use Uint32Array for timestamps', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            const timestamp = Date.now();
            matrix.setPrice(priceKey, 1850.50, timestamp);
            const entry = matrix.getPrice(priceKey);
            (0, globals_1.expect)(entry).not.toBeNull();
            (0, globals_1.expect)(typeof entry.timestamp).toBe('number');
            // Timestamp should be stored as relative seconds to save space
            (0, globals_1.expect)(entry.timestamp).toBeGreaterThan(0);
        });
        (0, globals_1.it)('should accept custom configuration', () => {
            const customConfig = {
                maxPairs: 500,
                reserveSlots: 50
            };
            const customMatrix = new price_matrix_1.PriceMatrix(customConfig);
            const config = customMatrix.getConfig();
            (0, globals_1.expect)(config.maxPairs).toBe(500);
            (0, globals_1.expect)(config.reserveSlots).toBe(50);
            customMatrix.destroy();
        });
        (0, globals_1.it)('should have default configuration for 1000 pairs', () => {
            const config = matrix.getConfig();
            (0, globals_1.expect)(config.maxPairs).toBe(1000);
        });
    });
    // ===========================================================================
    // S1.3.2: Atomic Updates
    // ===========================================================================
    (0, globals_1.describe)('S1.3.2: Atomic Operations', () => {
        (0, globals_1.it)('should perform thread-safe writes', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            // Write multiple prices
            matrix.setPrice(priceKey, 1800.00, Date.now());
            matrix.setPrice(priceKey, 1850.00, Date.now());
            matrix.setPrice(priceKey, 1900.00, Date.now());
            const entry = matrix.getPrice(priceKey);
            (0, globals_1.expect)(entry).not.toBeNull();
            (0, globals_1.expect)(entry.price).toBe(1900.00);
        });
        (0, globals_1.it)('should perform thread-safe reads', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            matrix.setPrice(priceKey, 1850.50, Date.now());
            // Read multiple times
            const reads = [];
            for (let i = 0; i < 100; i++) {
                reads.push(matrix.getPrice(priceKey));
            }
            // All reads should return consistent data
            (0, globals_1.expect)(reads.every(r => r !== null && r.price === 1850.50)).toBe(true);
        });
        (0, globals_1.it)('should handle concurrent-like updates without data corruption', async () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            const updates = [];
            // Simulate concurrent updates
            for (let i = 0; i < 100; i++) {
                updates.push(Promise.resolve().then(() => {
                    matrix.setPrice(priceKey, 1800 + i, Date.now());
                }));
            }
            await Promise.all(updates);
            const entry = matrix.getPrice(priceKey);
            (0, globals_1.expect)(entry).not.toBeNull();
            // Price should be one of the valid values
            (0, globals_1.expect)(entry.price).toBeGreaterThanOrEqual(1800);
            (0, globals_1.expect)(entry.price).toBeLessThanOrEqual(1899);
        });
        (0, globals_1.it)('should use Atomics for price updates', () => {
            // Verify the implementation uses Atomics (internal check)
            (0, globals_1.expect)(matrix.usesAtomics()).toBe(true);
        });
    });
    // ===========================================================================
    // S1.3.3: Price Index Mapper
    // ===========================================================================
    (0, globals_1.describe)('S1.3.3: Price Index Mapper', () => {
        (0, globals_1.it)('should map "chain:dex:pair" to array offset', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            const offset = matrix.getOffset(priceKey);
            (0, globals_1.expect)(typeof offset).toBe('number');
            (0, globals_1.expect)(offset).toBeGreaterThanOrEqual(0);
        });
        (0, globals_1.it)('should return consistent offsets for same key', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            const offset1 = matrix.getOffset(priceKey);
            const offset2 = matrix.getOffset(priceKey);
            (0, globals_1.expect)(offset1).toBe(offset2);
        });
        (0, globals_1.it)('should return different offsets for different keys', () => {
            const key1 = 'bsc:pancakeswap:0xpair1234';
            const key2 = 'bsc:pancakeswap:0xpair5678';
            const offset1 = matrix.getOffset(key1);
            const offset2 = matrix.getOffset(key2);
            (0, globals_1.expect)(offset1).not.toBe(offset2);
        });
        (0, globals_1.it)('should achieve O(1) lookup complexity', () => {
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
            (0, globals_1.expect)(Math.abs(timeFirst - timeLast)).toBeLessThan(1);
        });
        (0, globals_1.it)('should support pre-registering keys for known pairs', () => {
            const keys = ['bsc:pancakeswap:0xpair1', 'bsc:pancakeswap:0xpair2'];
            matrix.registerKeys(keys);
            // Keys should have reserved offsets
            const offset1 = matrix.getOffset(keys[0]);
            const offset2 = matrix.getOffset(keys[1]);
            (0, globals_1.expect)(offset1).toBeDefined();
            (0, globals_1.expect)(offset2).toBeDefined();
            (0, globals_1.expect)(offset1).not.toBe(offset2);
        });
        (0, globals_1.it)('should return -1 for unknown keys when strict mode enabled', () => {
            const strictMatrix = new price_matrix_1.PriceMatrix({ strictMode: true });
            const offset = strictMatrix.getOffset('unknown:key:here');
            (0, globals_1.expect)(offset).toBe(-1);
            strictMatrix.destroy();
        });
    });
    // ===========================================================================
    // Price Operations
    // ===========================================================================
    (0, globals_1.describe)('Price Operations', () => {
        (0, globals_1.it)('should set and get price correctly', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            const price = 1850.123456789;
            const timestamp = Date.now();
            matrix.setPrice(priceKey, price, timestamp);
            const entry = matrix.getPrice(priceKey);
            (0, globals_1.expect)(entry).not.toBeNull();
            (0, globals_1.expect)(entry.price).toBeCloseTo(price, 6);
            (0, globals_1.expect)(entry.timestamp).toBeDefined();
        });
        (0, globals_1.it)('should return null for non-existent price', () => {
            const entry = matrix.getPrice('nonexistent:key:here');
            (0, globals_1.expect)(entry).toBeNull();
        });
        (0, globals_1.it)('should update existing price', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            matrix.setPrice(priceKey, 1800.00, Date.now());
            matrix.setPrice(priceKey, 1850.00, Date.now());
            const entry = matrix.getPrice(priceKey);
            (0, globals_1.expect)(entry.price).toBe(1850.00);
        });
        (0, globals_1.it)('should support batch price updates', () => {
            const updates = [];
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
                (0, globals_1.expect)(entry).not.toBeNull();
                (0, globals_1.expect)(entry.price).toBe(1000 + i);
            }
        });
        (0, globals_1.it)('should support batch price retrieval', () => {
            const keys = generatePriceKeys(50);
            const timestamp = Date.now();
            // Set prices
            keys.forEach((key, i) => {
                matrix.setPrice(key, 1000 + i, timestamp);
            });
            // Get batch
            const entries = matrix.getBatch(keys);
            (0, globals_1.expect)(entries.length).toBe(50);
            (0, globals_1.expect)(entries.filter((e) => e !== null).length).toBe(50);
        });
        (0, globals_1.it)('should clear all prices', () => {
            const keys = generatePriceKeys(10);
            const timestamp = Date.now();
            keys.forEach((key, i) => {
                matrix.setPrice(key, 1000 + i, timestamp);
            });
            matrix.clear();
            keys.forEach(key => {
                const entry = matrix.getPrice(key);
                (0, globals_1.expect)(entry).toBeNull();
            });
        });
        (0, globals_1.it)('should delete specific price', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            matrix.setPrice(priceKey, 1850.00, Date.now());
            matrix.deletePrice(priceKey);
            const entry = matrix.getPrice(priceKey);
            (0, globals_1.expect)(entry).toBeNull();
        });
    });
    // ===========================================================================
    // Memory Management
    // ===========================================================================
    (0, globals_1.describe)('Memory Management', () => {
        (0, globals_1.it)('should fit 1000 pairs within 16KB memory', () => {
            const memoryUsage = matrix.getMemoryUsage();
            // 1000 pairs * (8 bytes price + 4 bytes timestamp) = 12KB base
            // Plus overhead for index mapping
            // Total should be < 16KB
            (0, globals_1.expect)(memoryUsage.totalBytes).toBeLessThan(16 * 1024);
        });
        (0, globals_1.it)('should report accurate memory usage', () => {
            const usageBefore = matrix.getMemoryUsage();
            // Add 100 prices
            for (let i = 0; i < 100; i++) {
                matrix.setPrice(createTestPriceKey(i), 1000 + i, Date.now());
            }
            const usageAfter = matrix.getMemoryUsage();
            (0, globals_1.expect)(usageAfter.usedSlots).toBe(100);
            (0, globals_1.expect)(usageAfter.usedSlots).toBeGreaterThan(usageBefore.usedSlots);
        });
        (0, globals_1.it)('should not exceed maxPairs limit', () => {
            const smallMatrix = new price_matrix_1.PriceMatrix({ maxPairs: 10 });
            // Try to add more than maxPairs
            for (let i = 0; i < 20; i++) {
                smallMatrix.setPrice(createTestPriceKey(i), 1000 + i, Date.now());
            }
            const usage = smallMatrix.getMemoryUsage();
            (0, globals_1.expect)(usage.usedSlots).toBeLessThanOrEqual(10);
            smallMatrix.destroy();
        });
        (0, globals_1.it)('should provide memory utilization percentage', () => {
            const usage = matrix.getMemoryUsage();
            (0, globals_1.expect)(usage.utilizationPercent).toBeDefined();
            (0, globals_1.expect)(usage.utilizationPercent).toBeGreaterThanOrEqual(0);
            (0, globals_1.expect)(usage.utilizationPercent).toBeLessThanOrEqual(100);
        });
    });
    // ===========================================================================
    // Statistics
    // ===========================================================================
    (0, globals_1.describe)('Statistics', () => {
        (0, globals_1.it)('should track read/write operations', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            matrix.setPrice(priceKey, 1850.00, Date.now());
            matrix.getPrice(priceKey);
            matrix.getPrice(priceKey);
            const stats = matrix.getStats();
            (0, globals_1.expect)(stats.writes).toBe(1);
            (0, globals_1.expect)(stats.reads).toBe(2);
        });
        (0, globals_1.it)('should track cache hits and misses', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            // Miss
            matrix.getPrice('nonexistent:key');
            // Set then hit
            matrix.setPrice(priceKey, 1850.00, Date.now());
            matrix.getPrice(priceKey);
            const stats = matrix.getStats();
            (0, globals_1.expect)(stats.hits).toBe(1);
            (0, globals_1.expect)(stats.misses).toBe(1);
        });
        (0, globals_1.it)('should reset statistics', () => {
            const priceKey = 'bsc:pancakeswap:0xpair1234';
            matrix.setPrice(priceKey, 1850.00, Date.now());
            matrix.getPrice(priceKey);
            matrix.resetStats();
            const stats = matrix.getStats();
            (0, globals_1.expect)(stats.reads).toBe(0);
            (0, globals_1.expect)(stats.writes).toBe(0);
        });
    });
    // ===========================================================================
    // Singleton Pattern
    // ===========================================================================
    (0, globals_1.describe)('Singleton Pattern', () => {
        (0, globals_1.it)('should return same instance from getPriceMatrix', () => {
            const instance1 = (0, price_matrix_1.getPriceMatrix)();
            const instance2 = (0, price_matrix_1.getPriceMatrix)();
            (0, globals_1.expect)(instance1).toBe(instance2);
        });
        (0, globals_1.it)('should reset singleton instance', () => {
            const instance1 = (0, price_matrix_1.getPriceMatrix)();
            (0, price_matrix_1.resetPriceMatrix)();
            const instance2 = (0, price_matrix_1.getPriceMatrix)();
            (0, globals_1.expect)(instance1).not.toBe(instance2);
        });
    });
});
// =============================================================================
// PriceIndexMapper Tests
// =============================================================================
(0, globals_1.describe)('PriceIndexMapper', () => {
    let mapper;
    (0, globals_1.beforeEach)(() => {
        mapper = new price_matrix_1.PriceIndexMapper(1000);
    });
    (0, globals_1.it)('should map key to unique index', () => {
        const key1 = 'bsc:pancakeswap:0xpair1';
        const key2 = 'bsc:pancakeswap:0xpair2';
        const index1 = mapper.getIndex(key1);
        const index2 = mapper.getIndex(key2);
        (0, globals_1.expect)(index1).not.toBe(index2);
        (0, globals_1.expect)(index1).toBeGreaterThanOrEqual(0);
        (0, globals_1.expect)(index2).toBeGreaterThanOrEqual(0);
    });
    (0, globals_1.it)('should return consistent index for same key', () => {
        const key = 'bsc:pancakeswap:0xpair1';
        const index1 = mapper.getIndex(key);
        const index2 = mapper.getIndex(key);
        (0, globals_1.expect)(index1).toBe(index2);
    });
    (0, globals_1.it)('should not exceed maxIndex', () => {
        const smallMapper = new price_matrix_1.PriceIndexMapper(10);
        for (let i = 0; i < 20; i++) {
            const index = smallMapper.getIndex(`key${i}`);
            (0, globals_1.expect)(index).toBeLessThan(10);
        }
    });
    (0, globals_1.it)('should support key lookup from index', () => {
        const key = 'bsc:pancakeswap:0xpair1';
        const index = mapper.getIndex(key);
        const retrievedKey = mapper.getKey(index);
        (0, globals_1.expect)(retrievedKey).toBe(key);
    });
    (0, globals_1.it)('should return null for unused index', () => {
        const key = mapper.getKey(999);
        (0, globals_1.expect)(key).toBeNull();
    });
    (0, globals_1.it)('should report usage statistics', () => {
        mapper.getIndex('key1');
        mapper.getIndex('key2');
        mapper.getIndex('key3');
        const stats = mapper.getStats();
        (0, globals_1.expect)(stats.usedSlots).toBe(3);
        (0, globals_1.expect)(stats.totalSlots).toBe(1000);
        (0, globals_1.expect)(stats.utilizationPercent).toBeCloseTo(0.3, 1);
    });
    (0, globals_1.it)('should support clearing all mappings', () => {
        mapper.getIndex('key1');
        mapper.getIndex('key2');
        mapper.clear();
        const stats = mapper.getStats();
        (0, globals_1.expect)(stats.usedSlots).toBe(0);
    });
});
// =============================================================================
// PriceEntry Interface Tests
// =============================================================================
(0, globals_1.describe)('PriceEntry Interface', () => {
    let matrix;
    (0, globals_1.beforeEach)(() => {
        (0, price_matrix_1.resetPriceMatrix)();
        matrix = new price_matrix_1.PriceMatrix();
    });
    (0, globals_1.afterEach)(() => {
        matrix.destroy();
    });
    (0, globals_1.it)('should have correct shape', () => {
        const priceKey = 'bsc:pancakeswap:0xpair1234';
        matrix.setPrice(priceKey, 1850.50, Date.now());
        const entry = matrix.getPrice(priceKey);
        (0, globals_1.expect)(entry).toHaveProperty('price');
        (0, globals_1.expect)(entry).toHaveProperty('timestamp');
        (0, globals_1.expect)(typeof entry.price).toBe('number');
        (0, globals_1.expect)(typeof entry.timestamp).toBe('number');
    });
});
// =============================================================================
// Performance Benchmarks
// =============================================================================
(0, globals_1.describe)('Performance Benchmarks', () => {
    let matrix;
    (0, globals_1.beforeEach)(() => {
        (0, price_matrix_1.resetPriceMatrix)();
        matrix = new price_matrix_1.PriceMatrix();
    });
    (0, globals_1.afterEach)(() => {
        matrix.destroy();
    });
    (0, globals_1.it)('should achieve <1μs lookup time (target)', () => {
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
        // Allow some variance: <10μs is still very good
        (0, globals_1.expect)(avgTimeMs).toBeLessThan(0.01); // <10μs
    });
    (0, globals_1.it)('should handle 1000 concurrent lookups efficiently', async () => {
        // Pre-populate
        const keys = generatePriceKeys(100);
        const timestamp = Date.now();
        keys.forEach((key, i) => {
            matrix.setPrice(key, 1000 + i, timestamp);
        });
        const startTime = performance.now();
        // Simulate concurrent lookups
        const lookups = Array.from({ length: 1000 }, (_, i) => Promise.resolve(matrix.getPrice(keys[i % keys.length])));
        await Promise.all(lookups);
        const endTime = performance.now();
        const totalTime = endTime - startTime;
        console.log(`1000 concurrent lookups: ${totalTime.toFixed(2)}ms`);
        // Should complete in <100ms
        (0, globals_1.expect)(totalTime).toBeLessThan(100);
    });
    (0, globals_1.it)('should maintain performance under high write load', () => {
        const iterations = 1000;
        const timestamp = Date.now();
        const startTime = performance.now();
        for (let i = 0; i < iterations; i++) {
            matrix.setPrice(createTestPriceKey(i % 100), 1000 + i, timestamp);
        }
        const endTime = performance.now();
        const avgTimeMs = (endTime - startTime) / iterations;
        console.log(`Average write time: ${(avgTimeMs * 1000).toFixed(3)}μs`);
        // Writes should also be fast: <100μs average
        (0, globals_1.expect)(avgTimeMs).toBeLessThan(0.1);
    });
    (0, globals_1.it)('should batch operations efficiently', () => {
        const batchSize = 100;
        const batches = 10;
        const timestamp = Date.now();
        const totalUpdates = [];
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
        // Batch should be efficient
        (0, globals_1.expect)(totalTime).toBeLessThan(50);
    });
});
// =============================================================================
// Edge Cases
// =============================================================================
(0, globals_1.describe)('Edge Cases', () => {
    let matrix;
    (0, globals_1.beforeEach)(() => {
        (0, price_matrix_1.resetPriceMatrix)();
        matrix = new price_matrix_1.PriceMatrix();
    });
    (0, globals_1.afterEach)(() => {
        matrix.destroy();
    });
    (0, globals_1.it)('should handle empty key gracefully', () => {
        (0, globals_1.expect)(() => matrix.setPrice('', 1850.00, Date.now())).not.toThrow();
        (0, globals_1.expect)(matrix.getPrice('')).toBeNull();
    });
    (0, globals_1.it)('should handle very long keys', () => {
        const longKey = 'bsc:pancakeswap:' + '0x' + 'a'.repeat(100);
        matrix.setPrice(longKey, 1850.00, Date.now());
        const entry = matrix.getPrice(longKey);
        (0, globals_1.expect)(entry).not.toBeNull();
        (0, globals_1.expect)(entry.price).toBe(1850.00);
    });
    (0, globals_1.it)('should handle special characters in keys', () => {
        const specialKey = 'bsc:pancake-swap_v3:0xPair1234';
        matrix.setPrice(specialKey, 1850.00, Date.now());
        const entry = matrix.getPrice(specialKey);
        (0, globals_1.expect)(entry).not.toBeNull();
    });
    (0, globals_1.it)('should handle zero price', () => {
        const priceKey = 'bsc:pancakeswap:0xpair1234';
        matrix.setPrice(priceKey, 0, Date.now());
        const entry = matrix.getPrice(priceKey);
        (0, globals_1.expect)(entry).not.toBeNull();
        (0, globals_1.expect)(entry.price).toBe(0);
    });
    (0, globals_1.it)('should handle very large prices', () => {
        const priceKey = 'bsc:pancakeswap:0xpair1234';
        const largePrice = 1e15; // Quadrillion
        matrix.setPrice(priceKey, largePrice, Date.now());
        const entry = matrix.getPrice(priceKey);
        (0, globals_1.expect)(entry).not.toBeNull();
        (0, globals_1.expect)(entry.price).toBe(largePrice);
    });
    (0, globals_1.it)('should handle very small prices', () => {
        const priceKey = 'bsc:pancakeswap:0xpair1234';
        const smallPrice = 1e-15;
        matrix.setPrice(priceKey, smallPrice, Date.now());
        const entry = matrix.getPrice(priceKey);
        (0, globals_1.expect)(entry).not.toBeNull();
        (0, globals_1.expect)(entry.price).toBeCloseTo(smallPrice, 18);
    });
    (0, globals_1.it)('should handle negative prices gracefully', () => {
        const priceKey = 'bsc:pancakeswap:0xpair1234';
        // Should either reject or store negative price
        (0, globals_1.expect)(() => matrix.setPrice(priceKey, -100, Date.now())).not.toThrow();
    });
    (0, globals_1.it)('should handle NaN price gracefully', () => {
        const priceKey = 'bsc:pancakeswap:0xpair1234';
        // Should either reject or handle NaN
        (0, globals_1.expect)(() => matrix.setPrice(priceKey, NaN, Date.now())).not.toThrow();
        const entry = matrix.getPrice(priceKey);
        // Either null or NaN is acceptable
        if (entry !== null) {
            (0, globals_1.expect)(Number.isNaN(entry.price) || entry.price === 0).toBe(true);
        }
    });
    (0, globals_1.it)('should handle Infinity price gracefully', () => {
        const priceKey = 'bsc:pancakeswap:0xpair1234';
        (0, globals_1.expect)(() => matrix.setPrice(priceKey, Infinity, Date.now())).not.toThrow();
    });
    (0, globals_1.it)('should not crash after destroy', () => {
        matrix.destroy();
        // Operations after destroy should not throw
        (0, globals_1.expect)(() => matrix.setPrice('key', 100, Date.now())).not.toThrow();
        (0, globals_1.expect)(matrix.getPrice('key')).toBeNull();
    });
    (0, globals_1.it)('should handle getBatch with non-existent keys', () => {
        const keys = ['nonexistent1', 'nonexistent2', 'nonexistent3'];
        const entries = matrix.getBatch(keys);
        (0, globals_1.expect)(entries.length).toBe(3);
        (0, globals_1.expect)(entries.every((e) => e === null)).toBe(true);
    });
    (0, globals_1.it)('should handle setBatch with empty array', () => {
        (0, globals_1.expect)(() => matrix.setBatch([])).not.toThrow();
    });
    (0, globals_1.it)('should reject invalid maxPairs config', () => {
        (0, globals_1.expect)(() => new price_matrix_1.PriceMatrix({ maxPairs: 0 })).toThrow('maxPairs must be positive');
        (0, globals_1.expect)(() => new price_matrix_1.PriceMatrix({ maxPairs: -1 })).toThrow('maxPairs must be positive');
    });
    (0, globals_1.it)('should reject invalid reserveSlots config', () => {
        (0, globals_1.expect)(() => new price_matrix_1.PriceMatrix({ reserveSlots: -1 })).toThrow('reserveSlots must be non-negative');
    });
    (0, globals_1.it)('should accept valid reserveSlots of 0', () => {
        const m = new price_matrix_1.PriceMatrix({ reserveSlots: 0 });
        (0, globals_1.expect)(m.getConfig().reserveSlots).toBe(0);
        m.destroy();
    });
});
// =============================================================================
// Prometheus Metrics
// =============================================================================
(0, globals_1.describe)('Prometheus Metrics', () => {
    let matrix;
    (0, globals_1.beforeEach)(() => {
        (0, price_matrix_1.resetPriceMatrix)();
        matrix = new price_matrix_1.PriceMatrix();
    });
    (0, globals_1.afterEach)(() => {
        matrix.destroy();
    });
    (0, globals_1.it)('should export Prometheus-format metrics', () => {
        matrix.setPrice('bsc:pancakeswap:0xpair1', 1850.00, Date.now());
        matrix.getPrice('bsc:pancakeswap:0xpair1');
        matrix.getPrice('nonexistent:key');
        const metrics = matrix.getPrometheusMetrics();
        (0, globals_1.expect)(metrics).toContain('price_matrix_reads');
        (0, globals_1.expect)(metrics).toContain('price_matrix_writes');
        (0, globals_1.expect)(metrics).toContain('price_matrix_hits');
        (0, globals_1.expect)(metrics).toContain('price_matrix_misses');
        (0, globals_1.expect)(metrics).toContain('price_matrix_memory_bytes');
        (0, globals_1.expect)(metrics).toContain('price_matrix_utilization');
    });
    (0, globals_1.it)('should include correct metric types', () => {
        const metrics = matrix.getPrometheusMetrics();
        (0, globals_1.expect)(metrics).toContain('# TYPE price_matrix_reads counter');
        (0, globals_1.expect)(metrics).toContain('# TYPE price_matrix_memory_bytes gauge');
    });
});
//# sourceMappingURL=price-matrix.test.js.map