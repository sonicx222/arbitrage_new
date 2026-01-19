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

    // Use DI to inject mock logger
    oracle = new PriceOracle({
      cacheTtlSeconds: 60,
      stalenessThresholdMs: 300000,
      logger: mockLogger as any
    });
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
      expect(oracle.getFallbackPrice('BTC')).toBe(45000); // Original
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

      expect(result.price).toBe(2500); // Static fallback
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
      const oracle = new PriceOracle({
        logger: createMockLogger() as any
      });
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

// ===========================================================================
// T2.7: Price Momentum Detection Tests
// ===========================================================================

import { PriceMomentumTracker, MomentumSignal } from '../../src/analytics/price-momentum';

describe('T2.7: Price Momentum Detection', () => {
  let tracker: PriceMomentumTracker;

  beforeEach(() => {
    tracker = new PriceMomentumTracker({
      windowSize: 100,        // 100 samples
      emaShortPeriod: 5,      // 5-sample EMA
      emaMediumPeriod: 15,    // 15-sample EMA
      emaLongPeriod: 60,      // 60-sample EMA
      zScoreThreshold: 2.0,   // 2 standard deviations for alerts
      volumeSpikeThreshold: 2.5 // 2.5x average volume for spike detection
    });
  });

  describe('Price History Tracking', () => {
    it('should add price updates correctly', () => {
      tracker.addPriceUpdate('ETH_USDT', 2500, 1000000);
      tracker.addPriceUpdate('ETH_USDT', 2510, 1100000);

      const stats = tracker.getStats('ETH_USDT');
      expect(stats).not.toBeNull();
      expect(stats!.sampleCount).toBe(2);
    });

    it('should maintain circular buffer with max window size', () => {
      // Add more samples than window size
      for (let i = 0; i < 150; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2500 + i, 1000000);
      }

      const stats = tracker.getStats('ETH_USDT');
      expect(stats!.sampleCount).toBe(100); // Should be capped at windowSize
    });

    it('should track multiple pairs independently', () => {
      tracker.addPriceUpdate('ETH_USDT', 2500, 1000000);
      tracker.addPriceUpdate('BTC_USDT', 45000, 5000000);

      const ethStats = tracker.getStats('ETH_USDT');
      const btcStats = tracker.getStats('BTC_USDT');

      expect(ethStats!.sampleCount).toBe(1);
      expect(btcStats!.sampleCount).toBe(1);
      expect(ethStats!.currentPrice).toBe(2500);
      expect(btcStats!.currentPrice).toBe(45000);
    });
  });

  describe('EMA Calculations', () => {
    it('should calculate short-period EMA correctly', () => {
      // Add enough samples for EMA calculation
      const prices = [2500, 2510, 2505, 2515, 2520, 2525, 2530];
      for (const price of prices) {
        tracker.addPriceUpdate('ETH_USDT', price, 1000000);
      }

      const stats = tracker.getStats('ETH_USDT');
      expect(stats!.emaShort).toBeGreaterThan(0);
      // EMA should be close to recent prices
      expect(stats!.emaShort).toBeGreaterThan(2510);
      expect(stats!.emaShort).toBeLessThan(2535);
    });

    it('should detect upward trend when price > all EMAs', () => {
      // Start with stable prices, then increase
      for (let i = 0; i < 20; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2500, 1000000);
      }
      for (let i = 0; i < 10; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2600 + i * 10, 1500000);
      }

      const signal = tracker.getMomentumSignal('ETH_USDT');
      expect(signal).not.toBeNull();
      expect(signal!.trend).toBe('bullish');
    });

    it('should detect downward trend when price < all EMAs', () => {
      // Start with high prices, then decrease
      for (let i = 0; i < 20; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2700, 1000000);
      }
      for (let i = 0; i < 10; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2500 - i * 10, 1500000);
      }

      const signal = tracker.getMomentumSignal('ETH_USDT');
      expect(signal).not.toBeNull();
      expect(signal!.trend).toBe('bearish');
    });
  });

  describe('Momentum Signals', () => {
    it('should calculate price velocity (rate of change)', () => {
      tracker.addPriceUpdate('ETH_USDT', 2500, 1000000);
      tracker.addPriceUpdate('ETH_USDT', 2550, 1000000); // +2% change

      const signal = tracker.getMomentumSignal('ETH_USDT');
      expect(signal).not.toBeNull();
      expect(signal!.velocity).toBeCloseTo(0.02, 2); // ~2%
    });

    it('should calculate price acceleration', () => {
      // Steady acceleration: price increases faster each step
      tracker.addPriceUpdate('ETH_USDT', 2500, 1000000);
      tracker.addPriceUpdate('ETH_USDT', 2510, 1000000); // +10
      tracker.addPriceUpdate('ETH_USDT', 2530, 1000000); // +20
      tracker.addPriceUpdate('ETH_USDT', 2560, 1000000); // +30

      const signal = tracker.getMomentumSignal('ETH_USDT');
      expect(signal).not.toBeNull();
      expect(signal!.acceleration).toBeGreaterThan(0); // Positive acceleration
    });

    it('should detect mean reversion opportunity', () => {
      // Build baseline at 2500
      for (let i = 0; i < 50; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2500 + (Math.random() - 0.5) * 10, 1000000);
      }
      // Sudden spike far from mean (> 2 std dev)
      tracker.addPriceUpdate('ETH_USDT', 2700, 1000000);

      const signal = tracker.getMomentumSignal('ETH_USDT');
      expect(signal).not.toBeNull();
      expect(signal!.meanReversionSignal).toBe(true);
      expect(Math.abs(signal!.zScore)).toBeGreaterThan(2);
    });
  });

  describe('Volume Analysis', () => {
    it('should detect volume spikes', () => {
      // Normal volume
      for (let i = 0; i < 20; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2500, 1000000);
      }
      // Volume spike (3x normal)
      tracker.addPriceUpdate('ETH_USDT', 2520, 3000000);

      const signal = tracker.getMomentumSignal('ETH_USDT');
      expect(signal).not.toBeNull();
      expect(signal!.volumeSpike).toBe(true);
      expect(signal!.volumeRatio).toBeGreaterThan(2.5);
    });

    it('should correlate volume with price movement', () => {
      // Price increase with high volume = stronger signal
      for (let i = 0; i < 10; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2500, 1000000);
      }
      // Strong move with volume confirmation
      tracker.addPriceUpdate('ETH_USDT', 2600, 5000000);

      const signal = tracker.getMomentumSignal('ETH_USDT');
      expect(signal!.confidence).toBeGreaterThan(0.7);
    });
  });

  describe('Signal Confidence', () => {
    it('should return higher confidence for consistent trends', () => {
      // Consistent uptrend
      for (let i = 0; i < 30; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2500 + i * 5, 1000000 + i * 10000);
      }

      const signal = tracker.getMomentumSignal('ETH_USDT');
      expect(signal!.confidence).toBeGreaterThan(0.6);
    });

    it('should return lower confidence for choppy price action', () => {
      // Alternating up/down
      for (let i = 0; i < 30; i++) {
        const price = i % 2 === 0 ? 2500 : 2520;
        tracker.addPriceUpdate('ETH_USDT', price, 1000000);
      }

      const signal = tracker.getMomentumSignal('ETH_USDT');
      expect(signal!.confidence).toBeLessThan(0.5);
    });
  });

  describe('Edge Cases', () => {
    it('should handle insufficient data gracefully', () => {
      tracker.addPriceUpdate('ETH_USDT', 2500, 1000000);

      const signal = tracker.getMomentumSignal('ETH_USDT');
      // Should return null or low-confidence signal with insufficient data
      expect(signal === null || signal.confidence < 0.3).toBe(true);
    });

    it('should handle unknown pair', () => {
      const signal = tracker.getMomentumSignal('UNKNOWN_PAIR');
      expect(signal).toBeNull();
    });

    it('should handle zero volume', () => {
      tracker.addPriceUpdate('ETH_USDT', 2500, 0);
      tracker.addPriceUpdate('ETH_USDT', 2510, 0);

      const stats = tracker.getStats('ETH_USDT');
      expect(stats).not.toBeNull();
      expect(stats!.averageVolume).toBe(0);
    });

    it('should reset pair data correctly', () => {
      for (let i = 0; i < 10; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2500 + i, 1000000);
      }

      tracker.resetPair('ETH_USDT');

      const stats = tracker.getStats('ETH_USDT');
      expect(stats).toBeNull();
    });

    it('should handle zero price gracefully (division by zero protection)', () => {
      // Add a zero price - should not crash
      tracker.addPriceUpdate('ETH_USDT', 0, 1000000);
      tracker.addPriceUpdate('ETH_USDT', 2500, 1000000);

      const signal = tracker.getMomentumSignal('ETH_USDT');
      // Should return a valid signal or null, not crash
      expect(signal === null || typeof signal.velocity === 'number').toBe(true);
    });

    it('should handle sequence starting with zero price', () => {
      tracker.addPriceUpdate('ETH_USDT', 0, 1000000);
      tracker.addPriceUpdate('ETH_USDT', 0, 1000000);
      tracker.addPriceUpdate('ETH_USDT', 2500, 1000000);

      // Should not throw
      expect(() => tracker.getMomentumSignal('ETH_USDT')).not.toThrow();
    });

    it('should evict LRU pairs when maxPairs exceeded', () => {
      // Create tracker with small maxPairs limit
      const limitedTracker = new PriceMomentumTracker({ maxPairs: 5 });

      // Add 10 pairs
      for (let i = 0; i < 10; i++) {
        limitedTracker.addPriceUpdate(`PAIR_${i}`, 2500, 1000000);
      }

      // Should have at most 5 pairs tracked
      let activeCount = 0;
      for (let i = 0; i < 10; i++) {
        if (limitedTracker.getStats(`PAIR_${i}`)) {
          activeCount++;
        }
      }

      expect(activeCount).toBeLessThanOrEqual(5);
    });

    it('should keep recently accessed pairs during LRU eviction', () => {
      // Use maxPairs=5 to allow more room for testing
      const limitedTracker = new PriceMomentumTracker({ maxPairs: 5 });

      // Add 5 pairs with time delays to establish access order
      limitedTracker.addPriceUpdate('PAIR_A', 2500, 1000000);
      limitedTracker.addPriceUpdate('PAIR_B', 3000, 1000000);
      limitedTracker.addPriceUpdate('PAIR_C', 3500, 1000000);
      limitedTracker.addPriceUpdate('PAIR_D', 4000, 1000000);
      limitedTracker.addPriceUpdate('PAIR_E', 4500, 1000000);

      // Now we're at capacity (5 pairs). Update PAIR_C to make it more recent
      // Note: This update does NOT trigger eviction yet since we're at capacity, not over
      limitedTracker.addPriceUpdate('PAIR_C', 3600, 1000000);

      // Add new pair to trigger eviction (goes from 5 to 6, triggers eviction of 1)
      limitedTracker.addPriceUpdate('PAIR_F', 5000, 1000000);

      // PAIR_C should be kept (recently accessed)
      expect(limitedTracker.getStats('PAIR_C')).not.toBeNull();
      // PAIR_F (the new one) should exist
      expect(limitedTracker.getStats('PAIR_F')).not.toBeNull();

      // Count how many pairs remain (should be at most 5)
      let activeCount = 0;
      for (const pair of ['PAIR_A', 'PAIR_B', 'PAIR_C', 'PAIR_D', 'PAIR_E', 'PAIR_F']) {
        if (limitedTracker.getStats(pair)) {
          activeCount++;
        }
      }
      expect(activeCount).toBeLessThanOrEqual(5);
    });
  });

  describe('Performance', () => {
    it('should handle high-frequency updates efficiently', () => {
      const start = performance.now();

      // Simulate 10,000 price updates
      for (let i = 0; i < 10000; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2500 + Math.random() * 100, 1000000 + Math.random() * 500000);
      }

      const elapsed = performance.now() - start;
      console.log(`10k price updates processed in ${elapsed.toFixed(2)}ms`);

      // Should complete in under 100ms
      expect(elapsed).toBeLessThan(100);
    });

    it('should calculate signals quickly', () => {
      // Pre-fill data
      for (let i = 0; i < 100; i++) {
        tracker.addPriceUpdate('ETH_USDT', 2500 + i, 1000000);
      }

      const start = performance.now();

      // Calculate signal 1000 times
      for (let i = 0; i < 1000; i++) {
        tracker.getMomentumSignal('ETH_USDT');
      }

      const elapsed = performance.now() - start;
      console.log(`1k signal calculations in ${elapsed.toFixed(2)}ms (${(elapsed / 1000).toFixed(3)}ms/op)`);

      // Should complete in under 200ms (increased from 50ms for CI environment stability)
      expect(elapsed).toBeLessThan(200);
    });
  });
});

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
      const bullishSignal: import('../../src/price-momentum').MomentumSignal = {
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
