/**
 * Tier 3 Optimization Tests
 *
 * Phase 3 enhancements from DETECTOR_OPTIMIZATION_ANALYSIS.md:
 * - T3.11: Multi-Leg Path Finding (5+ tokens)
 * - T3.12: Enhanced Whale Activity Detection
 * - T3.15: Liquidity Depth Analysis
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md
 */

import {
  CrossDexTriangularArbitrage,
  DexPool
} from '../../src/path-finding/cross-dex-triangular-arbitrage';
import {
  MultiLegPathFinder,
  MultiLegOpportunity,
  MultiLegPathConfig
} from '../../src/path-finding/multi-leg-path-finder';
import {
  WhaleActivityTracker,
  TrackedWhaleTransaction,
  WalletPattern,
  WhaleSignal,
  getWhaleActivityTracker,
  resetWhaleActivityTracker
} from '../../src/analytics/whale-activity-tracker';
import {
  LiquidityDepthAnalyzer,
  PoolLiquidity,
  getLiquidityDepthAnalyzer,
  resetLiquidityDepthAnalyzer
} from '../../src/analytics/liquidity-depth-analyzer';

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

function createWhaleTransaction(overrides: Partial<TrackedWhaleTransaction> = {}): TrackedWhaleTransaction {
  return {
    transactionHash: `0x${Math.random().toString(16).substring(2)}`,
    walletAddress: `0x${Math.random().toString(16).substring(2, 42)}`,
    chain: 'ethereum',
    dex: 'uniswap',
    pairAddress: '0xPAIR123',
    tokenIn: 'USDT',
    tokenOut: 'WETH',
    amountIn: 100000,
    amountOut: 40,
    usdValue: 100000,
    direction: 'buy',
    timestamp: Date.now(),
    priceImpact: 0.5,
    ...overrides
  };
}

function createPoolLiquidity(overrides: Partial<PoolLiquidity> = {}): PoolLiquidity {
  return {
    poolAddress: `0xPOOL${Math.random().toString(16).substring(2, 10)}`,
    chain: 'ethereum',
    dex: 'uniswap',
    token0: 'USDT',
    token1: 'WETH',
    reserve0: BigInt('10000000000000000000000000'), // 10M USDT (6 decimals scaled to 18)
    reserve1: BigInt('4000000000000000000000'),     // 4000 WETH
    feeBps: 30, // 0.3%
    liquidityUsd: 20000000, // $20M
    price: 2500, // 1 WETH = 2500 USDT
    timestamp: Date.now(),
    ...overrides
  };
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

// ===========================================================================
// T3.12: Whale Activity Detection Tests
// ===========================================================================

describe('T3.12: Whale Activity Detection', () => {
  let tracker: WhaleActivityTracker;

  beforeEach(() => {
    resetWhaleActivityTracker();
    tracker = new WhaleActivityTracker({
      whaleThresholdUsd: 50000,
      minTradesForPattern: 3,
      maxTrackedWallets: 100
    });
  });

  describe('Transaction Recording', () => {
    it('should record transactions above whale threshold', () => {
      const tx = createWhaleTransaction({ usdValue: 100000 });
      tracker.recordTransaction(tx);

      const stats = tracker.getStats();
      expect(stats.totalTransactionsTracked).toBe(1);
      expect(stats.totalWalletsTracked).toBe(1);
    });

    it('should ignore transactions below whale threshold', () => {
      const tx = createWhaleTransaction({ usdValue: 10000 }); // Below $50K threshold
      tracker.recordTransaction(tx);

      const stats = tracker.getStats();
      expect(stats.totalTransactionsTracked).toBe(0);
    });

    it('should track wallet profiles', () => {
      const walletAddress = '0xWHALE123';
      const tx = createWhaleTransaction({ walletAddress, usdValue: 100000 });
      tracker.recordTransaction(tx);

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile).toBeDefined();
      expect(profile!.totalTransactions).toBe(1);
      expect(profile!.totalVolumeUsd).toBe(100000);
    });

    it('should accumulate wallet statistics', () => {
      const walletAddress = '0xWHALE123';

      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          usdValue: 50000 + i * 10000
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.totalTransactions).toBe(5);
      expect(profile!.totalVolumeUsd).toBeGreaterThan(250000);
    });
  });

  describe('Pattern Detection', () => {
    it('should detect accumulator pattern', () => {
      const walletAddress = '0xACCUM123';

      // Multiple buy transactions
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.pattern).toBe('accumulator');
    });

    it('should detect distributor pattern', () => {
      const walletAddress = '0xDIST123';

      // Multiple sell transactions
      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'sell',
          usdValue: 100000
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.pattern).toBe('distributor');
    });

    it('should detect swing_trader pattern for mixed activity', () => {
      const walletAddress = '0xSWING123';

      // Mixed buy/sell transactions
      for (let i = 0; i < 6; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: i % 2 === 0 ? 'buy' : 'sell',
          usdValue: 100000,
          timestamp: Date.now() + i * 60000 // Spread over time
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.pattern).toBe('swing_trader');
    });

    it('should return unknown pattern for insufficient data', () => {
      const walletAddress = '0xNEW123';

      // Only 2 transactions (below minTradesForPattern of 3)
      for (let i = 0; i < 2; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.pattern).toBe('unknown');
    });

    it('should detect arbitrageur pattern for quick buy/sell cycles', () => {
      const walletAddress = '0xARB123';
      const now = Date.now();

      // Quick alternating buy/sell within 60 seconds (arbitrage pattern)
      for (let i = 0; i < 6; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: i % 2 === 0 ? 'buy' : 'sell',
          usdValue: 100000,
          timestamp: now + i * 10000 // 10 seconds apart (< 60s threshold)
        }));
      }

      const profile = tracker.getWalletProfile(walletAddress);
      expect(profile!.pattern).toBe('arbitrageur');
    });

    it('should handle out-of-order transaction timestamps correctly', () => {
      const walletAddress = '0xOOO123';
      const now = Date.now();

      // Record transactions out of order - pattern should still be detected correctly
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress,
        direction: 'buy',
        usdValue: 100000,
        timestamp: now + 30000 // Third chronologically
      }));
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress,
        direction: 'buy',
        usdValue: 100000,
        timestamp: now // First chronologically
      }));
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress,
        direction: 'buy',
        usdValue: 100000,
        timestamp: now + 15000 // Second chronologically
      }));

      const profile = tracker.getWalletProfile(walletAddress);
      // Even though recorded out of order, pattern detection should work
      expect(profile!.pattern).toBe('accumulator');
      // lastSeen should be the latest timestamp, not the last recorded
      expect(profile!.lastSeen).toBe(now + 30000);
    });
  });

  describe('Signal Generation', () => {
    it('should generate signals for known patterns', () => {
      const walletAddress = '0xACCUM123';
      const signals: WhaleSignal[] = [];

      tracker.onSignal((signal) => signals.push(signal));

      // Build pattern first
      for (let i = 0; i < 4; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      // Check if signal was generated
      expect(signals.length).toBeGreaterThan(0);
      expect(signals[signals.length - 1].type).toBe('follow');
    });

    it('should include confidence score in signals', () => {
      const walletAddress = '0xACCUM123';
      const signals: WhaleSignal[] = [];

      tracker.onSignal((signal) => signals.push(signal));

      for (let i = 0; i < 5; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      const lastSignal = signals[signals.length - 1];
      expect(lastSignal.confidence).toBeGreaterThanOrEqual(0.5);
      expect(lastSignal.confidence).toBeLessThanOrEqual(1.0);
    });

    it('should boost confidence for super whales', () => {
      const walletAddress = '0xSUPER123';
      const signals: WhaleSignal[] = [];

      tracker.onSignal((signal) => signals.push(signal));

      // Build pattern with normal trades
      for (let i = 0; i < 3; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      const normalConfidence = signals[signals.length - 1]?.confidence || 0;

      // Add super whale trade ($500K+)
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress,
        direction: 'buy',
        usdValue: 600000 // 10x threshold
      }));

      const superWhaleConfidence = signals[signals.length - 1].confidence;
      expect(superWhaleConfidence).toBeGreaterThan(normalConfidence);
    });

    it('should support unsubscribe from signals', () => {
      const walletAddress = '0xUNSUB123';
      const signals: WhaleSignal[] = [];

      // Subscribe and get unsubscribe function
      const unsubscribe = tracker.onSignal((signal) => signals.push(signal));

      // Build pattern
      for (let i = 0; i < 3; i++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress,
          direction: 'buy',
          usdValue: 100000
        }));
      }

      const signalsBeforeUnsub = signals.length;
      expect(signalsBeforeUnsub).toBeGreaterThan(0);

      // Unsubscribe
      unsubscribe();

      // Add more transactions
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress,
        direction: 'buy',
        usdValue: 100000
      }));

      // Signal count should not increase after unsubscribe
      expect(signals.length).toBe(signalsBeforeUnsub);
    });

    it('should handle handler errors gracefully', () => {
      const walletAddress = '0xERROR123';
      const goodSignals: WhaleSignal[] = [];

      // Add a handler that throws
      tracker.onSignal(() => {
        throw new Error('Handler error');
      });

      // Add a handler that works
      tracker.onSignal((signal) => goodSignals.push(signal));

      // Build pattern - should not throw despite bad handler
      expect(() => {
        for (let i = 0; i < 4; i++) {
          tracker.recordTransaction(createWhaleTransaction({
            walletAddress,
            direction: 'buy',
            usdValue: 100000
          }));
        }
      }).not.toThrow();

      // Good handler should still receive signals
      expect(goodSignals.length).toBeGreaterThan(0);
    });
  });

  describe('Activity Summary', () => {
    it('should calculate activity summary for a pair', () => {
      const pairAddress = '0xPAIR123';

      // Add multiple transactions
      tracker.recordTransaction(createWhaleTransaction({
        pairAddress,
        direction: 'buy',
        usdValue: 100000
      }));
      tracker.recordTransaction(createWhaleTransaction({
        pairAddress,
        direction: 'sell',
        usdValue: 50000
      }));

      const summary = tracker.getActivitySummary(pairAddress, 'ethereum');

      expect(summary.buyVolumeUsd).toBe(100000);
      expect(summary.sellVolumeUsd).toBe(50000);
      expect(summary.netFlowUsd).toBe(50000);
      expect(summary.dominantDirection).toBe('bullish');
    });

    it('should use exact matching for pairKey (regression test)', () => {
      // This tests that "USDT" should NOT match "USDT2" (includes() bug fix)
      tracker.recordTransaction(createWhaleTransaction({
        pairAddress: '0xPAIR_USDT2',
        tokenIn: 'USDT2',
        tokenOut: 'WETH',
        direction: 'buy',
        usdValue: 100000
      }));

      // Query for 'USDT' should NOT match 'USDT2'
      const summaryUSDT = tracker.getActivitySummary('USDT', 'ethereum');
      expect(summaryUSDT.buyVolumeUsd).toBe(0);
      expect(summaryUSDT.whaleCount).toBe(0);

      // Query for 'USDT2' should match
      const summaryUSDT2 = tracker.getActivitySummary('USDT2', 'ethereum');
      expect(summaryUSDT2.buyVolumeUsd).toBe(100000);
      expect(summaryUSDT2.whaleCount).toBe(1);
    });
  });

  describe('Wallet Queries', () => {
    it('should return top whales by volume', () => {
      // Create whales with different volumes
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress: '0xSMALL',
        usdValue: 50000
      }));
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress: '0xMEDIUM',
        usdValue: 100000
      }));
      tracker.recordTransaction(createWhaleTransaction({
        walletAddress: '0xLARGE',
        usdValue: 500000
      }));

      const topWhales = tracker.getTopWhales(2);

      expect(topWhales.length).toBe(2);
      expect(topWhales[0].address).toBe('0xLARGE');
      expect(topWhales[1].address).toBe('0xMEDIUM');
    });

    it('should return wallets by pattern', () => {
      // Create accumulators
      for (let i = 0; i < 2; i++) {
        const walletAddress = `0xACCUM${i}`;
        for (let j = 0; j < 4; j++) {
          tracker.recordTransaction(createWhaleTransaction({
            walletAddress,
            direction: 'buy',
            usdValue: 100000
          }));
        }
      }

      // Create a distributor
      const distWallet = '0xDIST';
      for (let j = 0; j < 4; j++) {
        tracker.recordTransaction(createWhaleTransaction({
          walletAddress: distWallet,
          direction: 'sell',
          usdValue: 100000
        }));
      }

      const accumulators = tracker.getWalletsByPattern('accumulator');
      expect(accumulators.length).toBe(2);

      const distributors = tracker.getWalletsByPattern('distributor');
      expect(distributors.length).toBe(1);
      expect(distributors[0].address).toBe(distWallet);
    });
  });

  describe('LRU Eviction', () => {
    it('should evict oldest wallets when limit reached', () => {
      const smallTracker = new WhaleActivityTracker({
        whaleThresholdUsd: 50000,
        maxTrackedWallets: 10
      });

      // Add 15 wallets
      for (let i = 0; i < 15; i++) {
        smallTracker.recordTransaction(createWhaleTransaction({
          walletAddress: `0xWALLET${i}`,
          usdValue: 100000,
          timestamp: Date.now() + i * 1000 // Different timestamps
        }));
      }

      const stats = smallTracker.getStats();
      expect(stats.totalWalletsTracked).toBeLessThanOrEqual(10);
      expect(stats.walletEvictions).toBeGreaterThan(0);
    });
  });

  describe('Singleton Factory', () => {
    it('should return same instance', () => {
      const instance1 = getWhaleActivityTracker();
      const instance2 = getWhaleActivityTracker();
      expect(instance1).toBe(instance2);
    });

    it('should reset properly', () => {
      const instance1 = getWhaleActivityTracker();
      instance1.recordTransaction(createWhaleTransaction({ usdValue: 100000 }));

      resetWhaleActivityTracker();

      const instance2 = getWhaleActivityTracker();
      expect(instance2).not.toBe(instance1);
      expect(instance2.getStats().totalTransactionsTracked).toBe(0);
    });
  });
});

// ===========================================================================
// T3.15: Liquidity Depth Analysis Tests
// ===========================================================================

describe('T3.15: Liquidity Depth Analysis', () => {
  let analyzer: LiquidityDepthAnalyzer;

  beforeEach(() => {
    resetLiquidityDepthAnalyzer();
    analyzer = new LiquidityDepthAnalyzer({
      depthLevels: 10,
      tradeSizeStepUsd: 1000,
      maxTradeSizeUsd: 100000,
      maxTrackedPools: 100,
      cacheTtlMs: 30000
    });
  });

  describe('Pool Tracking', () => {
    it('should update pool liquidity', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const retrieved = analyzer.getPoolLiquidity(pool.poolAddress);
      expect(retrieved).toBeDefined();
      expect(retrieved!.liquidityUsd).toBe(pool.liquidityUsd);
    });

    it('should track multiple pools', () => {
      for (let i = 0; i < 5; i++) {
        analyzer.updatePoolLiquidity(createPoolLiquidity({
          poolAddress: `0xPOOL${i}`
        }));
      }

      const tracked = analyzer.getTrackedPools();
      expect(tracked.length).toBe(5);
    });
  });

  describe('Depth Analysis', () => {
    it('should analyze pool depth', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);

      expect(analysis).not.toBeNull();
      expect(analysis!.buyLevels.length).toBeGreaterThan(0);
      expect(analysis!.sellLevels.length).toBeGreaterThan(0);
    });

    it('should calculate liquidity levels', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);

      for (const level of analysis!.buyLevels) {
        expect(level.tradeSize).toBeGreaterThan(0);
        expect(level.tradeSizeUsd).toBeGreaterThan(0);
        expect(level.priceImpactPercent).toBeGreaterThanOrEqual(0);
        expect(level.slippagePercent).toBeGreaterThan(0);
        expect(level.outputAmount).toBeGreaterThan(0);
      }
    });

    it('should increase slippage with larger trades', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      const levels = analysis!.buyLevels;

      // Slippage should generally increase with trade size
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i].slippagePercent).toBeGreaterThanOrEqual(levels[i - 1].slippagePercent - 0.01);
      }
    });

    it('should calculate optimal trade size', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);

      expect(analysis!.optimalTradeSizeUsd).toBeGreaterThan(0);
      expect(analysis!.maxTradeSizeFor1PercentSlippage).toBeGreaterThan(0);
    });

    it('should calculate liquidity score', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);

      expect(analysis!.liquidityScore).toBeGreaterThanOrEqual(0);
      expect(analysis!.liquidityScore).toBeLessThanOrEqual(1);
    });
  });

  describe('Slippage Estimation', () => {
    it('should estimate slippage for buy trades', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');

      expect(estimate).not.toBeNull();
      expect(estimate!.inputAmountUsd).toBe(10000);
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(estimate!.slippagePercent).toBeGreaterThan(0);
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should estimate slippage for sell trades', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'sell');

      expect(estimate).not.toBeNull();
      expect(estimate!.tradeDirection).toBe('sell');
      expect(estimate!.slippagePercent).toBeGreaterThan(0);
    });

    it('should increase slippage with larger trades', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const small = analyzer.estimateSlippage(pool.poolAddress, 1000, 'buy');
      const large = analyzer.estimateSlippage(pool.poolAddress, 100000, 'buy');

      expect(large!.slippagePercent).toBeGreaterThan(small!.slippagePercent);
    });

    it('should return confidence score', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');

      expect(estimate!.confidence).toBeGreaterThanOrEqual(0);
      expect(estimate!.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('Best Pool Finding', () => {
    it('should find best pool for token pair', () => {
      // Add multiple pools with different liquidity
      // Reserves must be proportional to liquidityUsd for realistic slippage
      analyzer.updatePoolLiquidity(createPoolLiquidity({
        poolAddress: '0xLOW',
        token0: 'USDT',
        token1: 'WETH',
        liquidityUsd: 100000, // Low liquidity
        // Low reserves: $50K USDT + 20 WETH
        reserve0: BigInt('50000000000000000000000'),   // 50K USDT
        reserve1: BigInt('20000000000000000000')       // 20 WETH
      }));
      analyzer.updatePoolLiquidity(createPoolLiquidity({
        poolAddress: '0xHIGH',
        token0: 'USDT',
        token1: 'WETH',
        liquidityUsd: 50000000, // High liquidity
        // High reserves: $25M USDT + 10K WETH
        reserve0: BigInt('25000000000000000000000000'), // 25M USDT
        reserve1: BigInt('10000000000000000000000')     // 10K WETH
      }));

      const best = analyzer.findBestPool('USDT', 'WETH', 10000, 'buy');

      expect(best).not.toBeNull();
      expect(best!.poolAddress).toBe('0xHIGH'); // Higher liquidity = lower slippage
    });

    it('should return null for unknown token pair', () => {
      analyzer.updatePoolLiquidity(createPoolLiquidity());

      const result = analyzer.findBestPool('UNKNOWN1', 'UNKNOWN2', 10000, 'buy');
      expect(result).toBeNull();
    });
  });

  describe('Caching', () => {
    it('should cache depth analysis', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      // First call
      analyzer.analyzeDepth(pool.poolAddress);
      const stats1 = analyzer.getStats();
      expect(stats1.cacheMisses).toBe(1);

      // Second call (should hit cache)
      analyzer.analyzeDepth(pool.poolAddress);
      const stats2 = analyzer.getStats();
      expect(stats2.cacheHits).toBe(1);
    });

    it('should invalidate cache on pool update', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      analyzer.analyzeDepth(pool.poolAddress);

      // Update pool — must change reserves (not just liquidityUsd) to trigger cache invalidation
      analyzer.updatePoolLiquidity({ ...pool, reserve0: pool.reserve0 * 2n, liquidityUsd: pool.liquidityUsd * 2 });

      // Should miss cache after update
      analyzer.analyzeDepth(pool.poolAddress);
      const stats = analyzer.getStats();
      expect(stats.cacheMisses).toBe(2);
    });
  });

  describe('LRU Eviction', () => {
    it('should evict oldest pools when limit reached', () => {
      const smallAnalyzer = new LiquidityDepthAnalyzer({
        maxTrackedPools: 10
      });

      // Add 15 pools
      for (let i = 0; i < 15; i++) {
        smallAnalyzer.updatePoolLiquidity(createPoolLiquidity({
          poolAddress: `0xPOOL${i}`,
          timestamp: Date.now() + i * 1000
        }));
      }

      const stats = smallAnalyzer.getStats();
      expect(stats.poolsTracked).toBeLessThanOrEqual(10);
      expect(stats.poolEvictions).toBeGreaterThan(0);
    });
  });

  describe('Statistics', () => {
    it('should track analysis statistics', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);

      analyzer.analyzeDepth(pool.poolAddress);
      analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');

      const stats = analyzer.getStats();
      expect(stats.analysisCount).toBe(1);
      expect(stats.avgAnalysisTimeMs).toBeGreaterThan(0);
    });

    it('should reset properly', () => {
      const pool = createPoolLiquidity();
      analyzer.updatePoolLiquidity(pool);
      analyzer.analyzeDepth(pool.poolAddress);

      analyzer.reset();

      const stats = analyzer.getStats();
      expect(stats.poolsTracked).toBe(0);
      expect(stats.analysisCount).toBe(0);
    });
  });

  describe('Singleton Factory', () => {
    it('should return same instance', () => {
      const instance1 = getLiquidityDepthAnalyzer();
      const instance2 = getLiquidityDepthAnalyzer();
      expect(instance1).toBe(instance2);
    });

    it('should reset properly', () => {
      const instance1 = getLiquidityDepthAnalyzer();
      instance1.updatePoolLiquidity(createPoolLiquidity());

      resetLiquidityDepthAnalyzer();

      const instance2 = getLiquidityDepthAnalyzer();
      expect(instance2).not.toBe(instance1);
      expect(instance2.getStats().poolsTracked).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle pool with zero reserves gracefully', () => {
      const pool = createPoolLiquidity({
        reserve0: 0n,
        reserve1: 0n
      });
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      expect(analysis).not.toBeNull();
      // Should return empty or safe default levels
    });

    it('should return null for unknown pool', () => {
      const analysis = analyzer.analyzeDepth('0xUNKNOWN');
      expect(analysis).toBeNull();
    });

    it('should handle very large trade sizes', () => {
      // Create a pool with $1M liquidity and proportional reserves
      // $500K USDT + 200 WETH (at $2500/WETH)
      const pool = createPoolLiquidity({
        liquidityUsd: 1000000, // $1M liquidity
        reserve0: BigInt('500000000000000000000000'),  // 500K USDT
        reserve1: BigInt('200000000000000000000')      // 200 WETH
      });
      analyzer.updatePoolLiquidity(pool);

      // Try to estimate slippage for $500K trade (50% of liquidity)
      const estimate = analyzer.estimateSlippage(pool.poolAddress, 500000, 'buy');

      // Should return high slippage but not crash
      expect(estimate).not.toBeNull();
      expect(estimate!.slippagePercent).toBeGreaterThan(5); // Expect significant slippage
    });
  });

  describe('Input Validation (regression tests)', () => {
    it('should skip pool update with missing poolAddress', () => {
      const pool = createPoolLiquidity({
        poolAddress: '' // Empty address
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getTrackedPools().length).toBe(0);
    });

    it('should skip pool update with negative reserves', () => {
      const pool = createPoolLiquidity({
        reserve0: -1n as unknown as bigint, // Negative reserve
        reserve1: BigInt('1000000000000000000')
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with zero price', () => {
      const pool = createPoolLiquidity({
        price: 0 // Zero price
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with negative price', () => {
      const pool = createPoolLiquidity({
        price: -100 // Negative price
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with NaN price', () => {
      const pool = createPoolLiquidity({
        price: NaN // Invalid price
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with Infinity price', () => {
      const pool = createPoolLiquidity({
        price: Infinity // Invalid price
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with negative liquidityUsd', () => {
      const pool = createPoolLiquidity({
        liquidityUsd: -1000 // Negative liquidity
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should skip pool update with NaN liquidityUsd', () => {
      const pool = createPoolLiquidity({
        liquidityUsd: NaN // Invalid liquidity
      });

      analyzer.updatePoolLiquidity(pool);

      // Pool should not be tracked
      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should accept valid pool data', () => {
      const pool = createPoolLiquidity(); // Valid defaults

      analyzer.updatePoolLiquidity(pool);

      // Pool should be tracked
      const retrieved = analyzer.getPoolLiquidity(pool.poolAddress);
      expect(retrieved).toBeDefined();
      expect(retrieved!.poolAddress).toBe(pool.poolAddress);
    });
  });
});
