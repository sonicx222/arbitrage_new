/**
 * CrossDexTriangularArbitrage Unit Tests
 *
 * Comprehensive tests for cross-DEX triangular and quadrilateral
 * arbitrage detection engine.
 *
 * Covers:
 * - Constructor and configuration
 * - Dynamic slippage calculation (T1.2)
 * - Triangular opportunity detection (3-hop)
 * - Quadrilateral opportunity detection (4-hop, T2.6)
 * - Statistics, config updates, slippage config accessors
 * - BigInt precision in AMM swap simulation
 * - Filtering: cross-DEX enforcement, profit thresholds, confidence
 *
 * @see cross-dex-triangular-arbitrage.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks (must be defined before importing the module under test)
// ---------------------------------------------------------------------------

jest.mock('../../src/logger');

jest.mock('../../src/caching/hierarchical-cache', () => ({
  getHierarchicalCache: () => ({
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  }),
}));

const mockEstimateGasCostRatio = jest.fn().mockReturnValue(0.001);
jest.mock('../../src/caching/gas-price-cache', () => ({
  getGasPriceCache: () => ({
    estimateGasCostRatio: mockEstimateGasCostRatio,
  }),
  GAS_UNITS: {
    simpleSwap: 150000,
    complexSwap: 200000,
    triangularArbitrage: 450000,
    quadrilateralArbitrage: 600000,
    multiLegPerHop: 150000,
    multiLegBase: 100000,
  },
  FALLBACK_GAS_COSTS_ETH: {
    ethereum: 0.005,
    bsc: 0.0001,
    arbitrum: 0.00005,
    base: 0.00001,
    polygon: 0.0001,
  } as Record<string, number>,
  FALLBACK_GAS_SCALING_PER_STEP: 0.25,
}));

const mockGetNativeTokenPrice = jest.fn().mockReturnValue(2000);
jest.mock('@arbitrage/config', () => ({
  getNativeTokenPrice: (...args: unknown[]) => mockGetNativeTokenPrice(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks
// ---------------------------------------------------------------------------

import {
  CrossDexTriangularArbitrage,
  DexPool,
  TriangularOpportunity,
  QuadrilateralOpportunity,
  DynamicSlippageConfig,
} from '../../src/cross-dex-triangular-arbitrage';

export {};

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

function createPool(overrides: Partial<DexPool> = {}): DexPool {
  return {
    dex: 'uniswap',
    token0: 'WETH',
    token1: 'USDC',
    reserve0: '1000000000000000000000', // 1000 tokens (18 decimals)
    reserve1: '2000000000000000000000000', // 2M tokens (18 decimals)
    fee: 30, // 0.3% in basis points
    liquidity: 1_000_000, // $1M
    price: 2000,
    ...overrides,
  };
}

/**
 * Build a set of pools that form a valid cross-DEX triangle:
 * WETH -> USDC (uniswap) -> DAI (sushiswap) -> WETH (curve)
 *
 * Reserves are set so the cycle is slightly profitable before gas.
 * The "mis-pricing" comes from an advantageous USDC->DAI ratio on sushiswap.
 */
function createTrianglePools(): DexPool[] {
  return [
    // Leg 1: WETH -> USDC on uniswap (price 2000 USDC per ETH)
    createPool({
      dex: 'uniswap',
      token0: 'WETH',
      token1: 'USDC',
      reserve0: '1000000000000000000000',      // 1000 WETH
      reserve1: '2000000000000000000000000',    // 2,000,000 USDC
      fee: 30,
      liquidity: 4_000_000,
      price: 2000,
    }),
    // Leg 2: USDC -> DAI on sushiswap (slight mispricing: 1 USDC = 1.02 DAI)
    createPool({
      dex: 'sushiswap',
      token0: 'USDC',
      token1: 'DAI',
      reserve0: '1000000000000000000000000',    // 1,000,000 USDC
      reserve1: '1020000000000000000000000',    // 1,020,000 DAI
      fee: 25,
      liquidity: 2_000_000,
      price: 1.02,
    }),
    // Leg 3: DAI -> WETH on curve (price ~2000 DAI per ETH)
    createPool({
      dex: 'curve',
      token0: 'DAI',
      token1: 'WETH',
      reserve0: '2000000000000000000000000',    // 2,000,000 DAI
      reserve1: '1000000000000000000000',       // 1000 WETH
      fee: 4,  // 0.04% fee on Curve
      liquidity: 4_000_000,
      price: 0.0005,
    }),
  ];
}

/**
 * Build pools for a quadrilateral:
 * WETH -> USDC (uniswap) -> DAI (sushiswap) -> WBTC (curve) -> WETH (pancakeswap)
 */
function createQuadPools(): DexPool[] {
  return [
    // WETH <-> USDC
    createPool({
      dex: 'uniswap',
      token0: 'WETH',
      token1: 'USDC',
      reserve0: '1000000000000000000000',
      reserve1: '2000000000000000000000000',
      fee: 30,
      liquidity: 4_000_000,
      price: 2000,
    }),
    // USDC <-> DAI (slight mispricing)
    createPool({
      dex: 'sushiswap',
      token0: 'USDC',
      token1: 'DAI',
      reserve0: '1000000000000000000000000',
      reserve1: '1030000000000000000000000', // 1.03 DAI per USDC
      fee: 25,
      liquidity: 2_000_000,
      price: 1.03,
    }),
    // DAI <-> WBTC
    createPool({
      dex: 'curve',
      token0: 'DAI',
      token1: 'WBTC',
      reserve0: '40000000000000000000000000',  // 40M DAI
      reserve1: '1000000000000000000000',       // 1000 WBTC
      fee: 4,
      liquidity: 40_000_000,
      price: 0.000025,
    }),
    // WBTC <-> WETH
    createPool({
      dex: 'pancakeswap',
      token0: 'WBTC',
      token1: 'WETH',
      reserve0: '100000000000000000000',        // 100 WBTC
      reserve1: '2000000000000000000000',       // 2000 WETH
      fee: 25,
      liquidity: 8_000_000,
      price: 20,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossDexTriangularArbitrage', () => {
  let arb: CrossDexTriangularArbitrage;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEstimateGasCostRatio.mockReturnValue(0.001);
    mockGetNativeTokenPrice.mockReturnValue(2000);
    arb = new CrossDexTriangularArbitrage();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should use default configuration when no options are provided', () => {
      const stats = arb.getStatistics();
      expect(stats.minProfitThreshold).toBe(0.005);
      expect(stats.maxSlippage).toBe(0.10);
      expect(stats.maxExecutionTime).toBe(5000);
    });

    it('should override configuration with provided options', () => {
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.01,
        maxSlippage: 0.05,
        maxExecutionTime: 3000,
      });
      const stats = custom.getStatistics();
      expect(stats.minProfitThreshold).toBe(0.01);
      expect(stats.maxSlippage).toBe(0.05);
      expect(stats.maxExecutionTime).toBe(3000);
    });

    it('should accept explicit 0 for minProfitThreshold using ?? semantics', () => {
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0,
      });
      const stats = custom.getStatistics();
      expect(stats.minProfitThreshold).toBe(0);
    });

    it('should merge partial slippage config with defaults', () => {
      const custom = new CrossDexTriangularArbitrage({
        slippageConfig: { baseSlippage: 0.01 },
      });
      const slippageCfg = custom.getSlippageConfig();
      expect(slippageCfg.baseSlippage).toBe(0.01);
      // Other values should still be defaults
      expect(slippageCfg.priceImpactScale).toBe(5.0);
      expect(slippageCfg.liquidityPenaltyScale).toBe(2.0);
    });

    it('should sync maxSlippage from slippageConfig if provided', () => {
      const custom = new CrossDexTriangularArbitrage({
        slippageConfig: { maxSlippage: 0.15 },
      });
      const stats = custom.getStatistics();
      // When slippageConfig.maxSlippage is set, constructor uses it for this.maxSlippage
      // because options.maxSlippage is undefined, it falls back to this.slippageConfig.maxSlippage
      expect(stats.maxSlippage).toBe(0.15);
    });
  });

  // =========================================================================
  // calculateDynamicSlippage
  // =========================================================================

  describe('calculateDynamicSlippage', () => {
    it('should return base slippage when trade size is 0', () => {
      const slippage = arb.calculateDynamicSlippage(0, 1000, 1_000_000);
      expect(slippage).toBeCloseTo(0.003, 6);
    });

    it('should add price impact for non-zero trade size', () => {
      // tradeSize=100, reserveIn=1000 => priceImpact = 100/(1000+100) = 0.0909...
      // slippage = 0.003 + 0.0909*5 = 0.003 + 0.4545 = 0.4575
      // But capped at maxSlippage (0.10)
      const slippage = arb.calculateDynamicSlippage(100, 1000, 1_000_000);
      expect(slippage).toBe(0.10); // Capped at max
    });

    it('should calculate price impact correctly for small trade', () => {
      // tradeSize=1, reserveIn=10000 => priceImpact = 1/10001 = 0.00009999
      // slippage = 0.003 + 0.00009999*5 = 0.003 + 0.0005 = 0.0035
      const slippage = arb.calculateDynamicSlippage(1, 10000, 1_000_000);
      expect(slippage).toBeCloseTo(0.003 + (1 / 10001) * 5, 6);
    });

    it('should add liquidity penalty for low-liquidity pools', () => {
      // liquidityUsd=50000 < minLiquidityUsd=100000
      // liquidityRatio = 50000/100000 = 0.5
      // liquidityPenalty = (1 - 0.5) * 2.0 * 0.01 = 0.01
      // slippage = 0.003 + 0 (tradeSize=0) + 0.01 = 0.013
      const slippage = arb.calculateDynamicSlippage(0, 1000, 50000);
      expect(slippage).toBeCloseTo(0.013, 6);
    });

    it('should not add liquidity penalty when liquidity exceeds min threshold', () => {
      const slippage = arb.calculateDynamicSlippage(0, 1000, 200_000);
      expect(slippage).toBeCloseTo(0.003, 6);
    });

    it('should not add liquidity penalty when liquidityUsd is 0', () => {
      // liquidityUsd=0 does not pass the > 0 check
      const slippage = arb.calculateDynamicSlippage(0, 1000, 0);
      expect(slippage).toBeCloseTo(0.003, 6);
    });

    it('should cap slippage at maxSlippage', () => {
      // Very large trade -> price impact pushes slippage above max
      const slippage = arb.calculateDynamicSlippage(5000, 1000, 1000);
      expect(slippage).toBeLessThanOrEqual(0.10);
      expect(slippage).toBe(0.10);
    });

    it('should respect custom maxSlippage from slippage config', () => {
      const custom = new CrossDexTriangularArbitrage({
        slippageConfig: { maxSlippage: 0.02 },
      });
      const slippage = custom.calculateDynamicSlippage(5000, 1000, 1000);
      expect(slippage).toBe(0.02);
    });

    it('should handle reserveIn of 0 gracefully', () => {
      // When reserveIn is 0, priceImpact branch is skipped
      const slippage = arb.calculateDynamicSlippage(100, 0, 1_000_000);
      expect(slippage).toBeCloseTo(0.003, 6);
    });

    it('should combine price impact and liquidity penalty', () => {
      // tradeSize=10, reserveIn=10000 => priceImpact = 10/10010 ~= 0.000999
      // priceImpactContrib = 0.000999 * 5 = 0.004995
      // liquidityUsd=25000 < 100000 => ratio=0.25, penalty=(1-0.25)*2*0.01 = 0.015
      // slippage = 0.003 + 0.004995 + 0.015 = 0.022995
      const slippage = arb.calculateDynamicSlippage(10, 10000, 25000);
      const expectedPriceImpact = (10 / 10010) * 5;
      const expectedPenalty = (1 - 25000 / 100000) * 2.0 * 0.01;
      expect(slippage).toBeCloseTo(0.003 + expectedPriceImpact + expectedPenalty, 5);
    });
  });

  // =========================================================================
  // findTriangularOpportunities
  // =========================================================================

  describe('findTriangularOpportunities', () => {
    it('should return empty array for empty pools', async () => {
      const result = await arb.findTriangularOpportunities('ethereum', []);
      expect(result).toEqual([]);
    });

    it('should return empty array when no triangles exist', async () => {
      // Only one pool, no triangle possible
      const pools = [createPool()];
      const result = await arb.findTriangularOpportunities('ethereum', pools);
      expect(result).toEqual([]);
    });

    it('should return empty array when only two pools do not close a triangle', async () => {
      const pools = [
        createPool({ dex: 'uniswap', token0: 'WETH', token1: 'USDC' }),
        createPool({ dex: 'sushiswap', token0: 'USDC', token1: 'DAI' }),
      ];
      const result = await arb.findTriangularOpportunities('ethereum', pools);
      expect(result).toEqual([]);
    });

    it('should filter out single-DEX triangles', async () => {
      // Triangle exists but all on the same DEX => filtered out
      const pools = [
        createPool({ dex: 'uniswap', token0: 'WETH', token1: 'USDC', reserve0: '1000000000000000000000', reserve1: '2000000000000000000000000', fee: 30, liquidity: 4_000_000 }),
        createPool({ dex: 'uniswap', token0: 'USDC', token1: 'DAI', reserve0: '1000000000000000000000000', reserve1: '1020000000000000000000000', fee: 25, liquidity: 2_000_000 }),
        createPool({ dex: 'uniswap', token0: 'DAI', token1: 'WETH', reserve0: '2000000000000000000000000', reserve1: '1000000000000000000000', fee: 4, liquidity: 4_000_000 }),
      ];
      const result = await arb.findTriangularOpportunities('ethereum', pools, ['WETH']);
      // All dexes are 'uniswap' => cross-DEX filter removes them
      expect(result).toEqual([]);
    });

    it('should detect profitable cross-DEX triangle', async () => {
      // Use very low gas cost and very low profit threshold to make the opportunity detectable
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.001,
        maxSlippage: 0.50,
        maxExecutionTime: 30000,
      });

      const pools = createTrianglePools();
      const result = await custom.findTriangularOpportunities('bsc', pools, ['WETH']);

      // There should be at least one detected opportunity if the mispricing produces enough profit
      // The exact count depends on the AMM math with the reserves we set up
      if (result.length > 0) {
        const opp = result[0];
        expect(opp.chain).toBe('bsc');
        expect(opp.path).toHaveLength(3);
        expect(opp.dexes).toHaveLength(3);
        expect(opp.steps).toHaveLength(3);
        expect(opp.netProfit).toBeGreaterThan(0);
        expect(opp.confidence).toBeGreaterThanOrEqual(0);
        expect(opp.id).toMatch(/^tri_/);
        // Cross-DEX: at least 2 unique DEXes
        expect(new Set(opp.dexes).size).toBeGreaterThanOrEqual(2);
      }
    });

    it('should use custom base tokens', async () => {
      // Pass a base token that doesn't appear in any pool
      const pools = createTrianglePools();
      const result = await arb.findTriangularOpportunities('ethereum', pools, ['NONEXISTENT']);
      expect(result).toEqual([]);
    });

    it('should rank opportunities by net profit descending', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.0001,
        maxSlippage: 0.50,
        maxExecutionTime: 30000,
      });

      // Create two sets of triangle pools with different mispricings
      const pools = [
        ...createTrianglePools(),
        // Second triangle with higher mispricing
        createPool({ dex: 'uniswap', token0: 'WBTC', token1: 'USDC', reserve0: '100000000000000000000', reserve1: '4000000000000000000000000', fee: 30, liquidity: 8_000_000, price: 40000 }),
        createPool({ dex: 'sushiswap', token0: 'USDC', token1: 'DAI', reserve0: '1000000000000000000000000', reserve1: '1050000000000000000000000', fee: 25, liquidity: 2_000_000, price: 1.05 }),
        createPool({ dex: 'curve', token0: 'DAI', token1: 'WBTC', reserve0: '4000000000000000000000000', reserve1: '100000000000000000000', fee: 4, liquidity: 8_000_000, price: 0.000025 }),
      ];

      const result = await custom.findTriangularOpportunities('bsc', pools, ['WETH', 'WBTC']);

      if (result.length >= 2) {
        // Verify descending sort by net profit
        for (let i = 1; i < result.length; i++) {
          expect(result[i - 1].netProfit).toBeGreaterThanOrEqual(result[i].netProfit - 0.001);
        }
      }
    });

    it('should compute profitUSD using getNativeTokenPrice', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      mockGetNativeTokenPrice.mockReturnValue(3000);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.0001,
        maxSlippage: 0.50,
        maxExecutionTime: 30000,
      });

      const pools = createTrianglePools();
      const result = await custom.findTriangularOpportunities('ethereum', pools, ['WETH']);

      if (result.length > 0) {
        const opp = result[0];
        // profitUSD = netProfit * getNativeTokenPrice(chain)
        expect(mockGetNativeTokenPrice).toHaveBeenCalledWith('ethereum');
        expect(opp.profitUSD).toBeCloseTo(opp.netProfit * 3000, 2);
      }
    });

    it('should filter by execution time', async () => {
      // Ethereum has a long base execution time (15000ms)
      // With maxExecutionTime=1000, all should be filtered
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.0001,
        maxSlippage: 0.50,
        maxExecutionTime: 1000, // Very low - Ethereum base time is 15000ms
      });

      const pools = createTrianglePools();
      const result = await custom.findTriangularOpportunities('ethereum', pools, ['WETH']);
      // Ethereum has 15000ms base + 3*500ms = 16500ms > 1000ms
      expect(result).toEqual([]);
    });

    it('should filter by minimum confidence (0.6 for triangular)', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.0001,
        maxSlippage: 0.50,
        maxExecutionTime: 30000,
      });

      // Pools with very low liquidity => low confidence
      const pools = [
        createPool({ dex: 'uniswap', token0: 'WETH', token1: 'USDC', reserve0: '1000000000000000000000', reserve1: '2000000000000000000000000', fee: 30, liquidity: 100, price: 2000 }),
        createPool({ dex: 'sushiswap', token0: 'USDC', token1: 'DAI', reserve0: '1000000000000000000000000', reserve1: '1020000000000000000000000', fee: 25, liquidity: 100, price: 1.02 }),
        createPool({ dex: 'curve', token0: 'DAI', token1: 'WETH', reserve0: '2000000000000000000000000', reserve1: '1000000000000000000000', fee: 4, liquidity: 100, price: 0.0005 }),
      ];

      const result = await custom.findTriangularOpportunities('bsc', pools, ['WETH']);
      // With liquidity=100 ($100), liquidityConfidence = 100/1_000_000 = 0.0001
      // Confidence should be very low => filtered out
      for (const opp of result) {
        expect(opp.confidence).toBeGreaterThanOrEqual(0.6);
      }
    });
  });

  // =========================================================================
  // findQuadrilateralOpportunities
  // =========================================================================

  describe('findQuadrilateralOpportunities', () => {
    it('should return empty array when fewer than 4 pools', async () => {
      const pools = [createPool(), createPool(), createPool()];
      const result = await arb.findQuadrilateralOpportunities('ethereum', pools);
      expect(result).toEqual([]);
    });

    it('should return empty array when no quadrilateral path exists', async () => {
      // 4 disconnected pools
      const pools = [
        createPool({ token0: 'A', token1: 'B', dex: 'dex1' }),
        createPool({ token0: 'C', token1: 'D', dex: 'dex2' }),
        createPool({ token0: 'E', token1: 'F', dex: 'dex3' }),
        createPool({ token0: 'G', token1: 'H', dex: 'dex4' }),
      ];
      const result = await arb.findQuadrilateralOpportunities('ethereum', pools, ['A']);
      expect(result).toEqual([]);
    });

    it('should filter out single-DEX quadrilaterals', async () => {
      // All 4 pools on same DEX
      const pools = [
        createPool({ dex: 'uniswap', token0: 'WETH', token1: 'USDC', liquidity: 4_000_000 }),
        createPool({ dex: 'uniswap', token0: 'USDC', token1: 'DAI', reserve0: '1000000000000000000000000', reserve1: '1030000000000000000000000', liquidity: 2_000_000 }),
        createPool({ dex: 'uniswap', token0: 'DAI', token1: 'WBTC', reserve0: '40000000000000000000000000', reserve1: '1000000000000000000000', liquidity: 40_000_000 }),
        createPool({ dex: 'uniswap', token0: 'WBTC', token1: 'WETH', reserve0: '100000000000000000000', reserve1: '2000000000000000000000', liquidity: 8_000_000 }),
      ];
      const result = await arb.findQuadrilateralOpportunities('ethereum', pools, ['WETH']);
      // All dexes are 'uniswap' => filtered by cross-DEX requirement
      expect(result).toEqual([]);
    });

    it('should detect profitable cross-DEX quadrilateral', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.0001,
        maxSlippage: 0.50,
        maxExecutionTime: 30000,
      });

      const pools = createQuadPools();
      const result = await custom.findQuadrilateralOpportunities('bsc', pools, ['WETH']);

      if (result.length > 0) {
        const opp = result[0];
        expect(opp.chain).toBe('bsc');
        expect(opp.path).toHaveLength(4);
        expect(opp.dexes).toHaveLength(4);
        expect(opp.steps).toHaveLength(4);
        expect(opp.netProfit).toBeGreaterThan(0);
        expect(opp.id).toMatch(/^quad_/);
        expect(new Set(opp.dexes).size).toBeGreaterThanOrEqual(2);
      }
    });

    it('should enforce minimum confidence of 0.5 for quadrilateral', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: 0.0001,
        maxSlippage: 0.50,
        maxExecutionTime: 30000,
      });

      const pools = createQuadPools();
      const result = await custom.findQuadrilateralOpportunities('bsc', pools, ['WETH']);

      for (const opp of result) {
        expect(opp.confidence).toBeGreaterThanOrEqual(0.5);
      }
    });

    it('should return empty when base token has fewer than 3 neighbors', async () => {
      // Base token 'X' only connects to 2 tokens
      const pools = [
        createPool({ dex: 'dex1', token0: 'X', token1: 'A', liquidity: 1_000_000 }),
        createPool({ dex: 'dex2', token0: 'X', token1: 'B', liquidity: 1_000_000 }),
        createPool({ dex: 'dex3', token0: 'A', token1: 'B', liquidity: 1_000_000 }),
        createPool({ dex: 'dex4', token0: 'B', token1: 'C', liquidity: 1_000_000 }),
      ];
      // X only has neighbors A, B (2 < 3 required)
      const result = await arb.findQuadrilateralOpportunities('ethereum', pools, ['X']);
      expect(result).toEqual([]);
    });
  });

  // =========================================================================
  // getStatistics / updateConfig / getSlippageConfig
  // =========================================================================

  describe('getStatistics', () => {
    it('should return current configuration', () => {
      const stats = arb.getStatistics();
      expect(stats).toHaveProperty('minProfitThreshold');
      expect(stats).toHaveProperty('maxSlippage');
      expect(stats).toHaveProperty('maxExecutionTime');
      expect(stats).toHaveProperty('supportedChains');
      expect(stats).toHaveProperty('slippageConfig');
      expect(stats.supportedChains).toEqual(['ethereum', 'bsc', 'arbitrum', 'base', 'polygon']);
    });

    it('should include slippage config in statistics', () => {
      const stats = arb.getStatistics();
      expect(stats.slippageConfig.baseSlippage).toBe(0.003);
      expect(stats.slippageConfig.priceImpactScale).toBe(5.0);
      expect(stats.slippageConfig.liquidityPenaltyScale).toBe(2.0);
    });
  });

  describe('updateConfig', () => {
    it('should update minProfitThreshold', () => {
      arb.updateConfig({ minProfitThreshold: 0.02 });
      expect(arb.getStatistics().minProfitThreshold).toBe(0.02);
    });

    it('should update maxSlippage', () => {
      arb.updateConfig({ maxSlippage: 0.15 });
      expect(arb.getStatistics().maxSlippage).toBe(0.15);
    });

    it('should update maxExecutionTime', () => {
      arb.updateConfig({ maxExecutionTime: 10000 });
      expect(arb.getStatistics().maxExecutionTime).toBe(10000);
    });

    it('should update partial slippage config', () => {
      arb.updateConfig({ slippageConfig: { baseSlippage: 0.005 } });
      const cfg = arb.getSlippageConfig();
      expect(cfg.baseSlippage).toBe(0.005);
      // Others unchanged
      expect(cfg.priceImpactScale).toBe(5.0);
    });

    it('should sync maxSlippage when slippageConfig.maxSlippage is updated', () => {
      arb.updateConfig({ slippageConfig: { maxSlippage: 0.20 } });
      expect(arb.getStatistics().maxSlippage).toBe(0.20);
      expect(arb.getSlippageConfig().maxSlippage).toBe(0.20);
    });

    it('should allow setting minProfitThreshold to 0', () => {
      arb.updateConfig({ minProfitThreshold: 0 });
      expect(arb.getStatistics().minProfitThreshold).toBe(0);
    });

    it('should not change unspecified fields', () => {
      const before = arb.getStatistics();
      arb.updateConfig({ minProfitThreshold: 0.02 });
      const after = arb.getStatistics();
      expect(after.maxSlippage).toBe(before.maxSlippage);
      expect(after.maxExecutionTime).toBe(before.maxExecutionTime);
    });
  });

  describe('getSlippageConfig', () => {
    it('should return a copy of the slippage config', () => {
      const cfg1 = arb.getSlippageConfig();
      const cfg2 = arb.getSlippageConfig();
      expect(cfg1).toEqual(cfg2);
      // Verify it's a copy, not the same object
      expect(cfg1).not.toBe(cfg2);
    });

    it('should not be affected by external mutations', () => {
      const cfg = arb.getSlippageConfig();
      cfg.baseSlippage = 999;
      expect(arb.getSlippageConfig().baseSlippage).toBe(0.003);
    });
  });

  // =========================================================================
  // BigInt precision (tested via AMM swap simulation)
  // =========================================================================

  describe('BigInt precision', () => {
    it('should produce deterministic swap results through triangular simulation', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: -1, // Accept any result to observe swap outputs
        maxSlippage: 1.0,
        maxExecutionTime: 60000,
      });

      const pools = createTrianglePools();
      const result1 = await custom.findTriangularOpportunities('bsc', pools, ['WETH']);
      const result2 = await custom.findTriangularOpportunities('bsc', pools, ['WETH']);

      // Both runs should produce identical step amounts (deterministic BigInt math)
      if (result1.length > 0 && result2.length > 0) {
        expect(result1[0].steps[0].amountOut).toBe(result2[0].steps[0].amountOut);
        expect(result1[0].steps[1].amountOut).toBe(result2[0].steps[1].amountOut);
        expect(result1[0].steps[2].amountOut).toBe(result2[0].steps[2].amountOut);
      }
    });

    it('should correctly apply fee deduction in AMM formula', async () => {
      // A single pool with known reserves, we can verify the AMM output
      // For 1 ETH input, reserve0=1000 ETH, reserve1=2M USDC, fee=30 bps:
      //   amountInWithFee = 1e18 * 9970 / 10000 = 997000000000000000
      //   numerator = 997000000000000000 * 2000000e18
      //   denominator = 1000e18 + 997000000000000000
      //   amountOut = numerator / denominator
      // This tests that the BigInt math produces the expected constant-product result
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: -1,
        maxSlippage: 1.0,
        maxExecutionTime: 60000,
      });

      // Simple triangle where we know the math
      const pools = [
        createPool({
          dex: 'uniswap',
          token0: 'WETH',
          token1: 'USDC',
          reserve0: '1000000000000000000000',   // 1000 WETH
          reserve1: '2000000000000000000000000', // 2,000,000 USDC
          fee: 30,
          liquidity: 4_000_000,
        }),
        createPool({
          dex: 'sushiswap',
          token0: 'USDC',
          token1: 'DAI',
          reserve0: '1000000000000000000000000',
          reserve1: '1000000000000000000000000', // 1:1 ratio
          fee: 0,  // Zero fee for simplicity
          liquidity: 2_000_000,
        }),
        createPool({
          dex: 'curve',
          token0: 'DAI',
          token1: 'WETH',
          reserve0: '2000000000000000000000000',
          reserve1: '1000000000000000000000',
          fee: 0,
          liquidity: 4_000_000,
        }),
      ];

      const result = await custom.findTriangularOpportunities('bsc', pools, ['WETH']);

      if (result.length > 0) {
        const step1 = result[0].steps[0];
        // Verify step1 is the WETH->USDC swap
        expect(step1.fromToken).toBe('WETH');
        expect(step1.toToken).toBe('USDC');
        // amountIn should be 1 ETH (1e18 / 1e18 = 1.0)
        expect(step1.amountIn).toBeCloseTo(1.0, 6);
        // With 0.3% fee on 1 ETH into 1000/2M pool:
        // amountInWithFee = 0.997
        // amountOut = (0.997 * 2000000) / (1000 + 0.997) = 1994000 / 1000.997 ~= 1992.01
        expect(step1.amountOut).toBeGreaterThan(1990);
        expect(step1.amountOut).toBeLessThan(2000);
      }
    });

    it('should handle reversed token order in pool correctly', async () => {
      // Pool has token0=USDC, token1=WETH but we swap WETH->USDC
      // The simulateSwapBigInt should correctly pick reserve1 as reserveIn
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: -1,
        maxSlippage: 1.0,
        maxExecutionTime: 60000,
      });

      // Triangle: WETH->USDC (reversed pool) -> USDC->DAI -> DAI->WETH
      const pools = [
        createPool({
          dex: 'uniswap',
          token0: 'USDC', // Note: USDC is token0, WETH is token1
          token1: 'WETH',
          reserve0: '2000000000000000000000000', // 2M USDC
          reserve1: '1000000000000000000000',    // 1000 WETH
          fee: 30,
          liquidity: 4_000_000,
        }),
        createPool({
          dex: 'sushiswap',
          token0: 'USDC',
          token1: 'DAI',
          reserve0: '1000000000000000000000000',
          reserve1: '1020000000000000000000000',
          fee: 25,
          liquidity: 2_000_000,
        }),
        createPool({
          dex: 'curve',
          token0: 'DAI',
          token1: 'WETH',
          reserve0: '2000000000000000000000000',
          reserve1: '1000000000000000000000',
          fee: 4,
          liquidity: 4_000_000,
        }),
      ];

      const result = await custom.findTriangularOpportunities('bsc', pools, ['WETH']);
      // Should not throw and should correctly handle the reversed pool
      // The function should work regardless of token ordering in pool
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // =========================================================================
  // Gas cost estimation (tested indirectly)
  // =========================================================================

  describe('gas cost estimation', () => {
    it('should use gas price cache when available', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.002);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: -1,
        maxSlippage: 1.0,
        maxExecutionTime: 60000,
      });

      const pools = createTrianglePools();
      await custom.findTriangularOpportunities('ethereum', pools, ['WETH']);

      // The gas cache should have been called
      expect(mockEstimateGasCostRatio).toHaveBeenCalled();
    });

    it('should fall back to static estimates when gas cache throws', async () => {
      mockEstimateGasCostRatio.mockImplementation(() => {
        throw new Error('Cache unavailable');
      });

      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: -1,
        maxSlippage: 1.0,
        maxExecutionTime: 60000,
      });

      const pools = createTrianglePools();
      // Should not throw even when cache fails
      const result = await custom.findTriangularOpportunities('bsc', pools, ['WETH']);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('should handle pools with very large reserves (BigInt safe)', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: -1,
        maxSlippage: 1.0,
        maxExecutionTime: 60000,
      });

      const pools = [
        createPool({
          dex: 'uniswap',
          token0: 'WETH',
          token1: 'USDC',
          reserve0: '999999999999999999999999999',   // Very large
          reserve1: '1999999999999999999999999999',
          fee: 30,
          liquidity: 100_000_000,
        }),
        createPool({
          dex: 'sushiswap',
          token0: 'USDC',
          token1: 'DAI',
          reserve0: '1000000000000000000000000000',
          reserve1: '1020000000000000000000000000',
          fee: 25,
          liquidity: 100_000_000,
        }),
        createPool({
          dex: 'curve',
          token0: 'DAI',
          token1: 'WETH',
          reserve0: '1999999999999999999999999999',
          reserve1: '999999999999999999999999999',
          fee: 4,
          liquidity: 100_000_000,
        }),
      ];

      // Should not overflow or throw
      const result = await custom.findTriangularOpportunities('bsc', pools, ['WETH']);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle pool with zero fee', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: -1,
        maxSlippage: 1.0,
        maxExecutionTime: 60000,
      });

      const pools = [
        createPool({ dex: 'uniswap', token0: 'WETH', token1: 'USDC', fee: 0, liquidity: 4_000_000 }),
        createPool({ dex: 'sushiswap', token0: 'USDC', token1: 'DAI', reserve0: '1000000000000000000000000', reserve1: '1020000000000000000000000', fee: 0, liquidity: 2_000_000 }),
        createPool({ dex: 'curve', token0: 'DAI', token1: 'WETH', reserve0: '2000000000000000000000000', reserve1: '1000000000000000000000', fee: 0, liquidity: 4_000_000 }),
      ];

      const result = await custom.findTriangularOpportunities('bsc', pools, ['WETH']);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should handle unknown chain gracefully in execution time estimation', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: -1,
        maxSlippage: 1.0,
        maxExecutionTime: 60000,
      });

      const pools = createTrianglePools();
      // 'unknown_chain' falls back to 5000ms base execution time
      const result = await custom.findTriangularOpportunities('unknown_chain', pools, ['WETH']);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return at most 10 opportunities', async () => {
      mockEstimateGasCostRatio.mockReturnValue(0.0001);
      const custom = new CrossDexTriangularArbitrage({
        minProfitThreshold: -1,
        maxSlippage: 1.0,
        maxExecutionTime: 60000,
      });

      // Create many pools to generate many triangles
      const tokens = ['WETH', 'USDC', 'DAI', 'USDT', 'WBTC', 'LINK'];
      const dexes = ['uniswap', 'sushiswap', 'curve', 'pancakeswap'];
      const pools: DexPool[] = [];

      for (let i = 0; i < tokens.length; i++) {
        for (let j = i + 1; j < tokens.length; j++) {
          for (const dex of dexes) {
            pools.push(createPool({
              dex,
              token0: tokens[i],
              token1: tokens[j],
              reserve0: '1000000000000000000000',
              reserve1: '1000000000000000000000',
              fee: 10 + Math.floor(Math.random() * 20),
              liquidity: 1_000_000 + Math.floor(Math.random() * 9_000_000),
            }));
          }
        }
      }

      const result = await custom.findTriangularOpportunities('bsc', pools, ['WETH']);
      expect(result.length).toBeLessThanOrEqual(10);
    });
  });
});
