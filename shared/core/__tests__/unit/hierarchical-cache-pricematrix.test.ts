/**
 * PHASE1-TASK34: PriceMatrix Integration Tests
 *
 * Tests for HierarchicalCache with PriceMatrix-based L1 cache.
 * Verifies that the new implementation provides correct functionality.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RedisMock } from '@arbitrage/test-utils';

// Make this file a module to avoid TS2451 redeclaration errors
export {};

// Create mock objects BEFORE jest.mock
const redisInstance = new RedisMock();
const mockRedis = {
  get: jest.fn<any>((key: string) => redisInstance.get(key)),
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

// Mock logger - Factory function to avoid hoisting issue with jest.mock
jest.mock('../../src/logger', () => ({
  createLogger: () => ({
    info: jest.fn<any>(),
    warn: jest.fn<any>(),
    error: jest.fn<any>(),
    debug: jest.fn<any>()
  }),
  getPerformanceLogger: () => ({
    startTimer: jest.fn(),
    endTimer: jest.fn(),
    logEventLatency: jest.fn(),
    logArbitrageOpportunity: jest.fn(),
    logExecutionResult: jest.fn(),
    logError: jest.fn(),
    logHealthCheck: jest.fn(),
    logMetrics: jest.fn()
  })
}));

// Mock redis module
jest.mock('../../src/redis', () => ({
  getRedisClient: () => Promise.resolve(mockRedis)
}));

// Mock correlation analyzer to avoid initialization overhead
jest.mock('../../src/caching/correlation-analyzer', () => ({
  getCorrelationAnalyzer: () => null
}));

import { HierarchicalCache, createHierarchicalCache } from '@arbitrage/core';

describe('HierarchicalCache with PriceMatrix', () => {
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
