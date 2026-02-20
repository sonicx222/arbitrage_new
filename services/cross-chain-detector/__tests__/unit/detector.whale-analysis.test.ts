/**
 * Cross-Chain Detector - Whale Impact Analysis Tests
 *
 * Split from detector.test.ts for maintainability.
 * Tests whale impact analysis including:
 * - Token parsing from whale transactions
 * - Whale activity direction detection
 * - Super whale detection
 * - Whale confidence boosting
 * - Opportunity sorting with whale priority
 * - TrackedWhaleTransaction construction
 *
 * @see IMPLEMENTATION_PLAN.md S3
 * @see detector.test.ts for core config, logic, price matrix tests
 */

import { describe, it, expect } from '@jest/globals';

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

import { getDefaultQuoteToken } from '@arbitrage/config';

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
