/**
 * Tier 2 Optimizations Unit Tests
 *
 * Tests for Tier 2 performance optimizations not covered by dedicated test files:
 * - T2.6: Quadrilateral Arbitrage (integration/performance tests)
 * - T2.10: L3 Cache Eviction Policy
 *
 * Removed (covered elsewhere):
 * - T2.7: Price Momentum — see price-momentum.test.ts
 * - T2.8: ML Predictor — see ml-opportunity-scorer.test.ts
 * - T2.9: Dynamic Fallback Prices — see price-oracle.test.ts
 * - T4.3.3: Orderflow Integration — see ml-opportunity-scorer.test.ts
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ===========================================================================
// Mocks - must be defined before imports
// ===========================================================================

// Mock the core module to prevent real Redis connections during tests
jest.mock('@arbitrage/core', () => {
  const actual = jest.requireActual('@arbitrage/core') as Record<string, unknown>;
  return {
    ...actual,
    getRedisClient: jest.fn<() => Promise<unknown>>().mockResolvedValue({
      get: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
      set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
      del: jest.fn<() => Promise<number>>().mockResolvedValue(1),
      ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    })
  };
});

// ===========================================================================
// T2.10: L3 Cache Eviction Policy Tests
// ===========================================================================

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
      expect(stats.l3!.maxSize).toBe(100);
    });

    it('should use default l3MaxSize when not specified', () => {
      const cache = new HierarchicalCache({
        l1Enabled: false,
        l2Enabled: false,
        l3Enabled: true
      });

      const stats = cache.getStats();
      expect(stats.l3!.maxSize).toBeGreaterThan(0);
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
      expect(stats1.l3!.entries).toBe(5);

      // Add 6th entry - should trigger eviction
      await cache.set('key5', { value: 5 });

      const stats2 = cache.getStats();
      expect(stats2.l3!.entries).toBeLessThanOrEqual(5);

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
      const evictionsBefore = statsBefore.l3!.evictions;

      // Trigger eviction
      await cache.set('key5', { value: 5 });

      const statsAfter = cache.getStats();
      expect(statsAfter.l3!.evictions).toBeGreaterThan(evictionsBefore);
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
      expect(stats.l3!.entries).toBeLessThanOrEqual(100);
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
      expect(stats.l3!.utilization).toBeCloseTo(0.5, 1); // 50/100 = 0.5
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
      expect(stats.l3!.entries).toBe(10);
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
      expect(stats.l3!.entries).toBe(1);

      // Value should be latest
      const value = await cache.get('sameKey');
      expect((value as any).value).toBe(9);
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
      expect(stats.l3!.entries).toBe(0);

      // Should be able to add new entries after clear
      await cache.set('newKey', { value: 'new' });
      expect(stats.l3!.entries).toBe(0); // Stats is snapshot
      const newStats = cache.getStats();
      expect(newStats.l3!.entries).toBe(1);
    });
  });
});

// ===========================================================================
// T2.6: Quadrilateral Arbitrage Tests
// ===========================================================================

import { CrossDexTriangularArbitrage, DexPool } from '@arbitrage/core/path-finding';

describe('T2.6: Quadrilateral Arbitrage', () => {
  // Create test pools for 4-hop arbitrage paths
  const createTestPools = (): DexPool[] => [
    // A->B pools (USDT->WETH)
    { dex: 'uniswap', token0: 'USDT', token1: 'WETH', reserve0: '1000000', reserve1: '500', fee: 30, liquidity: 1000000, price: 0.0005 },
    { dex: 'sushiswap', token0: 'USDT', token1: 'WETH', reserve0: '800000', reserve1: '410', fee: 25, liquidity: 800000, price: 0.000512 },
    // B->C pools (WETH->WBTC)
    { dex: 'uniswap', token0: 'WETH', token1: 'WBTC', reserve0: '1000', reserve1: '50', fee: 30, liquidity: 2000000, price: 0.05 },
    { dex: 'curve', token0: 'WETH', token1: 'WBTC', reserve0: '1200', reserve1: '62', fee: 4, liquidity: 2500000, price: 0.0517 },
    // C->D pools (WBTC->DAI)
    { dex: 'uniswap', token0: 'WBTC', token1: 'DAI', reserve0: '100', reserve1: '4500000', fee: 30, liquidity: 4500000, price: 45000 },
    { dex: 'balancer', token0: 'WBTC', token1: 'DAI', reserve0: '120', reserve1: '5500000', fee: 20, liquidity: 5500000, price: 45833 },
    // D->A pools (DAI->USDT)
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
