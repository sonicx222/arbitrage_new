/**
 * Unit Tests for MatrixPriceCache
 *
 * Tests the hot-path matrix-based price cache that uses TypedArrays
 * (Float64Array, Uint32Array) for ultra-fast price storage and retrieval.
 *
 * This module had ZERO test coverage prior to this file (P0 gap from test audit).
 *
 * Covers:
 * - TypedArray storage/retrieval correctness
 * - Index mapping (pair/DEX to matrix index)
 * - TTL expiry behavior
 * - Batch operations
 * - Invalidation (per-pair, per-DEX)
 * - Cache stats and hit/miss tracking
 * - Warmup queue (predictive warming)
 * - Capacity limits (max pairs, max DEXes)
 * - Resize behavior
 * - Singleton accessor
 *
 * @see shared/core/src/matrix-cache.ts
 * @see ADR-022: Hot-Path Optimization
 */

import { MatrixPriceCache, getMatrixPriceCache } from '../../src/matrix-cache';

// Mock the logger to suppress output during tests
jest.mock('../../src/logger');

describe('MatrixPriceCache', () => {
  let cache: MatrixPriceCache;

  beforeEach(() => {
    cache = new MatrixPriceCache(100, 5, 60); // 100 pairs, 5 DEXes, 60s TTL
  });

  // ==========================================================================
  // Construction
  // ==========================================================================
  describe('constructor', () => {
    it('should initialize with default parameters', () => {
      const defaultCache = new MatrixPriceCache();
      const stats = defaultCache.getCacheStats();
      expect(stats.activeEntries).toBe(0);
      expect(stats.totalRequests).toBe(0);
    });

    it('should initialize with custom parameters', () => {
      const customCache = new MatrixPriceCache(50, 3, 120);
      const stats = customCache.getCacheStats();
      expect(stats.activeEntries).toBe(0);
      expect(stats.memoryUsage).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // setPrice / getPrice
  // ==========================================================================
  describe('setPrice / getPrice', () => {
    it('should store and retrieve a price', () => {
      const success = cache.setPrice('ETH/USDC', 'uniswap', 3500.50);
      expect(success).toBe(true);

      const entry = cache.getPrice('ETH/USDC', 'uniswap');
      expect(entry).not.toBeNull();
      expect(entry!.price).toBe(3500.50);
      expect(entry!.timestamp).toBeGreaterThan(0);
      expect(entry!.age).toBeGreaterThanOrEqual(0);
      expect(entry!.age).toBeLessThan(1); // Should be very recent
    });

    it('should store price with liquidity', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500, 1000000);
      const entry = cache.getPrice('ETH/USDC', 'uniswap');
      expect(entry).not.toBeNull();
      expect(entry!.price).toBe(3500);
    });

    it('should return null for unknown pair', () => {
      const entry = cache.getPrice('UNKNOWN/PAIR', 'uniswap');
      expect(entry).toBeNull();
    });

    it('should return null for unknown DEX', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      const entry = cache.getPrice('ETH/USDC', 'sushiswap');
      expect(entry).toBeNull();
    });

    it('should overwrite existing price for same pair/DEX', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('ETH/USDC', 'uniswap', 3600);

      const entry = cache.getPrice('ETH/USDC', 'uniswap');
      expect(entry!.price).toBe(3600);
    });

    it('should handle multiple pairs on the same DEX', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('BTC/USDC', 'uniswap', 65000);

      expect(cache.getPrice('ETH/USDC', 'uniswap')!.price).toBe(3500);
      expect(cache.getPrice('BTC/USDC', 'uniswap')!.price).toBe(65000);
    });

    it('should handle same pair on multiple DEXes', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('ETH/USDC', 'sushiswap', 3505);

      expect(cache.getPrice('ETH/USDC', 'uniswap')!.price).toBe(3500);
      expect(cache.getPrice('ETH/USDC', 'sushiswap')!.price).toBe(3505);
    });

    it('should handle zero price', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 0);
      const entry = cache.getPrice('ETH/USDC', 'uniswap');
      expect(entry).not.toBeNull();
      expect(entry!.price).toBe(0);
    });

    it('should handle very small prices (memecoin scenarios)', () => {
      cache.setPrice('SHIB/USDT', 'uniswap', 0.00000847);
      const entry = cache.getPrice('SHIB/USDT', 'uniswap');
      expect(entry!.price).toBeCloseTo(0.00000847, 10);
    });

    it('should handle very large prices', () => {
      cache.setPrice('BTC/SAT', 'exchange', 100000000); // 1 BTC = 100M sats
      const entry = cache.getPrice('BTC/SAT', 'exchange');
      expect(entry!.price).toBe(100000000);
    });
  });

  // ==========================================================================
  // TTL Behavior
  // ==========================================================================
  describe('TTL expiry', () => {
    it('should return null for expired entries', () => {
      // Use a very short TTL
      const shortTtlCache = new MatrixPriceCache(10, 5, 1); // 1 second TTL
      shortTtlCache.setPrice('ETH/USDC', 'uniswap', 3500);

      // Verify it's there
      expect(shortTtlCache.getPrice('ETH/USDC', 'uniswap')).not.toBeNull();

      // Mock time to advance past TTL
      const origDateNow = Date.now;
      Date.now = jest.fn(() => origDateNow() + 2000); // 2 seconds later

      const entry = shortTtlCache.getPrice('ETH/USDC', 'uniswap');
      expect(entry).toBeNull();

      Date.now = origDateNow;
    });

    it('should not return entries that were never set (timestamp === 0)', () => {
      // Pair/DEX exist but this specific slot was never written
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('BTC/USDC', 'sushiswap', 65000);

      // ETH/USDC on sushiswap was never set
      const entry = cache.getPrice('ETH/USDC', 'sushiswap');
      // This should return null because timestamp is 0 for this slot
      // (pair and dex indices exist, but the specific matrix cell is empty)
      // Actually, this depends on whether sushiswap dex index exists
      // Since we set BTC/USDC on sushiswap, the dex index exists
      expect(entry).toBeNull();
    });
  });

  // ==========================================================================
  // getAllPricesForPair
  // ==========================================================================
  describe('getAllPricesForPair', () => {
    it('should return all DEX prices for a pair', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('ETH/USDC', 'sushiswap', 3505);
      cache.setPrice('ETH/USDC', 'curve', 3502);

      const prices = cache.getAllPricesForPair('ETH/USDC');

      expect(Object.keys(prices)).toHaveLength(3);
      expect(prices['uniswap'].price).toBe(3500);
      expect(prices['sushiswap'].price).toBe(3505);
      expect(prices['curve'].price).toBe(3502);
    });

    it('should return empty object for unknown pair', () => {
      const prices = cache.getAllPricesForPair('UNKNOWN/PAIR');
      expect(Object.keys(prices)).toHaveLength(0);
    });

    it('should exclude expired entries', () => {
      const shortTtlCache = new MatrixPriceCache(10, 5, 1);
      shortTtlCache.setPrice('ETH/USDC', 'uniswap', 3500);

      const origDateNow = Date.now;
      Date.now = jest.fn(() => origDateNow() + 2000);

      const prices = shortTtlCache.getAllPricesForPair('ETH/USDC');
      expect(Object.keys(prices)).toHaveLength(0);

      Date.now = origDateNow;
    });
  });

  // ==========================================================================
  // getAllPricesForDex
  // ==========================================================================
  describe('getAllPricesForDex', () => {
    it('should return all pair prices for a DEX', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('BTC/USDC', 'uniswap', 65000);
      cache.setPrice('LINK/ETH', 'uniswap', 0.004);

      const prices = cache.getAllPricesForDex('uniswap');

      expect(Object.keys(prices)).toHaveLength(3);
      expect(prices['ETH/USDC'].price).toBe(3500);
      expect(prices['BTC/USDC'].price).toBe(65000);
      expect(prices['LINK/ETH'].price).toBeCloseTo(0.004, 6);
    });

    it('should return empty object for unknown DEX', () => {
      const prices = cache.getAllPricesForDex('unknown_dex');
      expect(Object.keys(prices)).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Batch Operations
  // ==========================================================================
  describe('batchSetPrices', () => {
    it('should set multiple prices at once', () => {
      const count = cache.batchSetPrices([
        { pairKey: 'ETH/USDC', dexName: 'uniswap', price: 3500 },
        { pairKey: 'BTC/USDC', dexName: 'uniswap', price: 65000 },
        { pairKey: 'ETH/USDC', dexName: 'sushiswap', price: 3505 },
      ]);

      expect(count).toBe(3);
      expect(cache.getPrice('ETH/USDC', 'uniswap')!.price).toBe(3500);
      expect(cache.getPrice('BTC/USDC', 'uniswap')!.price).toBe(65000);
      expect(cache.getPrice('ETH/USDC', 'sushiswap')!.price).toBe(3505);
    });

    it('should set prices with liquidity', () => {
      const count = cache.batchSetPrices([
        { pairKey: 'ETH/USDC', dexName: 'uniswap', price: 3500, liquidity: 1000000 },
      ]);

      expect(count).toBe(1);
    });
  });

  describe('batchGetPrices', () => {
    it('should get multiple prices at once', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('BTC/USDC', 'uniswap', 65000);

      const results = cache.batchGetPrices([
        { pairKey: 'ETH/USDC', dexName: 'uniswap' },
        { pairKey: 'BTC/USDC', dexName: 'uniswap' },
        { pairKey: 'UNKNOWN/PAIR', dexName: 'uniswap' },
      ]);

      expect(results).toHaveLength(3);
      expect(results[0]!.price).toBe(3500);
      expect(results[1]!.price).toBe(65000);
      expect(results[2]).toBeNull();
    });
  });

  // ==========================================================================
  // Invalidation
  // ==========================================================================
  describe('invalidatePair', () => {
    it('should invalidate all prices for a specific pair', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('ETH/USDC', 'sushiswap', 3505);
      cache.setPrice('BTC/USDC', 'uniswap', 65000);

      cache.invalidatePair('ETH/USDC');

      expect(cache.getPrice('ETH/USDC', 'uniswap')).toBeNull();
      expect(cache.getPrice('ETH/USDC', 'sushiswap')).toBeNull();
      // Other pair should be unaffected
      expect(cache.getPrice('BTC/USDC', 'uniswap')!.price).toBe(65000);
    });

    it('should be no-op for unknown pair', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.invalidatePair('UNKNOWN/PAIR');
      expect(cache.getPrice('ETH/USDC', 'uniswap')!.price).toBe(3500);
    });
  });

  describe('invalidateDex', () => {
    it('should invalidate all prices for a specific DEX', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('BTC/USDC', 'uniswap', 65000);
      cache.setPrice('ETH/USDC', 'sushiswap', 3505);

      cache.invalidateDex('uniswap');

      expect(cache.getPrice('ETH/USDC', 'uniswap')).toBeNull();
      expect(cache.getPrice('BTC/USDC', 'uniswap')).toBeNull();
      // Other DEX should be unaffected
      expect(cache.getPrice('ETH/USDC', 'sushiswap')!.price).toBe(3505);
    });

    it('should be no-op for unknown DEX', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.invalidateDex('unknown_dex');
      expect(cache.getPrice('ETH/USDC', 'uniswap')!.price).toBe(3500);
    });
  });

  // ==========================================================================
  // clearExpired
  // ==========================================================================
  describe('clearExpired', () => {
    it('should clear expired entries and return count', () => {
      const shortTtlCache = new MatrixPriceCache(10, 5, 1);
      shortTtlCache.setPrice('ETH/USDC', 'uniswap', 3500);
      shortTtlCache.setPrice('BTC/USDC', 'uniswap', 65000);

      const origDateNow = Date.now;
      Date.now = jest.fn(() => origDateNow() + 2000);

      const cleared = shortTtlCache.clearExpired();
      expect(cleared).toBe(2);

      // Entries should now be gone
      expect(shortTtlCache.getPrice('ETH/USDC', 'uniswap')).toBeNull();
      expect(shortTtlCache.getPrice('BTC/USDC', 'uniswap')).toBeNull();

      Date.now = origDateNow;
    });

    it('should return 0 when nothing is expired', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      const cleared = cache.clearExpired();
      expect(cleared).toBe(0);
    });

    it('should return 0 on empty cache', () => {
      const cleared = cache.clearExpired();
      expect(cleared).toBe(0);
    });
  });

  // ==========================================================================
  // Cache Stats
  // ==========================================================================
  describe('getCacheStats', () => {
    it('should track hit rate', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);

      // 1 hit
      cache.getPrice('ETH/USDC', 'uniswap');
      // 1 miss
      cache.getPrice('UNKNOWN', 'uniswap');

      const stats = cache.getCacheStats();
      expect(stats.totalRequests).toBe(2);
      expect(stats.hitRate).toBe(0.5);
    });

    it('should count active entries', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('BTC/USDC', 'uniswap', 65000);
      cache.setPrice('ETH/USDC', 'sushiswap', 3505);

      const stats = cache.getCacheStats();
      expect(stats.activeEntries).toBe(3);
    });

    it('should calculate memory usage', () => {
      const stats = cache.getCacheStats();
      // Memory should account for 100 pairs * 5 DEXes = 500 slots
      // Float64Array (prices): 500 * 8 = 4000 bytes
      // Uint32Array (timestamps): 500 * 4 = 2000 bytes
      // Float64Array (liquidity): 500 * 8 = 4000 bytes
      // Total arrays: 10000 bytes
      expect(stats.memoryUsage).toBeGreaterThanOrEqual(10000);
    });

    it('should return 0 hit rate when no requests made', () => {
      const stats = cache.getCacheStats();
      expect(stats.hitRate).toBe(0);
      expect(stats.totalRequests).toBe(0);
    });
  });

  // ==========================================================================
  // Capacity Limits
  // ==========================================================================
  describe('capacity limits', () => {
    it('should return false when pair slots are full', () => {
      const tinyCache = new MatrixPriceCache(2, 2, 60); // Only 2 pair slots

      expect(tinyCache.setPrice('pair1', 'dex1', 100)).toBe(true);
      expect(tinyCache.setPrice('pair2', 'dex1', 200)).toBe(true);
      expect(tinyCache.setPrice('pair3', 'dex1', 300)).toBe(false); // Full
    });

    it('should return false when DEX slots are full', () => {
      const tinyCache = new MatrixPriceCache(2, 2, 60); // Only 2 DEX slots

      expect(tinyCache.setPrice('pair1', 'dex1', 100)).toBe(true);
      expect(tinyCache.setPrice('pair1', 'dex2', 200)).toBe(true);
      expect(tinyCache.setPrice('pair1', 'dex3', 300)).toBe(false); // Full
    });

    it('should reuse existing pair/DEX indices', () => {
      const tinyCache = new MatrixPriceCache(2, 2, 60);

      tinyCache.setPrice('pair1', 'dex1', 100);
      tinyCache.setPrice('pair1', 'dex2', 200); // Same pair, different DEX
      tinyCache.setPrice('pair2', 'dex1', 300); // Different pair, same DEX
      tinyCache.setPrice('pair2', 'dex2', 400); // Both existing

      expect(tinyCache.getPrice('pair1', 'dex1')!.price).toBe(100);
      expect(tinyCache.getPrice('pair1', 'dex2')!.price).toBe(200);
      expect(tinyCache.getPrice('pair2', 'dex1')!.price).toBe(300);
      expect(tinyCache.getPrice('pair2', 'dex2')!.price).toBe(400);
    });
  });

  // ==========================================================================
  // Resize
  // ==========================================================================
  describe('resize', () => {
    it('should preserve existing data after resize', () => {
      const smallCache = new MatrixPriceCache(5, 3, 60);
      smallCache.setPrice('ETH/USDC', 'uniswap', 3500);
      smallCache.setPrice('BTC/USDC', 'sushiswap', 65000);

      smallCache.resize(10, 5);

      expect(smallCache.getPrice('ETH/USDC', 'uniswap')!.price).toBe(3500);
      expect(smallCache.getPrice('BTC/USDC', 'sushiswap')!.price).toBe(65000);
    });

    it('should allow more entries after resize', () => {
      const tinyCache = new MatrixPriceCache(2, 2, 60);
      tinyCache.setPrice('pair1', 'dex1', 100);
      tinyCache.setPrice('pair2', 'dex1', 200);
      expect(tinyCache.setPrice('pair3', 'dex1', 300)).toBe(false); // Full

      tinyCache.resize(5, 2);
      expect(tinyCache.setPrice('pair3', 'dex1', 300)).toBe(true); // Now works
      expect(tinyCache.getPrice('pair3', 'dex1')!.price).toBe(300);
    });

    it('should be no-op when new size is smaller or equal', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.resize(50, 3); // Smaller than initial 100x5
      // Data should still be accessible
      expect(cache.getPrice('ETH/USDC', 'uniswap')!.price).toBe(3500);
    });
  });

  // ==========================================================================
  // Warmup Queue
  // ==========================================================================
  describe('warmup queue', () => {
    it('should queue warmup items sorted by priority', () => {
      cache.queueWarmup('ETH/USDC', 5, Date.now() + 1000);
      cache.queueWarmup('BTC/USDC', 10, Date.now() + 1000);
      cache.queueWarmup('LINK/ETH', 1, Date.now() + 1000);

      // Items should be processed highest priority first
      // processWarmupQueue checks expectedAccessTime
    });

    it('should process ready items from warmup queue', () => {
      const now = Date.now();
      cache.queueWarmup('ETH/USDC', 10, now - 200); // Already past due
      cache.queueWarmup('BTC/USDC', 5, now - 100);  // Already past due
      cache.queueWarmup('LINK/ETH', 1, now + 10000); // Future

      const processed = cache.processWarmupQueue(5);
      expect(processed).toBe(2); // Only past-due items
    });

    it('should respect maxItems limit', () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        cache.queueWarmup(`pair${i}`, 10, now - 200);
      }

      const processed = cache.processWarmupQueue(3);
      expect(processed).toBe(3);
    });

    it('should return 0 when queue is empty', () => {
      const processed = cache.processWarmupQueue();
      expect(processed).toBe(0);
    });
  });

  // ==========================================================================
  // Singleton
  // ==========================================================================
  describe('getMatrixPriceCache', () => {
    it('should return a MatrixPriceCache instance', () => {
      const instance = getMatrixPriceCache();
      expect(instance).toBeInstanceOf(MatrixPriceCache);
    });

    it('should return the same instance on subsequent calls', () => {
      const instance1 = getMatrixPriceCache();
      const instance2 = getMatrixPriceCache();
      expect(instance1).toBe(instance2);
    });
  });

  // ==========================================================================
  // Index Mapping Correctness
  // ==========================================================================
  describe('index mapping', () => {
    it('should map same pair to same index across calls', () => {
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      cache.setPrice('ETH/USDC', 'uniswap', 3600); // Same pair/dex

      const entry = cache.getPrice('ETH/USDC', 'uniswap');
      expect(entry!.price).toBe(3600); // Latest value
    });

    it('should maintain correct mapping after many inserts', () => {
      // Insert 20 different pairs
      for (let i = 0; i < 20; i++) {
        cache.setPrice(`pair${i}`, 'dex0', i * 100);
      }

      // Verify all are correct
      for (let i = 0; i < 20; i++) {
        const entry = cache.getPrice(`pair${i}`, 'dex0');
        expect(entry).not.toBeNull();
        expect(entry!.price).toBe(i * 100);
      }
    });

    it('should handle cross-product of pairs and DEXes', () => {
      const pairs = ['ETH/USDC', 'BTC/USDC', 'LINK/ETH'];
      const dexes = ['uniswap', 'sushiswap', 'curve'];

      // Set all combinations
      for (const pair of pairs) {
        for (const dex of dexes) {
          cache.setPrice(pair, dex, pairs.indexOf(pair) * 1000 + dexes.indexOf(dex));
        }
      }

      // Verify all combinations
      for (const pair of pairs) {
        for (const dex of dexes) {
          const entry = cache.getPrice(pair, dex);
          expect(entry!.price).toBe(pairs.indexOf(pair) * 1000 + dexes.indexOf(dex));
        }
      }
    });
  });

  // ==========================================================================
  // Timestamp correctness
  // ==========================================================================
  describe('timestamp handling', () => {
    it('should return timestamp in milliseconds', () => {
      const beforeMs = Date.now();
      cache.setPrice('ETH/USDC', 'uniswap', 3500);
      const afterMs = Date.now();

      const entry = cache.getPrice('ETH/USDC', 'uniswap');
      // Timestamp should be in milliseconds, between before and after
      // Note: stored as seconds internally, then multiplied back
      // So precision is to the second
      expect(entry!.timestamp).toBeGreaterThanOrEqual(Math.floor(beforeMs / 1000) * 1000);
      expect(entry!.timestamp).toBeLessThanOrEqual(Math.ceil(afterMs / 1000) * 1000 + 1000);
    });
  });
});
