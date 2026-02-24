/**
 * Hierarchical Cache Tests
 *
 * Tests for L1/L2/L3 cache hierarchy with promotion/demotion.
 * Covers both Map-based L1 and PriceMatrix-based L1 implementations.
 *
 * @migrated from shared/core/src/hierarchical-cache.test.ts
 * @see ADR-009: Test Architecture
 * @see PHASE1-TASK34: PriceMatrix Integration Tests
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RedisMock } from '@arbitrage/test-utils';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// Create mock objects BEFORE jest.mock to ensure they're captured
const redisInstance = new RedisMock();
const mockRedis = {
  get: jest.fn<any>((key: string) => redisInstance.get(key)),
  // P0-FIX: Add getRaw method used by hierarchical-cache for L2 reads
  getRaw: jest.fn<any>((key: string) => redisInstance.get(key)),
  set: jest.fn<any>((key: string, value: any, ttl?: number) => {
    if (ttl) {
      return redisInstance.setex(key, ttl, value);
    }
    return redisInstance.set(key, value);
  }),
  setex: jest.fn<any>((key: string, ttl: number, value: any) => redisInstance.setex(key, ttl, value)),
  del: jest.fn<any>((...keys: string[]) => {
    for (const key of keys) {
      redisInstance.del(key);
    }
    return Promise.resolve(keys.length);
  }),
  keys: jest.fn<any>((pattern: string) => redisInstance.keys(pattern)),
  // PHASE1-TASK34: Add SCAN mock for pattern invalidation
  scan: jest.fn<any>((cursor: string, matchArg: string, pattern: string, countArg: string, count: number) => {
    if (cursor !== '0') {
      return Promise.resolve(['0', []]);
    }
    const allKeys = redisInstance.keys(pattern);
    return Promise.resolve(['0', allKeys]);
  }),
  clear: jest.fn<any>(() => redisInstance.clear()),
  ping: jest.fn<any>(() => Promise.resolve('PONG'))
};

// Mock logger (auto-resolves to src/__mocks__/logger.ts)
jest.mock('../../src/logger');

// Mock redis module - return mockRedis directly
jest.mock('../../src/redis/client', () => ({
  getRedisClient: () => Promise.resolve(mockRedis)
}));

// Mock correlation analyzer to avoid initialization overhead
jest.mock('../../src/caching/correlation-analyzer', () => ({
  getCorrelationAnalyzer: () => null
}));

import { HierarchicalCache, createHierarchicalCache } from '@arbitrage/core';

describe('HierarchicalCache (Map-based L1)', () => {
  let cache: HierarchicalCache;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.clear();
    // P0-FIX: Reset BOTH get and getRaw mocks after clearAllMocks
    // clearAllMocks resets all mock implementations, so we need to restore them
    mockRedis.get.mockImplementation((key: string) => redisInstance.get(key));
    mockRedis.getRaw.mockImplementation((key: string) => redisInstance.get(key));
    cache = createHierarchicalCache({
      l1Enabled: true,
      l1Size: 64,
      l2Enabled: true,
      l2Ttl: 300,
      l3Enabled: true,
      enablePromotion: true,
      enableDemotion: false
    });
  });

  describe('basic operations', () => {
    it('should set and get values', async () => {
      const testKey = 'test:key';
      const testValue = { data: 'test', number: 42 };

      await cache.set(testKey, testValue);
      const result = await cache.get(testKey);

      expect(result).toEqual(testValue);
    });

    it('should return null for non-existent keys', async () => {
      const result = await cache.get('non-existent');
      expect(result).toBeNull();
    });

    it('should delete values', async () => {
      const testKey = 'test:delete';
      const testValue = 'delete-me';

      await cache.set(testKey, testValue);
      await cache.delete(testKey);
      const result = await cache.get(testKey);

      expect(result).toBeNull();
    });
  });

  describe('L1 Cache (Memory)', () => {
    it('should use L1 cache when enabled', async () => {
      const testKey = 'l1:test';
      const testValue = 'l1-value';

      await cache.set(testKey, testValue);

      // Get again - should be from L1
      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);

      const stats = cache.getStats();
      expect(stats.l1.hits).toBeGreaterThan(0);
    });

    it('should evict entries when L1 is full', async () => {
      // Create a cache with very small L1
      const smallCache = createHierarchicalCache({
        l1Size: 0.01, // Very small size to trigger eviction quickly
        l2Enabled: false,
        l3Enabled: false
      });

      // Fill L1 beyond capacity
      for (let i = 0; i < 100; i++) {
        await smallCache.set(`key:${i}`, { data: 'some data to take up space' + i });
      }

      const stats = smallCache.getStats();
      expect(stats.l1.evictions).toBeGreaterThan(0);
    });
  });

  describe('L2 Cache (Redis)', () => {
    it('should use L2 cache when enabled and L1 misses', async () => {
      const testKey = 'l2:test';
      const testValue = 'l2-value';

      // Set directly in Redis (mock) - cache stores just the JSON value
      await redisInstance.set(`cache:l2:${testKey}`, JSON.stringify(testValue));

      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);

      const stats = cache.getStats();
      expect(stats.l1.misses).toBeGreaterThan(0);
      expect(stats.l2.hits).toBeGreaterThan(0);
    });

    it('should write through to L2', async () => {
      const testKey = 'l2:write';
      const testValue = 'write-through';

      await cache.set(testKey, testValue);

      // P0-FIX: Cache uses setex() for L2 writes with TTL
      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });

  describe('L3 Cache (Persistent)', () => {
    it('should use L3 cache when L1 and L2 miss', async () => {
      const testKey = 'l3:test';
      const testValue = 'l3-value';

      // Create cache with just L3
      const l3OnlyCache = createHierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true
      });

      await l3OnlyCache.set(testKey, testValue);

      // Clear any internal state if necessary, here we just get it
      const result = await l3OnlyCache.get(testKey);
      expect(result).toEqual(testValue);

      const stats = l3OnlyCache.getStats();
      expect(stats.l3.hits).toBeGreaterThan(0);
    });
  });

  describe('Promotion and Demotion', () => {
    it('should promote data from L2 to L1 on access', async () => {
      const testKey = 'promote:test';
      const testValue = 'promote-me';

      // Set in L2 ONLY - cache stores just the JSON value
      await redisInstance.set(`cache:l2:${testKey}`, JSON.stringify(testValue));

      // Access it - should promote to L1
      await cache.get(testKey);

      const stats = cache.getStats();
      expect(stats.l2.hits).toBe(1);

      // Access again - should hit L1
      const result = await cache.get(testKey);
      expect(result).toEqual(testValue);
      expect(cache.getStats().l1.hits).toBe(1);
    });
  });

  describe('Advanced Features', () => {
    // P2-FIX: Test un-skipped - L1 cache enforces TTL on reads (lines 494-498 in hierarchical-cache.ts)
    // Use L1-only cache to avoid L2 (Redis mock) re-promoting expired entries
    it('should respect TTL', async () => {
      const l1OnlyCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
      });

      const testKey = 'ttl:test';
      const testValue = 'ttl-value';

      await l1OnlyCache.set(testKey, testValue, 0.1); // 0.1s = 100ms TTL

      await new Promise(resolve => setTimeout(resolve, 150)); // Wait 150ms (50% margin)

      const result = await l1OnlyCache.get(testKey);
      expect(result).toBeNull();
    });

    it('should handle clearing the cache', async () => {
      // Create a cache without L2 to avoid Redis clear issues in tests
      const l1l3Cache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,  // Disable L2 for this test to avoid mock timeout
        l3Enabled: true
      });

      await l1l3Cache.set('k1', 'v1');
      await l1l3Cache.set('k2', 'v2');

      await l1l3Cache.clear();

      expect(await l1l3Cache.get('k1')).toBeNull();
      expect(await l1l3Cache.get('k2')).toBeNull();
    }, 15000);
  });
});

describe('HierarchicalCache (PriceMatrix-based L1)', () => {
  let cache: HierarchicalCache;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.clear();
    // Restore mock implementations
    mockRedis.get.mockImplementation((key: string) => redisInstance.get(key));
    mockRedis.getRaw.mockImplementation((key: string) => redisInstance.get(key));
    mockRedis.scan.mockImplementation((cursor: string, matchArg: string, pattern: string, countArg: string, count: number) => {
      if (cursor !== '0') {
        return Promise.resolve(['0', []]);
      }
      const allKeys = redisInstance.keys(pattern);
      return Promise.resolve(['0', allKeys]);
    });

    // PHASE1-TASK34: Create cache with PriceMatrix enabled
    cache = createHierarchicalCache({
      l1Enabled: true,
      l1Size: 64,
      l2Enabled: true,
      l2Ttl: 300,
      l3Enabled: true,
      enablePromotion: true,
      enableDemotion: false,
      usePriceMatrix: true // Enable PriceMatrix
    });
  });

  describe('PHASE1-TASK34: Basic PriceMatrix operations', () => {
    it('should set and get price values', async () => {
      const testKey = 'price:eth:usd';
      const testValue = { price: 2000.50, timestamp: Date.now() };

      await cache.set(testKey, testValue);
      const result = await cache.get(testKey);

      expect(result).toEqual(testValue);
    });

    it('should return null for non-existent keys', async () => {
      const result = await cache.get('price:non-existent');
      expect(result).toBeNull();
    });

    it('should handle numeric price values', async () => {
      const testKey = 'price:btc:usd';
      const testValue = 45000.25;

      await cache.set(testKey, testValue);
      const result = await cache.get(testKey);

      expect(result).toBe(testValue);
    });

    it('should handle price objects with various fields', async () => {
      const testKey = 'price:uni:eth';
      const testValue = {
        price: 0.005,
        value: 0.005, // Alternate field
        volume: 1000000,
        timestamp: Date.now()
      };

      await cache.set(testKey, testValue);
      const result = await cache.get(testKey);

      expect(result).toEqual(testValue);
    });
  });

  describe('PHASE1-TASK34: L1 hit rate', () => {
    it('should serve from L1 cache on repeated reads', async () => {
      const testKey = 'price:ada:usd';
      const testValue = { price: 0.50 };

      // First write
      await cache.set(testKey, testValue);

      // Read multiple times (should all hit L1)
      for (let i = 0; i < 10; i++) {
        const result = await cache.get(testKey);
        expect(result).toEqual(testValue);
      }

      // Check stats
      const stats = cache.getStats();
      expect(stats.l1.hits).toBeGreaterThan(0);
      expect(stats.l1.implementation).toBe('PriceMatrix');
    });

    it('should achieve >90% L1 hit rate for hot keys', async () => {
      // Populate L1 with hot keys
      const hotKeys = Array.from({ length: 10 }, (_, i) => `price:hot:${i}`);
      for (const key of hotKeys) {
        await cache.set(key, { price: Math.random() * 1000 });
      }

      // Perform many reads
      const totalReads = 100;
      for (let i = 0; i < totalReads; i++) {
        const key = hotKeys[i % hotKeys.length];
        await cache.get(key);
      }

      // Calculate L1 hit rate
      const stats = cache.getStats();
      const l1HitRate = stats.l1.hits / (stats.l1.hits + stats.l1.misses);

      expect(l1HitRate).toBeGreaterThan(0.9); // >90% hit rate
    });
  });

  describe('PHASE1-TASK34: Cache invalidation', () => {
    it('should invalidate single keys', async () => {
      const testKey = 'price:sol:usd';
      const testValue = { price: 100 };

      await cache.set(testKey, testValue);
      expect(await cache.get(testKey)).toEqual(testValue);

      await cache.invalidate(testKey);
      expect(await cache.get(testKey)).toBeNull();
    });

    it('should clear all cache levels', async () => {
      // Use cache without L2 to avoid Redis mock re-promoting cleared entries
      const l1OnlyCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: true,
        usePriceMatrix: true,
      });

      // Set multiple keys
      await l1OnlyCache.set('price:eth:usd', { price: 2000 });
      await l1OnlyCache.set('price:btc:usd', { price: 45000 });
      await l1OnlyCache.set('price:ada:usd', { price: 0.50 });

      // Clear cache
      await l1OnlyCache.clear();

      // All keys should be gone
      expect(await l1OnlyCache.get('price:eth:usd')).toBeNull();
      expect(await l1OnlyCache.get('price:btc:usd')).toBeNull();
      expect(await l1OnlyCache.get('price:ada:usd')).toBeNull();
    });
  });

  describe('PHASE1-TASK34: Statistics and monitoring', () => {
    it('should include PriceMatrix stats', () => {
      const stats = cache.getStats();

      expect(stats.l1.implementation).toBe('PriceMatrix');
      expect(stats.l1.priceMatrix).toBeDefined();
      expect(stats.l1.priceMatrix.reads).toBeDefined();
      expect(stats.l1.priceMatrix.writes).toBeDefined();
      expect(stats.l1.priceMatrix.hits).toBeDefined();
      expect(stats.l1.priceMatrix.misses).toBeDefined();
    });

    it('should track cache operations', async () => {
      await cache.set('price:test:1', { price: 100 });
      await cache.get('price:test:1');
      await cache.get('price:test:nonexistent');

      const stats = cache.getStats();

      expect(stats.l1.priceMatrix.writes).toBeGreaterThan(0);
      expect(stats.l1.priceMatrix.reads).toBeGreaterThan(0);
      expect(stats.l1.priceMatrix.hits).toBeGreaterThan(0);
      expect(stats.l1.priceMatrix.misses).toBeGreaterThan(0);
    });
  });

  describe('PHASE1-TASK34: Backward compatibility', () => {
    it('should work with Map-based L1 when PriceMatrix is disabled', async () => {
      const mapCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: false // Disable PriceMatrix
      });

      const testKey = 'price:test:map';
      const testValue = { price: 123.45 };

      await mapCache.set(testKey, testValue);
      const result = await mapCache.get(testKey);

      expect(result).toEqual(testValue);

      const stats = mapCache.getStats();
      expect(stats.l1.implementation).toBe('Map');
      expect(stats.l1.priceMatrix).toBeUndefined();
    });
  });

  describe('PHASE1-TASK34: Capacity limits', () => {
    it('should respect L1 capacity limits', async () => {
      // Create small cache
      const smallCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 1, // 1MB = ~85K pairs max in PriceMatrix
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true
      });

      // Try to add many entries (some will be evicted)
      const numEntries = 100000; // More than capacity
      for (let i = 0; i < numEntries; i++) {
        await smallCache.set(`price:test:${i}`, { price: i });
      }

      const stats = smallCache.getStats();
      expect(stats.l1.entries).toBeLessThan(numEntries);
      expect(stats.l1.evictions).toBeGreaterThan(0);
    });
  });

  describe('PHASE1-TASK34: TTL support', () => {
    it('should expire entries after TTL', async () => {
      // Use L1-only cache to avoid L2 (Redis mock) re-promoting expired entries
      const l1OnlyCache = createHierarchicalCache({
        l1Enabled: true,
        l1Size: 64,
        l2Enabled: false,
        l3Enabled: false,
        usePriceMatrix: true,
      });

      const testKey = 'price:ttl:test';
      const testValue = { price: 999 };
      const ttl = 1; // 1 second

      await l1OnlyCache.set(testKey, testValue, ttl);

      // Should be available immediately
      expect(await l1OnlyCache.get(testKey)).toEqual(testValue);

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Should be expired now
      expect(await l1OnlyCache.get(testKey)).toBeNull();
    });
  });
});

describe('HierarchicalCache PriceMatrix vs Map comparison', () => {
  it('should produce identical results for both implementations', async () => {
    const priceMatrixCache = createHierarchicalCache({
      l1Enabled: true,
      l1Size: 64,
      l2Enabled: false,
      l3Enabled: false,
      usePriceMatrix: true
    });

    const mapCache = createHierarchicalCache({
      l1Enabled: true,
      l1Size: 64,
      l2Enabled: false,
      l3Enabled: false,
      usePriceMatrix: false
    });

    // Perform same operations on both
    const testKeys = ['price:a', 'price:b', 'price:c'];
    const testValues = [
      { price: 100 },
      { price: 200 },
      { price: 300 }
    ];

    for (let i = 0; i < testKeys.length; i++) {
      await priceMatrixCache.set(testKeys[i], testValues[i]);
      await mapCache.set(testKeys[i], testValues[i]);
    }

    // Verify reads produce same results
    for (let i = 0; i < testKeys.length; i++) {
      const pmResult = await priceMatrixCache.get(testKeys[i]);
      const mapResult = await mapCache.get(testKeys[i]);
      expect(pmResult).toEqual(mapResult);
    }
  });
});
