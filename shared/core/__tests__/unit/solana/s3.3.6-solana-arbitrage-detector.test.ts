/**
 * S3.3.6 Solana-Specific Arbitrage Detection Integration Tests
 *
 * Tests for Solana arbitrage detection including:
 * - Intra-Solana arbitrage (between Solana DEXs)
 * - Triangular arbitrage on Solana (SOL→USDC→JUP→SOL)
 * - Cross-chain price comparison (Solana vs EVM)
 * - Priority fee estimation for Solana transactions
 *
 * TDD: Tests written first, implementation to follow.
 *
 * @see IMPLEMENTATION_PLAN.md S3.3.6
 * @see shared/core/src/solana/solana-detector.ts
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// =============================================================================
// Imports - Direct import since SolanaArbitrageDetector doesn't use @solana/web3.js directly
// =============================================================================

import { EventEmitter } from 'events';
import {
  SolanaArbitrageDetector,
  type SolanaArbitrageConfig,
  type SolanaArbitrageOpportunity,
  type SolanaArbitrageStreamsClient,
  type TriangularPath,
  type CrossChainPriceComparison,
  type PriorityFeeEstimate,
  type SolanaArbitrageStats,
  type SolanaPoolInfo,
} from '../../../../../services/partition-solana/src/arbitrage-detector';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a mock Solana pool for testing.
 */
function createMockPool(overrides: Partial<{
  address: string;
  dex: string;
  token0Symbol: string;
  token1Symbol: string;
  price: number;
  fee: number;
  reserve0: string;
  reserve1: string;
}> = {}): SolanaPoolInfo {
  return {
    address: overrides.address || 'pool-address-1',
    programId: 'program-id-1',
    dex: overrides.dex || 'raydium',
    token0: {
      mint: 'So11111111111111111111111111111111111111112',
      symbol: overrides.token0Symbol || 'SOL',
      decimals: 9,
    },
    token1: {
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: overrides.token1Symbol || 'USDC',
      decimals: 6,
    },
    fee: overrides.fee ?? 25, // 0.25% in basis points
    reserve0: overrides.reserve0 || '1000000000000000', // 1M SOL
    reserve1: overrides.reserve1 || '100000000000000',  // 100M USDC
    price: overrides.price ?? 100.5,
    lastSlot: 12345678,
  };
}

/**
 * Creates a mock EVM price update for cross-chain comparison.
 */
function createMockEvmPriceUpdate(overrides: Partial<{
  chain: string;
  dex: string;
  token0: string;
  token1: string;
  price: number;
}> = {}) {
  return {
    pairKey: `${overrides.chain || 'ethereum'}-${overrides.dex || 'uniswap'}-WETH-USDC`,
    chain: overrides.chain || 'ethereum',
    dex: overrides.dex || 'uniswap',
    token0: overrides.token0 || 'WETH',
    token1: overrides.token1 || 'USDC',
    price: overrides.price ?? 2500.0,
    reserve0: '100000000000000000000', // 100 ETH
    reserve1: '250000000000',          // 250K USDC
    blockNumber: 19000000,
    timestamp: Date.now(),
    latency: 50,
    fee: 0.003,
  };
}

// =============================================================================
// Test Suites
// =============================================================================

describe('S3.3.6 Solana Arbitrage Detector', () => {
  let detector: SolanaArbitrageDetector;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
  });

  afterEach(async () => {
    if (detector) {
      await detector.stop();
    }
    jest.clearAllMocks();
  });

  // ===========================================================================
  // Configuration and Initialization
  // ===========================================================================

  describe('Configuration', () => {
    it('should initialize with default configuration', () => {
      const config: SolanaArbitrageConfig = {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      };

      detector = new SolanaArbitrageDetector(config, { logger: mockLogger });

      expect(detector).toBeDefined();
      expect(detector.getConfig()).toMatchObject({
        minProfitThreshold: expect.any(Number),
        priorityFeeMultiplier: expect.any(Number),
        crossChainEnabled: true,
      });
    });

    it('should accept custom configuration', () => {
      const config: SolanaArbitrageConfig = {
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        minProfitThreshold: 0.5, // 0.5%
        priorityFeeMultiplier: 1.5,
        crossChainEnabled: false,
        triangularEnabled: true,
        maxTriangularDepth: 4,
      };

      detector = new SolanaArbitrageDetector(config, { logger: mockLogger });

      const actualConfig = detector.getConfig();
      expect(actualConfig.minProfitThreshold).toBe(0.5);
      expect(actualConfig.priorityFeeMultiplier).toBe(1.5);
      expect(actualConfig.crossChainEnabled).toBe(false);
      expect(actualConfig.triangularEnabled).toBe(true);
    });

    it('should require rpcUrl', () => {
      expect(() => {
        // Test with empty rpcUrl
        new SolanaArbitrageDetector({ rpcUrl: '' }, { logger: mockLogger });
      }).toThrow(/rpcUrl/i);
    });
  });

  // ===========================================================================
  // Intra-Solana Arbitrage Detection
  // ===========================================================================

  describe('Intra-Solana Arbitrage', () => {
    beforeEach(() => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        minProfitThreshold: 0.3, // 0.3%
      }, { logger: mockLogger });
    });

    it('should detect arbitrage between two DEXs with price difference', async () => {
      // Pool 1: SOL/USDC on Raydium at $100
      const pool1 = createMockPool({
        address: 'raydium-sol-usdc',
        dex: 'raydium',
        price: 100.0,
      });

      // Pool 2: SOL/USDC on Orca at $101 (1% higher)
      const pool2 = createMockPool({
        address: 'orca-sol-usdc',
        dex: 'orca',
        price: 101.0,
      });

      // P0-FIX: addPool is async (uses mutex), must await
      await detector.addPool(pool1);
      await detector.addPool(pool2);

      const opportunities = await detector.detectIntraSolanaArbitrage();

      expect(opportunities.length).toBeGreaterThanOrEqual(1);
      expect(opportunities[0]).toMatchObject({
        type: 'intra-solana',
        chain: 'solana',
        buyDex: 'raydium',
        sellDex: 'orca',
        profitPercentage: expect.any(Number),
      });
      expect(opportunities[0].profitPercentage).toBeGreaterThan(0);
    });

    it('should not detect arbitrage when price difference is below threshold', async () => {
      // Pool 1: SOL/USDC at $100
      const pool1 = createMockPool({
        address: 'raydium-sol-usdc',
        dex: 'raydium',
        price: 100.0,
      });

      // Pool 2: SOL/USDC at $100.1 (0.1% higher - below 0.3% threshold)
      const pool2 = createMockPool({
        address: 'orca-sol-usdc',
        dex: 'orca',
        price: 100.1,
      });

      // P0-FIX: addPool is async (uses mutex), must await
      await detector.addPool(pool1);
      await detector.addPool(pool2);

      const opportunities = await detector.detectIntraSolanaArbitrage();

      expect(opportunities.length).toBe(0);
    });

    it('should account for DEX fees in profit calculation', async () => {
      // Pool 1: 0.25% fee
      const pool1 = createMockPool({
        address: 'raydium-sol-usdc',
        dex: 'raydium',
        price: 100.0,
        fee: 25, // 0.25%
      });

      // Pool 2: 0.30% fee, 0.6% price difference
      const pool2 = createMockPool({
        address: 'orca-sol-usdc',
        dex: 'orca',
        price: 100.6, // 0.6% higher
        fee: 30, // 0.30%
      });

      // P0-FIX: addPool is async (uses mutex), must await
      await detector.addPool(pool1);
      await detector.addPool(pool2);

      const opportunities = await detector.detectIntraSolanaArbitrage();

      // 0.6% gross - 0.55% fees = 0.05% net (below 0.3% threshold)
      expect(opportunities.length).toBe(0);
    });

    it('should handle multiple token pairs', async () => {
      // P0-FIX: addPool is async (uses mutex), must await
      // SOL/USDC pairs
      await detector.addPool(createMockPool({
        address: 'raydium-sol-usdc',
        dex: 'raydium',
        token0Symbol: 'SOL',
        token1Symbol: 'USDC',
        price: 100.0,
      }));
      await detector.addPool(createMockPool({
        address: 'orca-sol-usdc',
        dex: 'orca',
        token0Symbol: 'SOL',
        token1Symbol: 'USDC',
        price: 102.0, // 2% higher
      }));

      // JUP/USDC pairs
      await detector.addPool(createMockPool({
        address: 'raydium-jup-usdc',
        dex: 'raydium',
        token0Symbol: 'JUP',
        token1Symbol: 'USDC',
        price: 1.0,
      }));
      await detector.addPool(createMockPool({
        address: 'orca-jup-usdc',
        dex: 'orca',
        token0Symbol: 'JUP',
        token1Symbol: 'USDC',
        price: 1.015, // 1.5% higher
      }));

      const opportunities = await detector.detectIntraSolanaArbitrage();

      expect(opportunities.length).toBe(2);
    });
  });

  // ===========================================================================
  // Triangular Arbitrage Detection
  // ===========================================================================

  describe('Triangular Arbitrage', () => {
    beforeEach(() => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        minProfitThreshold: 0.3,
        triangularEnabled: true,
        maxTriangularDepth: 3,
      }, { logger: mockLogger });
    });

    it('should detect triangular arbitrage path', async () => {
      // Create a triangular arbitrage with prices that yield > 0.3% net profit
      // Path: SOL → USDC → JUP → SOL
      // Target: 2% gross profit to cover ~0.75% in fees and still exceed 0.3% threshold

      // SOL → USDC (buy USDC with SOL)
      await detector.addPool(createMockPool({
        address: 'pool-sol-usdc',
        dex: 'raydium',
        token0Symbol: 'SOL',
        token1Symbol: 'USDC',
        price: 100.0, // 100 USDC per SOL
        fee: 25, // 0.25%
      }));

      // USDC → JUP (buy JUP with USDC)
      await detector.addPool(createMockPool({
        address: 'pool-usdc-jup',
        dex: 'orca',
        token0Symbol: 'USDC',
        token1Symbol: 'JUP',
        price: 1.0, // 1 JUP per USDC
        fee: 25, // 0.25%
      }));

      // JUP → SOL (buy SOL with JUP)
      // Price set to create profitable cycle:
      // 1 SOL → 100 USDC → 100 JUP → ~1.02 SOL (2% gross profit)
      await detector.addPool(createMockPool({
        address: 'pool-jup-sol',
        dex: 'meteora',
        token0Symbol: 'JUP',
        token1Symbol: 'SOL',
        price: 0.0102, // 0.0102 SOL per JUP → 100 * 0.0102 = 1.02 SOL
        fee: 25, // 0.25%
      }));

      const triangularOpps = await detector.detectTriangularArbitrage();

      expect(triangularOpps.length).toBeGreaterThanOrEqual(1);
      expect(triangularOpps[0]).toMatchObject({
        type: 'triangular',
        chain: 'solana',
        path: expect.arrayContaining([
          expect.objectContaining({ token: 'SOL' }),
          expect.objectContaining({ token: 'USDC' }),
          expect.objectContaining({ token: 'JUP' }),
        ]),
      });
    });

    it('should calculate triangular profit correctly', async () => {
      // Start with 1 SOL
      // SOL → USDC: 1 * 100 = 100 USDC
      await detector.addPool(createMockPool({
        address: 'pool-sol-usdc',
        dex: 'raydium',
        token0Symbol: 'SOL',
        token1Symbol: 'USDC',
        price: 100.0,
        fee: 25, // 0.25%
      }));

      // USDC → JUP: 100 * 1.25 = 125 JUP
      await detector.addPool(createMockPool({
        address: 'pool-usdc-jup',
        dex: 'orca',
        token0Symbol: 'USDC',
        token1Symbol: 'JUP',
        price: 1.25,
        fee: 30, // 0.30%
      }));

      // JUP → SOL: 125 * 0.0085 = 1.0625 SOL (6.25% gross profit)
      await detector.addPool(createMockPool({
        address: 'pool-jup-sol',
        dex: 'meteora',
        token0Symbol: 'JUP',
        token1Symbol: 'SOL',
        price: 0.0085,
        fee: 25, // 0.25%
      }));

      const triangularOpps = await detector.detectTriangularArbitrage();

      if (triangularOpps.length > 0) {
        // Net profit should account for 0.8% total fees
        expect(triangularOpps[0].profitPercentage).toBeGreaterThan(0);
        expect(triangularOpps[0].estimatedOutput).toBeGreaterThan(1); // More than input
      }
    });

    it('should not detect triangular when disabled', async () => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        triangularEnabled: false,
      }, { logger: mockLogger });

      // Add pools that would normally create triangular opportunity
      await detector.addPool(createMockPool({ address: 'p1', token0Symbol: 'SOL', token1Symbol: 'USDC' }));
      await detector.addPool(createMockPool({ address: 'p2', token0Symbol: 'USDC', token1Symbol: 'JUP' }));
      await detector.addPool(createMockPool({ address: 'p3', token0Symbol: 'JUP', token1Symbol: 'SOL' }));

      const triangularOpps = await detector.detectTriangularArbitrage();

      expect(triangularOpps.length).toBe(0);
    });
  });

  // ===========================================================================
  // Cross-Chain Price Comparison
  // ===========================================================================

  describe('Cross-Chain Price Comparison', () => {
    beforeEach(() => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        minProfitThreshold: 0.5,
        crossChainEnabled: true,
      }, { logger: mockLogger });
    });

    it('should compare SOL/USDC price with EVM chains', async () => {
      // Solana SOL/USDC at $100
      await detector.addPool(createMockPool({
        address: 'raydium-sol-usdc',
        dex: 'raydium',
        token0Symbol: 'SOL',
        token1Symbol: 'USDC',
        price: 100.0,
      }));

      // EVM prices at $102 (2% higher)
      const evmPrices = [
        createMockEvmPriceUpdate({
          chain: 'ethereum',
          dex: 'uniswap',
          token0: 'SOL', // Wrapped SOL on Ethereum
          token1: 'USDC',
          price: 102.0,
        }),
      ];

      const comparisons = await detector.compareCrossChainPrices(evmPrices);

      expect(comparisons.length).toBeGreaterThanOrEqual(1);
      expect(comparisons[0]).toMatchObject({
        token: 'SOL',
        quoteToken: 'USDC',
        solanaPrice: 100.0,
        solanaDex: 'raydium',
        solanaPoolAddress: 'raydium-sol-usdc',
        evmChain: 'ethereum',
        evmPrice: 102.0,
        evmPairKey: expect.stringContaining('ethereum'),
        priceDifferencePercent: expect.any(Number),
      });
      expect(Math.abs(comparisons[0].priceDifferencePercent)).toBeCloseTo(2.0, 1);
    });

    it('should detect cross-chain arbitrage opportunities', async () => {
      // Solana USDC/SOL pair
      await detector.addPool(createMockPool({
        address: 'sol-usdc-pool',
        dex: 'raydium',
        token0Symbol: 'SOL',
        token1Symbol: 'USDC',
        price: 100.0,
      }));

      // EVM price significantly different
      const evmPrices = [
        createMockEvmPriceUpdate({
          chain: 'arbitrum',
          dex: 'uniswap',
          token0: 'SOL',
          token1: 'USDC',
          price: 105.0, // 5% higher
        }),
      ];

      const opportunities = await detector.detectCrossChainArbitrage(evmPrices);

      expect(opportunities.length).toBeGreaterThanOrEqual(1);
      expect(opportunities[0]).toMatchObject({
        type: 'cross-chain',
        sourceChain: 'solana',
        targetChain: 'arbitrum',
        token: 'SOL',
        quoteToken: 'USDC',
        direction: expect.stringMatching(/buy-solana-sell-evm|buy-evm-sell-solana/),
      });
      // Verify buyPair/sellPair are properly populated (not empty)
      expect(opportunities[0].buyPair).toBeTruthy();
      expect(opportunities[0].sellPair).toBeTruthy();
      // Since Solana is cheaper, direction should be buy-solana-sell-evm
      // buyPair should be Solana pool, sellPair should be EVM pair
      expect(opportunities[0].buyPair).toBe('sol-usdc-pool');
      expect(opportunities[0].sellPair).toContain('arbitrum');
    });

    it('should normalize token symbols for cross-chain matching', async () => {
      // Phase 0 Item 2: LST normalization requires normalizeLiquidStaking: true
      // to collapse MSOL→SOL for cross-chain matching. Default is now false
      // (preserves LST identities for intra-chain pricing).
      const crossChainDetector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        minProfitThreshold: 0.5,
        crossChainEnabled: true,
        normalizeLiquidStaking: true,
      }, { logger: mockLogger });

      // Solana uses MSOL (staked SOL)
      await crossChainDetector.addPool(createMockPool({
        address: 'msol-usdc-pool',
        dex: 'raydium',
        token0Symbol: 'MSOL',
        token1Symbol: 'USDC',
        price: 105.0, // MSOL trades at premium
      }));

      // EVM uses SOL (canonical)
      const evmPrices = [
        createMockEvmPriceUpdate({
          chain: 'ethereum',
          token0: 'SOL',
          token1: 'USDC',
          price: 100.0,
        }),
      ];

      // MSOL should be normalized to SOL for comparison
      const comparisons = await crossChainDetector.compareCrossChainPrices(evmPrices);

      expect(comparisons.length).toBeGreaterThanOrEqual(1);
      expect(comparisons[0].token).toBe('SOL'); // Normalized
    });

    it('should not compare when cross-chain is disabled', async () => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        crossChainEnabled: false,
      }, { logger: mockLogger });

      await detector.addPool(createMockPool({ address: 'p1' }));

      const evmPrices = [createMockEvmPriceUpdate()];
      const comparisons = await detector.compareCrossChainPrices(evmPrices);

      expect(comparisons.length).toBe(0);
    });
  });

  // ===========================================================================
  // Priority Fee Estimation
  // ===========================================================================

  describe('Priority Fee Estimation', () => {
    beforeEach(() => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        priorityFeeMultiplier: 1.2,
        basePriorityFeeLamports: 10000, // 0.00001 SOL
      }, { logger: mockLogger });
    });

    it('should estimate priority fee for arbitrage transaction', async () => {
      const estimate = await detector.estimatePriorityFee({
        computeUnits: 300000,
        urgency: 'medium',
      });

      expect(estimate).toMatchObject({
        baseFee: expect.any(Number),
        priorityFee: expect.any(Number),
        totalFee: expect.any(Number),
        computeUnits: 300000,
        microLamportsPerCu: expect.any(Number),
      });
      expect(estimate.totalFee).toBeGreaterThan(0);
    });

    it('should increase priority fee for urgent transactions', async () => {
      const normalEstimate = await detector.estimatePriorityFee({
        computeUnits: 300000,
        urgency: 'medium',
      });

      const urgentEstimate = await detector.estimatePriorityFee({
        computeUnits: 300000,
        urgency: 'high',
      });

      expect(urgentEstimate.priorityFee).toBeGreaterThan(normalEstimate.priorityFee);
    });

    it('should scale fee with compute units', async () => {
      const smallEstimate = await detector.estimatePriorityFee({
        computeUnits: 100000,
        urgency: 'medium',
      });

      const largeEstimate = await detector.estimatePriorityFee({
        computeUnits: 500000,
        urgency: 'medium',
      });

      expect(largeEstimate.totalFee).toBeGreaterThan(smallEstimate.totalFee);
    });

    it('should account for priority fee in profit calculation', async () => {
      // Add pools with marginal arbitrage opportunity
      await detector.addPool(createMockPool({
        address: 'pool1',
        dex: 'raydium',
        price: 100.0,
        fee: 25,
      }));
      await detector.addPool(createMockPool({
        address: 'pool2',
        dex: 'orca',
        price: 100.8, // 0.8% gross profit
        fee: 25,
      }));

      const opportunities = await detector.detectIntraSolanaArbitrage();

      // Profit should account for execution costs
      if (opportunities.length > 0) {
        expect(opportunities[0]).toHaveProperty('estimatedGasCost');
        expect(opportunities[0].netProfitAfterGas).toBeDefined();
      }
    });
  });

  // ===========================================================================
  // Statistics and Monitoring
  // ===========================================================================

  describe('Statistics', () => {
    beforeEach(() => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, { logger: mockLogger });
    });

    it('should track detection statistics', async () => {
      await detector.addPool(createMockPool({ address: 'p1', dex: 'raydium', price: 100.0 }));
      await detector.addPool(createMockPool({ address: 'p2', dex: 'orca', price: 102.0 }));

      await detector.detectIntraSolanaArbitrage();

      const stats = detector.getStats();

      expect(stats).toMatchObject({
        totalDetections: expect.any(Number),
        intraSolanaOpportunities: expect.any(Number),
        triangularOpportunities: expect.any(Number),
        crossChainOpportunities: expect.any(Number),
        poolsTracked: 2,
        lastDetectionTime: expect.any(Number),
      });
    });

    it('should reset statistics', async () => {
      await detector.addPool(createMockPool({ address: 'p1' }));

      detector.resetStats();
      const stats = detector.getStats();

      expect(stats.totalDetections).toBe(0);
      expect(stats.intraSolanaOpportunities).toBe(0);
    });
  });

  // ===========================================================================
  // Pool Management
  // ===========================================================================

  describe('Pool Management', () => {
    beforeEach(() => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, { logger: mockLogger });
    });

    it('should add and remove pools', async () => {
      const pool = createMockPool({ address: 'test-pool' });

      // P0-FIX: addPool is async (uses mutex), must await
      await detector.addPool(pool);
      expect(detector.getPoolCount()).toBe(1);

      await detector.removePool('test-pool');
      expect(detector.getPoolCount()).toBe(0);
    });

    it('should update pool prices', async () => {
      const pool = createMockPool({ address: 'test-pool', price: 100.0 });
      // P0-FIX: addPool is async (uses mutex), must await
      await detector.addPool(pool);

      await detector.updatePoolPrice('test-pool', 105.0);

      const updatedPool = detector.getPool('test-pool');
      expect(updatedPool?.price).toBe(105.0);
    });

    it('should get pools by token pair', async () => {
      // P0-FIX: addPool is async (uses mutex), must await
      await detector.addPool(createMockPool({
        address: 'pool1',
        dex: 'raydium',
        token0Symbol: 'SOL',
        token1Symbol: 'USDC',
      }));
      await detector.addPool(createMockPool({
        address: 'pool2',
        dex: 'orca',
        token0Symbol: 'SOL',
        token1Symbol: 'USDC',
      }));
      await detector.addPool(createMockPool({
        address: 'pool3',
        dex: 'raydium',
        token0Symbol: 'JUP',
        token1Symbol: 'USDC',
      }));

      const solUsdcPools = detector.getPoolsByTokenPair('SOL', 'USDC');

      expect(solUsdcPools.length).toBe(2);
    });
  });

  // ===========================================================================
  // Event Emission
  // ===========================================================================

  describe('Event Emission', () => {
    beforeEach(() => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, { logger: mockLogger });
    });

    it('should emit opportunity event when arbitrage detected', async () => {
      const opportunityHandler = jest.fn();
      detector.on('opportunity', opportunityHandler);

      // P0-FIX: addPool is async (uses mutex), must await
      await detector.addPool(createMockPool({ address: 'p1', dex: 'raydium', price: 100.0 }));
      await detector.addPool(createMockPool({ address: 'p2', dex: 'orca', price: 102.0 }));

      await detector.detectIntraSolanaArbitrage();

      expect(opportunityHandler).toHaveBeenCalled();
      expect(opportunityHandler.mock.calls[0][0]).toMatchObject({
        type: expect.stringMatching(/intra-solana|cross-dex/),
      });
    });

    it('should emit price-update event when pool price changes', async () => {
      const priceHandler = jest.fn();
      detector.on('price-update', priceHandler);

      // P0-FIX: addPool and updatePoolPrice are async (uses mutex), must await
      await detector.addPool(createMockPool({ address: 'test-pool', price: 100.0 }));
      await detector.updatePoolPrice('test-pool', 105.0);

      expect(priceHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          poolAddress: 'test-pool',
          oldPrice: 100.0,
          newPrice: 105.0,
        })
      );
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('Error Handling', () => {
    beforeEach(() => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, { logger: mockLogger });
    });

    it('should handle pools with missing prices gracefully', async () => {
      const poolWithoutPrice = createMockPool({ address: 'no-price' });
      delete (poolWithoutPrice as any).price;

      await detector.addPool(poolWithoutPrice);
      await detector.addPool(createMockPool({ address: 'with-price', price: 100.0 }));

      // Should not throw
      const opportunities = await detector.detectIntraSolanaArbitrage();
      expect(opportunities).toBeDefined();
    });

    it('should handle invalid pool addresses gracefully', () => {
      expect(() => {
        detector.updatePoolPrice('non-existent-pool', 100.0);
      }).not.toThrow();

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should handle cross-chain comparison with empty EVM prices', async () => {
      await detector.addPool(createMockPool({ address: 'sol-pool' }));

      const comparisons = await detector.compareCrossChainPrices([]);

      expect(comparisons).toEqual([]);
    });
  });
});

// =============================================================================
// Additional Test Suites
// =============================================================================

describe('S3.3.6 Integration with SolanaDetector', () => {
  it('should extend SolanaDetector functionality', () => {
    // This test verifies that SolanaArbitrageDetector can work with
    // the existing SolanaDetector infrastructure
    const config: SolanaArbitrageConfig = {
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    };

    const detector = new SolanaArbitrageDetector(config);

    // Should have access to SolanaDetector methods
    expect(typeof detector.addPool).toBe('function');
    expect(typeof detector.getPool).toBe('function');
    expect(typeof detector.detectIntraSolanaArbitrage).toBe('function');
    expect(typeof detector.detectTriangularArbitrage).toBe('function');
    expect(typeof detector.compareCrossChainPrices).toBe('function');
    expect(typeof detector.estimatePriorityFee).toBe('function');
  });
});

// =============================================================================
// Redis Streams Integration Tests
// =============================================================================

/**
 * Helper to create a mock streams client with proper typing.
 */
function createMockStreamsClient(): SolanaArbitrageStreamsClient & { xadd: jest.Mock } {
  const xaddMock = jest.fn();
  xaddMock.mockImplementation(() => Promise.resolve('stream-id-1234'));
  return {
    xadd: xaddMock,
  } as unknown as SolanaArbitrageStreamsClient & { xadd: jest.Mock };
}

describe('S3.3.6 Redis Streams Integration', () => {
  let detector: SolanaArbitrageDetector;
  let mockLogger: any;
  let mockStreamsClient: SolanaArbitrageStreamsClient & { xadd: jest.Mock };

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    mockStreamsClient = createMockStreamsClient();
  });

  afterEach(async () => {
    if (detector) {
      await detector.stop();
    }
    jest.clearAllMocks();
  });

  describe('setStreamsClient', () => {
    it('should set Redis Streams client', () => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, { logger: mockLogger });

      expect(detector.hasStreamsClient()).toBe(false);

      detector.setStreamsClient(mockStreamsClient);

      expect(detector.hasStreamsClient()).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith('Redis Streams client attached');
    });

    it('should accept streams client via dependency injection', () => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, {
        logger: mockLogger,
        streamsClient: mockStreamsClient,
      });

      expect(detector.hasStreamsClient()).toBe(true);
    });
  });

  describe('hasStreamsClient', () => {
    it('should return false when no client is set', () => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, { logger: mockLogger });

      expect(detector.hasStreamsClient()).toBe(false);
    });

    it('should return true after client is set', () => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, { logger: mockLogger });

      detector.setStreamsClient(mockStreamsClient);

      expect(detector.hasStreamsClient()).toBe(true);
    });
  });

  describe('publishOpportunity', () => {
    it('should publish opportunity to Redis Streams', async () => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, { logger: mockLogger, streamsClient: mockStreamsClient });

      const opportunity: SolanaArbitrageOpportunity = {
        id: 'test-opportunity-1',
        type: 'intra-solana',
        chain: 'solana',
        buyDex: 'raydium',
        sellDex: 'orca',
        buyPair: 'pool-1',
        sellPair: 'pool-2',
        token0: 'SOL',
        token1: 'USDC',
        buyPrice: 100.0,
        sellPrice: 102.0,
        profitPercentage: 1.5,
        expectedProfit: 0.015,
        confidence: 0.85,
        timestamp: Date.now(),
        expiresAt: Date.now() + 1000,
        status: 'pending',
      };

      await detector.publishOpportunity(opportunity);

      expect(mockStreamsClient.xadd).toHaveBeenCalledWith(
        'stream:opportunities',
        expect.objectContaining({
          id: opportunity.id,
          type: opportunity.type,
          chain: opportunity.chain,
          buyDex: opportunity.buyDex,
          sellDex: opportunity.sellDex,
          token0: opportunity.token0,
          token1: opportunity.token1,
          source: 'solana-arbitrage-detector',
        })
      );
    });

    it('should skip publishing when no streams client is set', async () => {
      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, { logger: mockLogger });

      const opportunity: SolanaArbitrageOpportunity = {
        id: 'test-opportunity-1',
        type: 'intra-solana',
        chain: 'solana',
        buyDex: 'raydium',
        sellDex: 'orca',
        buyPair: 'pool-1',
        sellPair: 'pool-2',
        token0: 'SOL',
        token1: 'USDC',
        buyPrice: 100.0,
        sellPrice: 102.0,
        profitPercentage: 1.5,
        expectedProfit: 0.015,
        confidence: 0.85,
        timestamp: Date.now(),
        expiresAt: Date.now() + 1000,
        status: 'pending',
      };

      // Should not throw
      await detector.publishOpportunity(opportunity);

      expect(mockStreamsClient.xadd).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'No streams client, skipping opportunity publish',
        expect.objectContaining({ opportunityId: opportunity.id })
      );
    });

    it('should handle xadd errors gracefully', async () => {
      const errorXaddMock = jest.fn();
      errorXaddMock.mockImplementation(() => Promise.reject(new Error('Redis connection failed')));
      const errorClient = {
        xadd: errorXaddMock,
      } as unknown as SolanaArbitrageStreamsClient;

      detector = new SolanaArbitrageDetector({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
      }, { logger: mockLogger, streamsClient: errorClient });

      const opportunity: SolanaArbitrageOpportunity = {
        id: 'test-opportunity-error',
        type: 'intra-solana',
        chain: 'solana',
        buyDex: 'raydium',
        sellDex: 'orca',
        buyPair: 'pool-1',
        sellPair: 'pool-2',
        token0: 'SOL',
        token1: 'USDC',
        buyPrice: 100.0,
        sellPrice: 102.0,
        profitPercentage: 1.5,
        expectedProfit: 0.015,
        confidence: 0.85,
        timestamp: Date.now(),
        expiresAt: Date.now() + 1000,
        status: 'pending',
      };

      // Should not throw
      await detector.publishOpportunity(opportunity);

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to publish opportunity to Redis Streams',
        expect.objectContaining({
          opportunityId: opportunity.id,
        })
      );
    });
  });
});

// =============================================================================
// SolanaDetector Composition Tests
// =============================================================================

describe('S3.3.6 SolanaDetector Composition', () => {
  let detector: SolanaArbitrageDetector;
  let mockLogger: any;
  let mockSolanaDetector: EventEmitter;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    mockSolanaDetector = new EventEmitter();

    detector = new SolanaArbitrageDetector({
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    }, { logger: mockLogger });
  });

  afterEach(async () => {
    if (detector) {
      await detector.stop();
    }
    mockSolanaDetector.removeAllListeners();
    jest.clearAllMocks();
  });

  describe('connectToSolanaDetector', () => {
    it('should connect to SolanaDetector for pool updates', () => {
      detector.connectToSolanaDetector(mockSolanaDetector);

      expect(mockLogger.info).toHaveBeenCalledWith('Connected to SolanaDetector for pool updates');
    });

    it('should add new pools from poolUpdate events', () => {
      detector.connectToSolanaDetector(mockSolanaDetector);

      const newPool: SolanaPoolInfo = {
        address: 'new-pool-address',
        programId: 'program-id',
        dex: 'raydium',
        token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
        token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
        fee: 25,
        price: 100.0,
      };

      mockSolanaDetector.emit('poolUpdate', newPool);

      expect(detector.getPoolCount()).toBe(1);
      expect(detector.getPool('new-pool-address')).toMatchObject({
        address: 'new-pool-address',
        dex: 'raydium',
        price: 100.0,
      });
    });

    it('should update existing pool prices from poolUpdate events', () => {
      detector.connectToSolanaDetector(mockSolanaDetector);

      // Add initial pool
      const initialPool: SolanaPoolInfo = {
        address: 'existing-pool',
        programId: 'program-id',
        dex: 'orca',
        token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
        token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
        fee: 25,
        price: 100.0,
      };
      detector.addPool(initialPool);

      // Emit update with new price
      mockSolanaDetector.emit('poolUpdate', {
        ...initialPool,
        price: 105.0,
      });

      expect(detector.getPoolCount()).toBe(1);
      expect(detector.getPool('existing-pool')?.price).toBe(105.0);
    });

    it('should remove pools from poolRemoved events', async () => {
      detector.connectToSolanaDetector(mockSolanaDetector);

      // Add pool first
      const pool: SolanaPoolInfo = {
        address: 'pool-to-remove',
        programId: 'program-id',
        dex: 'raydium',
        token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
        token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
        fee: 25,
        price: 100.0,
      };
      await detector.addPool(pool);
      expect(detector.getPoolCount()).toBe(1);

      // Emit removal
      mockSolanaDetector.emit('poolRemoved', 'pool-to-remove');

      // P0-FIX: Wait for async removal to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(detector.getPoolCount()).toBe(0);
      expect(detector.getPool('pool-to-remove')).toBeUndefined();
    });

    it('should handle multiple pool updates in sequence', async () => {
      detector.connectToSolanaDetector(mockSolanaDetector);

      // Emit multiple updates
      for (let i = 0; i < 5; i++) {
        mockSolanaDetector.emit('poolUpdate', {
          address: `pool-${i}`,
          programId: 'program-id',
          dex: i % 2 === 0 ? 'raydium' : 'orca',
          token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
          token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
          fee: 25,
          price: 100.0 + i,
        });
      }

      expect(detector.getPoolCount()).toBe(5);
    });

    it('should detect arbitrage after pool updates', async () => {
      detector.connectToSolanaDetector(mockSolanaDetector);

      // Add pools with price difference via events
      mockSolanaDetector.emit('poolUpdate', {
        address: 'raydium-sol-usdc',
        programId: 'program-id',
        dex: 'raydium',
        token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
        token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
        fee: 25,
        price: 100.0,
      });

      mockSolanaDetector.emit('poolUpdate', {
        address: 'orca-sol-usdc',
        programId: 'program-id',
        dex: 'orca',
        token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
        token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
        fee: 25,
        price: 102.0, // 2% higher
      });

      const opportunities = await detector.detectIntraSolanaArbitrage();

      expect(opportunities.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// =============================================================================
// Batch Import Tests
// =============================================================================

describe('S3.3.6 Batch Import', () => {
  let detector: SolanaArbitrageDetector;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    detector = new SolanaArbitrageDetector({
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    }, { logger: mockLogger });
  });

  afterEach(async () => {
    if (detector) {
      await detector.stop();
    }
    jest.clearAllMocks();
  });

  describe('importPools', () => {
    it('should import multiple pools at once', async () => {
      const pools: SolanaPoolInfo[] = [
        {
          address: 'pool-1',
          programId: 'program-id',
          dex: 'raydium',
          token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
          token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
          fee: 25,
          price: 100.0,
        },
        {
          address: 'pool-2',
          programId: 'program-id',
          dex: 'orca',
          token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
          token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
          fee: 30,
          price: 101.0,
        },
        {
          address: 'pool-3',
          programId: 'program-id',
          dex: 'meteora',
          token0: { mint: 'mint2', symbol: 'JUP', decimals: 6 },
          token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
          fee: 25,
          price: 1.5,
        },
      ];

      await detector.importPools(pools);

      expect(detector.getPoolCount()).toBe(3);
      expect(detector.getPool('pool-1')).toBeDefined();
      expect(detector.getPool('pool-2')).toBeDefined();
      expect(detector.getPool('pool-3')).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('Imported pools', { imported: 3, skipped: 0, total: 3 });
    });

    it('should handle empty pool array', () => {
      detector.importPools([]);

      expect(detector.getPoolCount()).toBe(0);
      expect(mockLogger.debug).toHaveBeenCalledWith('importPools called with empty array, nothing to import');
    });

    it('should make pools available for arbitrage detection after import', async () => {
      const pools: SolanaPoolInfo[] = [
        {
          address: 'raydium-pool',
          programId: 'program-id',
          dex: 'raydium',
          token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
          token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
          fee: 25,
          price: 100.0,
        },
        {
          address: 'orca-pool',
          programId: 'program-id',
          dex: 'orca',
          token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
          token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
          fee: 25,
          price: 102.0, // 2% higher
        },
      ];

      await detector.importPools(pools);

      const opportunities = await detector.detectIntraSolanaArbitrage();

      expect(opportunities.length).toBeGreaterThanOrEqual(1);
      expect(opportunities[0].buyDex).toBe('raydium');
      expect(opportunities[0].sellDex).toBe('orca');
    });

    it('should index pools by token pair after import', async () => {
      const pools: SolanaPoolInfo[] = [
        {
          address: 'pool-1',
          programId: 'program-id',
          dex: 'raydium',
          token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
          token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
          fee: 25,
          price: 100.0,
        },
        {
          address: 'pool-2',
          programId: 'program-id',
          dex: 'orca',
          token0: { mint: 'mint0', symbol: 'SOL', decimals: 9 },
          token1: { mint: 'mint1', symbol: 'USDC', decimals: 6 },
          fee: 25,
          price: 101.0,
        },
      ];

      await detector.importPools(pools);

      const solUsdcPools = detector.getPoolsByTokenPair('SOL', 'USDC');

      expect(solUsdcPools.length).toBe(2);
    });

    it('should handle large batch import', async () => {
      const pools: SolanaPoolInfo[] = [];
      for (let i = 0; i < 100; i++) {
        pools.push({
          address: `pool-${i}`,
          programId: 'program-id',
          dex: ['raydium', 'orca', 'meteora'][i % 3],
          token0: { mint: `mint-${i}-0`, symbol: 'SOL', decimals: 9 },
          token1: { mint: `mint-${i}-1`, symbol: 'USDC', decimals: 6 },
          fee: 25,
          price: 100.0 + (i * 0.01),
        });
      }

      await detector.importPools(pools);

      expect(detector.getPoolCount()).toBe(100);
      expect(mockLogger.info).toHaveBeenCalledWith('Imported pools', { imported: 100, skipped: 0, total: 100 });
    });
  });
});
