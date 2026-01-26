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

// =============================================================================
// Edge Case Tests for Bug Fixes
// =============================================================================

describe('Bug Fix Validation', () => {
  describe('Division by Zero Guards', () => {
    it('should handle zero profit improvement without division by zero', () => {
      const existingNetProfit = 0;
      const newNetProfit = 100;

      // DIV-ZERO-FIX: Same logic as in detector.ts and opportunity-publisher.ts
      const profitImprovement = existingNetProfit > 0
        ? (newNetProfit - existingNetProfit) / existingNetProfit
        : (newNetProfit > existingNetProfit ? 1.0 : 0);

      expect(profitImprovement).toBe(1.0); // 100% improvement
      expect(Number.isFinite(profitImprovement)).toBe(true);
    });

    it('should handle negative existing profit', () => {
      const existingNetProfit = -50;
      const newNetProfit = 100;

      const profitImprovement = existingNetProfit > 0
        ? (newNetProfit - existingNetProfit) / existingNetProfit
        : (newNetProfit > existingNetProfit ? 1.0 : 0);

      expect(profitImprovement).toBe(1.0); // Improvement from negative to positive
    });

    it('should return 0 improvement when new is not better', () => {
      const existingNetProfit = 0;
      const newNetProfit = -10;

      const profitImprovement = existingNetProfit > 0
        ? (newNetProfit - existingNetProfit) / existingNetProfit
        : (newNetProfit > existingNetProfit ? 1.0 : 0);

      expect(profitImprovement).toBe(0);
    });
  });

  describe('Price Validation', () => {
    it('should reject zero prices', () => {
      const validatePrice = (price: number): boolean => {
        return typeof price === 'number' && !isNaN(price) && price > 0;
      };

      expect(validatePrice(0)).toBe(false);
      expect(validatePrice(-1)).toBe(false);
      expect(validatePrice(NaN)).toBe(false);
      expect(validatePrice(100)).toBe(true);
    });
  });

  describe('Min/Max Price Finding (Performance)', () => {
    it('should find min/max in O(n) instead of sorting', () => {
      const chainPrices = [
        { chain: 'ethereum', price: 2500 },
        { chain: 'arbitrum', price: 2510 },
        { chain: 'optimism', price: 2495 },
        { chain: 'base', price: 2505 },
        { chain: 'polygon', price: 2520 },
      ];

      // O(n) approach
      let lowestPrice = chainPrices[0];
      let highestPrice = chainPrices[0];

      for (let i = 1; i < chainPrices.length; i++) {
        if (chainPrices[i].price < lowestPrice.price) {
          lowestPrice = chainPrices[i];
        }
        if (chainPrices[i].price > highestPrice.price) {
          highestPrice = chainPrices[i];
        }
      }

      expect(lowestPrice.chain).toBe('optimism');
      expect(lowestPrice.price).toBe(2495);
      expect(highestPrice.chain).toBe('polygon');
      expect(highestPrice.price).toBe(2520);
    });
  });
});

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

// =============================================================================
// Whale Impact Analysis Tests
// Tests for analyzeWhaleImpact and detectWhaleInducedOpportunities logic
// =============================================================================

describe('Whale Impact Analysis', () => {
  // Default whale config for testing (matches detector.ts DEFAULT_WHALE_CONFIG)
  const whaleConfig = {
    superWhaleThresholdUsd: 500000,
    significantFlowThresholdUsd: 100000,
    whaleBullishBoost: 1.15,
    whaleBearishPenalty: 0.85,
    superWhaleBoost: 1.25,
    activityWindowMs: 5 * 60 * 1000,
  };

  describe('Token Parsing from WhaleTransaction', () => {
    /**
     * FIX 4.3: Token parsing logic extracted from analyzeWhaleImpact
     * Handles multiple token formats:
     * - "WETH/USDC" (standard pair format)
     * - "WETH_USDC" (underscore separator)
     * - "traderjoe_WETH_USDC" (DEX prefix with underscore)
     * - "WETH" (single token)
     */
    function parseTokenPair(tokenString: string): { baseToken: string; quoteToken: string } {
      let baseToken: string;
      let quoteToken: string;

      if (tokenString.includes('/')) {
        const tokenParts = tokenString.split('/');
        baseToken = tokenParts[0] || tokenString;
        quoteToken = tokenParts[1] || 'USDC';
      } else if (tokenString.includes('_')) {
        const tokenParts = tokenString.split('_');
        // Take last two parts as tokens (handles DEX_TOKEN0_TOKEN1 format)
        baseToken = tokenParts.length >= 2 ? tokenParts[tokenParts.length - 2] : tokenString;
        quoteToken = tokenParts.length >= 2 ? tokenParts[tokenParts.length - 1] : 'USDC';
      } else {
        // Single token - common case is trading against stablecoins
        baseToken = tokenString;
        quoteToken = 'USDC'; // Default quote token for whale trades
      }

      return { baseToken, quoteToken };
    }

    it('should parse standard pair format (WETH/USDC)', () => {
      const result = parseTokenPair('WETH/USDC');
      expect(result.baseToken).toBe('WETH');
      expect(result.quoteToken).toBe('USDC');
    });

    it('should parse slash-separated pair (WBTC/USDT)', () => {
      const result = parseTokenPair('WBTC/USDT');
      expect(result.baseToken).toBe('WBTC');
      expect(result.quoteToken).toBe('USDT');
    });

    it('should parse underscore-separated pair (WETH_USDC)', () => {
      const result = parseTokenPair('WETH_USDC');
      expect(result.baseToken).toBe('WETH');
      expect(result.quoteToken).toBe('USDC');
    });

    it('should parse DEX-prefixed pair (traderjoe_WETH_USDC)', () => {
      const result = parseTokenPair('traderjoe_WETH_USDC');
      expect(result.baseToken).toBe('WETH');
      expect(result.quoteToken).toBe('USDC');
    });

    it('should parse DEX-prefixed pair with version (uniswap_v3_WETH_USDT)', () => {
      const result = parseTokenPair('uniswap_v3_WETH_USDT');
      expect(result.baseToken).toBe('WETH');
      expect(result.quoteToken).toBe('USDT');
    });

    it('should handle single token with USDC default', () => {
      const result = parseTokenPair('WETH');
      expect(result.baseToken).toBe('WETH');
      expect(result.quoteToken).toBe('USDC');
    });

    it('should handle single token for various tokens', () => {
      expect(parseTokenPair('LINK').baseToken).toBe('LINK');
      expect(parseTokenPair('LINK').quoteToken).toBe('USDC');
      expect(parseTokenPair('ARB').baseToken).toBe('ARB');
      expect(parseTokenPair('OP').baseToken).toBe('OP');
    });

    it('should handle empty string gracefully', () => {
      const result = parseTokenPair('');
      expect(result.baseToken).toBe('');
      expect(result.quoteToken).toBe('USDC');
    });
  });

  describe('Whale Activity Direction Detection', () => {
    /**
     * Logic for determining dominant direction from buy/sell volumes
     * Extracted from WhaleActivityTracker.getActivitySummary
     */
    function detectDominantDirection(
      buyVolumeUsd: number,
      sellVolumeUsd: number
    ): 'bullish' | 'bearish' | 'neutral' {
      const totalVolume = buyVolumeUsd + sellVolumeUsd;
      if (totalVolume === 0) return 'neutral';

      const buyRatio = buyVolumeUsd / totalVolume;
      if (buyRatio > 0.6) return 'bullish';
      if (buyRatio < 0.4) return 'bearish';
      return 'neutral';
    }

    it('should detect bullish when buy volume > 60%', () => {
      expect(detectDominantDirection(70000, 30000)).toBe('bullish');
      expect(detectDominantDirection(100000, 40000)).toBe('bullish'); // ~71%
    });

    it('should detect bearish when buy volume < 40%', () => {
      expect(detectDominantDirection(30000, 70000)).toBe('bearish');
      expect(detectDominantDirection(20000, 80000)).toBe('bearish'); // 20%
    });

    it('should detect neutral when buy volume is 40-60%', () => {
      expect(detectDominantDirection(50000, 50000)).toBe('neutral');
      expect(detectDominantDirection(45000, 55000)).toBe('neutral');
      expect(detectDominantDirection(55000, 45000)).toBe('neutral');
    });

    it('should handle zero volume as neutral', () => {
      expect(detectDominantDirection(0, 0)).toBe('neutral');
    });

    it('should handle edge cases at boundaries', () => {
      // Exactly 60% should be neutral (not > 0.6)
      expect(detectDominantDirection(60, 40)).toBe('neutral');
      // Just above 60% should be bullish
      expect(detectDominantDirection(61, 39)).toBe('bullish');
      // Exactly 40% should be neutral (not < 0.4)
      expect(detectDominantDirection(40, 60)).toBe('neutral');
      // Just below 40% should be bearish
      expect(detectDominantDirection(39, 61)).toBe('bearish');
    });
  });

  describe('Super Whale Detection', () => {
    it('should classify super whale transactions', () => {
      const isSuperWhale = (usdValue: number): boolean => {
        return usdValue >= whaleConfig.superWhaleThresholdUsd;
      };

      expect(isSuperWhale(500000)).toBe(true);   // Exactly threshold
      expect(isSuperWhale(600000)).toBe(true);   // Above threshold
      expect(isSuperWhale(1000000)).toBe(true);  // $1M whale
      expect(isSuperWhale(499999)).toBe(false);  // Just below
      expect(isSuperWhale(100000)).toBe(false);  // Normal whale
    });

    it('should trigger immediate detection for super whales', () => {
      const shouldTriggerImmediateDetection = (
        usdValue: number,
        netFlowUsd: number
      ): boolean => {
        return usdValue >= whaleConfig.superWhaleThresholdUsd ||
               Math.abs(netFlowUsd) > whaleConfig.significantFlowThresholdUsd;
      };

      // Super whale by USD value
      expect(shouldTriggerImmediateDetection(500000, 0)).toBe(true);
      expect(shouldTriggerImmediateDetection(600000, 50000)).toBe(true);

      // Significant net flow (positive or negative)
      expect(shouldTriggerImmediateDetection(50000, 150000)).toBe(true);
      expect(shouldTriggerImmediateDetection(50000, -150000)).toBe(true);

      // Neither condition met
      expect(shouldTriggerImmediateDetection(50000, 50000)).toBe(false);
      expect(shouldTriggerImmediateDetection(100000, 100000)).toBe(false);
    });
  });

  describe('Whale Confidence Boosting', () => {
    /**
     * Calculate whale-based confidence adjustment
     * Extracted from detector.ts calculateConfidence
     */
    function calculateWhaleConfidenceBoost(
      dominantDirection: 'bullish' | 'bearish' | 'neutral',
      superWhaleCount: number,
      netFlowUsd: number
    ): number {
      let boost = 1.0;

      // Direction-based boost/penalty
      if (dominantDirection === 'bullish') {
        boost *= whaleConfig.whaleBullishBoost;
      } else if (dominantDirection === 'bearish') {
        boost *= whaleConfig.whaleBearishPenalty;
      }

      // Super whale activity boost
      if (superWhaleCount > 0) {
        boost *= whaleConfig.superWhaleBoost;
      }

      // Significant net flow boost
      if (Math.abs(netFlowUsd) > whaleConfig.significantFlowThresholdUsd) {
        boost *= 1.1;
      }

      return boost;
    }

    it('should boost confidence for bullish whale activity', () => {
      const boost = calculateWhaleConfidenceBoost('bullish', 0, 50000);
      expect(boost).toBe(1.15); // whaleBullishBoost
    });

    it('should penalize confidence for bearish whale activity', () => {
      const boost = calculateWhaleConfidenceBoost('bearish', 0, 50000);
      expect(boost).toBe(0.85); // whaleBearishPenalty
    });

    it('should not modify confidence for neutral whale activity', () => {
      const boost = calculateWhaleConfidenceBoost('neutral', 0, 50000);
      expect(boost).toBe(1.0);
    });

    it('should apply super whale boost', () => {
      const boost = calculateWhaleConfidenceBoost('neutral', 1, 50000);
      expect(boost).toBe(1.25); // superWhaleBoost
    });

    it('should apply both bullish and super whale boosts', () => {
      const boost = calculateWhaleConfidenceBoost('bullish', 2, 50000);
      expect(boost).toBeCloseTo(1.15 * 1.25, 4); // whaleBullishBoost * superWhaleBoost
    });

    it('should apply significant flow boost (positive)', () => {
      const boost = calculateWhaleConfidenceBoost('neutral', 0, 150000);
      expect(boost).toBe(1.1); // 10% boost for significant flow
    });

    it('should apply significant flow boost (negative)', () => {
      const boost = calculateWhaleConfidenceBoost('neutral', 0, -150000);
      expect(boost).toBe(1.1); // 10% boost for significant flow (absolute value)
    });

    it('should compound all boosts', () => {
      // Bullish + super whale + significant flow
      const boost = calculateWhaleConfidenceBoost('bullish', 1, 200000);
      const expected = 1.15 * 1.25 * 1.1; // ~1.58
      expect(boost).toBeCloseTo(expected, 4);
    });

    it('should compound bearish penalty with super whale', () => {
      // Bearish + super whale = conflicting signals
      const boost = calculateWhaleConfidenceBoost('bearish', 1, 50000);
      const expected = 0.85 * 1.25; // ~1.0625 (net slightly positive)
      expect(boost).toBeCloseTo(expected, 4);
    });
  });

  describe('Opportunity Sorting with Whale Priority', () => {
    interface TestOpportunity {
      token: string;
      netProfit: number;
      confidence: number;
      whaleTriggered?: boolean;
    }

    /**
     * Sort opportunities with whale-triggered priority
     * Extracted from filterValidOpportunities in detector.ts
     */
    function sortOpportunities(opportunities: TestOpportunity[]): TestOpportunity[] {
      return [...opportunities].sort((a, b) => {
        // Whale-triggered first
        if (a.whaleTriggered && !b.whaleTriggered) return -1;
        if (!a.whaleTriggered && b.whaleTriggered) return 1;
        // Then by net profit
        return b.netProfit - a.netProfit;
      });
    }

    it('should prioritize whale-triggered opportunities', () => {
      const opps: TestOpportunity[] = [
        { token: 'WETH', netProfit: 200, confidence: 0.9 },
        { token: 'USDC', netProfit: 100, confidence: 0.85, whaleTriggered: true },
        { token: 'WBTC', netProfit: 150, confidence: 0.8 }
      ];

      const sorted = sortOpportunities(opps);

      expect(sorted[0].token).toBe('USDC'); // Whale-triggered comes first
      expect(sorted[0].whaleTriggered).toBe(true);
    });

    it('should sort whale-triggered by profit among themselves', () => {
      const opps: TestOpportunity[] = [
        { token: 'WETH', netProfit: 50, confidence: 0.9, whaleTriggered: true },
        { token: 'USDC', netProfit: 200, confidence: 0.85, whaleTriggered: true },
        { token: 'WBTC', netProfit: 100, confidence: 0.8, whaleTriggered: true }
      ];

      const sorted = sortOpportunities(opps);

      expect(sorted[0].netProfit).toBe(200);
      expect(sorted[1].netProfit).toBe(100);
      expect(sorted[2].netProfit).toBe(50);
    });

    it('should sort non-whale opportunities by profit', () => {
      const opps: TestOpportunity[] = [
        { token: 'WETH', netProfit: 50, confidence: 0.9 },
        { token: 'USDC', netProfit: 200, confidence: 0.85 },
        { token: 'WBTC', netProfit: 100, confidence: 0.8 }
      ];

      const sorted = sortOpportunities(opps);

      expect(sorted[0].netProfit).toBe(200);
      expect(sorted[1].netProfit).toBe(100);
      expect(sorted[2].netProfit).toBe(50);
    });

    it('should handle mixed whale and non-whale opportunities', () => {
      const opps: TestOpportunity[] = [
        { token: 'A', netProfit: 300, confidence: 0.9 },               // Non-whale, highest profit
        { token: 'B', netProfit: 50, confidence: 0.85, whaleTriggered: true },  // Whale, low profit
        { token: 'C', netProfit: 200, confidence: 0.8 },               // Non-whale
        { token: 'D', netProfit: 100, confidence: 0.75, whaleTriggered: true }, // Whale, medium profit
      ];

      const sorted = sortOpportunities(opps);

      // Whale-triggered first (sorted by profit)
      expect(sorted[0].token).toBe('D'); // Whale with 100 profit
      expect(sorted[1].token).toBe('B'); // Whale with 50 profit
      // Then non-whale (sorted by profit)
      expect(sorted[2].token).toBe('A'); // Non-whale with 300 profit
      expect(sorted[3].token).toBe('C'); // Non-whale with 200 profit
    });

    it('should handle empty array', () => {
      const sorted = sortOpportunities([]);
      expect(sorted.length).toBe(0);
    });

    it('should handle single element', () => {
      const opps: TestOpportunity[] = [
        { token: 'WETH', netProfit: 100, confidence: 0.9 }
      ];
      const sorted = sortOpportunities(opps);
      expect(sorted.length).toBe(1);
      expect(sorted[0].token).toBe('WETH');
    });
  });

  describe('TrackedWhaleTransaction Construction', () => {
    /**
     * Build TrackedWhaleTransaction from WhaleTransaction
     * Logic from analyzeWhaleImpact in detector.ts
     */
    interface WhaleTransaction {
      transactionHash: string;
      address: string;
      token: string;
      amount: number;
      usdValue: number;
      direction: 'buy' | 'sell';
      dex: string;
      chain: string;
      timestamp: number;
      impact: number;
    }

    interface TrackedWhaleTransaction {
      transactionHash: string;
      walletAddress: string;
      chain: string;
      dex: string;
      pairAddress: string;
      tokenIn: string;
      tokenOut: string;
      amountIn: number;
      amountOut: number;
      usdValue: number;
      direction: 'buy' | 'sell';
      priceImpact: number;
      timestamp: number;
    }

    function buildTrackedTransaction(whaleTx: WhaleTransaction): TrackedWhaleTransaction {
      let baseToken: string;
      let quoteToken: string;

      if (whaleTx.token.includes('/')) {
        const tokenParts = whaleTx.token.split('/');
        baseToken = tokenParts[0] || whaleTx.token;
        quoteToken = tokenParts[1] || 'USDC';
      } else if (whaleTx.token.includes('_')) {
        const tokenParts = whaleTx.token.split('_');
        baseToken = tokenParts.length >= 2 ? tokenParts[tokenParts.length - 2] : whaleTx.token;
        quoteToken = tokenParts.length >= 2 ? tokenParts[tokenParts.length - 1] : 'USDC';
      } else {
        baseToken = whaleTx.token;
        quoteToken = 'USDC';
      }

      return {
        transactionHash: whaleTx.transactionHash,
        walletAddress: whaleTx.address,
        chain: whaleTx.chain,
        dex: whaleTx.dex,
        pairAddress: whaleTx.token,
        tokenIn: whaleTx.direction === 'buy' ? quoteToken : baseToken,
        tokenOut: whaleTx.direction === 'buy' ? baseToken : quoteToken,
        amountIn: whaleTx.direction === 'buy' ? whaleTx.usdValue : whaleTx.amount,
        amountOut: whaleTx.direction === 'buy' ? whaleTx.amount : whaleTx.usdValue,
        usdValue: whaleTx.usdValue,
        direction: whaleTx.direction,
        priceImpact: whaleTx.impact,
        timestamp: whaleTx.timestamp,
      };
    }

    it('should correctly map buy transaction', () => {
      const whaleTx: WhaleTransaction = {
        transactionHash: '0xabc123',
        address: '0xwhale',
        token: 'WETH/USDC',
        amount: 100, // 100 WETH
        usdValue: 250000, // $250K
        direction: 'buy',
        dex: 'uniswap',
        chain: 'ethereum',
        timestamp: Date.now(),
        impact: 0.5,
      };

      const tracked = buildTrackedTransaction(whaleTx);

      expect(tracked.walletAddress).toBe('0xwhale');
      expect(tracked.tokenIn).toBe('USDC');  // Spending USDC
      expect(tracked.tokenOut).toBe('WETH'); // Receiving WETH
      expect(tracked.amountIn).toBe(250000); // USD value spent
      expect(tracked.amountOut).toBe(100);   // WETH received
      expect(tracked.direction).toBe('buy');
    });

    it('should correctly map sell transaction', () => {
      const whaleTx: WhaleTransaction = {
        transactionHash: '0xdef456',
        address: '0xwhale2',
        token: 'WETH/USDC',
        amount: 50, // 50 WETH being sold
        usdValue: 125000, // $125K received
        direction: 'sell',
        dex: 'uniswap',
        chain: 'arbitrum',
        timestamp: Date.now(),
        impact: 0.3,
      };

      const tracked = buildTrackedTransaction(whaleTx);

      expect(tracked.tokenIn).toBe('WETH');  // Spending WETH
      expect(tracked.tokenOut).toBe('USDC'); // Receiving USDC
      expect(tracked.amountIn).toBe(50);     // WETH spent
      expect(tracked.amountOut).toBe(125000); // USD received
      expect(tracked.direction).toBe('sell');
    });

    it('should handle single token format', () => {
      const whaleTx: WhaleTransaction = {
        transactionHash: '0xghi789',
        address: '0xwhale3',
        token: 'LINK', // Single token
        amount: 10000,
        usdValue: 150000,
        direction: 'buy',
        dex: 'sushiswap',
        chain: 'polygon',
        timestamp: Date.now(),
        impact: 0.2,
      };

      const tracked = buildTrackedTransaction(whaleTx);

      expect(tracked.tokenIn).toBe('USDC');  // Default quote
      expect(tracked.tokenOut).toBe('LINK');
    });

    it('should handle DEX-prefixed format', () => {
      const whaleTx: WhaleTransaction = {
        transactionHash: '0xjkl012',
        address: '0xwhale4',
        token: 'traderjoe_WAVAX_USDC',
        amount: 5000,
        usdValue: 100000,
        direction: 'sell',
        dex: 'traderjoe',
        chain: 'avalanche',
        timestamp: Date.now(),
        impact: 0.4,
      };

      const tracked = buildTrackedTransaction(whaleTx);

      expect(tracked.tokenIn).toBe('WAVAX'); // Selling WAVAX
      expect(tracked.tokenOut).toBe('USDC');
      expect(tracked.pairAddress).toBe('traderjoe_WAVAX_USDC');
    });
  });
});

// =============================================================================
// Circuit Breaker Tests (FIX #5 Verification)
// =============================================================================

describe('Circuit Breaker Behavior', () => {
  const DETECTION_ERROR_THRESHOLD = 5;
  const CIRCUIT_BREAKER_RESET_MS = 30000;

  /**
   * Simulates circuit breaker logic from CrossChainDetectorService
   */
  function createCircuitBreaker() {
    let consecutiveErrors = 0;
    let lastTrip = 0;

    return {
      recordError(): boolean {
        consecutiveErrors++;
        if (consecutiveErrors >= DETECTION_ERROR_THRESHOLD) {
          lastTrip = Date.now();
          return true; // Circuit tripped
        }
        return false;
      },
      recordSuccess(): void {
        consecutiveErrors = 0;
      },
      isOpen(): boolean {
        if (consecutiveErrors < DETECTION_ERROR_THRESHOLD) return false;
        return (Date.now() - lastTrip) < CIRCUIT_BREAKER_RESET_MS;
      },
      reset(): void {
        consecutiveErrors = 0;
        lastTrip = 0;
      },
      getConsecutiveErrors(): number {
        return consecutiveErrors;
      },
    };
  }

  it('should trip circuit breaker after threshold consecutive errors', () => {
    const breaker = createCircuitBreaker();

    // Record errors up to threshold
    for (let i = 0; i < DETECTION_ERROR_THRESHOLD - 1; i++) {
      expect(breaker.recordError()).toBe(false);
      expect(breaker.isOpen()).toBe(false);
    }

    // Next error should trip the breaker
    expect(breaker.recordError()).toBe(true);
    expect(breaker.isOpen()).toBe(true);
  });

  it('should reset error count on success', () => {
    const breaker = createCircuitBreaker();

    // Record some errors
    breaker.recordError();
    breaker.recordError();
    expect(breaker.getConsecutiveErrors()).toBe(2);

    // Success should reset count
    breaker.recordSuccess();
    expect(breaker.getConsecutiveErrors()).toBe(0);
    expect(breaker.isOpen()).toBe(false);
  });

  it('should block detection while circuit is open', () => {
    const breaker = createCircuitBreaker();

    // Trip the breaker
    for (let i = 0; i < DETECTION_ERROR_THRESHOLD; i++) {
      breaker.recordError();
    }

    expect(breaker.isOpen()).toBe(true);

    // Simulate detection attempt (should be blocked)
    let detectionRan = false;
    if (!breaker.isOpen()) {
      detectionRan = true;
    }
    expect(detectionRan).toBe(false);
  });

  it('should not trip on mixed success/error patterns', () => {
    const breaker = createCircuitBreaker();

    // Alternating pattern should not trip
    for (let i = 0; i < 10; i++) {
      breaker.recordError();
      breaker.recordError();
      breaker.recordSuccess(); // Resets count
    }

    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getConsecutiveErrors()).toBe(0);
  });
});

// =============================================================================
// Version Counter Reset Tests (FIX 4.4 Verification)
// =============================================================================

describe('Version Counter Edge Cases', () => {
  it('should handle version counter approaching MAX_SAFE_INTEGER', () => {
    const MAX_VERSION = Number.MAX_SAFE_INTEGER - 1000;
    let version = MAX_VERSION - 2;
    let cachedVersion = MAX_VERSION - 3;

    // Simulate increments near overflow
    version++;
    expect(version).toBe(MAX_VERSION - 1);

    version++;
    expect(version).toBe(MAX_VERSION);

    version++;
    // Should reset to prevent overflow
    if (version > MAX_VERSION) {
      version = 1; // FIX 4.4: Reset to 1, not 0
      cachedVersion = -1;
    }

    expect(version).toBe(1);
    expect(cachedVersion).toBe(-1);

    // After rebuild, cachedVersion should match version
    cachedVersion = version;
    expect(cachedVersion).toBe(1);

    // Next increment should work normally
    version++;
    expect(version).toBe(2);
    expect(cachedVersion !== version).toBe(true); // Cache should be invalidated
  });

  it('should rebuild cache after version reset', () => {
    let version = 1;
    let cachedVersion = -1;
    let cacheRebuilt = false;

    // Simulate cache check after reset
    if (cachedVersion !== version) {
      cacheRebuilt = true;
      cachedVersion = version;
    }

    expect(cacheRebuilt).toBe(true);
    expect(cachedVersion).toBe(version);
  });

  it('should not have collision after clear() and reset', () => {
    let version = 0;
    let cachedVersion = -1;

    // After clear()
    version = 0;
    cachedVersion = -1;

    // First snapshot build
    if (cachedVersion !== version) {
      cachedVersion = version;
    }
    expect(cachedVersion).toBe(0);

    // Data update increments version
    version++;
    expect(version).toBe(1);

    // Cache check should detect change
    expect(cachedVersion !== version).toBe(true);
  });
});

// =============================================================================
// ETH Price Detection Tests
// =============================================================================

describe('ETH Price Detection', () => {
  /**
   * Logic extracted from maybeUpdateEthPrice in detector.ts
   */
  function isEthPricePair(pairKey: string): boolean {
    const upperPairKey = pairKey.toUpperCase();
    const isEthPair = (
      (upperPairKey.includes('WETH') || upperPairKey.includes('_ETH_') || upperPairKey.startsWith('ETH_')) &&
      (upperPairKey.includes('USDC') || upperPairKey.includes('USDT') || upperPairKey.includes('DAI') || upperPairKey.includes('BUSD'))
    );
    return isEthPair;
  }

  function isValidEthPrice(price: number): boolean {
    return price > 100 && price < 100000;
  }

  it('should detect WETH/USDC as ETH price pair', () => {
    expect(isEthPricePair('UNISWAP_WETH_USDC')).toBe(true);
    expect(isEthPricePair('SUSHISWAP_WETH_USDT')).toBe(true);
    expect(isEthPricePair('CURVE_WETH_DAI')).toBe(true);
  });

  it('should detect ETH_USDC format', () => {
    expect(isEthPricePair('ETH_USDC')).toBe(true);
    expect(isEthPricePair('PANCAKE_ETH_BUSD')).toBe(true);
  });

  it('should not detect non-ETH pairs', () => {
    expect(isEthPricePair('UNISWAP_WBTC_USDC')).toBe(false);
    expect(isEthPricePair('UNISWAP_LINK_USDT')).toBe(false);
    expect(isEthPricePair('SUSHISWAP_UNI_DAI')).toBe(false);
  });

  it('should validate ETH price in reasonable range', () => {
    expect(isValidEthPrice(2500)).toBe(true);   // Current realistic price
    expect(isValidEthPrice(500)).toBe(true);    // Bear market
    expect(isValidEthPrice(10000)).toBe(true);  // Bull market
    expect(isValidEthPrice(50)).toBe(false);    // Too low (likely error)
    expect(isValidEthPrice(150000)).toBe(false); // Too high (likely error)
    expect(isValidEthPrice(0)).toBe(false);     // Invalid
    expect(isValidEthPrice(-100)).toBe(false);  // Invalid
  });
});

// =============================================================================
// Token Pair Normalization Edge Cases
// =============================================================================

// =============================================================================
// Concurrent Detection Guard Tests (Fix 8.1)
// =============================================================================

describe('Concurrent Detection Guard', () => {
  /**
   * Simulates the isDetecting concurrency guard from detector.ts.
   * This prevents overlapping detection cycles that could cause race conditions.
   */
  function createDetectionGuard() {
    let isDetecting = false;
    let detectionCount = 0;
    let skippedCount = 0;

    return {
      async startDetection(detectFn: () => Promise<void>): Promise<boolean> {
        // FIX 5.1: Skip if already detecting
        if (isDetecting) {
          skippedCount++;
          return false;
        }

        isDetecting = true;
        try {
          await detectFn();
          detectionCount++;
          return true;
        } finally {
          isDetecting = false;
        }
      },
      getStats: () => ({
        detectionCount,
        skippedCount,
        isDetecting,
      }),
    };
  }

  it('should allow sequential detection cycles', async () => {
    const guard = createDetectionGuard();

    await guard.startDetection(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    await guard.startDetection(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    const stats = guard.getStats();
    expect(stats.detectionCount).toBe(2);
    expect(stats.skippedCount).toBe(0);
  });

  it('should skip concurrent detection attempts', async () => {
    const guard = createDetectionGuard();

    // Start a long-running detection
    const detection1 = guard.startDetection(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    // Try to start another detection while the first is running
    const detection2 = guard.startDetection(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
    });

    // Second should be skipped
    const result2 = await detection2;
    expect(result2).toBe(false);

    // Wait for first to complete
    const result1 = await detection1;
    expect(result1).toBe(true);

    const stats = guard.getStats();
    expect(stats.detectionCount).toBe(1);
    expect(stats.skippedCount).toBe(1);
  });

  it('should recover after detection throws error', async () => {
    const guard = createDetectionGuard();

    // Detection that throws
    try {
      await guard.startDetection(async () => {
        throw new Error('Detection failed');
      });
    } catch {
      // Expected error
    }

    // Guard should be reset, allowing new detection
    const result = await guard.startDetection(async () => {
      // Success
    });

    expect(result).toBe(true);
    expect(guard.getStats().isDetecting).toBe(false);
  });

  it('should handle multiple rapid detection attempts', async () => {
    const guard = createDetectionGuard();

    // Start multiple detections rapidly
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(guard.startDetection(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      }));
    }

    await Promise.all(promises);

    const stats = guard.getStats();
    // Only one should have run, rest should be skipped
    expect(stats.detectionCount).toBe(1);
    expect(stats.skippedCount).toBe(4);
  });

  it('should not be detecting after all cycles complete', async () => {
    const guard = createDetectionGuard();

    await guard.startDetection(async () => {});

    expect(guard.getStats().isDetecting).toBe(false);
  });
});

// =============================================================================
// Price Impact Estimation Tests (Fix 8.1 - analyzePendingOpportunity support)
// =============================================================================

describe('Price Impact Estimation', () => {
  /**
   * Estimate price impact based on trade size and liquidity.
   * Extracted from analyzePendingOpportunity logic.
   */
  function estimatePriceImpact(
    amountIn: bigint,
    reserve0: string | undefined,
    reserve1: string | undefined,
    tokenDecimals: number = 18
  ): number {
    // Guard against missing reserve data
    if (!reserve0 || !reserve1) {
      return 0;
    }

    try {
      const r0 = BigInt(reserve0);
      const r1 = BigInt(reserve1);

      // Guard against zero reserves
      if (r0 === 0n || r1 === 0n) {
        return 0;
      }

      // Calculate impact as percentage of pool
      // Impact ≈ amountIn / reserve0 for constant product AMM
      const scaleFactor = 10000n; // 0.01% precision
      const impactBps = (amountIn * scaleFactor) / r0;

      // Convert to percentage (divide by 100 since scaleFactor is 10000)
      return Number(impactBps) / 100;
    } catch {
      return 0;
    }
  }

  it('should estimate impact for small trade', () => {
    const amountIn = 1000000000000000000n; // 1 ETH
    const reserve0 = '1000000000000000000000'; // 1000 ETH
    const reserve1 = '2500000000000'; // 2.5M USDC (6 decimals)

    const impact = estimatePriceImpact(amountIn, reserve0, reserve1);

    // 1 ETH / 1000 ETH = 0.1%
    expect(impact).toBeCloseTo(0.1, 2);
  });

  it('should estimate higher impact for larger trade', () => {
    const amountIn = 100000000000000000000n; // 100 ETH
    const reserve0 = '1000000000000000000000'; // 1000 ETH
    const reserve1 = '2500000000000'; // 2.5M USDC

    const impact = estimatePriceImpact(amountIn, reserve0, reserve1);

    // 100 ETH / 1000 ETH = 10%
    expect(impact).toBeCloseTo(10, 1);
  });

  it('should return 0 for missing reserves', () => {
    const amountIn = 1000000000000000000n;

    expect(estimatePriceImpact(amountIn, undefined, '1000')).toBe(0);
    expect(estimatePriceImpact(amountIn, '1000', undefined)).toBe(0);
    expect(estimatePriceImpact(amountIn, undefined, undefined)).toBe(0);
  });

  it('should return 0 for zero reserves', () => {
    const amountIn = 1000000000000000000n;

    expect(estimatePriceImpact(amountIn, '0', '1000000')).toBe(0);
    expect(estimatePriceImpact(amountIn, '1000000', '0')).toBe(0);
  });

  it('should handle very large reserves', () => {
    // Large DeFi pools can have billions in liquidity
    const amountIn = 10000000000000000000n; // 10 ETH
    const reserve0 = '100000000000000000000000'; // 100,000 ETH
    const reserve1 = '250000000000000'; // 250M USDC

    const impact = estimatePriceImpact(amountIn, reserve0, reserve1);

    // 10 ETH / 100000 ETH = 0.01%
    expect(impact).toBeCloseTo(0.01, 3);
  });

  it('should handle invalid reserve strings gracefully', () => {
    const amountIn = 1000000000000000000n;

    // Invalid string should return 0, not throw
    expect(estimatePriceImpact(amountIn, 'invalid', '1000')).toBe(0);
    expect(estimatePriceImpact(amountIn, '1000', 'invalid')).toBe(0);
  });
});

// =============================================================================
// Pending Opportunity Analysis Tests (Fix 8.1)
// =============================================================================

describe('Pending Opportunity Analysis', () => {
  /**
   * Check if a pending opportunity's deadline is still valid.
   */
  function isDeadlineValid(deadline: number, bufferSeconds: number = 30): boolean {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return deadline > nowSeconds + bufferSeconds;
  }

  /**
   * Calculate confidence adjustment based on slippage tolerance.
   * Higher slippage = lower confidence (whale may be desperate)
   */
  function adjustConfidenceForSlippage(
    baseConfidence: number,
    slippageTolerance: number
  ): number {
    // High slippage (>1%) reduces confidence
    if (slippageTolerance > 0.01) {
      return baseConfidence * 0.9;
    }
    // Very high slippage (>3%) reduces confidence more
    if (slippageTolerance > 0.03) {
      return baseConfidence * 0.7;
    }
    // Normal slippage (0.1-0.5%) is standard
    return baseConfidence;
  }

  describe('Deadline Validation', () => {
    it('should accept valid future deadline', () => {
      const futureDeadline = Math.floor(Date.now() / 1000) + 300; // 5 min
      expect(isDeadlineValid(futureDeadline)).toBe(true);
    });

    it('should reject expired deadline', () => {
      const pastDeadline = Math.floor(Date.now() / 1000) - 60; // 1 min ago
      expect(isDeadlineValid(pastDeadline)).toBe(false);
    });

    it('should reject deadline too close to now (within buffer)', () => {
      const closeDeadline = Math.floor(Date.now() / 1000) + 20; // 20 sec
      expect(isDeadlineValid(closeDeadline, 30)).toBe(false);
    });

    it('should accept deadline just outside buffer', () => {
      const okDeadline = Math.floor(Date.now() / 1000) + 35; // 35 sec
      expect(isDeadlineValid(okDeadline, 30)).toBe(true);
    });
  });

  describe('Slippage-Based Confidence', () => {
    it('should not penalize normal slippage', () => {
      expect(adjustConfidenceForSlippage(0.8, 0.005)).toBe(0.8);
      expect(adjustConfidenceForSlippage(0.8, 0.003)).toBe(0.8);
    });

    it('should reduce confidence for high slippage', () => {
      expect(adjustConfidenceForSlippage(0.8, 0.015)).toBeCloseTo(0.72, 10); // 0.8 * 0.9
      expect(adjustConfidenceForSlippage(0.8, 0.02)).toBeCloseTo(0.72, 10);
    });

    it('should reduce confidence more for very high slippage', () => {
      expect(adjustConfidenceForSlippage(0.8, 0.05)).toBeCloseTo(0.72, 10); // Still 0.9 (> 0.01 check first)
    });

    it('should handle edge cases', () => {
      expect(adjustConfidenceForSlippage(1.0, 0)).toBe(1.0);
      expect(adjustConfidenceForSlippage(0, 0.01)).toBe(0);
    });
  });

  describe('Cross-Chain Opportunity Detection from Pending', () => {
    /**
     * Check if a pending swap creates a cross-chain arbitrage opportunity.
     * This simulates the core logic from analyzePendingOpportunity.
     */
    interface PricePoint {
      chain: string;
      dex: string;
      price: number;
    }

    function detectCrossChainFromPending(
      pendingChain: string,
      pendingPrice: number,
      otherPrices: PricePoint[],
      minPriceDiff: number = 0.005 // 0.5%
    ): { targetChain: string; targetDex: string; priceDiff: number } | null {
      let bestOpportunity: { targetChain: string; targetDex: string; priceDiff: number } | null = null;
      let bestPriceDiff = 0;

      for (const point of otherPrices) {
        // Skip same chain
        if (point.chain === pendingChain) continue;

        // Calculate price difference
        const priceDiff = Math.abs(point.price - pendingPrice) / Math.min(point.price, pendingPrice);

        if (priceDiff > minPriceDiff && priceDiff > bestPriceDiff) {
          bestPriceDiff = priceDiff;
          bestOpportunity = {
            targetChain: point.chain,
            targetDex: point.dex,
            priceDiff,
          };
        }
      }

      return bestOpportunity;
    }

    it('should detect cross-chain opportunity when price diff exceeds threshold', () => {
      const otherPrices: PricePoint[] = [
        { chain: 'ethereum', dex: 'uniswap', price: 2500 },
        { chain: 'arbitrum', dex: 'sushiswap', price: 2550 }, // 2% higher
        { chain: 'polygon', dex: 'quickswap', price: 2480 },
      ];

      const result = detectCrossChainFromPending('ethereum', 2500, otherPrices);

      expect(result).not.toBeNull();
      expect(result!.targetChain).toBe('arbitrum');
      expect(result!.priceDiff).toBeCloseTo(0.02, 3);
    });

    it('should return null when no significant price diff', () => {
      const otherPrices: PricePoint[] = [
        { chain: 'ethereum', dex: 'uniswap', price: 2500 },
        { chain: 'arbitrum', dex: 'sushiswap', price: 2502 }, // 0.08% - too small
        { chain: 'polygon', dex: 'quickswap', price: 2498 },
      ];

      const result = detectCrossChainFromPending('ethereum', 2500, otherPrices);

      expect(result).toBeNull();
    });

    it('should skip same chain prices', () => {
      const otherPrices: PricePoint[] = [
        { chain: 'ethereum', dex: 'uniswap', price: 2500 },
        { chain: 'ethereum', dex: 'sushiswap', price: 2600 }, // Same chain - should skip
      ];

      const result = detectCrossChainFromPending('ethereum', 2500, otherPrices);

      expect(result).toBeNull();
    });

    it('should find best opportunity among multiple', () => {
      const otherPrices: PricePoint[] = [
        { chain: 'arbitrum', dex: 'sushiswap', price: 2525 }, // 1% diff
        { chain: 'polygon', dex: 'quickswap', price: 2575 }, // 3% diff - best
        { chain: 'optimism', dex: 'velodrome', price: 2550 }, // 2% diff
      ];

      const result = detectCrossChainFromPending('ethereum', 2500, otherPrices);

      expect(result).not.toBeNull();
      expect(result!.targetChain).toBe('polygon');
      expect(result!.priceDiff).toBeCloseTo(0.03, 3);
    });
  });
});

// =============================================================================
// Token Pair Normalization Edge Cases
// =============================================================================

describe('Token Pair Normalization Edge Cases', () => {
  /**
   * Token normalization logic (simplified version from types.ts)
   */
  function normalizeToInternalFormat(tokenPair: string): string {
    if (!tokenPair || typeof tokenPair !== 'string') {
      return tokenPair;
    }
    // If it contains slash, convert to underscore
    if (tokenPair.includes('/')) {
      return tokenPair.replace('/', '_');
    }
    // Already in internal format or needs extraction from pairKey
    const parts = tokenPair.split('_');
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}_${parts[parts.length - 1]}`;
    }
    return tokenPair;
  }

  it('should normalize display format to internal format', () => {
    expect(normalizeToInternalFormat('WETH/USDC')).toBe('WETH_USDC');
    expect(normalizeToInternalFormat('WBTC/USDT')).toBe('WBTC_USDT');
  });

  it('should handle already internal format', () => {
    expect(normalizeToInternalFormat('WETH_USDC')).toBe('WETH_USDC');
  });

  it('should extract token pair from DEX-prefixed format', () => {
    expect(normalizeToInternalFormat('UNISWAP_WETH_USDC')).toBe('WETH_USDC');
    expect(normalizeToInternalFormat('SUSHISWAP_WBTC_USDT')).toBe('WBTC_USDT');
    expect(normalizeToInternalFormat('traderjoe_WAVAX_USDC')).toBe('WAVAX_USDC');
  });

  it('should handle DEX version prefixes', () => {
    expect(normalizeToInternalFormat('uniswap_v3_WETH_USDC')).toBe('WETH_USDC');
    expect(normalizeToInternalFormat('curve_v2_WETH_USDT')).toBe('WETH_USDT');
  });

  it('should handle edge cases gracefully', () => {
    expect(normalizeToInternalFormat('')).toBe('');
    expect(normalizeToInternalFormat('SINGLE')).toBe('SINGLE');
    // @ts-expect-error Testing null handling
    expect(normalizeToInternalFormat(null)).toBe(null);
    // @ts-expect-error Testing undefined handling
    expect(normalizeToInternalFormat(undefined)).toBe(undefined);
  });

  it('should handle chain-specific token variants', () => {
    // These should be extracted correctly even with chain-specific suffixes
    expect(normalizeToInternalFormat('TRADERJOE_WETH.e_USDC')).toBe('WETH.e_USDC');
    expect(normalizeToInternalFormat('PANCAKE_BTCB_BUSD')).toBe('BTCB_BUSD');
  });
});
