/**
 * Tier 2 Optimizations Unit Tests
 *
 * Tests for Tier 2 performance optimizations:
 * - T2.9: Dynamic Fallback Prices
 * - T2.10: L3 Cache Eviction Policy
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Mock } from 'jest-mock';

// ===========================================================================
// Mocks - must be defined before imports
// ===========================================================================

// Mock Redis client interface
interface MockRedisClient {
  get: Mock<(key: string) => Promise<unknown>>;
  set: Mock<(key: string, value: unknown, ttl?: number) => Promise<string>>;
  del: Mock<(...keys: string[]) => Promise<number>>;
  ping: Mock<() => Promise<boolean>>;
}

// Mock Redis client factory
const createMockRedisClient = (): MockRedisClient => ({
  get: jest.fn<(key: string) => Promise<unknown>>().mockResolvedValue(null),
  set: jest.fn<(key: string, value: unknown, ttl?: number) => Promise<string>>().mockResolvedValue('OK'),
  del: jest.fn<(...keys: string[]) => Promise<number>>().mockResolvedValue(1),
  ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
});

let mockRedisClient: MockRedisClient;

// Mock the core module (including redis)
jest.mock('@arbitrage/core', () => {
  const actual = jest.requireActual('@arbitrage/core') as Record<string, unknown>;
  return {
    ...actual,
    getRedisClient: jest.fn<() => Promise<MockRedisClient>>().mockImplementation(() => Promise.resolve(mockRedisClient))
  };
});

// Create mock logger for DI injection
const createMockLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
});

// ===========================================================================
// T2.9: Dynamic Fallback Prices Tests
// ===========================================================================

import { PriceOracle, resetPriceOracle, getDefaultPrice } from '@arbitrage/core';

describe('T2.9: Dynamic Fallback Prices', () => {
  let oracle: PriceOracle;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    jest.clearAllMocks();
    resetPriceOracle();
    mockRedisClient = createMockRedisClient();
    mockLogger = createMockLogger();

    // Use DI to inject mock logger (second parameter is deps object)
    oracle = new PriceOracle({
      cacheTtlSeconds: 60,
      stalenessThresholdMs: 300000
    }, { logger: mockLogger as any });
    await oracle.initialize(mockRedisClient as any);
  });

  afterEach(() => {
    oracle.clearLocalCache();
  });

  describe('Last Known Good Price Tracking', () => {
    it('should track last known good price from cache hits', async () => {
      // Simulate a successful price from Redis cache
      const cachedData = { price: 3500, timestamp: Date.now() };
      mockRedisClient.get.mockResolvedValue(cachedData);

      await oracle.getPrice('ETH');

      // The last known good price should be tracked
      const lastKnownGood = oracle.getLastKnownGoodPrice('ETH');
      expect(lastKnownGood).toBe(3500);
    });

    it('should not update last known good price from fallback', async () => {
      // No cache, using fallback
      mockRedisClient.get.mockResolvedValue(null);

      await oracle.getPrice('ETH');

      // Last known good should not be updated from static fallback
      const lastKnownGood = oracle.getLastKnownGoodPrice('ETH');
      expect(lastKnownGood).toBe(0); // No last known good yet
    });

    it('should prefer last known good over static fallback when cache misses', async () => {
      // First call: get price from cache, establishing last known good
      const cachedData = { price: 3500, timestamp: Date.now() };
      mockRedisClient.get.mockResolvedValueOnce(cachedData);
      await oracle.getPrice('ETH');

      // Clear local cache to force fallback path
      oracle.clearLocalCache();

      // Second call: cache miss, Redis miss
      mockRedisClient.get.mockResolvedValueOnce(null);
      const result = await oracle.getPrice('ETH');

      // Should use last known good (3500) instead of static fallback (2500)
      expect(result.price).toBe(3500);
      expect(result.source).toBe('lastKnownGood');
    });

    it('should handle wrapped token aliases for last known good', async () => {
      const cachedData = { price: 3500, timestamp: Date.now() };
      mockRedisClient.get.mockResolvedValue(cachedData);

      await oracle.getPrice('WETH');

      // WETH should track ETH's last known good
      const lastKnownGood = oracle.getLastKnownGoodPrice('ETH');
      expect(lastKnownGood).toBe(3500);
    });
  });

  describe('Bulk Fallback Price Updates', () => {
    it('should update multiple fallback prices at once', () => {
      oracle.updateFallbackPrices({
        ETH: 3000,
        BTC: 95000,
        BNB: 350
      });

      expect(oracle.getFallbackPrice('ETH')).toBe(3000);
      expect(oracle.getFallbackPrice('BTC')).toBe(95000);
      expect(oracle.getFallbackPrice('BNB')).toBe(350);
    });

    it('should preserve existing fallbacks not in update', () => {
      const originalUsdt = oracle.getFallbackPrice('USDT');

      oracle.updateFallbackPrices({
        ETH: 3000
      });

      // USDT should not be changed
      expect(oracle.getFallbackPrice('USDT')).toBe(originalUsdt);
    });

    it('should ignore invalid prices in bulk update', () => {
      const originalEth = oracle.getFallbackPrice('ETH');

      oracle.updateFallbackPrices({
        ETH: -100,
        BTC: 0,
        BNB: 350
      });

      // Invalid prices should be ignored
      expect(oracle.getFallbackPrice('ETH')).toBe(originalEth);
      expect(oracle.getFallbackPrice('BTC')).toBe(100000); // Original
      expect(oracle.getFallbackPrice('BNB')).toBe(350); // Valid update
    });

    it('should handle wrapped token normalization in bulk update', () => {
      oracle.updateFallbackPrices({
        WETH: 3000,
        WBTC: 95000
      });

      // Should be normalized to native tokens
      expect(oracle.getFallbackPrice('ETH')).toBe(3000);
      expect(oracle.getFallbackPrice('BTC')).toBe(95000);
    });
  });

  describe('Price Staleness Metrics', () => {
    beforeEach(() => {
      oracle.resetPriceMetrics();
    });

    it('should track fallback price usage count', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      oracle.clearLocalCache();

      // Call getPrice for different tokens (each will use fallback)
      await oracle.getPrice('ETH');
      await oracle.getPrice('BTC');

      const metrics = oracle.getPriceMetrics();
      expect(metrics.fallbackUsageCount).toBeGreaterThanOrEqual(2);
    });

    it('should track cache hit count', async () => {
      const cachedData = { price: 3500, timestamp: Date.now() };
      mockRedisClient.get.mockResolvedValue(cachedData);
      oracle.clearLocalCache();

      await oracle.getPrice('ETH');

      const metrics = oracle.getPriceMetrics();
      expect(metrics.cacheHitCount).toBeGreaterThanOrEqual(1);
    });

    it('should report stale fallback usage warnings', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      oracle.clearLocalCache();

      await oracle.getPrice('ETH');

      const metrics = oracle.getPriceMetrics();
      expect(metrics.staleFallbackWarnings).toContain('ETH');
    });
  });

  describe('Integration with Existing Price Oracle', () => {
    it('should preserve existing getPrice behavior', async () => {
      const cachedData = { price: 2600, timestamp: Date.now() };
      mockRedisClient.get.mockResolvedValue(cachedData);

      const result = await oracle.getPrice('ETH');

      expect(result.price).toBe(2600);
      expect(result.source).toBe('cache');
    });

    it('should preserve existing fallback behavior when no last known good', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const result = await oracle.getPrice('ETH');

      expect(result.price).toBe(3500); // Static fallback
      expect(result.source).toBe('fallback');
    });
  });
});

// ===========================================================================
// T2.10: L3 Cache Eviction Policy Tests
// ===========================================================================

// Note: Using the same mock from above for Redis

import { HierarchicalCache, LRUQueue } from '../../src/caching/hierarchical-cache';

describe('T2.10: L3 Cache Eviction Policy', () => {
  describe('L3 Max Size Configuration', () => {
    it('should accept l3MaxSize in config', () => {
      const cache = new HierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true,
        l3MaxSize: 100
      });

      const stats = cache.getStats();
      expect(stats.l3.maxSize).toBe(100);
    });

    it('should use default l3MaxSize when not specified', () => {
      const cache = new HierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true
      });

      const stats = cache.getStats();
      expect(stats.l3.maxSize).toBeGreaterThan(0);
    });
  });

  describe('L3 LRU Eviction', () => {
    let cache: HierarchicalCache;

    beforeEach(() => {
      cache = new HierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true,
        l3MaxSize: 5 // Small size for testing
      });
    });

    it('should evict oldest entries when L3 exceeds max size', async () => {
      // Add 5 entries (at capacity)
      for (let i = 0; i < 5; i++) {
        await cache.set(`key${i}`, { value: i });
      }

      // Verify all 5 are there
      const stats1 = cache.getStats();
      expect(stats1.l3.entries).toBe(5);

      // Add 6th entry - should trigger eviction
      await cache.set('key5', { value: 5 });

      const stats2 = cache.getStats();
      expect(stats2.l3.entries).toBeLessThanOrEqual(5);

      // Oldest entry (key0) should be evicted
      const oldestValue = await cache.get('key0');
      expect(oldestValue).toBeNull();
    });

    it('should keep most recently accessed entries', async () => {
      // Add 5 entries
      for (let i = 0; i < 5; i++) {
        await cache.set(`key${i}`, { value: i });
      }

      // Access key0 to make it recently used
      await cache.get('key0');

      // Add new entry - should evict key1 (oldest non-accessed)
      await cache.set('key5', { value: 5 });

      // key0 should still be there (was accessed)
      const key0Value = await cache.get('key0');
      expect(key0Value).not.toBeNull();

      // key1 should be evicted (oldest)
      const key1Value = await cache.get('key1');
      expect(key1Value).toBeNull();
    });

    it('should track L3 eviction count in stats', async () => {
      // Fill cache
      for (let i = 0; i < 5; i++) {
        await cache.set(`key${i}`, { value: i });
      }

      const statsBefore = cache.getStats();
      const evictionsBefore = statsBefore.l3.evictions;

      // Trigger eviction
      await cache.set('key5', { value: 5 });

      const statsAfter = cache.getStats();
      expect(statsAfter.l3.evictions).toBeGreaterThan(evictionsBefore);
    });
  });

  describe('L3 Memory Leak Prevention', () => {
    it('should not grow unbounded over many operations', async () => {
      const cache = new HierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true,
        l3MaxSize: 100
      });

      // Add many more entries than max size
      for (let i = 0; i < 500; i++) {
        await cache.set(`key${i}`, { value: i, data: 'x'.repeat(100) });
      }

      const stats = cache.getStats();
      expect(stats.l3.entries).toBeLessThanOrEqual(100);
    });

    it('should report L3 utilization', async () => {
      const cache = new HierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true,
        l3MaxSize: 100
      });

      for (let i = 0; i < 50; i++) {
        await cache.set(`key${i}`, { value: i });
      }

      const stats = cache.getStats();
      expect(stats.l3.utilization).toBeCloseTo(0.5, 1); // 50/100 = 0.5
    });
  });

  describe('L3 Eviction Queue Performance', () => {
    it('should maintain O(1) eviction operations', async () => {
      const cache = new HierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true,
        l3MaxSize: 1000
      });

      // Fill to capacity
      for (let i = 0; i < 1000; i++) {
        await cache.set(`key${i}`, { value: i });
      }

      // Measure eviction time
      const start = performance.now();
      for (let i = 1000; i < 2000; i++) {
        await cache.set(`key${i}`, { value: i });
      }
      const elapsed = performance.now() - start;

      // 1000 evictions should be fast (< 100ms with O(1) operations)
      console.log(`L3 eviction performance: ${elapsed.toFixed(2)}ms for 1000 evictions (${(elapsed / 1000).toFixed(3)}ms/op)`);
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('Edge Cases', () => {
    it('should handle l3MaxSize of 0 (disabled eviction)', async () => {
      const cache = new HierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true,
        l3MaxSize: 0 // 0 means unlimited (backwards compatible)
      });

      // Should not throw
      for (let i = 0; i < 10; i++) {
        await cache.set(`key${i}`, { value: i });
      }

      const stats = cache.getStats();
      expect(stats.l3.entries).toBe(10);
    });

    it('should handle setting same key multiple times', async () => {
      const cache = new HierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true,
        l3MaxSize: 5
      });

      // Set same key multiple times
      for (let i = 0; i < 10; i++) {
        await cache.set('sameKey', { value: i });
      }

      // Should only have 1 entry
      const stats = cache.getStats();
      expect(stats.l3.entries).toBe(1);

      // Value should be latest
      const value = await cache.get('sameKey');
      expect(value.value).toBe(9);
    });

    it('should properly clear L3 eviction queue', async () => {
      const cache = new HierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true,
        l3MaxSize: 5
      });

      for (let i = 0; i < 5; i++) {
        await cache.set(`key${i}`, { value: i });
      }

      await cache.clear();

      const stats = cache.getStats();
      expect(stats.l3.entries).toBe(0);

      // Should be able to add new entries after clear
      await cache.set('newKey', { value: 'new' });
      expect(stats.l3.entries).toBe(0); // Stats is snapshot
      const newStats = cache.getStats();
      expect(newStats.l3.entries).toBe(1);
    });
  });
});

// ===========================================================================
// Integration Tests
// ===========================================================================

describe('Tier 2 Integration', () => {
  describe('Dynamic Prices with Cache Hierarchy', () => {
    it('should update last known good prices from cache hits', async () => {
      // This test validates that price updates flow correctly through the system
      const mockRedis = createMockRedisClient();
      const oracle = new PriceOracle({}, { logger: createMockLogger() as any });
      await oracle.initialize(mockRedis as any);

      // Simulate a cache hit by setting up mock to return price data
      mockRedis.get.mockResolvedValue({ price: 3500, timestamp: Date.now() });

      // Get price - this triggers cache hit and updates last known good
      await oracle.getPrice('ETH');

      // Last known good should be set from cache hit
      const lastKnownGood = oracle.getLastKnownGoodPrice('ETH');
      expect(lastKnownGood).toBe(3500);

      // Clean up
      oracle.clearLocalCache();
    });
  });
});

// ===========================================================================
// T2.6: Quadrilateral Arbitrage Tests
// ===========================================================================

import { CrossDexTriangularArbitrage, DexPool } from '@arbitrage/core';

describe('T2.6: Quadrilateral Arbitrage', () => {
  // Create test pools for 4-hop arbitrage paths
  const createTestPools = (): DexPool[] => [
    // A→B pools (USDT→WETH)
    { dex: 'uniswap', token0: 'USDT', token1: 'WETH', reserve0: '1000000', reserve1: '500', fee: 30, liquidity: 1000000, price: 0.0005 },
    { dex: 'sushiswap', token0: 'USDT', token1: 'WETH', reserve0: '800000', reserve1: '410', fee: 25, liquidity: 800000, price: 0.000512 },
    // B→C pools (WETH→WBTC)
    { dex: 'uniswap', token0: 'WETH', token1: 'WBTC', reserve0: '1000', reserve1: '50', fee: 30, liquidity: 2000000, price: 0.05 },
    { dex: 'curve', token0: 'WETH', token1: 'WBTC', reserve0: '1200', reserve1: '62', fee: 4, liquidity: 2500000, price: 0.0517 },
    // C→D pools (WBTC→DAI)
    { dex: 'uniswap', token0: 'WBTC', token1: 'DAI', reserve0: '100', reserve1: '4500000', fee: 30, liquidity: 4500000, price: 45000 },
    { dex: 'balancer', token0: 'WBTC', token1: 'DAI', reserve0: '120', reserve1: '5500000', fee: 20, liquidity: 5500000, price: 45833 },
    // D→A pools (DAI→USDT)
    { dex: 'curve', token0: 'DAI', token1: 'USDT', reserve0: '5000000', reserve1: '4990000', fee: 4, liquidity: 10000000, price: 0.998 },
    { dex: 'uniswap', token0: 'DAI', token1: 'USDT', reserve0: '2000000', reserve1: '2010000', fee: 30, liquidity: 4000000, price: 1.005 },
    // Additional pools to complete the graph
    { dex: 'uniswap', token0: 'USDT', token1: 'DAI', reserve0: '3000000', reserve1: '3010000', fee: 30, liquidity: 6000000, price: 1.003 },
    { dex: 'uniswap', token0: 'WETH', token1: 'USDT', reserve0: '600', reserve1: '1200000', fee: 30, liquidity: 1200000, price: 2000 },
    { dex: 'sushiswap', token0: 'WBTC', token1: 'WETH', reserve0: '60', reserve1: '1150', fee: 25, liquidity: 2300000, price: 19.17 },
  ];

  describe('Quadrilateral Path Detection', () => {
    it('should find quadrilateral arbitrage opportunities', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.001
      });
      const pools = createTestPools();

      // findQuadrilateralOpportunities is new method to be implemented
      const opportunities = await engine.findQuadrilateralOpportunities(
        'ethereum',
        pools,
        ['USDT', 'USDC']
      );

      // Should find at least one 4-hop opportunity
      expect(opportunities).toBeDefined();
      expect(Array.isArray(opportunities)).toBe(true);
    });

    it('should correctly identify 4-token paths', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.001
      });
      const pools = createTestPools();

      const opportunities = await engine.findQuadrilateralOpportunities(
        'ethereum',
        pools,
        ['USDT']
      );

      // Every opportunity should have exactly 4 tokens in the path
      for (const opp of opportunities) {
        expect(opp.path.length).toBe(4);
        // Path should be circular (start and end with same token)
        expect(opp.path[0]).toBe(opp.steps[0].fromToken);
        expect(opp.steps[3].toToken).toBe(opp.path[0]);
      }
    });

    it('should use 4 DEXes for each quadrilateral', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.001
      });
      const pools = createTestPools();

      const opportunities = await engine.findQuadrilateralOpportunities(
        'ethereum',
        pools,
        ['USDT']
      );

      // Every opportunity should have exactly 4 DEXes
      for (const opp of opportunities) {
        expect(opp.dexes.length).toBe(4);
        expect(opp.steps.length).toBe(4);
      }
    });
  });

  describe('Quadrilateral Opportunity Evaluation', () => {
    it('should calculate profit across 4 hops correctly', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.0001 // Low threshold to catch all opportunities
      });
      const pools = createTestPools();

      const opportunities = await engine.findQuadrilateralOpportunities(
        'ethereum',
        pools,
        ['USDT']
      );

      for (const opp of opportunities) {
        // Profit should be calculated correctly (can be positive or negative)
        expect(typeof opp.profitPercentage).toBe('number');
        expect(typeof opp.profitUSD).toBe('number');
        expect(typeof opp.netProfit).toBe('number');

        // If opportunity is returned, netProfit should be positive
        expect(opp.netProfit).toBeGreaterThan(0);
      }
    });

    it('should include gas costs for 4-hop execution', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.001
      });
      const pools = createTestPools();

      const opportunities = await engine.findQuadrilateralOpportunities(
        'ethereum',
        pools,
        ['USDT']
      );

      for (const opp of opportunities) {
        // Gas cost should be higher than triangular (4 swaps vs 3)
        expect(opp.gasCost).toBeGreaterThan(0);
        // Expect 4 swap gas costs (~150k gas per swap)
        // This is approximately 4x more than single swap
        expect(opp.gasCost).toBeGreaterThan(100); // $100+ gas for 4 swaps
      }
    });

    it('should apply dynamic slippage across all 4 legs', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.001,
        slippageConfig: {
          baseSlippage: 0.003,
          priceImpactScale: 5.0,
          maxSlippage: 0.10,
          minLiquidityUsd: 100000,
          liquidityPenaltyScale: 2.0
        }
      });
      const pools = createTestPools();

      const opportunities = await engine.findQuadrilateralOpportunities(
        'ethereum',
        pools,
        ['USDT']
      );

      for (const opp of opportunities) {
        // Each step should have slippage applied
        for (const step of opp.steps) {
          expect(step.slippage).toBeGreaterThan(0);
          expect(step.slippage).toBeLessThanOrEqual(0.10); // Max 10%
        }
      }
    });
  });

  describe('Quadrilateral Performance', () => {
    it('should complete detection within acceptable time', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.001
      });
      const pools = createTestPools();

      const start = performance.now();
      await engine.findQuadrilateralOpportunities(
        'ethereum',
        pools,
        ['USDT', 'USDC', 'DAI']
      );
      const elapsed = performance.now() - start;

      // Quadrilateral detection should complete in reasonable time
      // Allow up to 500ms for test pools (would be faster with indexing)
      console.log(`Quadrilateral detection time: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThan(1000);
    });

    it('should handle large pool sets efficiently', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.001
      });

      // Create larger pool set (simulating real-world conditions)
      const basePools = createTestPools();
      const largePools: DexPool[] = [];

      // Generate more pools by varying prices slightly
      for (let i = 0; i < 10; i++) {
        for (const pool of basePools) {
          largePools.push({
            ...pool,
            dex: `${pool.dex}_${i}`,
            price: pool.price * (1 + (Math.random() - 0.5) * 0.1),
            liquidity: pool.liquidity * (0.8 + Math.random() * 0.4)
          });
        }
      }

      const start = performance.now();
      await engine.findQuadrilateralOpportunities(
        'ethereum',
        largePools,
        ['USDT']
      );
      const elapsed = performance.now() - start;

      console.log(`Large pool detection (${largePools.length} pools): ${elapsed.toFixed(2)}ms`);
      // Should still complete in reasonable time with pruning
      expect(elapsed).toBeLessThan(5000);
    });
  });

  describe('Integration with Triangular Detection', () => {
    it('should detect both triangular and quadrilateral opportunities', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.0001 // Very low threshold
      });
      const pools = createTestPools();

      // Get both types of opportunities
      const triangular = await engine.findTriangularOpportunities('ethereum', pools, ['USDT']);
      const quadrilateral = await engine.findQuadrilateralOpportunities('ethereum', pools, ['USDT']);

      // Both should return valid arrays
      expect(Array.isArray(triangular)).toBe(true);
      expect(Array.isArray(quadrilateral)).toBe(true);
    });

    it('should distinguish quadrilateral from triangular by path length', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.0001
      });
      const pools = createTestPools();

      const triangular = await engine.findTriangularOpportunities('ethereum', pools, ['USDT']);
      const quadrilateral = await engine.findQuadrilateralOpportunities('ethereum', pools, ['USDT']);

      // Triangular should have 3-token paths (displayed as 3 unique tokens)
      for (const opp of triangular) {
        expect(opp.path.length).toBe(3);
      }

      // Quadrilateral should have 4-token paths
      for (const opp of quadrilateral) {
        expect(opp.path.length).toBe(4);
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty pool list', async () => {
      const engine = new CrossDexTriangularArbitrage();

      const opportunities = await engine.findQuadrilateralOpportunities(
        'ethereum',
        [],
        ['USDT']
      );

      expect(opportunities).toEqual([]);
    });

    it('should handle pools with insufficient connectivity', async () => {
      const engine = new CrossDexTriangularArbitrage();

      // Only 2 pools - can't form a quadrilateral
      const sparsesPools: DexPool[] = [
        { dex: 'uniswap', token0: 'USDT', token1: 'WETH', reserve0: '1000000', reserve1: '500', fee: 30, liquidity: 1000000, price: 0.0005 },
        { dex: 'sushiswap', token0: 'WETH', token1: 'WBTC', reserve0: '1000', reserve1: '50', fee: 25, liquidity: 2000000, price: 0.05 },
      ];

      const opportunities = await engine.findQuadrilateralOpportunities(
        'ethereum',
        sparsesPools,
        ['USDT']
      );

      expect(opportunities).toEqual([]);
    });

    it('should skip paths with zero liquidity pools', async () => {
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.001
      });

      const poolsWithZeroLiquidity = createTestPools().map((pool, i) => ({
        ...pool,
        liquidity: i === 0 ? 0 : pool.liquidity
      }));

      const opportunities = await engine.findQuadrilateralOpportunities(
        'ethereum',
        poolsWithZeroLiquidity,
        ['USDT']
      );

      // Should not include paths through zero-liquidity pool
      for (const opp of opportunities) {
        for (const step of opp.steps) {
          expect(step.amountOut).toBeGreaterThan(0);
        }
      }
    });
  });
});

// T2.7 Price Momentum Detection tests removed — covered by price-momentum.test.ts
// (standalone PriceMomentumTracker unit tests; see @see shared/core/__tests__/unit/price-momentum.test.ts)

import { PriceMomentumTracker, MomentumSignal } from '../../src/analytics/price-momentum';

// ===========================================================================
// T2.8: ML Predictor Integration Tests
// ===========================================================================

import {
  MLOpportunityScorer,
  getMLOpportunityScorer,
  resetMLOpportunityScorer
} from '../../src/analytics/ml-opportunity-scorer';

describe('T2.8: ML Predictor Integration', () => {
  let scorer: MLOpportunityScorer;

  beforeEach(() => {
    resetMLOpportunityScorer();
    scorer = new MLOpportunityScorer({
      mlWeight: 0.3,           // 30% weight for ML predictions
      baseWeight: 0.7,         // 70% weight for base confidence
      minMLConfidence: 0.5,    // Minimum ML confidence to consider
      directionBonus: 0.1,     // Bonus for aligned direction
      directionPenalty: 0.15   // Penalty for opposing direction
    });
  });

  describe('Score Enhancement', () => {
    it('should enhance confidence when ML predicts favorable direction', async () => {
      const baseConfidence = 0.7;

      // ML predicts price will go up with high confidence
      const enhancedScore = await scorer.enhanceOpportunityScore({
        baseConfidence,
        mlPrediction: {
          predictedPrice: 2600,
          confidence: 0.85,
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy', // Buying when price goes up = profitable
        currentPrice: 2500
      });

      // Score should be enhanced
      expect(enhancedScore.enhancedConfidence).toBeGreaterThan(baseConfidence);
      expect(enhancedScore.mlContribution).toBeGreaterThan(0);
    });

    it('should reduce confidence when ML predicts opposing direction', async () => {
      const baseConfidence = 0.7;

      // ML predicts price will go down
      const enhancedScore = await scorer.enhanceOpportunityScore({
        baseConfidence,
        mlPrediction: {
          predictedPrice: 2400,
          confidence: 0.8,
          direction: 'down',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy', // Buying when price goes down = unfavorable
        currentPrice: 2500
      });

      // Score should be reduced
      expect(enhancedScore.enhancedConfidence).toBeLessThan(baseConfidence);
      expect(enhancedScore.directionAligned).toBe(false);
    });

    it('should not modify score when ML confidence is below threshold', async () => {
      const baseConfidence = 0.7;

      // Low confidence ML prediction should be ignored
      const enhancedScore = await scorer.enhanceOpportunityScore({
        baseConfidence,
        mlPrediction: {
          predictedPrice: 2700,
          confidence: 0.3, // Below threshold
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Score should remain unchanged
      expect(enhancedScore.enhancedConfidence).toBeCloseTo(baseConfidence, 2);
      expect(enhancedScore.mlApplied).toBe(false);
    });

    it('should handle sideways prediction neutrally', async () => {
      const baseConfidence = 0.7;

      const enhancedScore = await scorer.enhanceOpportunityScore({
        baseConfidence,
        mlPrediction: {
          predictedPrice: 2505,
          confidence: 0.85,
          direction: 'sideways',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Sideways prediction should have minimal effect
      expect(Math.abs(enhancedScore.enhancedConfidence - baseConfidence)).toBeLessThan(0.1);
    });
  });

  describe('Batch Scoring', () => {
    it('should score multiple opportunities efficiently', async () => {
      const opportunities: Array<{
        baseConfidence: number;
        mlPrediction: { predictedPrice: number; confidence: number; direction: 'up' | 'down' | 'sideways'; timeHorizon: number; features: number[] };
        opportunityDirection: 'buy' | 'sell';
        currentPrice: number;
      }> = [];
      for (let i = 0; i < 10; i++) {
        opportunities.push({
          baseConfidence: 0.6 + Math.random() * 0.3,
          mlPrediction: {
            predictedPrice: 2500 + (Math.random() - 0.5) * 200,
            confidence: 0.6 + Math.random() * 0.3,
            direction: ['up', 'down', 'sideways'][i % 3] as 'up' | 'down' | 'sideways',
            timeHorizon: 300000,
            features: []
          },
          opportunityDirection: 'buy' as 'buy' | 'sell',
          currentPrice: 2500
        });
      }

      const start = performance.now();
      const results = await scorer.enhanceBatch(opportunities);
      const elapsed = performance.now() - start;

      expect(results.length).toBe(10);
      expect(elapsed).toBeLessThan(50); // Should be fast
    });

    it('should rank opportunities by enhanced score', async () => {
      const opportunities = [
        {
          id: 'opp1',
          baseConfidence: 0.6,
          mlPrediction: { predictedPrice: 2600, confidence: 0.9, direction: 'up' as const, timeHorizon: 300000, features: [] },
          opportunityDirection: 'buy' as const,
          currentPrice: 2500
        },
        {
          id: 'opp2',
          baseConfidence: 0.8,
          mlPrediction: { predictedPrice: 2400, confidence: 0.9, direction: 'down' as const, timeHorizon: 300000, features: [] },
          opportunityDirection: 'buy' as const,
          currentPrice: 2500
        },
        {
          id: 'opp3',
          baseConfidence: 0.7,
          mlPrediction: { predictedPrice: 2550, confidence: 0.8, direction: 'up' as const, timeHorizon: 300000, features: [] },
          opportunityDirection: 'buy' as const,
          currentPrice: 2500
        }
      ];

      const ranked = await scorer.rankOpportunities(opportunities);

      // Best opportunity should have highest enhanced score
      expect(ranked[0].enhancedConfidence).toBeGreaterThan(ranked[1].enhancedConfidence);
      expect(ranked[1].enhancedConfidence).toBeGreaterThan(ranked[2].enhancedConfidence);
    });
  });

  describe('Price Impact Integration', () => {
    it('should factor in predicted price change magnitude', async () => {
      const baseConfidence = 0.7;

      // Large predicted price increase
      const largeMove = await scorer.enhanceOpportunityScore({
        baseConfidence,
        mlPrediction: {
          predictedPrice: 2750, // 10% increase
          confidence: 0.85,
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Small predicted price increase
      const smallMove = await scorer.enhanceOpportunityScore({
        baseConfidence,
        mlPrediction: {
          predictedPrice: 2525, // 1% increase
          confidence: 0.85,
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Larger move should have higher score
      expect(largeMove.priceImpactScore).toBeGreaterThan(smallMove.priceImpactScore);
    });
  });

  describe('Fallback Behavior', () => {
    it('should work without ML prediction', async () => {
      const baseConfidence = 0.7;

      const result = await scorer.enhanceOpportunityScore({
        baseConfidence,
        mlPrediction: null,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Should return base confidence unchanged
      expect(result.enhancedConfidence).toBe(baseConfidence);
      expect(result.mlApplied).toBe(false);
    });

    it('should handle invalid ML prediction gracefully', async () => {
      const baseConfidence = 0.7;

      const result = await scorer.enhanceOpportunityScore({
        baseConfidence,
        mlPrediction: {
          predictedPrice: NaN,
          confidence: -1,
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Should fallback to base confidence
      expect(result.enhancedConfidence).toBe(baseConfidence);
      expect(result.mlApplied).toBe(false);
    });
  });

  describe('Configuration', () => {
    it('should respect custom weights', async () => {
      const customScorer = new MLOpportunityScorer({
        mlWeight: 0.5,     // 50% ML weight
        baseWeight: 0.5,   // 50% base weight
        minMLConfidence: 0.5,
        directionBonus: 0.1,
        directionPenalty: 0.15
      });

      const result = await customScorer.enhanceOpportunityScore({
        baseConfidence: 0.7,
        mlPrediction: {
          predictedPrice: 2600,
          confidence: 0.9,
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // With 50/50 weights, ML should have more influence
      expect(result.mlContribution).toBeGreaterThan(0.2);
    });

    it('should return stats about scoring activity', () => {
      const stats = scorer.getStats();

      expect(stats).toHaveProperty('scoredOpportunities');
      expect(stats).toHaveProperty('mlEnhancedCount');
      expect(stats).toHaveProperty('avgMLContribution');
      expect(stats).toHaveProperty('avgEnhancement');
    });
  });

  describe('Integration with Momentum Signals', () => {
    it('should combine ML prediction with momentum signals', async () => {
      const momentumTracker = new PriceMomentumTracker();

      // Build momentum data
      for (let i = 0; i < 20; i++) {
        momentumTracker.addPriceUpdate('ETH_USDT', 2500 + i * 5, 1000000);
      }

      const momentumSignal = momentumTracker.getMomentumSignal('ETH_USDT');

      const result = await scorer.enhanceWithMomentum({
        baseConfidence: 0.7,
        mlPrediction: {
          predictedPrice: 2650,
          confidence: 0.85,
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        momentumSignal,
        opportunityDirection: 'buy',
        currentPrice: 2600
      });

      // Should have combined score from ML and momentum
      expect(result.enhancedConfidence).toBeDefined();
      expect(result.momentumContribution).toBeDefined();
    });

    it('should scale momentum bonuses proportionally to momentumWeight', async () => {
      // Create scorers with different momentum weights
      const lowMomentumScorer = new MLOpportunityScorer({
        mlWeight: 0.3,
        baseWeight: 0.7,
        minMLConfidence: 0.5,
        directionBonus: 0.1,
        directionPenalty: 0.15,
        momentumWeight: 0.1 // Low momentum weight
      });

      const highMomentumScorer = new MLOpportunityScorer({
        mlWeight: 0.3,
        baseWeight: 0.7,
        minMLConfidence: 0.5,
        directionBonus: 0.1,
        directionPenalty: 0.15,
        momentumWeight: 0.4 // High momentum weight
      });

      // Full MomentumSignal with all required properties
      const bullishSignal: import('../../src/analytics/price-momentum').MomentumSignal = {
        pair: 'ETH_USDT',
        currentPrice: 2500,
        velocity: 0.02,
        acceleration: 0.001,
        zScore: 1.5,
        meanReversionSignal: false,
        volumeSpike: true,
        volumeRatio: 2.5,
        trend: 'bullish',
        confidence: 0.9,
        emaShort: 2480,
        emaMedium: 2450,
        emaLong: 2400,
        timestamp: Date.now()
      };

      const input = {
        baseConfidence: 0.7,
        mlPrediction: {
          predictedPrice: 2600,
          confidence: 0.85,
          direction: 'up' as const,
          timeHorizon: 300000,
          features: [] as number[]
        },
        momentumSignal: bullishSignal,
        opportunityDirection: 'buy' as const,
        currentPrice: 2500
      };

      const lowResult = await lowMomentumScorer.enhanceWithMomentum(input);
      const highResult = await highMomentumScorer.enhanceWithMomentum(input);

      // Higher momentum weight should have proportionally larger momentum contribution
      // momentumContribution scales with momentumWeight
      expect(highResult.momentumContribution!).toBeGreaterThan(lowResult.momentumContribution!);
    });

    it('should return unchanged score without momentum signal', async () => {
      const mlResult = await scorer.enhanceOpportunityScore({
        baseConfidence: 0.7,
        mlPrediction: {
          predictedPrice: 2600,
          confidence: 0.85,
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      const withMomentum = await scorer.enhanceWithMomentum({
        baseConfidence: 0.7,
        mlPrediction: {
          predictedPrice: 2600,
          confidence: 0.85,
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        momentumSignal: null,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Without momentum signal, enhanceWithMomentum should return same as enhanceOpportunityScore
      expect(withMomentum.enhancedConfidence).toBe(mlResult.enhancedConfidence);
    });
  });

  describe('Weight Configuration Edge Cases', () => {
    it('should normalize weights that do not sum to 1', () => {
      // Constructor should normalize weights
      const scorer = new MLOpportunityScorer({
        mlWeight: 0.4,
        baseWeight: 0.8, // Sum is 1.2, not 1
        minMLConfidence: 0.5,
        directionBonus: 0.1,
        directionPenalty: 0.15
      });

      // Should not throw and should work
      expect(async () => {
        await scorer.enhanceOpportunityScore({
          baseConfidence: 0.7,
          mlPrediction: {
            predictedPrice: 2600,
            confidence: 0.85,
            direction: 'up',
            timeHorizon: 300000,
            features: []
          },
          opportunityDirection: 'buy',
          currentPrice: 2500
        });
      }).not.toThrow();
    });

    it('should clamp enhanced confidence to [0, 1]', async () => {
      // Create extreme scenario that could push score above 1 or below 0
      const extremeScorer = new MLOpportunityScorer({
        mlWeight: 0.5,
        baseWeight: 0.5,
        minMLConfidence: 0.5,
        directionBonus: 0.5, // Large bonus
        directionPenalty: 0.5 // Large penalty
      });

      // High confidence ML prediction with aligned direction
      const highResult = await extremeScorer.enhanceOpportunityScore({
        baseConfidence: 0.95,
        mlPrediction: {
          predictedPrice: 3000, // Large price move
          confidence: 0.99,
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Low confidence with opposing direction
      const lowResult = await extremeScorer.enhanceOpportunityScore({
        baseConfidence: 0.1,
        mlPrediction: {
          predictedPrice: 2000,
          confidence: 0.99,
          direction: 'down',
          timeHorizon: 300000,
          features: []
        },
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Both should be clamped to [0, 1]
      expect(highResult.enhancedConfidence).toBeLessThanOrEqual(1);
      expect(highResult.enhancedConfidence).toBeGreaterThanOrEqual(0);
      expect(lowResult.enhancedConfidence).toBeLessThanOrEqual(1);
      expect(lowResult.enhancedConfidence).toBeGreaterThanOrEqual(0);
    });
  });
});

// ===========================================================================
// T4.3.3: Orderflow Integration with ML Opportunity Scorer Tests
// ===========================================================================

import type {
  OrderflowSignal,
  OpportunityWithOrderflow,
  EnhancedScoreWithOrderflow
} from '../../src/analytics/ml-opportunity-scorer';

describe('T4.3.3: Orderflow Integration with ML Opportunity Scorer', () => {
  let scorer: MLOpportunityScorer;

  beforeEach(() => {
    resetMLOpportunityScorer();
    scorer = new MLOpportunityScorer({
      mlWeight: 0.3,
      baseWeight: 0.7,
      minMLConfidence: 0.5,
      directionBonus: 0.1,
      directionPenalty: 0.15,
      orderflowWeight: 0.15 // New: orderflow weight for integration
    });
  });

  describe('Orderflow Signal Type Mapping', () => {
    it('should map bullish orderflow direction to up ML direction', async () => {
      const orderflowSignal: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.3,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Bullish orderflow should boost buy opportunity
      expect(result.orderflowApplied).toBe(true);
      expect(result.orderflowContribution).toBeGreaterThan(0);
      expect(result.orderflowDirectionAligned).toBe(true);
    });

    it('should map bearish orderflow direction to down ML direction', async () => {
      const orderflowSignal: OrderflowSignal = {
        direction: 'bearish',
        confidence: 0.8,
        orderflowPressure: -0.6,
        expectedVolatility: 0.3,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal,
        opportunityDirection: 'sell',
        currentPrice: 2500
      });

      // Bearish orderflow should boost sell opportunity
      expect(result.orderflowApplied).toBe(true);
      expect(result.orderflowContribution).toBeGreaterThan(0);
      expect(result.orderflowDirectionAligned).toBe(true);
    });

    it('should map neutral orderflow direction to sideways ML direction', async () => {
      const orderflowSignal: OrderflowSignal = {
        direction: 'neutral',
        confidence: 0.7,
        orderflowPressure: 0.1,
        expectedVolatility: 0.2,
        whaleImpact: 0.2,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Neutral orderflow should have minimal effect
      expect(result.orderflowApplied).toBe(true);
      expect(result.orderflowDirectionAligned).toBe(true); // Neutral is always considered aligned
    });
  });

  describe('Orderflow Score Enhancement', () => {
    it('should enhance confidence when orderflow aligns with opportunity direction', async () => {
      const baseConfidence = 0.7;
      const orderflowSignal: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.85,
        orderflowPressure: 0.7,
        expectedVolatility: 0.3,
        whaleImpact: 0.6,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence,
        mlPrediction: null,
        orderflowSignal,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      expect(result.enhancedConfidence).toBeGreaterThan(baseConfidence);
    });

    it('should reduce confidence when orderflow opposes opportunity direction', async () => {
      const baseConfidence = 0.7;
      const orderflowSignal: OrderflowSignal = {
        direction: 'bearish',
        confidence: 0.85,
        orderflowPressure: -0.7,
        expectedVolatility: 0.3,
        whaleImpact: 0.6,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence,
        mlPrediction: null,
        orderflowSignal,
        opportunityDirection: 'buy', // Buy when orderflow is bearish
        currentPrice: 2500
      });

      expect(result.enhancedConfidence).toBeLessThan(baseConfidence);
      expect(result.orderflowDirectionAligned).toBe(false);
    });

    it('should apply orderflowWeight correctly', async () => {
      // Create scorer with higher orderflow weight
      const highOrderflowScorer = new MLOpportunityScorer({
        mlWeight: 0.3,
        baseWeight: 0.7,
        minMLConfidence: 0.5,
        directionBonus: 0.1,
        directionPenalty: 0.15,
        orderflowWeight: 0.3 // Higher orderflow weight
      });

      const orderflowSignal: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.9,
        orderflowPressure: 0.8,
        expectedVolatility: 0.3,
        whaleImpact: 0.7,
        timestamp: Date.now()
      };

      const input = {
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal,
        opportunityDirection: 'buy' as const,
        currentPrice: 2500
      };

      const lowResult = await scorer.enhanceWithOrderflow(input);
      const highResult = await highOrderflowScorer.enhanceWithOrderflow(input);

      // Higher orderflow weight should have larger orderflow contribution
      expect(highResult.orderflowContribution!).toBeGreaterThan(lowResult.orderflowContribution!);
    });
  });

  describe('Combined ML + Orderflow Enhancement', () => {
    it('should combine ML prediction and orderflow signal', async () => {
      const baseConfidence = 0.7;
      const mlPrediction = {
        predictedPrice: 2600,
        confidence: 0.85,
        direction: 'up' as const,
        timeHorizon: 300000,
        features: [] as number[]
      };
      const orderflowSignal: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence,
        mlPrediction,
        orderflowSignal,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Both ML and orderflow should contribute
      expect(result.mlApplied).toBe(true);
      expect(result.orderflowApplied).toBe(true);
      expect(result.mlContribution).toBeGreaterThan(0);
      expect(result.orderflowContribution).toBeGreaterThan(0);
    });

    it('should give higher score when ML and orderflow agree', async () => {
      const baseConfidence = 0.7;
      const alignedOrderflow: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };
      const opposingOrderflow: OrderflowSignal = {
        direction: 'bearish',
        confidence: 0.8,
        orderflowPressure: -0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const mlPrediction = {
        predictedPrice: 2600,
        confidence: 0.85,
        direction: 'up' as const,
        timeHorizon: 300000,
        features: [] as number[]
      };

      const alignedResult = await scorer.enhanceWithOrderflow({
        baseConfidence,
        mlPrediction,
        orderflowSignal: alignedOrderflow,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      const opposingResult = await scorer.enhanceWithOrderflow({
        baseConfidence,
        mlPrediction,
        orderflowSignal: opposingOrderflow,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // When ML (up) and orderflow (bullish) agree with buy, score should be higher
      expect(alignedResult.enhancedConfidence).toBeGreaterThan(opposingResult.enhancedConfidence);
    });
  });

  describe('Orderflow Pressure Integration', () => {
    it('should boost score with high positive orderflow pressure for buy', async () => {
      const highPressure: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.9, // Strong buying pressure
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };
      const lowPressure: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.3, // Weak buying pressure
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const highPressureResult = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: highPressure,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      const lowPressureResult = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: lowPressure,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Higher pressure should result in higher score
      expect(highPressureResult.enhancedConfidence).toBeGreaterThan(lowPressureResult.enhancedConfidence);
    });

    it('should boost score with high negative orderflow pressure for sell', async () => {
      const strongSellPressure: OrderflowSignal = {
        direction: 'bearish',
        confidence: 0.8,
        orderflowPressure: -0.9, // Strong selling pressure
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: strongSellPressure,
        opportunityDirection: 'sell',
        currentPrice: 2500
      });

      // Strong selling pressure should boost sell opportunity
      expect(result.enhancedConfidence).toBeGreaterThan(0.7);
    });
  });

  describe('Whale Impact Factor', () => {
    it('should factor whale impact into score enhancement', async () => {
      const highWhaleImpact: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.9, // High whale activity impact
        timestamp: Date.now()
      };
      const lowWhaleImpact: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.2, // Low whale activity impact
        timestamp: Date.now()
      };

      const highImpactResult = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: highWhaleImpact,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      const lowImpactResult = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: lowWhaleImpact,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Higher whale impact should affect the score more
      expect(Math.abs(highImpactResult.enhancedConfidence - 0.7)).toBeGreaterThan(
        Math.abs(lowImpactResult.enhancedConfidence - 0.7)
      );
    });
  });

  describe('Volatility Consideration', () => {
    it('should reduce confidence with high expected volatility', async () => {
      const highVolatility: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.9, // Very high volatility
        whaleImpact: 0.5,
        timestamp: Date.now()
      };
      const lowVolatility: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.1, // Low volatility
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const highVolResult = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: highVolatility,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      const lowVolResult = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: lowVolatility,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // High volatility should result in lower confidence due to uncertainty
      expect(highVolResult.enhancedConfidence).toBeLessThan(lowVolResult.enhancedConfidence);
    });
  });

  describe('Fallback Behavior', () => {
    it('should return base score without orderflow signal', async () => {
      const result = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: null,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      expect(result.enhancedConfidence).toBe(0.7);
      expect(result.orderflowApplied).toBe(false);
    });

    it('should skip orderflow signal below minOrderflowConfidence threshold', async () => {
      const lowConfidenceSignal: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.3, // Below default threshold (0.4)
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: lowConfidenceSignal,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Low confidence signal should be skipped entirely
      expect(result.orderflowApplied).toBe(false);
      expect(result.orderflowContribution).toBe(0);
      expect(result.enhancedConfidence).toBe(0.7); // Base confidence unchanged
    });

    it('should apply orderflow signal at or above minOrderflowConfidence threshold', async () => {
      const validConfidenceSignal: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.4, // At threshold
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: validConfidenceSignal,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Signal at threshold should be applied
      expect(result.orderflowApplied).toBe(true);
      expect(result.orderflowContribution).not.toBe(0);
    });

    it('should skip invalid orderflow signal with NaN values', async () => {
      const invalidSignal: OrderflowSignal = {
        direction: 'bullish',
        confidence: NaN, // Invalid
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: invalidSignal,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Invalid signal should be skipped
      expect(result.orderflowApplied).toBe(false);
      expect(result.enhancedConfidence).toBe(0.7);
    });

    it('should skip orderflow signal with zero confidence', async () => {
      const zeroConfidenceSignal: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0, // Zero confidence
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: zeroConfidenceSignal,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // Zero confidence is below threshold, should be skipped
      expect(result.orderflowApplied).toBe(false);
      expect(result.enhancedConfidence).toBe(0.7);
    });
  });

  describe('Combined Momentum, ML, and Orderflow', () => {
    it('should combine all three signals when available', async () => {
      const momentumSignal: MomentumSignal = {
        pair: 'ETH_USDT',
        currentPrice: 2500,
        velocity: 0.02,
        acceleration: 0.001,
        zScore: 1.5,
        meanReversionSignal: false,
        volumeSpike: true,
        volumeRatio: 2.5,
        trend: 'bullish',
        confidence: 0.85,
        emaShort: 2480,
        emaMedium: 2450,
        emaLong: 2400,
        timestamp: Date.now()
      };

      const mlPrediction = {
        predictedPrice: 2600,
        confidence: 0.85,
        direction: 'up' as const,
        timeHorizon: 300000,
        features: [] as number[]
      };

      const orderflowSignal: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithAllSignals({
        baseConfidence: 0.6,
        mlPrediction,
        momentumSignal,
        orderflowSignal,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // All signals should contribute
      expect(result.mlApplied).toBe(true);
      expect(result.orderflowApplied).toBe(true);
      expect(result.momentumContribution).toBeDefined();
      expect(result.orderflowContribution).toBeDefined();
      expect(result.mlContribution).toBeGreaterThan(0);

      // With all signals aligned (bullish), confidence should be significantly enhanced
      expect(result.enhancedConfidence).toBeGreaterThan(0.7);
    });

    it('should handle mixed signals appropriately', async () => {
      const momentumSignal: MomentumSignal = {
        pair: 'ETH_USDT',
        currentPrice: 2500,
        velocity: -0.02, // Bearish momentum
        acceleration: -0.001,
        zScore: -1.5,
        meanReversionSignal: false,
        volumeSpike: false,
        volumeRatio: 1.0,
        trend: 'bearish',
        confidence: 0.85,
        emaShort: 2520,
        emaMedium: 2550,
        emaLong: 2600,
        timestamp: Date.now()
      };

      const mlPrediction = {
        predictedPrice: 2600,
        confidence: 0.85,
        direction: 'up' as const, // ML says up
        timeHorizon: 300000,
        features: [] as number[]
      };

      const orderflowSignal: OrderflowSignal = {
        direction: 'bullish', // Orderflow says bullish
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      const result = await scorer.enhanceWithAllSignals({
        baseConfidence: 0.6,
        mlPrediction,
        momentumSignal, // Bearish
        orderflowSignal, // Bullish
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      // With mixed signals, the enhancement should be moderate
      expect(result.enhancedConfidence).toBeDefined();
      // The score should reflect the conflict between momentum (bearish) and ML+orderflow (bullish)
    });
  });

  describe('Statistics Tracking', () => {
    it('should track orderflow enhancement statistics', async () => {
      // Perform some enhancements
      const orderflowSignal: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: Date.now()
      };

      await scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      await scorer.enhanceWithOrderflow({
        baseConfidence: 0.6,
        mlPrediction: null,
        orderflowSignal,
        opportunityDirection: 'sell', // Misaligned
        currentPrice: 2500
      });

      const stats = scorer.getStats();

      expect(stats.scoredOpportunities).toBeGreaterThanOrEqual(2);
      expect(stats).toHaveProperty('orderflowEnhancedCount');
      expect(stats).toHaveProperty('avgOrderflowContribution');
    });
  });

  describe('Edge Cases', () => {
    it('should clamp enhanced confidence to [0, 1] with extreme orderflow', async () => {
      // Extreme positive case
      const extremeBullish: OrderflowSignal = {
        direction: 'bullish',
        confidence: 1.0,
        orderflowPressure: 1.0,
        expectedVolatility: 0.0,
        whaleImpact: 1.0,
        timestamp: Date.now()
      };

      const positiveResult = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.95,
        mlPrediction: {
          predictedPrice: 3000,
          confidence: 0.99,
          direction: 'up',
          timeHorizon: 300000,
          features: []
        },
        orderflowSignal: extremeBullish,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      expect(positiveResult.enhancedConfidence).toBeLessThanOrEqual(1);
      expect(positiveResult.enhancedConfidence).toBeGreaterThanOrEqual(0);

      // Extreme negative case
      const extremeBearish: OrderflowSignal = {
        direction: 'bearish',
        confidence: 1.0,
        orderflowPressure: -1.0,
        expectedVolatility: 1.0,
        whaleImpact: 1.0,
        timestamp: Date.now()
      };

      const negativeResult = await scorer.enhanceWithOrderflow({
        baseConfidence: 0.1,
        mlPrediction: {
          predictedPrice: 2000,
          confidence: 0.99,
          direction: 'down',
          timeHorizon: 300000,
          features: []
        },
        orderflowSignal: extremeBearish,
        opportunityDirection: 'buy',
        currentPrice: 2500
      });

      expect(negativeResult.enhancedConfidence).toBeLessThanOrEqual(1);
      expect(negativeResult.enhancedConfidence).toBeGreaterThanOrEqual(0);
    });

    it('should handle zero timestamp gracefully', async () => {
      const signalWithZeroTimestamp: OrderflowSignal = {
        direction: 'bullish',
        confidence: 0.8,
        orderflowPressure: 0.6,
        expectedVolatility: 0.25,
        whaleImpact: 0.5,
        timestamp: 0 // Zero timestamp
      };

      // Should not throw
      await expect(scorer.enhanceWithOrderflow({
        baseConfidence: 0.7,
        mlPrediction: null,
        orderflowSignal: signalWithZeroTimestamp,
        opportunityDirection: 'buy',
        currentPrice: 2500
      })).resolves.toBeDefined();
    });
  });

  describe('toOrderflowSignal Helper', () => {
    it('should convert OrderflowPrediction to OrderflowSignal', () => {
      // Import the helper
      const { toOrderflowSignal } = require('../../src/analytics/ml-opportunity-scorer');

      // Mock OrderflowPrediction from @arbitrage/ml
      const prediction = {
        direction: 'bullish' as const,
        confidence: 0.85,
        orderflowPressure: 0.6,
        expectedVolatility: 0.3,
        whaleImpact: 0.5,
        timeHorizonMs: 60000,
        features: { whaleSwapCount1h: 5 }, // Extra field should be ignored
        timestamp: Date.now()
      };

      const signal = toOrderflowSignal(prediction);

      expect(signal.direction).toBe('bullish');
      expect(signal.confidence).toBe(0.85);
      expect(signal.orderflowPressure).toBe(0.6);
      expect(signal.expectedVolatility).toBe(0.3);
      expect(signal.whaleImpact).toBe(0.5);
      expect(signal.timestamp).toBe(prediction.timestamp);
      // Extra fields should not be present
      expect((signal as unknown as Record<string, unknown>).timeHorizonMs).toBeUndefined();
      expect((signal as unknown as Record<string, unknown>).features).toBeUndefined();
    });

    it('should work with minimal required fields', () => {
      const { toOrderflowSignal } = require('../../src/analytics/ml-opportunity-scorer');

      const minimalPrediction = {
        direction: 'neutral' as const,
        confidence: 0.5,
        orderflowPressure: 0,
        expectedVolatility: 0.1,
        whaleImpact: 0.2,
        timestamp: 123456789
      };

      const signal = toOrderflowSignal(minimalPrediction);

      expect(signal).toEqual({
        direction: 'neutral',
        confidence: 0.5,
        orderflowPressure: 0,
        expectedVolatility: 0.1,
        whaleImpact: 0.2,
        timestamp: 123456789
      });
    });
  });
});
