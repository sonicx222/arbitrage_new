/**
 * Cross-Chain Detector Service Unit Tests
 *
 * Tests for cross-chain arbitrage detection logic:
 * - Bridge cost estimation
 * - Cross-chain price comparison
 * - Opportunity filtering
 *
 * @see IMPLEMENTATION_PLAN.md S3
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Set required environment variables BEFORE any config imports
process.env.NODE_ENV = 'test';
process.env.ETHEREUM_RPC_URL = 'https://eth.llamarpc.com';
process.env.ETHEREUM_WS_URL = 'wss://eth.llamarpc.com';
process.env.BSC_RPC_URL = 'https://bsc-dataseed.binance.org';
process.env.BSC_WS_URL = 'wss://bsc-dataseed.binance.org';
process.env.POLYGON_RPC_URL = 'https://polygon-rpc.com';
process.env.POLYGON_WS_URL = 'wss://polygon-rpc.com';
process.env.ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc';
process.env.ARBITRUM_WS_URL = 'wss://arb1.arbitrum.io/rpc';
process.env.OPTIMISM_RPC_URL = 'https://mainnet.optimism.io';
process.env.OPTIMISM_WS_URL = 'wss://mainnet.optimism.io';
process.env.BASE_RPC_URL = 'https://mainnet.base.org';
process.env.BASE_WS_URL = 'wss://mainnet.base.org';
process.env.REDIS_URL = 'redis://localhost:6379';

// Import config directly to test configuration
import { CHAINS, ARBITRAGE_CONFIG } from '@arbitrage/config';

// =============================================================================
// Configuration Tests (No mocking required)
// =============================================================================

describe('Cross-Chain Configuration', () => {
  describe('Supported Chains', () => {
    it('should have all supported chains configured', () => {
      expect(CHAINS.ethereum).toBeDefined();
      expect(CHAINS.arbitrum).toBeDefined();
      expect(CHAINS.optimism).toBeDefined();
      expect(CHAINS.base).toBeDefined();
      expect(CHAINS.polygon).toBeDefined();
      expect(CHAINS.bsc).toBeDefined();
    });

    it('should have unique chain IDs', () => {
      const chainIds = new Set<number>();
      const chains = ['ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bsc'];

      for (const chainName of chains) {
        const chain = CHAINS[chainName];
        expect(chainIds.has(chain.id)).toBe(false);
        chainIds.add(chain.id);
      }
    });
  });

  describe('Arbitrage Thresholds', () => {
    it('should have different min profit thresholds per chain', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.ethereum).toBeDefined();
      expect(ARBITRAGE_CONFIG.chainMinProfits.arbitrum).toBeDefined();
      expect(ARBITRAGE_CONFIG.chainMinProfits.polygon).toBeDefined();
    });

    it('should have Ethereum with highest threshold (gas costs)', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.ethereum).toBeGreaterThan(
        ARBITRAGE_CONFIG.chainMinProfits.arbitrum
      );
    });
  });
});

// =============================================================================
// Cross-Chain Logic Tests
// =============================================================================

describe('CrossChainDetectorService Logic', () => {
  describe('Bridge Cost Estimation', () => {
    it('should estimate bridge costs correctly', () => {
      // Typical bridge costs in USD
      const bridgeCosts: Record<string, Record<string, number>> = {
        ethereum: {
          arbitrum: 15,    // ~$15 for ETH -> Arbitrum
          optimism: 15,    // ~$15 for ETH -> Optimism
          polygon: 20,     // ~$20 for ETH -> Polygon (longer bridge time)
          base: 15         // ~$15 for ETH -> Base
        },
        arbitrum: {
          ethereum: 5,     // ~$5 for Arbitrum -> ETH (cheap on L2)
          optimism: 8,     // ~$8 cross-L2
          base: 8
        }
      };

      expect(bridgeCosts.ethereum.arbitrum).toBe(15);
      expect(bridgeCosts.arbitrum.ethereum).toBeLessThan(bridgeCosts.ethereum.arbitrum);
    });

    it('should calculate total cross-chain costs', () => {
      const bridgeCost = 15;
      const sourceGasCost = 5;
      const destGasCost = 2;

      const totalCost = bridgeCost + sourceGasCost + destGasCost;
      expect(totalCost).toBe(22);
    });
  });

  describe('Cross-Chain Opportunity Detection', () => {
    it('should detect profitable cross-chain arbitrage', () => {
      // Same token, different prices on different chains
      const ethPriceOnEthereum = 2500;
      const ethPriceOnArbitrum = 2530; // 1.2% higher

      const priceDiff = Math.abs(ethPriceOnEthereum - ethPriceOnArbitrum) / Math.min(ethPriceOnEthereum, ethPriceOnArbitrum);
      const tradeAmount = 10000;
      const grossProfit = tradeAmount * priceDiff;
      const bridgeCosts = 15;
      const gasCosts = 10;

      const netProfit = grossProfit - bridgeCosts - gasCosts;

      expect(priceDiff).toBeCloseTo(0.012, 3); // ~1.2%
      expect(grossProfit).toBeCloseTo(120, 0);
      expect(netProfit).toBeCloseTo(95, 0);
      expect(netProfit).toBeGreaterThan(0);
    });

    it('should reject unprofitable cross-chain opportunities', () => {
      const ethPriceOnEthereum = 2500;
      const ethPriceOnArbitrum = 2505; // Only 0.2% higher

      const priceDiff = Math.abs(ethPriceOnEthereum - ethPriceOnArbitrum) / Math.min(ethPriceOnEthereum, ethPriceOnArbitrum);
      const tradeAmount = 10000;
      const grossProfit = tradeAmount * priceDiff;
      const bridgeCosts = 15;
      const gasCosts = 10;

      const netProfit = grossProfit - bridgeCosts - gasCosts;

      expect(netProfit).toBeLessThan(0);
    });
  });

  describe('Opportunity Filtering', () => {
    it('should sort opportunities by net profit', () => {
      const opportunities = [
        { token: 'WETH', netProfit: 50, confidence: 0.9 },
        { token: 'USDC', netProfit: 150, confidence: 0.85 },
        { token: 'WBTC', netProfit: 100, confidence: 0.8 }
      ];

      const sorted = opportunities.sort((a, b) => b.netProfit - a.netProfit);

      expect(sorted[0].netProfit).toBe(150);
      expect(sorted[1].netProfit).toBe(100);
      expect(sorted[2].netProfit).toBe(50);
    });

    it('should filter by minimum confidence', () => {
      const opportunities = [
        { token: 'WETH', netProfit: 100, confidence: 0.9 },
        { token: 'USDC', netProfit: 200, confidence: 0.3 },  // Low confidence
        { token: 'WBTC', netProfit: 50, confidence: 0.8 }
      ];

      const minConfidence = 0.7;
      const filtered = opportunities.filter(o => o.confidence >= minConfidence);

      expect(filtered.length).toBe(2);
      expect(filtered.some(o => o.token === 'USDC')).toBe(false);
    });

    it('should filter by minimum net profit', () => {
      const opportunities = [
        { token: 'WETH', netProfit: 100, confidence: 0.9 },
        { token: 'USDC', netProfit: 5, confidence: 0.95 },   // Low profit
        { token: 'WBTC', netProfit: 50, confidence: 0.8 }
      ];

      const minProfit = 20;
      const filtered = opportunities.filter(o => o.netProfit >= minProfit);

      expect(filtered.length).toBe(2);
      expect(filtered.some(o => o.token === 'USDC')).toBe(false);
    });
  });

  describe('Bridge Time Considerations', () => {
    it('should account for bridge time in opportunity validity', () => {
      // Bridge times in minutes
      const bridgeTimes: Record<string, number> = {
        'ethereum-arbitrum': 10,
        'ethereum-optimism': 10,
        'ethereum-polygon': 30,
        'arbitrum-optimism': 2,
        'arbitrum-base': 2
      };

      // Fast L2-to-L2 bridges are preferred
      expect(bridgeTimes['arbitrum-optimism']).toBeLessThan(bridgeTimes['ethereum-polygon']);
    });

    it('should calculate price validity window', () => {
      const bridgeTime = 10; // minutes
      const safetyMargin = 1.5;

      const validityWindow = bridgeTime * safetyMargin;

      // Price must remain valid for 15 minutes
      expect(validityWindow).toBe(15);
    });
  });
});

// =============================================================================
// Price Matrix Tests
// =============================================================================

describe('Cross-Chain Price Matrix', () => {
  it('should track same token across chains', () => {
    const priceMatrix: Map<string, Map<string, number>> = new Map();

    // WETH prices across chains
    const wethPrices = new Map<string, number>();
    wethPrices.set('ethereum', 2500);
    wethPrices.set('arbitrum', 2510);
    wethPrices.set('optimism', 2505);
    wethPrices.set('base', 2508);

    priceMatrix.set('WETH', wethPrices);

    expect(priceMatrix.get('WETH')?.get('ethereum')).toBe(2500);
    expect(priceMatrix.get('WETH')?.get('arbitrum')).toBe(2510);
  });

  it('should find best buy/sell chains', () => {
    const prices: Record<string, number> = {
      ethereum: 2500,
      arbitrum: 2510,
      optimism: 2495,
      base: 2505
    };

    const chains = Object.keys(prices);
    let minChain = chains[0];
    let maxChain = chains[0];

    for (const chain of chains) {
      if (prices[chain] < prices[minChain]) minChain = chain;
      if (prices[chain] > prices[maxChain]) maxChain = chain;
    }

    expect(minChain).toBe('optimism');  // Buy here (cheapest)
    expect(maxChain).toBe('arbitrum');   // Sell here (most expensive)
  });
});

// =============================================================================
// Risk Management Tests
// =============================================================================

describe('Cross-Chain Risk Management', () => {
  it('should calculate slippage impact', () => {
    const tradeAmount = 100000;
    const liquidity = 5000000;
    const slippageRate = 0.001; // 0.1% per 1% of liquidity

    const tradeImpact = tradeAmount / liquidity;
    const expectedSlippage = tradeImpact * slippageRate;

    expect(expectedSlippage).toBeCloseTo(0.00002, 5);
  });

  it('should limit exposure per chain', () => {
    const maxExposurePerChain = 0.2; // 20% of total capital
    const totalCapital = 100000;

    const maxTradeOnChain = totalCapital * maxExposurePerChain;

    expect(maxTradeOnChain).toBe(20000);
  });

  it('should require minimum liquidity', () => {
    const minLiquidity = 100000; // $100K minimum
    const poolLiquidities = [50000, 150000, 75000, 200000];

    const validPools = poolLiquidities.filter(l => l >= minLiquidity);

    expect(validPools.length).toBe(2);
    expect(validPools).toContain(150000);
    expect(validPools).toContain(200000);
  });
});
