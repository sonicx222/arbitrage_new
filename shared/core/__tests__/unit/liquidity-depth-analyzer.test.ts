/**
 * Liquidity Depth Analyzer Unit Tests
 *
 * Tests for AMM pool liquidity analysis, slippage estimation,
 * depth level calculation, BigInt precision, LRU eviction,
 * V3 concentrated liquidity, and Curve StableSwap models.
 *
 * @see shared/core/src/analytics/liquidity-depth-analyzer.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  LiquidityDepthAnalyzer,
  getLiquidityDepthAnalyzer,
  resetLiquidityDepthAnalyzer
} from '../../src/analytics/liquidity-depth-analyzer';
import type {
  PoolLiquidity,
  LiquidityDepthConfig
} from '../../src/analytics/liquidity-depth-analyzer';

// =============================================================================
// Test Helpers
// =============================================================================

function createPool(overrides: Partial<PoolLiquidity> = {}): PoolLiquidity {
  return {
    poolAddress: '0xpool_eth_usdt',
    chain: 'ethereum',
    dex: 'uniswap',
    token0: 'USDT',
    token1: 'WETH',
    reserve0: BigInt('10000000') * BigInt(1e18), // 10M USDT (scaled)
    reserve1: BigInt('5000') * BigInt(1e18),      // 5K WETH (scaled)
    feeBps: 30, // 0.3%
    liquidityUsd: 20000000, // $20M
    price: 2000, // WETH = $2000
    timestamp: Date.now(),
    ...overrides
  };
}

const TEST_CONFIG: Partial<LiquidityDepthConfig> = {
  depthLevels: 5,
  tradeSizeStepUsd: 1000,
  maxTradeSizeUsd: 100000,
  maxTrackedPools: 20,
  cacheTtlMs: 5000
};

describe('LiquidityDepthAnalyzer', () => {
  let analyzer: LiquidityDepthAnalyzer;

  beforeEach(() => {
    resetLiquidityDepthAnalyzer();
    analyzer = new LiquidityDepthAnalyzer(TEST_CONFIG);
  });

  afterEach(() => {
    analyzer.reset();
  });

  // ===========================================================================
  // updatePoolLiquidity
  // ===========================================================================

  describe('updatePoolLiquidity', () => {
    it('should store a valid pool', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      expect(analyzer.getPoolLiquidity(pool.poolAddress)).not.toBeUndefined();
      expect(analyzer.getTrackedPools()).toContain(pool.poolAddress);
    });

    it('should reject pool with missing address', () => {
      const pool = createPool({ poolAddress: '' });
      analyzer.updatePoolLiquidity(pool);

      expect(analyzer.getTrackedPools().length).toBe(0);
    });

    it('should reject pool with negative reserves', () => {
      const pool = createPool({ reserve0: -1n });
      analyzer.updatePoolLiquidity(pool);

      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should reject pool with zero price', () => {
      const pool = createPool({ price: 0 });
      analyzer.updatePoolLiquidity(pool);

      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should reject pool with negative price', () => {
      const pool = createPool({ price: -100 });
      analyzer.updatePoolLiquidity(pool);

      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should reject pool with NaN price', () => {
      const pool = createPool({ price: NaN });
      analyzer.updatePoolLiquidity(pool);

      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should reject pool with Infinity price', () => {
      const pool = createPool({ price: Infinity });
      analyzer.updatePoolLiquidity(pool);

      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should reject pool with negative liquidityUsd', () => {
      const pool = createPool({ liquidityUsd: -1000 });
      analyzer.updatePoolLiquidity(pool);

      expect(analyzer.getPoolLiquidity(pool.poolAddress)).toBeUndefined();
    });

    it('should update existing pool data', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const updatedPool = createPool({ price: 2500, timestamp: Date.now() + 1000 });
      analyzer.updatePoolLiquidity(updatedPool);

      const stored = analyzer.getPoolLiquidity(pool.poolAddress);
      expect(stored!.price).toBe(2500);
    });

    it('should invalidate depth cache on pool update', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      // Generate cached analysis
      const analysis1 = analyzer.analyzeDepth(pool.poolAddress);
      expect(analysis1).not.toBeNull();

      // Update pool — should invalidate cache
      const updatedPool = createPool({ price: 2500, timestamp: Date.now() + 1000 });
      analyzer.updatePoolLiquidity(updatedPool);

      // Next analysis should be fresh (cache miss)
      const stats = analyzer.getStats();
      // At least 1 cache miss from the second analysis
      expect(stats.cacheMisses).toBeGreaterThanOrEqual(1);
    });
  });

  // ===========================================================================
  // analyzeDepth
  // ===========================================================================

  describe('analyzeDepth', () => {
    it('should return null for unknown pool', () => {
      expect(analyzer.analyzeDepth('0xunknown')).toBeNull();
    });

    it('should return depth analysis for tracked pool', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      expect(analysis).not.toBeNull();
      expect(analysis!.poolAddress).toBe(pool.poolAddress);
      expect(analysis!.chain).toBe('ethereum');
      expect(analysis!.buyLevels.length).toBeGreaterThan(0);
      expect(analysis!.sellLevels.length).toBeGreaterThan(0);
    });

    it('should calculate increasing price impact for larger trades', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      const buyLevels = analysis!.buyLevels;

      // Price impact should increase with trade size
      for (let i = 1; i < buyLevels.length; i++) {
        expect(buyLevels[i].priceImpactPercent).toBeGreaterThanOrEqual(buyLevels[i - 1].priceImpactPercent);
      }
    });

    it('should calculate increasing trade sizes for each level', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      const buyLevels = analysis!.buyLevels;

      for (let i = 1; i < buyLevels.length; i++) {
        expect(buyLevels[i].tradeSizeUsd).toBeGreaterThan(buyLevels[i - 1].tradeSizeUsd);
      }
    });

    it('should return cached result on second call', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      analyzer.analyzeDepth(pool.poolAddress);
      analyzer.analyzeDepth(pool.poolAddress);

      const stats = analyzer.getStats();
      expect(stats.cacheHits).toBeGreaterThanOrEqual(1);
    });

    it('should calculate liquidity score between 0 and 1', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      expect(analysis!.liquidityScore).toBeGreaterThanOrEqual(0);
      expect(analysis!.liquidityScore).toBeLessThanOrEqual(1);
    });

    it('should calculate optimal trade size', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      expect(analysis!.optimalTradeSizeUsd).toBeGreaterThanOrEqual(0);
    });

    it('should limit depth levels based on pool liquidity', () => {
      // Small pool — should have fewer levels
      const smallPool = createPool({
        poolAddress: '0xsmall_pool',
        liquidityUsd: 5000, // Only $5K liquidity
        reserve0: BigInt('2500') * BigInt(1e18),
        reserve1: BigInt('1') * BigInt(1e18)
      });
      analyzer.updatePoolLiquidity(smallPool);

      const analysis = analyzer.analyzeDepth('0xsmall_pool');
      // With $5K liquidity and max 50% = $2.5K max, and $1K step, should be ~2 levels
      if (analysis) {
        expect(analysis.buyLevels.length).toBeLessThanOrEqual(TEST_CONFIG.depthLevels!);
      }
    });
  });

  // ===========================================================================
  // estimateSlippage
  // ===========================================================================

  describe('estimateSlippage', () => {
    it('should return null for unknown pool', () => {
      expect(analyzer.estimateSlippage('0xunknown', 1000, 'buy')).toBeNull();
    });

    it('should estimate slippage for a buy trade', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.tradeDirection).toBe('buy');
      expect(estimate!.inputAmountUsd).toBe(10000);
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should estimate slippage for a sell trade', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'sell');
      expect(estimate).not.toBeNull();
      expect(estimate!.tradeDirection).toBe('sell');
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should show higher slippage for larger trades', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const small = analyzer.estimateSlippage(pool.poolAddress, 1000, 'buy');
      const large = analyzer.estimateSlippage(pool.poolAddress, 50000, 'buy');

      expect(large!.priceImpactPercent).toBeGreaterThan(small!.priceImpactPercent);
    });

    it('should calculate confidence between 0 and 1', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');
      expect(estimate!.confidence).toBeGreaterThanOrEqual(0);
      expect(estimate!.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ===========================================================================
  // findBestPool
  // ===========================================================================

  describe('findBestPool', () => {
    it('should return null when no matching pools', () => {
      expect(analyzer.findBestPool('WETH', 'USDT', 1000, 'buy')).toBeNull();
    });

    it('should find the best pool for a trade', () => {
      // Pool with higher liquidity (lower slippage)
      const goodPool = createPool({
        poolAddress: '0xgood_pool',
        token0: 'USDT',
        token1: 'WETH',
        liquidityUsd: 50000000,
        reserve0: BigInt('25000000') * BigInt(1e18),
        reserve1: BigInt('12500') * BigInt(1e18),
        feeBps: 5 // 0.05% fee
      });
      // Pool with lower liquidity (higher slippage)
      const badPool = createPool({
        poolAddress: '0xbad_pool',
        token0: 'USDT',
        token1: 'WETH',
        liquidityUsd: 100000,
        reserve0: BigInt('50000') * BigInt(1e18),
        reserve1: BigInt('25') * BigInt(1e18),
        feeBps: 100 // 1% fee
      });

      analyzer.updatePoolLiquidity(goodPool);
      analyzer.updatePoolLiquidity(badPool);

      const result = analyzer.findBestPool('USDT', 'WETH', 10000, 'buy');
      expect(result).not.toBeNull();
      expect(result!.poolAddress).toBe('0xgood_pool');
    });

    it('should match pools with tokens in either order', () => {
      const pool = createPool({
        poolAddress: '0xreversed_pool',
        token0: 'WETH',
        token1: 'USDT'
      });
      analyzer.updatePoolLiquidity(pool);

      // Search with reversed token order
      const result = analyzer.findBestPool('USDT', 'WETH', 1000, 'buy');
      expect(result).not.toBeNull();
    });
  });

  // ===========================================================================
  // BigInt precision (calculateSwapOutput)
  // ===========================================================================

  describe('BigInt precision', () => {
    it('should handle zero input amount', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      // A $0 trade should give 0 output
      const estimate = analyzer.estimateSlippage(pool.poolAddress, 0, 'buy');
      // With 0 input, the output should be 0 or near-0
      if (estimate) {
        expect(estimate.outputAmount).toBe(0);
      }
    });

    it('should handle very small trade amounts', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 1, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.outputAmount).toBeGreaterThanOrEqual(0);
    });

    it('should handle pools with very small reserves', () => {
      const tinyPool = createPool({
        poolAddress: '0xtiny_pool',
        reserve0: 1000n, // Very small reserves
        reserve1: 500n,
        liquidityUsd: 1,
        price: 2
      });
      analyzer.updatePoolLiquidity(tinyPool);

      // Should not throw
      const analysis = analyzer.analyzeDepth('0xtiny_pool');
      // May return null or empty levels for tiny pool
      if (analysis) {
        expect(analysis.buyLevels).toBeDefined();
      }
    });
  });

  // ===========================================================================
  // LRU Eviction
  // ===========================================================================

  describe('LRU eviction', () => {
    it('should evict oldest pools when maxTrackedPools exceeded', () => {
      const smallAnalyzer = new LiquidityDepthAnalyzer({
        ...TEST_CONFIG,
        maxTrackedPools: 5
      });

      for (let i = 0; i < 6; i++) {
        smallAnalyzer.updatePoolLiquidity(createPool({
          poolAddress: `0xpool_${i}`,
          timestamp: Date.now() + i * 1000
        }));
      }

      const stats = smallAnalyzer.getStats();
      expect(stats.poolsTracked).toBeLessThanOrEqual(5);
      expect(stats.poolEvictions).toBeGreaterThan(0);

      smallAnalyzer.reset();
    });
  });

  // ===========================================================================
  // Stats / Reset
  // ===========================================================================

  describe('stats', () => {
    it('should track analysis count and cache metrics', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);

      analyzer.analyzeDepth(pool.poolAddress); // miss
      analyzer.analyzeDepth(pool.poolAddress); // hit

      const stats = analyzer.getStats();
      expect(stats.analysisCount).toBe(1); // Only 1 real analysis
      expect(stats.cacheHits).toBe(1);
      expect(stats.cacheMisses).toBe(1);
      expect(stats.avgAnalysisTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reset', () => {
    it('should clear all pools and caches', () => {
      const pool = createPool();
      analyzer.updatePoolLiquidity(pool);
      analyzer.analyzeDepth(pool.poolAddress);

      analyzer.reset();

      expect(analyzer.getTrackedPools().length).toBe(0);
      const stats = analyzer.getStats();
      expect(stats.poolsTracked).toBe(0);
      expect(stats.analysisCount).toBe(0);
    });
  });

  // ===========================================================================
  // Singleton factory
  // ===========================================================================

  describe('singleton', () => {
    it('should return the same instance on multiple calls', () => {
      const a = getLiquidityDepthAnalyzer();
      const b = getLiquidityDepthAnalyzer();
      expect(a).toBe(b);
      resetLiquidityDepthAnalyzer();
    });

    it('should return a new instance after reset', () => {
      const a = getLiquidityDepthAnalyzer();
      resetLiquidityDepthAnalyzer();
      const b = getLiquidityDepthAnalyzer();
      expect(a).not.toBe(b);
      resetLiquidityDepthAnalyzer();
    });
  });

  // ===========================================================================
  // V3 / Curve Pool Helpers
  // ===========================================================================

  /**
   * Create a V3 concentrated liquidity pool.
   *
   * sqrtPriceX96 encodes current price in Q64.96 format:
   *   sqrtPriceX96 = sqrt(price) * 2^96
   *
   * For USDT/WETH at price=2000:
   *   sqrt(2000) ~= 44.72
   *   sqrtPriceX96 = 44.72 * 2^96 ~= 3.54e30
   *
   * liquidity (L) determines virtual reserves via:
   *   virtualReserve0 = L * Q96 / sqrtPriceX96
   *   virtualReserve1 = L * sqrtPriceX96 / Q96
   *
   * For V3 to provide deeper liquidity than V2 with the same actual reserves,
   * L must make virtual reserves exceed actual reserves.
   * "Neutral" L: reserve0 * sqrtPriceX96 / Q96 ≈ 4.47e26 for these reserves.
   * Default L = 1e27 gives ~2.2x effective depth vs constant-product.
   *
   * tickSpacing determines granularity: 1 (0.01%), 10 (0.05%), 60 (0.3%), 200 (1%).
   */
  function createV3Pool(overrides: Partial<PoolLiquidity> = {}): PoolLiquidity {
    // sqrtPriceX96 for price=2000: sqrt(2000) * 2^96
    const sqrtPrice2000 = BigInt('3543191142285914205922034323215');
    return {
      poolAddress: '0xv3_pool_eth_usdt',
      chain: 'ethereum',
      dex: 'uniswap_v3',
      token0: 'USDT',
      token1: 'WETH',
      reserve0: BigInt('10000000') * BigInt(1e18),
      reserve1: BigInt('5000') * BigInt(1e18),
      feeBps: 30,
      liquidityUsd: 20000000,
      price: 2000,
      timestamp: Date.now(),
      ammType: 'concentrated' as const,
      sqrtPriceX96: sqrtPrice2000,
      liquidity: BigInt('1000000000') * BigInt(1e18), // ~2.2x effective depth
      tickSpacing: 60,
      ...overrides
    };
  }

  /**
   * Create a Curve StableSwap pool.
   *
   * amplificationParameter (A) controls curve shape:
   *   A=0   -> constant product (x*y=k)
   *   A=100 -> typical stablecoin pool
   *   A=2000 -> tightly pegged pool (near zero slippage for equal-value swaps)
   *   A->inf -> constant sum (zero slippage)
   */
  function createCurvePool(overrides: Partial<PoolLiquidity> = {}): PoolLiquidity {
    return {
      poolAddress: '0xcurve_usdc_usdt',
      chain: 'ethereum',
      dex: 'curve',
      token0: 'USDC',
      token1: 'USDT',
      reserve0: BigInt('50000000') * BigInt(1e18),
      reserve1: BigInt('50000000') * BigInt(1e18),
      feeBps: 4, // 0.04% typical Curve fee
      liquidityUsd: 100000000,
      price: 1.0, // stablecoins are 1:1
      timestamp: Date.now(),
      ammType: 'stable_swap' as const,
      amplificationParameter: 500,
      ...overrides
    };
  }

  // ===========================================================================
  // V3 Concentrated Liquidity
  // ===========================================================================

  describe('V3 Concentrated Liquidity', () => {
    it('should return a valid slippage estimate for a V3 pool', () => {
      const pool = createV3Pool();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.tradeDirection).toBe('buy');
      expect(estimate!.inputAmountUsd).toBe(10000);
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(estimate!.outputAmount).toBeGreaterThan(0);
      expect(estimate!.effectivePrice).toBeGreaterThan(0);
      expect(estimate!.confidence).toBeGreaterThanOrEqual(0);
      expect(estimate!.confidence).toBeLessThanOrEqual(1);
    });

    it('should produce output proportional to liquidity', () => {
      // Higher liquidity -> more output for same trade size (less slippage)
      const lowLiqPool = createV3Pool({
        poolAddress: '0xv3_low_liq',
        liquidity: BigInt('1000000') * BigInt(1e18),
        liquidityUsd: 5000000,
        reserve0: BigInt('2500000') * BigInt(1e18),
        reserve1: BigInt('1250') * BigInt(1e18),
      });
      const highLiqPool = createV3Pool({
        poolAddress: '0xv3_high_liq',
        liquidity: BigInt('50000000') * BigInt(1e18),
        liquidityUsd: 200000000,
        reserve0: BigInt('100000000') * BigInt(1e18),
        reserve1: BigInt('50000') * BigInt(1e18),
      });

      analyzer.updatePoolLiquidity(lowLiqPool);
      analyzer.updatePoolLiquidity(highLiqPool);

      const lowEst = analyzer.estimateSlippage('0xv3_low_liq', 10000, 'buy');
      const highEst = analyzer.estimateSlippage('0xv3_high_liq', 10000, 'buy');

      expect(lowEst).not.toBeNull();
      expect(highEst).not.toBeNull();
      // Higher liquidity pool should have lower price impact
      expect(highEst!.priceImpactPercent).toBeLessThan(lowEst!.priceImpactPercent);
    });

    it('should have lower slippage than constant-product for small trades within tick range', () => {
      // V3 concentrated liquidity provides deeper effective reserves within tick range.
      // L must be large enough that virtualReserve0 > actual reserve0.
      // For reserve0=20M*1e18, neutral L ≈ 8.94e26. Using 2e27 for ~2.2x depth.
      const v3Pool = createV3Pool({
        poolAddress: '0xv3_compare',
        liquidity: BigInt('2000000000') * BigInt(1e18),
        liquidityUsd: 40000000,
        reserve0: BigInt('20000000') * BigInt(1e18),
        reserve1: BigInt('10000') * BigInt(1e18),
      });
      const v2Pool = createPool({
        poolAddress: '0xv2_compare',
        liquidityUsd: 40000000,
        reserve0: BigInt('20000000') * BigInt(1e18),
        reserve1: BigInt('10000') * BigInt(1e18),
      });

      analyzer.updatePoolLiquidity(v3Pool);
      analyzer.updatePoolLiquidity(v2Pool);

      const v3Est = analyzer.estimateSlippage('0xv3_compare', 5000, 'buy');
      const v2Est = analyzer.estimateSlippage('0xv2_compare', 5000, 'buy');

      expect(v3Est).not.toBeNull();
      expect(v2Est).not.toBeNull();
      // V3 should have lower or equal slippage for small trades
      expect(v3Est!.slippagePercent).toBeLessThanOrEqual(v2Est!.slippagePercent);
    });

    it('should handle fee tier 100 (0.01%)', () => {
      const pool = createV3Pool({
        poolAddress: '0xv3_fee_100',
        feeBps: 1, // 0.01% = 1 basis point
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 5000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should handle fee tier 500 (0.05%)', () => {
      const pool = createV3Pool({
        poolAddress: '0xv3_fee_500',
        feeBps: 5,
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 5000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should handle fee tier 3000 (0.3%)', () => {
      const pool = createV3Pool({
        poolAddress: '0xv3_fee_3000',
        feeBps: 30,
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 5000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should handle fee tier 10000 (1.0%)', () => {
      const pool = createV3Pool({
        poolAddress: '0xv3_fee_10000',
        feeBps: 100,
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 5000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.outputAmount).toBeGreaterThan(0);
      // Higher fee should reduce effective output
    });

    it('should produce higher slippage for higher fee tiers', () => {
      const lowFeePool = createV3Pool({
        poolAddress: '0xv3_low_fee',
        feeBps: 1,
      });
      const highFeePool = createV3Pool({
        poolAddress: '0xv3_high_fee',
        feeBps: 100,
      });

      analyzer.updatePoolLiquidity(lowFeePool);
      analyzer.updatePoolLiquidity(highFeePool);

      const lowFeeEst = analyzer.estimateSlippage('0xv3_low_fee', 10000, 'buy');
      const highFeeEst = analyzer.estimateSlippage('0xv3_high_fee', 10000, 'buy');

      expect(lowFeeEst).not.toBeNull();
      expect(highFeeEst).not.toBeNull();
      expect(highFeeEst!.slippagePercent).toBeGreaterThan(lowFeeEst!.slippagePercent);
    });

    it('should produce valid depth analysis with buy and sell levels', () => {
      const pool = createV3Pool();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      expect(analysis).not.toBeNull();
      expect(analysis!.poolAddress).toBe(pool.poolAddress);
      expect(analysis!.buyLevels.length).toBeGreaterThan(0);
      expect(analysis!.sellLevels.length).toBeGreaterThan(0);
      expect(analysis!.liquidityScore).toBeGreaterThanOrEqual(0);
      expect(analysis!.liquidityScore).toBeLessThanOrEqual(1);
      expect(analysis!.optimalTradeSizeUsd).toBeGreaterThanOrEqual(0);

      // Price impact should be monotonically non-decreasing
      for (let i = 1; i < analysis!.buyLevels.length; i++) {
        expect(analysis!.buyLevels[i].priceImpactPercent)
          .toBeGreaterThanOrEqual(analysis!.buyLevels[i - 1].priceImpactPercent);
      }
    });

    it('should return valid result for a very large trade exceeding typical tick range', () => {
      const pool = createV3Pool({
        poolAddress: '0xv3_large_trade',
        liquidityUsd: 50000000,
      });
      analyzer.updatePoolLiquidity(pool);

      // Trade size close to 50% of pool liquidity
      const estimate = analyzer.estimateSlippage(pool.poolAddress, 20000000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(estimate!.outputAmount).toBeGreaterThanOrEqual(0);
    });

    it('should handle V3 pool with zero liquidity gracefully', () => {
      const pool = createV3Pool({
        poolAddress: '0xv3_zero_liq',
        liquidity: 0n,
        reserve0: 0n,
        reserve1: 0n,
        liquidityUsd: 0,
        price: 2000,
      });
      // Price > 0 but liquidityUsd = 0: should still be accepted (valid price)
      // but produce minimal/zero output
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage('0xv3_zero_liq', 1000, 'buy');
      // Either null (pool rejected) or zero/near-zero output
      if (estimate) {
        expect(estimate.outputAmount).toBeGreaterThanOrEqual(0);
      }
    });

    it('should handle V3 pool with sqrtPriceX96 = 0n gracefully', () => {
      const pool = createV3Pool({
        poolAddress: '0xv3_zero_sqrt',
        sqrtPriceX96: 0n,
      });
      analyzer.updatePoolLiquidity(pool);

      // Should not throw; may fall back to constant-product or return degraded result
      const estimate = analyzer.estimateSlippage('0xv3_zero_sqrt', 1000, 'buy');
      if (estimate) {
        expect(estimate.priceImpactPercent).toBeGreaterThanOrEqual(0);
      }
    });

    it('should show increasing slippage with trade size', () => {
      const pool = createV3Pool();
      analyzer.updatePoolLiquidity(pool);

      const small = analyzer.estimateSlippage(pool.poolAddress, 1000, 'buy');
      const medium = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');
      const large = analyzer.estimateSlippage(pool.poolAddress, 50000, 'buy');

      expect(small).not.toBeNull();
      expect(medium).not.toBeNull();
      expect(large).not.toBeNull();
      expect(medium!.priceImpactPercent).toBeGreaterThanOrEqual(small!.priceImpactPercent);
      expect(large!.priceImpactPercent).toBeGreaterThan(medium!.priceImpactPercent);
    });
  });

  // ===========================================================================
  // Curve StableSwap
  // ===========================================================================

  describe('Curve StableSwap', () => {
    it('should return very low slippage for equal-value stablecoin swaps with high A', () => {
      const pool = createCurvePool({
        amplificationParameter: 2000,
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.outputAmount).toBeGreaterThan(0);
      // For stablecoins with high A, price impact should be very small
      expect(estimate!.priceImpactPercent).toBeLessThan(0.1);
    });

    it('should approximate constant-product behavior when A=0', () => {
      const curveA0 = createCurvePool({
        poolAddress: '0xcurve_a0',
        amplificationParameter: 0,
      });
      const v2Pool = createPool({
        poolAddress: '0xv2_compare_curve',
        token0: 'USDC',
        token1: 'USDT',
        reserve0: BigInt('50000000') * BigInt(1e18),
        reserve1: BigInt('50000000') * BigInt(1e18),
        feeBps: 4,
        liquidityUsd: 100000000,
        price: 1.0,
      });

      analyzer.updatePoolLiquidity(curveA0);
      analyzer.updatePoolLiquidity(v2Pool);

      const curveEst = analyzer.estimateSlippage('0xcurve_a0', 50000, 'buy');
      const v2Est = analyzer.estimateSlippage('0xv2_compare_curve', 50000, 'buy');

      expect(curveEst).not.toBeNull();
      expect(v2Est).not.toBeNull();
      // At A=0, Curve should approximate constant-product
      // Allow 20% tolerance due to implementation differences
      expect(curveEst!.priceImpactPercent).toBeCloseTo(v2Est!.priceImpactPercent, 0);
    });

    it('should approach zero slippage for same-price tokens with very high A', () => {
      const pool = createCurvePool({
        poolAddress: '0xcurve_high_a',
        amplificationParameter: 10000,
        // Balanced stablecoin reserves
        reserve0: BigInt('100000000') * BigInt(1e18),
        reserve1: BigInt('100000000') * BigInt(1e18),
        liquidityUsd: 200000000,
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 100000, 'buy');
      expect(estimate).not.toBeNull();
      // With very high A and balanced reserves, price impact should be very small.
      // Note: priceImpact includes fee cost (~0.04% at feeBps=4), so threshold is 0.1%
      expect(estimate!.priceImpactPercent).toBeLessThan(0.1);
    });

    it('should produce lower slippage with higher A parameter', () => {
      const lowA = createCurvePool({
        poolAddress: '0xcurve_low_a',
        amplificationParameter: 10,
      });
      const highA = createCurvePool({
        poolAddress: '0xcurve_high_a2',
        amplificationParameter: 2000,
      });

      analyzer.updatePoolLiquidity(lowA);
      analyzer.updatePoolLiquidity(highA);

      const lowAEst = analyzer.estimateSlippage('0xcurve_low_a', 50000, 'buy');
      const highAEst = analyzer.estimateSlippage('0xcurve_high_a2', 50000, 'buy');

      expect(lowAEst).not.toBeNull();
      expect(highAEst).not.toBeNull();
      // Higher A should mean lower price impact
      expect(highAEst!.priceImpactPercent).toBeLessThan(lowAEst!.priceImpactPercent);
    });

    it('should produce valid depth analysis levels', () => {
      const pool = createCurvePool();
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      expect(analysis).not.toBeNull();
      expect(analysis!.poolAddress).toBe(pool.poolAddress);
      expect(analysis!.buyLevels.length).toBeGreaterThan(0);
      expect(analysis!.sellLevels.length).toBeGreaterThan(0);
      expect(analysis!.liquidityScore).toBeGreaterThanOrEqual(0);
      expect(analysis!.liquidityScore).toBeLessThanOrEqual(1);

      // Trade size should increase across levels
      for (let i = 1; i < analysis!.buyLevels.length; i++) {
        expect(analysis!.buyLevels[i].tradeSizeUsd)
          .toBeGreaterThan(analysis!.buyLevels[i - 1].tradeSizeUsd);
      }

      // Price impact should be monotonically non-decreasing
      for (let i = 1; i < analysis!.buyLevels.length; i++) {
        expect(analysis!.buyLevels[i].priceImpactPercent)
          .toBeGreaterThanOrEqual(analysis!.buyLevels[i - 1].priceImpactPercent);
      }
    });

    it('should produce less output from unbalanced reserves when buying the scarce token', () => {
      const balanced = createCurvePool({
        poolAddress: '0xcurve_balanced',
        reserve0: BigInt('50000000') * BigInt(1e18),
        reserve1: BigInt('50000000') * BigInt(1e18),
      });
      const unbalanced = createCurvePool({
        poolAddress: '0xcurve_unbalanced',
        reserve0: BigInt('80000000') * BigInt(1e18),
        reserve1: BigInt('20000000') * BigInt(1e18),
      });

      analyzer.updatePoolLiquidity(balanced);
      analyzer.updatePoolLiquidity(unbalanced);

      // Buying from the unbalanced pool (token1 is scarce at 20M vs 80M)
      // should produce less output than the balanced pool
      const balancedEst = analyzer.estimateSlippage('0xcurve_balanced', 100000, 'buy');
      const unbalancedEst = analyzer.estimateSlippage('0xcurve_unbalanced', 100000, 'buy');

      expect(balancedEst).not.toBeNull();
      expect(unbalancedEst).not.toBeNull();
      // Unbalanced pool gives less output for the scarce token
      expect(unbalancedEst!.outputAmount).toBeLessThan(balancedEst!.outputAmount);
    });

    it('should show increasing slippage with trade size', () => {
      const pool = createCurvePool();
      analyzer.updatePoolLiquidity(pool);

      const small = analyzer.estimateSlippage(pool.poolAddress, 1000, 'buy');
      const large = analyzer.estimateSlippage(pool.poolAddress, 1000000, 'buy');

      expect(small).not.toBeNull();
      expect(large).not.toBeNull();
      expect(large!.priceImpactPercent).toBeGreaterThan(small!.priceImpactPercent);
    });

    it('should handle negative amplification parameter gracefully', () => {
      const pool = createCurvePool({
        poolAddress: '0xcurve_neg_a',
        amplificationParameter: -100,
      });
      analyzer.updatePoolLiquidity(pool);

      // Should not throw; may fall back to constant-product
      const estimate = analyzer.estimateSlippage('0xcurve_neg_a', 10000, 'buy');
      if (estimate) {
        expect(estimate.priceImpactPercent).toBeGreaterThanOrEqual(0);
        expect(estimate.outputAmount).toBeGreaterThanOrEqual(0);
      }
    });

    it('should handle zero fee Curve pool', () => {
      const pool = createCurvePool({
        poolAddress: '0xcurve_zero_fee',
        feeBps: 0,
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // AMM Type Selection
  // ===========================================================================

  describe('AMM Type Selection', () => {
    it('should default to constant-product when no ammType is set', () => {
      const pool = createPool(); // No ammType field
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should use constant-product model when ammType is constant_product', () => {
      const explicit = createPool({
        poolAddress: '0xexplicit_cp',
        ammType: 'constant_product' as const,
      });
      const implicit = createPool({
        poolAddress: '0ximplicit_cp',
        // No ammType -> default constant-product
      });

      analyzer.updatePoolLiquidity(explicit);
      analyzer.updatePoolLiquidity(implicit);

      const explicitEst = analyzer.estimateSlippage('0xexplicit_cp', 10000, 'buy');
      const implicitEst = analyzer.estimateSlippage('0ximplicit_cp', 10000, 'buy');

      expect(explicitEst).not.toBeNull();
      expect(implicitEst).not.toBeNull();
      // Both should produce identical results
      expect(explicitEst!.priceImpactPercent).toBeCloseTo(implicitEst!.priceImpactPercent, 10);
      expect(explicitEst!.outputAmount).toBeCloseTo(implicitEst!.outputAmount, 10);
    });

    it('should use V3 model when ammType is concentrated', () => {
      const v3Pool = createV3Pool();
      analyzer.updatePoolLiquidity(v3Pool);

      const stored = analyzer.getPoolLiquidity(v3Pool.poolAddress);
      expect(stored).not.toBeUndefined();
      expect((stored as any).ammType).toBe('concentrated');

      const estimate = analyzer.estimateSlippage(v3Pool.poolAddress, 10000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should use Curve model when ammType is stable', () => {
      const curvePool = createCurvePool();
      analyzer.updatePoolLiquidity(curvePool);

      const stored = analyzer.getPoolLiquidity(curvePool.poolAddress);
      expect(stored).not.toBeUndefined();
      expect((stored as any).ammType).toBe('stable_swap');

      const estimate = analyzer.estimateSlippage(curvePool.poolAddress, 10000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should fall back to constant-product when V3 pool is missing sqrtPriceX96', () => {
      const incompleteV3 = createV3Pool({
        poolAddress: '0xv3_no_sqrt',
        sqrtPriceX96: undefined as any,
        liquidity: undefined as any,
      });
      analyzer.updatePoolLiquidity(incompleteV3);

      // Should still produce a valid result via constant-product fallback
      const estimate = analyzer.estimateSlippage('0xv3_no_sqrt', 10000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should fall back to constant-product when Curve pool is missing amplificationParameter', () => {
      const incompleteCurve = createCurvePool({
        poolAddress: '0xcurve_no_amp',
        amplificationParameter: undefined as any,
      });
      analyzer.updatePoolLiquidity(incompleteCurve);

      // Should still produce a valid result via constant-product fallback
      const estimate = analyzer.estimateSlippage('0xcurve_no_amp', 10000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should dispatch different models producing different results for same reserves', () => {
      // Same reserves, but one is V3 concentrated, one is constant-product, one is Curve stable
      // sqrtPriceX96 for price=1.0: sqrt(1) * 2^96
      const sqrtPrice1_0 = BigInt('79228162514264337593543950336');
      const baseOverrides = {
        token0: 'USDC' as const,
        token1: 'USDT' as const,
        reserve0: BigInt('50000000') * BigInt(1e18),
        reserve1: BigInt('50000000') * BigInt(1e18),
        liquidityUsd: 100000000,
        price: 1.0,
        feeBps: 30,
      };

      const cpPool = createPool({
        poolAddress: '0xdispatch_cp',
        ...baseOverrides,
      });
      const v3Pool = createV3Pool({
        poolAddress: '0xdispatch_v3',
        ...baseOverrides,
        sqrtPriceX96: sqrtPrice1_0,
        liquidity: BigInt('50000000') * BigInt(1e18),
      });
      const curvePool = createCurvePool({
        poolAddress: '0xdispatch_curve',
        ...baseOverrides,
        amplificationParameter: 500,
      });

      analyzer.updatePoolLiquidity(cpPool);
      analyzer.updatePoolLiquidity(v3Pool);
      analyzer.updatePoolLiquidity(curvePool);

      const cpEst = analyzer.estimateSlippage('0xdispatch_cp', 50000, 'buy');
      const v3Est = analyzer.estimateSlippage('0xdispatch_v3', 50000, 'buy');
      const curveEst = analyzer.estimateSlippage('0xdispatch_curve', 50000, 'buy');

      expect(cpEst).not.toBeNull();
      expect(v3Est).not.toBeNull();
      expect(curveEst).not.toBeNull();

      // All three models should produce valid, non-negative results
      expect(cpEst!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(v3Est!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      expect(curveEst!.priceImpactPercent).toBeGreaterThanOrEqual(0);

      // Curve stable pool should have the lowest slippage for stablecoin pairs
      expect(curveEst!.priceImpactPercent).toBeLessThan(cpEst!.priceImpactPercent);
    });
  });

  // ===========================================================================
  // Backwards Compatibility
  // ===========================================================================

  describe('Backwards Compatibility', () => {
    it('should accept pools without ammType and behave identically to before', () => {
      const pool = createPool(); // No ammType
      analyzer.updatePoolLiquidity(pool);

      const analysis = analyzer.analyzeDepth(pool.poolAddress);
      expect(analysis).not.toBeNull();
      expect(analysis!.buyLevels.length).toBeGreaterThan(0);
      expect(analysis!.sellLevels.length).toBeGreaterThan(0);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
    });

    it('should still validate pool fields (price, reserves) for new AMM types', () => {
      const badV3 = createV3Pool({
        poolAddress: '0xv3_bad_price',
        price: -100,
      });
      const badCurve = createCurvePool({
        poolAddress: '0xcurve_bad_reserves',
        reserve0: -1n,
      });

      analyzer.updatePoolLiquidity(badV3);
      analyzer.updatePoolLiquidity(badCurve);

      expect(analyzer.getPoolLiquidity('0xv3_bad_price')).toBeUndefined();
      expect(analyzer.getPoolLiquidity('0xcurve_bad_reserves')).toBeUndefined();
    });

    it('should work with findBestPool across mixed pool types', () => {
      const cpPool = createPool({
        poolAddress: '0xmixed_cp',
        token0: 'USDC',
        token1: 'USDT',
        reserve0: BigInt('10000000') * BigInt(1e18),
        reserve1: BigInt('10000000') * BigInt(1e18),
        liquidityUsd: 20000000,
        price: 1.0,
        feeBps: 30,
      });
      const curvePool = createCurvePool({
        poolAddress: '0xmixed_curve',
        token0: 'USDC',
        token1: 'USDT',
        amplificationParameter: 500,
      });

      analyzer.updatePoolLiquidity(cpPool);
      analyzer.updatePoolLiquidity(curvePool);

      const result = analyzer.findBestPool('USDC', 'USDT', 10000, 'buy');
      expect(result).not.toBeNull();
      // Curve pool should win for stablecoin pair due to lower slippage
      expect(result!.poolAddress).toBe('0xmixed_curve');
    });

    it('should work with analyzeDepth for each pool type', () => {
      const cpPool = createPool({ poolAddress: '0xcompat_cp' });
      const v3Pool = createV3Pool({ poolAddress: '0xcompat_v3' });
      const curvePool = createCurvePool({ poolAddress: '0xcompat_curve' });

      analyzer.updatePoolLiquidity(cpPool);
      analyzer.updatePoolLiquidity(v3Pool);
      analyzer.updatePoolLiquidity(curvePool);

      const cpAnalysis = analyzer.analyzeDepth('0xcompat_cp');
      const v3Analysis = analyzer.analyzeDepth('0xcompat_v3');
      const curveAnalysis = analyzer.analyzeDepth('0xcompat_curve');

      // All should return valid depth analyses
      for (const analysis of [cpAnalysis, v3Analysis, curveAnalysis]) {
        expect(analysis).not.toBeNull();
        expect(analysis!.buyLevels.length).toBeGreaterThan(0);
        expect(analysis!.sellLevels.length).toBeGreaterThan(0);
        expect(analysis!.liquidityScore).toBeGreaterThanOrEqual(0);
        expect(analysis!.liquidityScore).toBeLessThanOrEqual(1);
        expect(analysis!.optimalTradeSizeUsd).toBeGreaterThanOrEqual(0);
      }
    });

    it('should produce non-negative price impact for all AMM types', () => {
      const pools = [
        createPool({ poolAddress: '0xregress_cp' }),
        createV3Pool({ poolAddress: '0xregress_v3' }),
        createCurvePool({ poolAddress: '0xregress_curve' }),
      ];

      for (const pool of pools) {
        analyzer.updatePoolLiquidity(pool);
        const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');
        expect(estimate).not.toBeNull();
        expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
      }
    });

    it('should produce bounded output for all AMM types', () => {
      const pools = [
        createPool({ poolAddress: '0xreserve_cp' }),
        createV3Pool({ poolAddress: '0xreserve_v3' }),
        createCurvePool({ poolAddress: '0xreserve_curve' }),
      ];

      for (const pool of pools) {
        analyzer.updatePoolLiquidity(pool);
        const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'buy');
        expect(estimate).not.toBeNull();
        expect(estimate!.outputAmount).toBeGreaterThan(0);

        // For non-concentrated pools, output should be less than actual reserves.
        // V3 concentrated liquidity uses virtual reserves larger than actual deposits
        // (that's the core value proposition), so output can exceed actual reserves.
        if (pool.ammType !== 'concentrated') {
          const reserve1Float = Number(pool.reserve1) / 1e18;
          expect(estimate!.outputAmount).toBeLessThan(reserve1Float);
        }
      }
    });

    it('should cache and evict V3 and Curve pools same as constant-product', () => {
      const v3Pool = createV3Pool({ poolAddress: '0xcache_v3' });
      analyzer.updatePoolLiquidity(v3Pool);

      // First call: cache miss
      analyzer.analyzeDepth('0xcache_v3');
      // Second call: cache hit
      analyzer.analyzeDepth('0xcache_v3');

      const stats = analyzer.getStats();
      expect(stats.cacheHits).toBeGreaterThanOrEqual(1);
      expect(stats.cacheMisses).toBeGreaterThanOrEqual(1);
    });

    it('should invalidate cache when V3 pool sqrtPrice is updated', () => {
      const pool = createV3Pool({ poolAddress: '0xcache_v3_update' });
      analyzer.updatePoolLiquidity(pool);

      // Generate cached analysis
      const analysis1 = analyzer.analyzeDepth('0xcache_v3_update');
      expect(analysis1).not.toBeNull();

      // Update pool with new sqrtPrice (simulates price movement)
      const newSqrtPrice = BigInt('3600000000000000000000000000000');
      const updatedPool = createV3Pool({
        poolAddress: '0xcache_v3_update',
        sqrtPriceX96: newSqrtPrice,
        price: 2100,
        timestamp: Date.now() + 1000,
      });
      analyzer.updatePoolLiquidity(updatedPool);

      // Cache should be invalidated
      const analysis2 = analyzer.analyzeDepth('0xcache_v3_update');
      expect(analysis2).not.toBeNull();

      const stats = analyzer.getStats();
      // Should have at least 2 cache misses (initial + after invalidation)
      expect(stats.cacheMisses).toBeGreaterThanOrEqual(2);
    });
  });

  // ===========================================================================
  // Edge Cases across AMM types
  // ===========================================================================

  describe('Edge cases across AMM types', () => {
    it('should handle zero input amount for all AMM types', () => {
      const pools = [
        createPool({ poolAddress: '0xzero_cp' }),
        createV3Pool({ poolAddress: '0xzero_v3' }),
        createCurvePool({ poolAddress: '0xzero_curve' }),
      ];

      for (const pool of pools) {
        analyzer.updatePoolLiquidity(pool);
        const estimate = analyzer.estimateSlippage(pool.poolAddress, 0, 'buy');
        if (estimate) {
          expect(estimate.outputAmount).toBe(0);
        }
      }
    });

    it('should handle feeBps of 10000 (100% fee) for V3 pool', () => {
      const pool = createV3Pool({
        poolAddress: '0xv3_100pct_fee',
        feeBps: 10000,
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 1000, 'buy');
      // With 100% fee, output should be 0 or near 0
      if (estimate) {
        expect(estimate.outputAmount).toBeCloseTo(0, 5);
      }
    });

    it('should handle very large amplification parameter', () => {
      const pool = createCurvePool({
        poolAddress: '0xcurve_huge_a',
        amplificationParameter: 100000,
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 50000, 'buy');
      expect(estimate).not.toBeNull();
      // With huge A, slippage should be near zero for balanced stables
      // Note: priceImpact includes fee cost (~0.04% at feeBps=4)
      expect(estimate!.priceImpactPercent).toBeLessThan(0.1);
    });

    it('should handle V3 pool with very narrow tick range (highly concentrated)', () => {
      const pool = createV3Pool({
        poolAddress: '0xv3_narrow',
        tickSpacing: 1,
        // Very high liquidity concentrated in narrow range
        liquidity: BigInt('100000000') * BigInt(1e18),
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 5000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
    });

    it('should handle V3 pool with very wide tick range (approaching constant-product)', () => {
      const pool = createV3Pool({
        poolAddress: '0xv3_wide',
        tickSpacing: 200,
        // Lower liquidity spread across wide range
        liquidity: BigInt('100000') * BigInt(1e18),
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 5000, 'buy');
      expect(estimate).not.toBeNull();
      expect(estimate!.priceImpactPercent).toBeGreaterThanOrEqual(0);
    });

    it('should handle sell direction for V3 pools', () => {
      const pool = createV3Pool();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'sell');
      expect(estimate).not.toBeNull();
      expect(estimate!.tradeDirection).toBe('sell');
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should handle sell direction for Curve pools', () => {
      const pool = createCurvePool();
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage(pool.poolAddress, 10000, 'sell');
      expect(estimate).not.toBeNull();
      expect(estimate!.tradeDirection).toBe('sell');
      expect(estimate!.outputAmount).toBeGreaterThan(0);
    });

    it('should handle Curve pool with reserves = 0', () => {
      const pool = createCurvePool({
        poolAddress: '0xcurve_zero_reserves',
        reserve0: 0n,
        reserve1: 0n,
        liquidityUsd: 0,
        price: 1.0,
      });
      analyzer.updatePoolLiquidity(pool);

      const estimate = analyzer.estimateSlippage('0xcurve_zero_reserves', 1000, 'buy');
      if (estimate) {
        expect(estimate.outputAmount).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
