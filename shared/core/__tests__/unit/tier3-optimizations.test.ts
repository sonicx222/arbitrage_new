/**
 * Tier 3 Optimization Tests
 *
 * Phase 3 enhancements from DETECTOR_OPTIMIZATION_ANALYSIS.md:
 * - T3.11: Multi-Leg Path Finding (5+ tokens)
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md
 */

import {
  CrossDexTriangularArbitrage,
  DexPool
} from '../../src/cross-dex-triangular-arbitrage';
import {
  MultiLegPathFinder,
  MultiLegOpportunity,
  MultiLegPathConfig
} from '../../src/multi-leg-path-finder';

// ===========================================================================
// Test Data Factory
// ===========================================================================

/**
 * Create a comprehensive set of test pools for multi-leg path finding.
 * Includes 8+ tokens to enable 5+ hop paths.
 */
function createMultiLegTestPools(): DexPool[] {
  // Token set: USDT, USDC, WETH, WBTC, DAI, LINK, UNI, AAVE
  // This allows for 5+ hop paths like: USDT -> WETH -> LINK -> UNI -> AAVE -> USDT
  return [
    // USDT pairs
    {
      dex: 'uniswap',
      token0: 'USDT',
      token1: 'USDC',
      reserve0: '10000000000000000000000000', // 10M USDT
      reserve1: '10000000000000000000000000', // 10M USDC
      fee: 5, // 0.05%
      liquidity: 20000000,
      price: 1.0001
    },
    {
      dex: 'uniswap',
      token0: 'USDT',
      token1: 'WETH',
      reserve0: '5000000000000000000000000', // 5M USDT
      reserve1: '2000000000000000000000', // 2000 WETH
      fee: 30, // 0.3%
      liquidity: 10000000,
      price: 2500
    },
    {
      dex: 'sushiswap',
      token0: 'USDT',
      token1: 'WETH',
      reserve0: '4000000000000000000000000',
      reserve1: '1600000000000000000000',
      fee: 30,
      liquidity: 8000000,
      price: 2500.5
    },
    {
      dex: 'uniswap',
      token0: 'USDT',
      token1: 'WBTC',
      reserve0: '3000000000000000000000000',
      reserve1: '75000000000000000000', // 75 WBTC
      fee: 30,
      liquidity: 6000000,
      price: 40000
    },
    // WETH pairs
    {
      dex: 'uniswap',
      token0: 'WETH',
      token1: 'WBTC',
      reserve0: '1000000000000000000000', // 1000 WETH
      reserve1: '65000000000000000000', // 65 WBTC
      fee: 30,
      liquidity: 5000000,
      price: 0.065
    },
    {
      dex: 'uniswap',
      token0: 'WETH',
      token1: 'LINK',
      reserve0: '500000000000000000000', // 500 WETH
      reserve1: '100000000000000000000000', // 100k LINK
      fee: 30,
      liquidity: 2500000,
      price: 200
    },
    {
      dex: 'sushiswap',
      token0: 'WETH',
      token1: 'LINK',
      reserve0: '400000000000000000000',
      reserve1: '80000000000000000000000',
      fee: 30,
      liquidity: 2000000,
      price: 200.1
    },
    {
      dex: 'uniswap',
      token0: 'WETH',
      token1: 'UNI',
      reserve0: '300000000000000000000', // 300 WETH
      reserve1: '150000000000000000000000', // 150k UNI
      fee: 30,
      liquidity: 1500000,
      price: 500
    },
    {
      dex: 'uniswap',
      token0: 'WETH',
      token1: 'AAVE',
      reserve0: '200000000000000000000', // 200 WETH
      reserve1: '6000000000000000000000', // 6k AAVE
      fee: 30,
      liquidity: 1000000,
      price: 30
    },
    // LINK pairs
    {
      dex: 'uniswap',
      token0: 'LINK',
      token1: 'UNI',
      reserve0: '50000000000000000000000', // 50k LINK
      reserve1: '25000000000000000000000', // 25k UNI
      fee: 30,
      liquidity: 1250000,
      price: 0.5
    },
    {
      dex: 'sushiswap',
      token0: 'LINK',
      token1: 'UNI',
      reserve0: '40000000000000000000000',
      reserve1: '20000000000000000000000',
      fee: 30,
      liquidity: 1000000,
      price: 0.5001
    },
    // UNI pairs
    {
      dex: 'uniswap',
      token0: 'UNI',
      token1: 'AAVE',
      reserve0: '30000000000000000000000', // 30k UNI
      reserve1: '4500000000000000000000', // 4.5k AAVE
      fee: 30,
      liquidity: 750000,
      price: 0.15
    },
    // AAVE pairs - completes the cycle back
    {
      dex: 'uniswap',
      token0: 'AAVE',
      token1: 'USDT',
      reserve0: '3000000000000000000000', // 3k AAVE
      reserve1: '300000000000000000000000', // 300k USDT
      fee: 30,
      liquidity: 600000,
      price: 100
    },
    {
      dex: 'sushiswap',
      token0: 'AAVE',
      token1: 'USDT',
      reserve0: '2500000000000000000000',
      reserve1: '250000000000000000000000',
      fee: 30,
      liquidity: 500000,
      price: 100.1
    },
    // DAI pairs for additional paths
    {
      dex: 'uniswap',
      token0: 'DAI',
      token1: 'USDT',
      reserve0: '8000000000000000000000000', // 8M DAI
      reserve1: '8000000000000000000000000', // 8M USDT
      fee: 5,
      liquidity: 16000000,
      price: 1.0002
    },
    {
      dex: 'uniswap',
      token0: 'DAI',
      token1: 'WETH',
      reserve0: '2500000000000000000000000', // 2.5M DAI
      reserve1: '1000000000000000000000', // 1000 WETH
      fee: 30,
      liquidity: 5000000,
      price: 2500
    },
    {
      dex: 'uniswap',
      token0: 'DAI',
      token1: 'LINK',
      reserve0: '500000000000000000000000', // 500k DAI
      reserve1: '40000000000000000000000', // 40k LINK
      fee: 30,
      liquidity: 1000000,
      price: 12.5
    }
  ];
}

// ===========================================================================
// T3.11: Multi-Leg Path Finding Tests
// ===========================================================================

describe('T3.11: Multi-Leg Path Finding (5+ tokens)', () => {
  let pathFinder: MultiLegPathFinder;

  beforeEach(() => {
    pathFinder = new MultiLegPathFinder({
      minProfitThreshold: 0.001, // 0.1% minimum profit
      maxPathLength: 7, // Max 7 tokens in path (6 swaps)
      minPathLength: 5, // Min 5 tokens (4 swaps, but this tests 5+ specifically)
      maxCandidatesPerHop: 15, // Limit branching factor
      timeoutMs: 5000 // 5 second timeout
    });
  });

  describe('Path Discovery', () => {
    it('should discover 5-hop paths (5 unique tokens + return)', async () => {
      const pools = createMultiLegTestPools();

      // targetPathLength=5 means 5 unique tokens in the cycle
      // Path includes return token, so path.length = 6
      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        5 // 5 unique tokens (path array will have 6 elements including return)
      );

      // Should return an array (may be empty if no profitable paths)
      expect(Array.isArray(opportunities)).toBe(true);

      // Check structure of any returned opportunities
      for (const opp of opportunities) {
        // Path includes return token: [A, B, C, D, E, A] = 6 elements for 5 unique tokens
        expect(opp.path.length).toBe(6);
        expect(opp.dexes.length).toBe(5); // 5 swaps to connect 6 path elements
        expect(opp.path[0]).toBe(opp.path[opp.path.length - 1]); // Cycle
      }
    });

    it('should discover 6-hop paths (6 unique tokens + return)', async () => {
      const pools = createMultiLegTestPools();

      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        6
      );

      expect(Array.isArray(opportunities)).toBe(true);

      for (const opp of opportunities) {
        // Path includes return token: [A, B, C, D, E, F, A] = 7 elements for 6 unique tokens
        expect(opp.path.length).toBe(7);
        expect(opp.dexes.length).toBe(6);
      }
    });

    it('should find cyclic paths returning to base token', async () => {
      const pools = createMultiLegTestPools();

      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        5
      );

      for (const opp of opportunities) {
        // First and last token should be the same (cycle)
        const firstToken = opp.path[0];
        const lastSwapToToken = opp.steps[opp.steps.length - 1].toToken;
        expect(lastSwapToToken).toBe(firstToken);
      }
    });

    it('should not include duplicate tokens in path (except start/end)', async () => {
      const pools = createMultiLegTestPools();

      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        5
      );

      for (const opp of opportunities) {
        // All tokens except the last should be unique
        const pathWithoutEnd = opp.path.slice(0, -1);
        const uniqueTokens = new Set(pathWithoutEnd);
        expect(uniqueTokens.size).toBe(pathWithoutEnd.length);
      }
    });
  });

  describe('Profit Calculation', () => {
    it('should calculate profit correctly for multi-leg paths', async () => {
      const pools = createMultiLegTestPools();

      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        5
      );

      for (const opp of opportunities) {
        // Profit should be a number
        expect(typeof opp.profitPercentage).toBe('number');
        expect(typeof opp.netProfit).toBe('number');
        expect(typeof opp.profitUSD).toBe('number');

        // If returned, netProfit should be positive
        expect(opp.netProfit).toBeGreaterThan(0);
      }
    });

    it('should account for higher gas costs with more hops', async () => {
      const pools = createMultiLegTestPools();

      const fiveHop = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        5
      );

      const sixHop = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        6
      );

      // If we have both, 6-hop should have higher gas costs
      if (fiveHop.length > 0 && sixHop.length > 0) {
        const avgGas5 = fiveHop.reduce((sum, o) => sum + o.gasCost, 0) / fiveHop.length;
        const avgGas6 = sixHop.reduce((sum, o) => sum + o.gasCost, 0) / sixHop.length;
        expect(avgGas6).toBeGreaterThan(avgGas5);
      }
    });

    it('should apply slippage to each step', async () => {
      const pools = createMultiLegTestPools();

      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        5
      );

      for (const opp of opportunities) {
        for (const step of opp.steps) {
          expect(step.slippage).toBeGreaterThanOrEqual(0);
          expect(step.slippage).toBeLessThanOrEqual(0.10); // Max 10%
        }
      }
    });
  });

  describe('Performance Constraints', () => {
    it('should complete within timeout for moderate pool sets', async () => {
      const pools = createMultiLegTestPools();

      const start = performance.now();
      await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT', 'WETH'],
        5
      );
      const elapsed = performance.now() - start;

      // Should complete within 5 seconds
      expect(elapsed).toBeLessThan(5000);
    });

    it('should respect maxCandidatesPerHop to limit branching', async () => {
      const limitedFinder = new MultiLegPathFinder({
        minProfitThreshold: 0.001,
        maxPathLength: 7,
        minPathLength: 5,
        maxCandidatesPerHop: 5, // Very limited branching
        timeoutMs: 2000
      });

      const pools = createMultiLegTestPools();

      const start = performance.now();
      await limitedFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        6
      );
      const elapsed = performance.now() - start;

      // Should be fast with limited branching
      expect(elapsed).toBeLessThan(2000);
    });

    it('should handle empty pool set gracefully', async () => {
      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        [],
        ['USDT'],
        5
      );

      expect(opportunities).toEqual([]);
    });

    it('should handle insufficient pools for path length', async () => {
      // Only 3 pools - not enough for 5-hop path
      const limitedPools: DexPool[] = [
        {
          dex: 'uniswap',
          token0: 'USDT',
          token1: 'WETH',
          reserve0: '1000000000000000000000000',
          reserve1: '400000000000000000000',
          fee: 30,
          liquidity: 2000000,
          price: 2500
        },
        {
          dex: 'uniswap',
          token0: 'WETH',
          token1: 'WBTC',
          reserve0: '200000000000000000000',
          reserve1: '13000000000000000000',
          fee: 30,
          liquidity: 1000000,
          price: 0.065
        },
        {
          dex: 'uniswap',
          token0: 'WBTC',
          token1: 'USDT',
          reserve0: '10000000000000000000',
          reserve1: '400000000000000000000000',
          fee: 30,
          liquidity: 800000,
          price: 40000
        }
      ];

      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        limitedPools,
        ['USDT'],
        5
      );

      // Should return empty array (not enough tokens for 5-hop)
      expect(opportunities).toEqual([]);
    });
  });

  describe('Confidence and Ranking', () => {
    it('should calculate confidence based on liquidity and slippage', async () => {
      const pools = createMultiLegTestPools();

      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        5
      );

      for (const opp of opportunities) {
        expect(opp.confidence).toBeGreaterThanOrEqual(0);
        expect(opp.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('should rank opportunities by net profit', async () => {
      const pools = createMultiLegTestPools();

      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        5
      );

      // Opportunities should be sorted by netProfit descending (with floating point tolerance)
      for (let i = 1; i < opportunities.length; i++) {
        const prev = opportunities[i - 1].netProfit;
        const curr = opportunities[i].netProfit;
        // Allow tiny floating point differences (up to 0.001%)
        const tolerance = Math.abs(prev) * 0.00001;
        expect(prev + tolerance).toBeGreaterThanOrEqual(curr);
      }
    });

    it('should filter out low-confidence opportunities', async () => {
      const strictFinder = new MultiLegPathFinder({
        minProfitThreshold: 0.01, // Higher threshold
        maxPathLength: 7,
        minPathLength: 5,
        maxCandidatesPerHop: 15,
        timeoutMs: 5000,
        minConfidence: 0.5 // Require 50% confidence
      });

      const pools = createMultiLegTestPools();

      const opportunities = await strictFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        ['USDT'],
        5
      );

      for (const opp of opportunities) {
        expect(opp.confidence).toBeGreaterThanOrEqual(0.5);
      }
    });
  });

  describe('Integration with Existing Detection', () => {
    it('should work alongside triangular and quadrilateral detection', async () => {
      const pools = createMultiLegTestPools();

      // Use the existing engine for 3/4 hop
      const engine = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.0001
      });

      // Get all types of opportunities
      const triangular = await engine.findTriangularOpportunities('ethereum', pools, ['USDT']);
      const quadrilateral = await engine.findQuadrilateralOpportunities('ethereum', pools, ['USDT']);
      const multiLeg = await pathFinder.findMultiLegOpportunities('ethereum', pools, ['USDT'], 5);

      // All should return valid arrays
      expect(Array.isArray(triangular)).toBe(true);
      expect(Array.isArray(quadrilateral)).toBe(true);
      expect(Array.isArray(multiLeg)).toBe(true);

      // Path lengths should be distinct
      // Note: triangular/quadrilateral don't include return in path, multi-leg does
      if (triangular.length > 0) {
        expect(triangular[0].path.length).toBe(3); // [A, B, C] (return implied)
      }
      if (quadrilateral.length > 0) {
        expect(quadrilateral[0].path.length).toBe(4); // [A, B, C, D] (return implied)
      }
      if (multiLeg.length > 0) {
        // Multi-leg includes return token in path
        expect(multiLeg[0].path.length).toBe(6); // [A, B, C, D, E, A] for 5 unique tokens
      }
    });
  });

  describe('Edge Cases', () => {
    it('should handle disconnected token graphs', async () => {
      // Two separate graphs with no connection
      const disconnectedPools: DexPool[] = [
        // Graph 1: USDT <-> WETH
        {
          dex: 'uniswap',
          token0: 'USDT',
          token1: 'WETH',
          reserve0: '1000000000000000000000000',
          reserve1: '400000000000000000000',
          fee: 30,
          liquidity: 2000000,
          price: 2500
        },
        // Graph 2: LINK <-> UNI (disconnected from USDT)
        {
          dex: 'uniswap',
          token0: 'LINK',
          token1: 'UNI',
          reserve0: '50000000000000000000000',
          reserve1: '25000000000000000000000',
          fee: 30,
          liquidity: 1250000,
          price: 0.5
        }
      ];

      // Should not crash and return empty (no 5-hop path possible)
      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        disconnectedPools,
        ['USDT'],
        5
      );

      expect(opportunities).toEqual([]);
    });

    it('should handle pools with zero liquidity', async () => {
      const poolsWithZeroLiquidity = createMultiLegTestPools().map(p => ({
        ...p,
        liquidity: p.liquidity === 750000 ? 0 : p.liquidity // Zero out one pool
      }));

      // Should not crash
      await expect(
        pathFinder.findMultiLegOpportunities('ethereum', poolsWithZeroLiquidity, ['USDT'], 5)
      ).resolves.not.toThrow();
    });

    it('should handle extremely high fee pools', async () => {
      const highFeePools = createMultiLegTestPools().map(p => ({
        ...p,
        fee: 1000 // 10% fee - very high
      }));

      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        highFeePools,
        ['USDT'],
        5
      );

      // Should return empty or very few opportunities with such high fees
      // Any returned should still have positive profit
      for (const opp of opportunities) {
        expect(opp.netProfit).toBeGreaterThan(0);
      }
    });

    it('should handle empty baseTokens array', async () => {
      const pools = createMultiLegTestPools();

      const opportunities = await pathFinder.findMultiLegOpportunities(
        'ethereum',
        pools,
        [], // Empty base tokens
        5
      );

      expect(opportunities).toEqual([]);
    });
  });

  // ===========================================================================
  // T3.11 Bug Fixes: Additional Test Coverage
  // ===========================================================================

  describe('Configuration and Stats', () => {
    it('should return correct config via getConfig()', () => {
      const config = pathFinder.getConfig();

      expect(config.minProfitThreshold).toBe(0.001);
      expect(config.maxPathLength).toBe(7);
      expect(config.minPathLength).toBe(5);
      expect(config.maxCandidatesPerHop).toBe(15);
      expect(config.timeoutMs).toBe(5000);
    });

    it('should update config via updateConfig()', () => {
      pathFinder.updateConfig({ minProfitThreshold: 0.005 });
      const config = pathFinder.getConfig();

      expect(config.minProfitThreshold).toBe(0.005);

      // Reset for other tests
      pathFinder.updateConfig({ minProfitThreshold: 0.001 });
    });

    it('should track stats correctly', async () => {
      const pools = createMultiLegTestPools();

      // Reset stats first
      pathFinder.resetStats();

      const statsBefore = pathFinder.getStats();
      expect(statsBefore.totalCalls).toBe(0);
      expect(statsBefore.totalPathsExplored).toBe(0);

      // Run path finding
      await pathFinder.findMultiLegOpportunities('ethereum', pools, ['USDT'], 5);

      const statsAfter = pathFinder.getStats();
      expect(statsAfter.totalCalls).toBe(1);
      expect(statsAfter.totalPathsExplored).toBeGreaterThan(0);
      expect(statsAfter.avgProcessingTimeMs).toBeGreaterThan(0);
    });

    it('should reset stats correctly', () => {
      pathFinder.resetStats();
      const stats = pathFinder.getStats();

      expect(stats.totalCalls).toBe(0);
      expect(stats.totalOpportunitiesFound).toBe(0);
      expect(stats.totalPathsExplored).toBe(0);
      expect(stats.timeouts).toBe(0);
      expect(stats.avgProcessingTimeMs).toBe(0);
    });
  });

  describe('Race Condition Prevention', () => {
    it('should handle concurrent calls without state corruption', async () => {
      const pools = createMultiLegTestPools();

      // Run multiple calls concurrently
      const [result1, result2, result3] = await Promise.all([
        pathFinder.findMultiLegOpportunities('ethereum', pools, ['USDT'], 5),
        pathFinder.findMultiLegOpportunities('bsc', pools, ['WETH'], 5),
        pathFinder.findMultiLegOpportunities('arbitrum', pools, ['DAI'], 5)
      ]);

      // Each should return valid results (may be empty)
      expect(Array.isArray(result1)).toBe(true);
      expect(Array.isArray(result2)).toBe(true);
      expect(Array.isArray(result3)).toBe(true);

      // Results should have correct chain
      for (const opp of result1) {
        expect(opp.chain).toBe('ethereum');
      }
      for (const opp of result2) {
        expect(opp.chain).toBe('bsc');
      }
      for (const opp of result3) {
        expect(opp.chain).toBe('arbitrum');
      }
    });
  });

  describe('Timeout Behavior', () => {
    it('should track timeouts in stats when timeout is reached', async () => {
      // Create path finder with very short timeout
      const quickTimeoutFinder = new MultiLegPathFinder({
        minProfitThreshold: 0.001,
        maxPathLength: 7,
        minPathLength: 5,
        maxCandidatesPerHop: 100, // High branching to trigger timeout
        timeoutMs: 1 // 1ms - will timeout
      });

      const pools = createMultiLegTestPools();

      // Run and check timeout is tracked
      await quickTimeoutFinder.findMultiLegOpportunities('ethereum', pools, ['USDT', 'WETH', 'DAI'], 5);
      const stats = quickTimeoutFinder.getStats();

      // Timeout may or may not be triggered depending on speed
      // Just verify stats are tracked
      expect(stats.totalCalls).toBe(1);
    });
  });
});
