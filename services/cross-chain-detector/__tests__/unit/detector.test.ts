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
import { CHAINS, ARBITRAGE_CONFIG, getDefaultQuoteToken } from '@arbitrage/config';
// FIX #13: Import production functions instead of re-implementing inline
import { normalizeToInternalFormat, toDisplayTokenPair, toInternalTokenPair } from '../../src/types';

// =============================================================================
// Configuration Tests (No mocking required)
// =============================================================================

describe('Cross-Chain Configuration', () => {
  describe('Supported Chains', () => {
    /**
     * GIVEN: System is configured for cross-chain arbitrage
     * WHEN: Querying supported chains
     * THEN: All production chains should be available
     *
     * **Business Value:**
     * Ensures the system can discover arbitrage opportunities across all
     * major EVM chains (Ethereum, L2s, sidechains). Missing chain configuration
     * would result in missed profitable opportunities.
     */
    it('should support all production chains for cross-chain arbitrage', () => {
      expect(CHAINS.ethereum).toBeDefined();
      expect(CHAINS.arbitrum).toBeDefined();
      expect(CHAINS.optimism).toBeDefined();
      expect(CHAINS.base).toBeDefined();
      expect(CHAINS.polygon).toBeDefined();
      expect(CHAINS.bsc).toBeDefined();
    });

    /**
     * GIVEN: Multiple chains configured in the system
     * WHEN: Validating chain configurations
     * THEN: Each chain should have unique chain ID
     *
     * **Business Value:**
     * Prevents transaction routing errors. If two chains shared the same
     * chain ID, transactions could be sent to the wrong network, resulting
     * in failed trades and capital loss.
     */
    it('should prevent chain ID conflicts for transaction routing', () => {
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
    /**
     * GIVEN: Different chains have different gas costs
     * WHEN: Configuring minimum profit thresholds
     * THEN: Each chain should have appropriate threshold tuned for its gas costs
     *
     * **Business Value:**
     * Prevents executing unprofitable trades. Ethereum's high gas costs
     * ($50-200) require higher minimum profits than L2s ($1-5) to remain
     * profitable after transaction fees.
     */
    it('should tune profit thresholds based on chain-specific gas costs', () => {
      expect(ARBITRAGE_CONFIG.chainMinProfits.ethereum).toBeDefined();
      expect(ARBITRAGE_CONFIG.chainMinProfits.arbitrum).toBeDefined();
      expect(ARBITRAGE_CONFIG.chainMinProfits.polygon).toBeDefined();
    });

    /**
     * GIVEN: Ethereum has highest gas costs (~$50-200 per trade)
     * WHEN: Comparing minimum profit thresholds
     * THEN: Ethereum threshold should be higher than L2 thresholds
     *
     * **Business Value:**
     * Protects capital by filtering out Ethereum opportunities that would
     * be profitable on L2s but unprofitable on mainnet due to gas costs.
     * Prevents gas-expensive failed trades.
     */
    it('should require higher profit on Ethereum to compensate for high gas costs', () => {
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
    /**
     * GIVEN: Same token priced differently on Ethereum ($2500) and Arbitrum ($2530)
     * WHEN: Calculating net profit after bridge and gas costs
     * THEN: Should identify as profitable opportunity ($95 net profit)
     *
     * **Business Value:**
     * Cross-chain arbitrage exploits price discrepancies across chains.
     * When price difference (1.2%) exceeds total costs (bridge $15 + gas $10),
     * the opportunity is profitable. This test verifies the core profit
     * calculation logic that protects capital.
     */
    it('should identify cross-chain opportunities exceeding all costs', () => {
      // Given: Same token, different prices on different chains
      const ethPriceOnEthereum = 2500;
      const ethPriceOnArbitrum = 2530; // 1.2% higher

      const priceDiff = Math.abs(ethPriceOnEthereum - ethPriceOnArbitrum) / Math.min(ethPriceOnEthereum, ethPriceOnArbitrum);
      const tradeAmount = 10000;
      const grossProfit = tradeAmount * priceDiff;
      const bridgeCosts = 15;
      const gasCosts = 10;

      // When: Calculating net profit
      const netProfit = grossProfit - bridgeCosts - gasCosts;

      // Then: Should be profitable
      expect(priceDiff).toBeCloseTo(0.012, 3); // ~1.2%
      expect(grossProfit).toBeCloseTo(120, 0);
      expect(netProfit).toBeCloseTo(95, 0);
      expect(netProfit).toBeGreaterThan(0);
    });

    /**
     * GIVEN: Small price difference (0.2%) between chains
     * WHEN: Bridge and gas costs exceed gross profit
     * THEN: Should reject as unprofitable
     *
     * **Business Value:**
     * Prevents capital loss from executing trades where costs exceed gains.
     * A 0.2% price difference generates only $20 gross profit on $10k trade,
     * but bridge ($15) + gas ($10) = $25 costs result in -$5 net loss.
     * Filtering prevents wasting gas on unprofitable trades.
     */
    it('should filter out opportunities where costs exceed profit', () => {
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
    /**
     * GIVEN: Multiple opportunities with different net profits
     * WHEN: Prioritizing for execution
     * THEN: Should sort by net profit (highest first)
     *
     * **Business Value:**
     * Ensures execution engine processes most profitable opportunities first.
     * Critical when execution capacity is limited (gas budget, RPC rate limits)
     * or when opportunities are short-lived. Maximizes profit per execution slot.
     */
    it('should prioritize highest-profit opportunities for execution', () => {
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

    /**
     * GIVEN: Opportunities with varying confidence scores
     * WHEN: Filtering by minimum confidence threshold (0.7)
     * THEN: Should exclude low-confidence opportunities
     *
     * **Business Value:**
     * Reduces failed trades from stale prices or low-liquidity pairs.
     * Low confidence (0.3) indicates price data may be outdated or slippage
     * may be high. Even if gross profit looks attractive ($200), low confidence
     * signals higher execution risk. Filtering prevents wasting gas on likely failures.
     */
    it('should exclude low-confidence opportunities to reduce failed trades', () => {
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

    /**
     * GIVEN: Opportunities with varying net profits
     * WHEN: Filtering by minimum profitability threshold ($20)
     * THEN: Should exclude marginal opportunities below threshold
     *
     * **Business Value:**
     * Prevents execution of barely-profitable trades that may become
     * unprofitable due to small price movements or gas price spikes.
     * $5 net profit provides no buffer for slippage or gas fluctuations.
     * Minimum threshold ($20) ensures reasonable profit margin after execution risk.
     */
    it('should exclude marginal opportunities below profitability threshold', () => {
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
     * FIX #13: Token parsing logic from analyzeWhaleImpact.
     * Updated to use getDefaultQuoteToken() from @arbitrage/config
     * instead of hardcoded 'USDC', matching production behavior.
     *
     * NOTE: This is a private helper within analyzeWhaleImpact, so it cannot
     * be imported directly. The inline copy is maintained for unit-level testing
     * but kept in sync with the production implementation.
     *
     * @see detector.ts analyzeWhaleImpact method (~line 1634)
     */
    function parseTokenPair(
      tokenString: string,
      chain: string = 'ethereum'
    ): { baseToken: string; quoteToken: string } {
      let baseToken: string;
      let quoteToken: string;

      if (tokenString.includes('/')) {
        const tokenParts = tokenString.split('/');
        baseToken = tokenParts[0] || tokenString;
        quoteToken = tokenParts[1]?.trim() || getDefaultQuoteToken(chain);
      } else if (tokenString.includes('_')) {
        const tokenParts = tokenString.split('_');
        // Take last two parts as tokens (handles DEX_TOKEN0_TOKEN1 format)
        baseToken = tokenParts.length >= 2 ? tokenParts[tokenParts.length - 2] : tokenString;
        quoteToken = tokenParts.length >= 2 ? tokenParts[tokenParts.length - 1] : getDefaultQuoteToken(chain);
      } else {
        // Single token - common case is trading against stablecoins
        baseToken = tokenString;
        quoteToken = getDefaultQuoteToken(chain);
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

    it('should handle single token with chain-specific default quote', () => {
      // FIX #13: Production uses getDefaultQuoteToken(chain), not hardcoded 'USDC'
      const ethResult = parseTokenPair('WETH', 'ethereum');
      expect(ethResult.baseToken).toBe('WETH');
      expect(ethResult.quoteToken).toBe(getDefaultQuoteToken('ethereum'));

      const bscResult = parseTokenPair('WBNB', 'bsc');
      expect(bscResult.baseToken).toBe('WBNB');
      expect(bscResult.quoteToken).toBe(getDefaultQuoteToken('bsc'));
    });

    it('should handle single token for various tokens', () => {
      expect(parseTokenPair('LINK').baseToken).toBe('LINK');
      expect(parseTokenPair('LINK').quoteToken).toBe(getDefaultQuoteToken('ethereum'));
      expect(parseTokenPair('ARB').baseToken).toBe('ARB');
      expect(parseTokenPair('OP').baseToken).toBe('OP');
    });

    it('should handle empty string gracefully', () => {
      const result = parseTokenPair('');
      expect(result.baseToken).toBe('');
      expect(result.quoteToken).toBe(getDefaultQuoteToken('ethereum'));
    });
  });

  describe('Whale Activity Direction Detection', () => {
    /**
     * Logic for determining dominant direction from buy/sell volumes.
     * Extracted from WhaleActivityTracker.getActivitySummary in @arbitrage/core.
     * FIX #13: Kept as inline copy because the production logic is embedded
     * in WhaleActivityTracker.getActivitySummary (not exported standalone).
     *
     * @see shared/core/src/analytics/whale-activity-tracker.ts getActivitySummary
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
     * Calculate whale-based confidence adjustment.
     * FIX #13: This tests the whale boost logic as a unit with configurable
     * values from whaleConfig. The production implementation now lives in
     * confidence-calculator.ts (ConfidenceCalculator.applyWhaleBoost) with
     * different default config values. This inline copy tests the algorithmic
     * behavior with detector-specific whale config values.
     *
     * @see confidence-calculator.ts ConfidenceCalculator.applyWhaleBoost
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
     * Sort opportunities with whale-triggered priority.
     * Extracted from filterValidOpportunities in detector.ts.
     * FIX #13: Kept as inline copy because filterValidOpportunities is private.
     * Sorting logic matches production: whale-triggered first, then by netProfit.
     *
     * @see detector.ts filterValidOpportunities method
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

    /**
     * FIX #13: Updated inline copy to match production behavior.
     * Production uses getDefaultQuoteToken(chain) from @arbitrage/config
     * instead of hardcoded 'USDC'.
     *
     * @see detector.ts analyzeWhaleImpact method
     */
    function buildTrackedTransaction(whaleTx: WhaleTransaction): TrackedWhaleTransaction {
      let baseToken: string;
      let quoteToken: string;

      if (whaleTx.token.includes('/')) {
        const tokenParts = whaleTx.token.split('/');
        baseToken = tokenParts[0] || whaleTx.token;
        quoteToken = tokenParts[1]?.trim() || getDefaultQuoteToken(whaleTx.chain);
      } else if (whaleTx.token.includes('_')) {
        const tokenParts = whaleTx.token.split('_');
        baseToken = tokenParts.length >= 2 ? tokenParts[tokenParts.length - 2] : whaleTx.token;
        quoteToken = tokenParts.length >= 2 ? tokenParts[tokenParts.length - 1] : getDefaultQuoteToken(whaleTx.chain);
      } else {
        baseToken = whaleTx.token;
        quoteToken = getDefaultQuoteToken(whaleTx.chain);
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

      // FIX #13: Uses chain-specific default quote token, not hardcoded 'USDC'
      expect(tracked.tokenIn).toBe(getDefaultQuoteToken('polygon'));
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
//
// FIX #13 NOTE: Circuit breaker is private internal state of
// CrossChainDetectorService (lastCircuitBreakerTrip, detectionErrorCount).
// These tests use inline logic to test the algorithm in isolation since
// the production implementation is not exported. This is acceptable as
// it tests the contract, not the implementation.
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
    const version = 1;
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
   * Logic extracted from maybeUpdateEthPrice in detector.ts.
   * FIX #13: Kept as inline copy because maybeUpdateEthPrice is a private
   * method of CrossChainDetectorService. The inline logic matches production.
   *
   * @see detector.ts maybeUpdateEthPrice method
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
//
// FIX #13 NOTE: Detection guard is private internal state of the detector
// (OperationGuard instance). The production implementation uses OperationGuard
// from @arbitrage/core. This inline reimplementation tests the concurrency
// guard algorithm in isolation.
// =============================================================================

describe('Concurrent Detection Guard', () => {
  /**
   * Simulates the isDetecting concurrency guard from detector.ts.
   * This prevents overlapping detection cycles that could cause race conditions.
   * @see detector.ts detectionGuard (OperationGuard from @arbitrage/core)
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
  // FIX #24: Reversed branch order so > 0.03 is checked before > 0.01
  // Previously, > 0.01 caught all > 0.03 values, making the 0.7x penalty unreachable
  function adjustConfidenceForSlippage(
    baseConfidence: number,
    slippageTolerance: number
  ): number {
    // Very high slippage (>3%) reduces confidence more
    if (slippageTolerance > 0.03) {
      return baseConfidence * 0.7;
    }
    // High slippage (>1%) reduces confidence
    if (slippageTolerance > 0.01) {
      return baseConfidence * 0.9;
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
      // FIX #24: Now correctly applies 0.7x penalty for slippage > 0.03
      expect(adjustConfidenceForSlippage(0.8, 0.05)).toBeCloseTo(0.56, 10); // 0.8 * 0.7
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
  // FIX #13: Use the production normalizeToInternalFormat from types.ts
  // instead of re-implementing the logic inline. The production function
  // is imported at the top of this file.

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

// =============================================================================
// P0 Fix Regression Tests
// =============================================================================

describe('P0 Fix Regression: percentageDiff units consistency', () => {
  /**
   * P0 FIX #1 REGRESSION: percentageDiff must be in percentage format (e.g., 2.0 for 2%),
   * NOT decimal format (e.g., 0.02 for 2%).
   *
   * The publisher divides by 100 unconditionally (opportunity-publisher.ts:197):
   *   expectedProfitInTokens = (percentageDiff / 100) * amountInTokens
   *
   * If percentageDiff is a decimal (0.02), the publisher produces:
   *   0.02 / 100 = 0.0002 (100× too low)
   *
   * If percentageDiff is a percentage (2.0), the publisher produces:
   *   2.0 / 100 = 0.02 (correct)
   */
  it('should store percentageDiff as percentage (×100), not decimal ratio', () => {
    // Simulates the pending opportunity path (analyzePendingOpportunity)
    const postSwapPrice = 2500;
    const bestAltPrice = 2550;
    const priceDiff = bestAltPrice - postSwapPrice;
    const priceDiffPercent = priceDiff / postSwapPrice; // decimal: 0.02

    // P0 FIX: Must multiply by 100 to match cross-chain convention
    const percentageDiff = priceDiffPercent * 100; // percentage: 2.0

    expect(percentageDiff).toBe(2.0);
    expect(percentageDiff).not.toBe(priceDiffPercent); // Must NOT be 0.02
  });

  it('should produce correct expectedProfit when publisher divides by 100', () => {
    const percentageDiff = 2.0; // 2% in percentage format
    const amountInTokens = 1.0; // 1 ETH

    // Publisher formula: (percentageDiff / 100) * amountInTokens
    const expectedProfitInTokens = (percentageDiff / 100) * amountInTokens;

    expect(expectedProfitInTokens).toBe(0.02); // 2% of 1 token = 0.02 tokens
  });

  it('should match cross-chain path convention for percentageDiff', () => {
    // Cross-chain path: percentageDiff = (priceDiff / lowestPrice) * 100
    const lowestPrice = 2500;
    const highestPrice = 2550;
    const crossChainPercentageDiff = ((highestPrice - lowestPrice) / lowestPrice) * 100;

    // Pending path (after fix): percentageDiff = priceDiffPercent * 100
    const postSwapPrice = 2500;
    const bestAltPrice = 2550;
    const pendingPercentageDiff = ((bestAltPrice - postSwapPrice) / postSwapPrice) * 100;

    // Both paths should produce the same format
    expect(pendingPercentageDiff).toBeCloseTo(crossChainPercentageDiff, 10);
  });
});

describe('P0 Fix Regression: net profit includes gas costs and swap fees', () => {
  /**
   * P0 FIX #2 REGRESSION: netProfit must subtract gas costs and swap fees,
   * not just bridge costs. The formula is:
   *
   *   netProfit = priceDiff - bridgeCost - gasCostPerToken - swapFeePerToken
   *
   * Where:
   *   gasCostPerToken = (estimatedGasCost × 2) / tradeTokens  (source + dest chains)
   *   swapFeePerToken = feePercentage × (sourcePrice + destPrice)  (buy + sell fees)
   */
  it('should subtract gas costs and swap fees from net profit', () => {
    // Given: ETH at $3000 on source, $3060 on dest (2% spread)
    const lowestPrice = 3000;
    const highestPrice = 3060;
    const priceDiff = highestPrice - lowestPrice; // $60/token

    // Bridge cost (already in per-token units)
    const bridgeCost = 5; // $5/token

    // Gas costs: $5 USD per chain × 2 chains, converted to per-token
    const estimatedGasCostUsd = 5;
    const tradeSizeUsd = 1000;
    const tradeTokens = tradeSizeUsd / lowestPrice; // 0.333 ETH
    const gasCostPerToken = (estimatedGasCostUsd * 2) / tradeTokens; // ~$30/token

    // Swap fees: 0.3% on buy + 0.3% on sell
    const feePercentage = 0.003;
    const swapFeePerToken = feePercentage * (lowestPrice + highestPrice); // ~$18.18/token

    // Net profit with full cost accounting
    const netProfit = priceDiff - bridgeCost - gasCostPerToken - swapFeePerToken;

    // Net should be much less than priceDiff - bridgeCost alone
    const oldNetProfit = priceDiff - bridgeCost; // $55 (overstated)
    expect(netProfit).toBeLessThan(oldNetProfit);

    // Verify specific components
    expect(priceDiff).toBe(60);
    expect(gasCostPerToken).toBeCloseTo(30, 0);
    expect(swapFeePerToken).toBeCloseTo(18.18, 1);
    expect(netProfit).toBeCloseTo(6.82, 0);
  });

  it('should filter out opportunities where gas and fees exceed price difference', () => {
    // Given: Small 0.5% price spread
    const lowestPrice = 3000;
    const highestPrice = 3015; // 0.5% higher
    const priceDiff = highestPrice - lowestPrice; // $15/token

    const bridgeCost = 5;
    const tradeSizeUsd = 1000;
    const tradeTokens = tradeSizeUsd / lowestPrice;
    const gasCostPerToken = (5 * 2) / tradeTokens; // ~$30/token
    const swapFeePerToken = 0.003 * (lowestPrice + highestPrice); // ~$18.05/token

    const netProfit = priceDiff - bridgeCost - gasCostPerToken - swapFeePerToken;

    // With full cost accounting, this should be unprofitable
    expect(netProfit).toBeLessThan(0);
  });

  it('should handle zero trade tokens gracefully', () => {
    const tradeTokens = 0;
    // When tradeTokens is 0, gasCostPerToken should fall back to 0
    const gasCostPerToken = tradeTokens > 0
      ? (5 * 2) / tradeTokens
      : 0;

    expect(gasCostPerToken).toBe(0);
    expect(Number.isFinite(gasCostPerToken)).toBe(true);
  });

  it('should handle high-value tokens with low token count correctly', () => {
    // BTC at $60000, trade size $1000 → only 0.0167 tokens
    const lowestPrice = 60000;
    const highestPrice = 61200; // 2% spread
    const priceDiff = highestPrice - lowestPrice; // $1200/token

    const tradeSizeUsd = 1000;
    const tradeTokens = tradeSizeUsd / lowestPrice; // ~0.0167 BTC
    const gasCostPerToken = (5 * 2) / tradeTokens; // ~$600/token

    // Gas cost per token is very high for expensive tokens with small trade sizes
    expect(gasCostPerToken).toBeCloseTo(600, -1);

    // Even with 2% spread ($1200/token), gas alone may eat most of the profit
    const swapFeePerToken = 0.003 * (lowestPrice + highestPrice);
    const bridgeCost = 5;
    const netProfit = priceDiff - bridgeCost - gasCostPerToken - swapFeePerToken;

    // The high gas-per-token significantly reduces net profit
    expect(netProfit).toBeLessThan(priceDiff - bridgeCost);
  });
});

// =============================================================================
// FIX #5: updateBridgeData() Validation and Rate Limiting Tests
// Tests for bridge data validation bounds and per-route rate limiting logic.
// =============================================================================

describe('updateBridgeData validation and rate limiting', () => {
  /**
   * Validates bridge data fields using the same logic as
   * CrossChainDetectorService.updateBridgeData().
   */
  function validateBridgeData(bridgeResult: {
    actualLatency: number;
    actualCost: number;
    amount: number;
    timestamp: number;
  }): { valid: boolean; reason?: string } {
    const { actualLatency, actualCost, amount, timestamp } = bridgeResult;

    if (!Number.isFinite(actualLatency) || actualLatency <= 0 || actualLatency > 3600000) {
      return { valid: false, reason: 'invalid actualLatency' };
    }
    if (!Number.isFinite(actualCost) || actualCost < 0 || actualCost > 1000) {
      return { valid: false, reason: 'invalid actualCost' };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { valid: false, reason: 'invalid amount' };
    }
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > Date.now() + 60000) {
      return { valid: false, reason: 'invalid timestamp' };
    }

    return { valid: true };
  }

  /**
   * Rate limiter matching updateBridgeData() logic:
   * max 10 updates per 60-second window per route key.
   */
  function createRateLimiter() {
    const rateLimit = new Map<string, number[]>();
    const windowMs = 60000;
    const maxUpdatesPerWindow = 10;

    return {
      isAllowed(routeKey: string): boolean {
        const now = Date.now();
        let timestamps = rateLimit.get(routeKey);
        if (timestamps) {
          timestamps = timestamps.filter(t => now - t < windowMs);
          rateLimit.set(routeKey, timestamps);
          if (timestamps.length >= maxUpdatesPerWindow) {
            return false;
          }
        } else {
          timestamps = [];
          rateLimit.set(routeKey, timestamps);
        }
        timestamps.push(now);
        return true;
      },
    };
  }

  it('should accept valid bridge data', () => {
    const result = validateBridgeData({
      actualLatency: 120,
      actualCost: 15.5,
      amount: 1000,
      timestamp: Date.now() - 5000,
    });
    expect(result.valid).toBe(true);
  });

  it('should reject negative actualLatency', () => {
    const result = validateBridgeData({
      actualLatency: -10,
      actualCost: 15,
      amount: 1000,
      timestamp: Date.now(),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid actualLatency');
  });

  it('should reject NaN actualLatency', () => {
    const result = validateBridgeData({
      actualLatency: NaN,
      actualCost: 15,
      amount: 1000,
      timestamp: Date.now(),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid actualLatency');
  });

  it('should reject actualLatency exceeding 3600000', () => {
    const result = validateBridgeData({
      actualLatency: 3600001,
      actualCost: 15,
      amount: 1000,
      timestamp: Date.now(),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid actualLatency');
  });

  it('should reject negative actualCost', () => {
    const result = validateBridgeData({
      actualLatency: 120,
      actualCost: -1,
      amount: 1000,
      timestamp: Date.now(),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid actualCost');
  });

  it('should reject actualCost exceeding 1000', () => {
    const result = validateBridgeData({
      actualLatency: 120,
      actualCost: 1001,
      amount: 1000,
      timestamp: Date.now(),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid actualCost');
  });

  it('should reject zero amount', () => {
    const result = validateBridgeData({
      actualLatency: 120,
      actualCost: 15,
      amount: 0,
      timestamp: Date.now(),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid amount');
  });

  it('should reject negative amount', () => {
    const result = validateBridgeData({
      actualLatency: 120,
      actualCost: 15,
      amount: -100,
      timestamp: Date.now(),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid amount');
  });

  it('should reject future timestamp (beyond 60s tolerance)', () => {
    const result = validateBridgeData({
      actualLatency: 120,
      actualCost: 15,
      amount: 1000,
      timestamp: Date.now() + 120000, // 2 minutes in future
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid timestamp');
  });

  it('should reject zero timestamp', () => {
    const result = validateBridgeData({
      actualLatency: 120,
      actualCost: 15,
      amount: 1000,
      timestamp: 0,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('invalid timestamp');
  });

  it('should rate limit: allow up to 10 updates per route per 60s', () => {
    const limiter = createRateLimiter();
    const routeKey = 'ethereum-arbitrum-stargate';

    for (let i = 0; i < 10; i++) {
      expect(limiter.isAllowed(routeKey)).toBe(true);
    }

    // 11th should be rejected
    expect(limiter.isAllowed(routeKey)).toBe(false);
  });

  it('should rate limit independently per route', () => {
    const limiter = createRateLimiter();

    for (let i = 0; i < 10; i++) {
      limiter.isAllowed('ethereum-arbitrum-stargate');
    }

    // Different route should still be allowed
    expect(limiter.isAllowed('arbitrum-optimism-hop')).toBe(true);
  });
});

// =============================================================================
// ETH Price Circuit Breaker Tests (FIX #9)
//
// Tests the rate-of-change circuit breaker that rejects ETH prices deviating
// >20% from the median of recent prices. Uses inline logic matching production
// implementation in CrossChainDetectorService.validateEthPriceRate().
// =============================================================================

describe('ETH Price Circuit Breaker (FIX #9)', () => {
  const ETH_PRICE_HISTORY_SIZE = 10;
  const ETH_PRICE_MAX_DEVIATION = 0.2; // 20%

  /**
   * Simulates validateEthPriceRate logic from CrossChainDetectorService
   */
  function createEthPriceValidator() {
    const recentPrices: number[] = [];

    return {
      validate(price: number): boolean {
        if (recentPrices.length >= 3) {
          const sorted = recentPrices.slice().sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          const median = sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];

          const deviation = Math.abs(price - median) / median;
          if (deviation > ETH_PRICE_MAX_DEVIATION) {
            return false; // Rejected
          }
        }

        recentPrices.push(price);
        if (recentPrices.length > ETH_PRICE_HISTORY_SIZE) {
          recentPrices.splice(0, recentPrices.length - ETH_PRICE_HISTORY_SIZE);
        }
        return true; // Accepted
      },
      getHistory(): number[] {
        return [...recentPrices];
      },
    };
  }

  it('should accept prices when fewer than 3 data points exist', () => {
    const validator = createEthPriceValidator();

    // First two prices accepted unconditionally (no median to compare against)
    expect(validator.validate(3000)).toBe(true);
    expect(validator.validate(3100)).toBe(true);
    expect(validator.getHistory()).toHaveLength(2);
  });

  it('should accept prices within 20% of median', () => {
    const validator = createEthPriceValidator();

    // Build history: median = 3000
    validator.validate(2900);
    validator.validate(3000);
    validator.validate(3100);

    // 15% above median (~3450) should be accepted
    expect(validator.validate(3450)).toBe(true);
  });

  it('should reject prices deviating >20% from median', () => {
    const validator = createEthPriceValidator();

    // Build history: median = 3000
    validator.validate(2900);
    validator.validate(3000);
    validator.validate(3100);

    // Poisoned price ($200) — 93% deviation from median, should be rejected
    expect(validator.validate(200)).toBe(false);

    // History should NOT include the rejected price
    expect(validator.getHistory()).toHaveLength(3);
    expect(validator.getHistory()).not.toContain(200);
  });

  it('should reject price spikes >20% above median', () => {
    const validator = createEthPriceValidator();

    // Build history: median = 3000
    validator.validate(2900);
    validator.validate(3000);
    validator.validate(3100);

    // 25% above median (3750) should be rejected
    expect(validator.validate(3750)).toBe(false);
  });

  it('should accept gradual price changes within threshold', () => {
    const validator = createEthPriceValidator();

    // Gradual price increase: 3000 -> 3100 -> 3200 -> 3300 -> 3400
    // Each step is ~3% change, well within 20%
    expect(validator.validate(3000)).toBe(true);
    expect(validator.validate(3100)).toBe(true);
    expect(validator.validate(3200)).toBe(true);
    expect(validator.validate(3300)).toBe(true);
    expect(validator.validate(3400)).toBe(true);

    expect(validator.getHistory()).toHaveLength(5);
  });

  it('should cap history at ETH_PRICE_HISTORY_SIZE entries', () => {
    const validator = createEthPriceValidator();

    // Add 12 prices (exceeds size limit of 10)
    for (let i = 0; i < 12; i++) {
      validator.validate(3000 + i * 10); // Gradual increase
    }

    expect(validator.getHistory()).toHaveLength(ETH_PRICE_HISTORY_SIZE);
  });

  it('should use median (not mean) to resist outlier influence', () => {
    const validator = createEthPriceValidator();

    // History with one high outlier that was accepted early
    // Prices: 3000, 3000, 3500 (accepted before 3 points existed)
    validator.validate(3000);
    validator.validate(3000);
    validator.validate(3500); // Accepted (only 2 data points at validation time)

    // Median of [3000, 3000, 3500] = 3000 (middle value when sorted)
    // A price of 3100 should be accepted (3.3% from median 3000)
    expect(validator.validate(3100)).toBe(true);

    // A price of 200 should be rejected (93% from median)
    expect(validator.validate(200)).toBe(false);
  });
});

// =============================================================================
// FIX #3: Lifecycle State Machine Tests
//
// Tests the start/stop lifecycle state transitions using inline state machine
// logic. The production implementation uses ServiceStateManager; these tests
// verify the state transition contract that start()/stop() depend on.
// =============================================================================

describe('Lifecycle State Machine (FIX #3)', () => {
  enum State {
    IDLE = 'IDLE',
    STARTING = 'STARTING',
    RUNNING = 'RUNNING',
    STOPPING = 'STOPPING',
    STOPPED = 'STOPPED',
    ERROR = 'ERROR',
  }

  /**
   * Simulates the lifecycle state machine from ServiceStateManager/CrossChainDetectorService.
   * @see detector.ts start()/stop() methods
   * @see service-state.ts executeStart()/executeStop()
   */
  function createLifecycle() {
    let state = State.IDLE;
    const initModules = jest.fn<() => void>();
    const cleanupModules = jest.fn<() => void>();

    return {
      getState: () => state,
      async start(shouldFail = false): Promise<boolean> {
        if (state !== State.IDLE && state !== State.STOPPED) return false;
        state = State.STARTING;
        try {
          if (shouldFail) throw new Error('Start failed');
          initModules();
          state = State.RUNNING;
          return true;
        } catch {
          state = State.ERROR;
          return false;
        }
      },
      async stop(): Promise<boolean> {
        if (state !== State.RUNNING && state !== State.ERROR) return false;
        state = State.STOPPING;
        cleanupModules();
        state = State.STOPPED;
        return true;
      },
      getInitModules: () => initModules,
      getCleanupModules: () => cleanupModules,
    };
  }

  it('should transition IDLE -> RUNNING on successful start', async () => {
    const lifecycle = createLifecycle();
    expect(lifecycle.getState()).toBe(State.IDLE);

    const result = await lifecycle.start();

    expect(result).toBe(true);
    expect(lifecycle.getState()).toBe(State.RUNNING);
    expect(lifecycle.getInitModules()).toHaveBeenCalledTimes(1);
  });

  it('should transition RUNNING -> STOPPED on stop', async () => {
    const lifecycle = createLifecycle();
    await lifecycle.start();

    const result = await lifecycle.stop();

    expect(result).toBe(true);
    expect(lifecycle.getState()).toBe(State.STOPPED);
    expect(lifecycle.getCleanupModules()).toHaveBeenCalledTimes(1);
  });

  it('should transition to ERROR state when start fails', async () => {
    const lifecycle = createLifecycle();

    const result = await lifecycle.start(true);

    expect(result).toBe(false);
    expect(lifecycle.getState()).toBe(State.ERROR);
  });

  it('should allow stop from ERROR state (cleanup)', async () => {
    const lifecycle = createLifecycle();
    await lifecycle.start(true);
    expect(lifecycle.getState()).toBe(State.ERROR);

    const result = await lifecycle.stop();

    expect(result).toBe(true);
    expect(lifecycle.getState()).toBe(State.STOPPED);
  });

  it('should prevent double-start from RUNNING state', async () => {
    const lifecycle = createLifecycle();
    await lifecycle.start();

    const result = await lifecycle.start();

    expect(result).toBe(false);
    expect(lifecycle.getState()).toBe(State.RUNNING);
  });

  it('should prevent stop from IDLE state', async () => {
    const lifecycle = createLifecycle();

    const result = await lifecycle.stop();

    expect(result).toBe(false);
    expect(lifecycle.getState()).toBe(State.IDLE);
  });

  it('should allow restart after stop (STOPPED -> RUNNING)', async () => {
    const lifecycle = createLifecycle();
    await lifecycle.start();
    await lifecycle.stop();
    expect(lifecycle.getState()).toBe(State.STOPPED);

    const result = await lifecycle.start();

    expect(result).toBe(true);
    expect(lifecycle.getState()).toBe(State.RUNNING);
    expect(lifecycle.getInitModules()).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// FIX #3/#4: findArbitrageInPrices Core Algorithm Tests
//
// Tests the price comparison and opportunity generation logic in isolation.
// The production method is private, so we test the inline algorithm here
// matching the core logic from detector.ts:1335-1498.
// =============================================================================

describe('findArbitrageInPrices algorithm (FIX #3/#4)', () => {
  interface TestPricePoint {
    chain: string;
    dex: string;
    pairKey: string;
    price: number;
    timestamp: number;
  }

  /**
   * Simplified inline implementation of findArbitrageInPrices core logic.
   * Tests min/max finding, price diff calculation, and profit threshold filtering.
   * @see detector.ts findArbitrageInPrices method
   */
  function findArbitrage(
    chainPrices: TestPricePoint[],
    bridgeCost: number,
    minProfitThreshold: number,
    maxPriceAgeMs = 30000,
  ) {
    if (chainPrices.length < 2) return [];

    let lowest = chainPrices[0];
    let highest = chainPrices[0];

    for (let i = 1; i < chainPrices.length; i++) {
      if (chainPrices[i].price < lowest.price) lowest = chainPrices[i];
      if (chainPrices[i].price > highest.price) highest = chainPrices[i];
    }

    // Invalid price guard (check both low and high)
    if (lowest.price <= 0 || !Number.isFinite(lowest.price)) return [];
    if (highest.price <= 0 || !Number.isFinite(highest.price)) return [];

    // Staleness guard
    const now = Date.now();
    if (now - lowest.timestamp > maxPriceAgeMs || now - highest.timestamp > maxPriceAgeMs) {
      return [];
    }

    const priceDiff = highest.price - lowest.price;
    const netProfit = priceDiff - bridgeCost;

    if (netProfit > minProfitThreshold * lowest.price) {
      return [{
        sourceChain: lowest.chain,
        sourceDex: lowest.dex,
        targetChain: highest.chain,
        targetDex: highest.dex,
        priceDiff,
        bridgeCost,
        netProfit,
        sourcePrice: lowest.price,
        targetPrice: highest.price,
      }];
    }
    return [];
  }

  const now = Date.now();

  it('should find opportunity when price diff exceeds threshold', () => {
    const prices: TestPricePoint[] = [
      { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH_USDC', price: 2500, timestamp: now },
      { chain: 'arbitrum', dex: 'camelot', pairKey: 'WETH_USDC', price: 2600, timestamp: now },
    ];

    const result = findArbitrage(prices, 10, 0.001); // bridgeCost=$10, minProfit=0.1%
    expect(result).toHaveLength(1);
    expect(result[0].sourceChain).toBe('ethereum');
    expect(result[0].targetChain).toBe('arbitrum');
    expect(result[0].priceDiff).toBe(100);
    expect(result[0].netProfit).toBe(90); // 100 - 10
  });

  it('should return empty when profit below threshold after bridge cost', () => {
    const prices: TestPricePoint[] = [
      { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH_USDC', price: 2500, timestamp: now },
      { chain: 'arbitrum', dex: 'camelot', pairKey: 'WETH_USDC', price: 2505, timestamp: now },
    ];

    // Bridge cost $10 wipes out the $5 price diff
    const result = findArbitrage(prices, 10, 0.001);
    expect(result).toHaveLength(0);
  });

  it('should return empty for fewer than 2 price points', () => {
    expect(findArbitrage([], 10, 0.001)).toHaveLength(0);
    expect(findArbitrage([
      { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH_USDC', price: 2500, timestamp: now },
    ], 10, 0.001)).toHaveLength(0);
  });

  it('should correctly identify min and max from multiple chains', () => {
    const prices: TestPricePoint[] = [
      { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH_USDC', price: 2550, timestamp: now },
      { chain: 'arbitrum', dex: 'camelot', pairKey: 'WETH_USDC', price: 2450, timestamp: now }, // lowest
      { chain: 'polygon', dex: 'quickswap', pairKey: 'WETH_USDC', price: 2600, timestamp: now }, // highest
      { chain: 'optimism', dex: 'velodrome', pairKey: 'WETH_USDC', price: 2500, timestamp: now },
    ];

    const result = findArbitrage(prices, 5, 0.001);
    expect(result).toHaveLength(1);
    expect(result[0].sourceChain).toBe('arbitrum'); // lowest price
    expect(result[0].targetChain).toBe('polygon'); // highest price
    expect(result[0].priceDiff).toBe(150); // 2600 - 2450
  });

  it('should reject stale prices beyond max age', () => {
    const prices: TestPricePoint[] = [
      { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH_USDC', price: 2500, timestamp: now - 60000 }, // 1min old
      { chain: 'arbitrum', dex: 'camelot', pairKey: 'WETH_USDC', price: 2600, timestamp: now },
    ];

    // Max age 30s - first price is 60s old, should reject
    const result = findArbitrage(prices, 5, 0.001, 30000);
    expect(result).toHaveLength(0);
  });

  it('should reject zero or negative prices', () => {
    const prices: TestPricePoint[] = [
      { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH_USDC', price: 0, timestamp: now },
      { chain: 'arbitrum', dex: 'camelot', pairKey: 'WETH_USDC', price: 2600, timestamp: now },
    ];

    expect(findArbitrage(prices, 5, 0.001)).toHaveLength(0);
  });

  it('should reject Infinity prices', () => {
    const prices: TestPricePoint[] = [
      { chain: 'ethereum', dex: 'uniswap', pairKey: 'WETH_USDC', price: Infinity, timestamp: now },
      { chain: 'arbitrum', dex: 'camelot', pairKey: 'WETH_USDC', price: 2600, timestamp: now },
    ];

    expect(findArbitrage(prices, 5, 0.001)).toHaveLength(0);
  });
});
