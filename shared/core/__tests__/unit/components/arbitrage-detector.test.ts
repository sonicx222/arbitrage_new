/**
 * Unit Tests for ArbitrageDetector
 *
 * Tests pure functions for arbitrage detection logic.
 * These tests verify the canonical detection formulas used across all detectors.
 */

import {
  detectArbitrage,
  detectArbitrageForTokenPair,
  calculateArbitrageProfit,
  isReverseTokenOrder,
  normalizeTokenOrder,
  adjustPriceForTokenOrder,
  isValidPairSnapshot,
  validateDetectionInput,
  type ArbitrageDetectionInput,
} from '../../../src/components/arbitrage-detector';

import { getTokenPairKey } from '../../../src/components/token-utils';

import type { PairSnapshot } from '../../../src/components/pair-repository';

describe('ArbitrageDetector', () => {
  // Test fixtures
  const basePairSnapshot: PairSnapshot = {
    address: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
    dex: 'uniswapv2',
    token0: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    reserve0: '1000000000000000000000', // 1000 ETH
    reserve1: '3500000000000', // 3500000 USDC
    fee: 0.003,
    blockNumber: 12345678,
  };

  const baseChainConfig = {
    gasEstimate: '200000',
    confidence: 0.85,
    expiryMs: 30000,
  };

  // ===========================================================================
  // detectArbitrage
  // ===========================================================================
  describe('detectArbitrage', () => {
    it('should detect profitable arbitrage opportunity', () => {
      // Second pair with higher price (1% spread)
      const pair2: PairSnapshot = {
        ...basePairSnapshot,
        address: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000', // 1000 ETH
        reserve1: '3465000000000', // 3465000 USDC (price is ~1% higher)
      };

      const input: ArbitrageDetectionInput = {
        pair1: basePairSnapshot,
        pair2,
        minProfitThreshold: 0.003, // 0.3%
        chainConfig: baseChainConfig,
        timestamp: Date.now(),
      };

      const result = detectArbitrage(input);

      expect(result.found).toBe(true);
      expect(result.opportunity).toBeDefined();
      expect(result.opportunity!.profitPercentage).toBeGreaterThan(0);
      expect(result.opportunity!.buyDex).toBeDefined();
      expect(result.opportunity!.sellDex).toBeDefined();
    });

    it('should not detect opportunity below threshold', () => {
      // Second pair with small spread (0.2%)
      const pair2: PairSnapshot = {
        ...basePairSnapshot,
        address: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000',
        reserve1: '3493000000000', // ~0.2% price difference
      };

      const input: ArbitrageDetectionInput = {
        pair1: basePairSnapshot,
        pair2,
        minProfitThreshold: 0.005, // 0.5% threshold
        chainConfig: baseChainConfig,
        timestamp: Date.now(),
      };

      const result = detectArbitrage(input);

      expect(result.found).toBe(false);
      expect(result.reason).toContain('below threshold');
    });

    it('should return invalid for zero reserves', () => {
      const pair2: PairSnapshot = {
        ...basePairSnapshot,
        address: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
        reserve0: '0',
        reserve1: '3500000000000',
      };

      const input: ArbitrageDetectionInput = {
        pair1: basePairSnapshot,
        pair2,
        minProfitThreshold: 0.003,
        chainConfig: baseChainConfig,
      };

      const result = detectArbitrage(input);

      expect(result.found).toBe(false);
      expect(result.reason).toContain('Invalid');
    });

    it('should handle reversed token order', () => {
      // Pair with reversed token order
      const pair2: PairSnapshot = {
        ...basePairSnapshot,
        address: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
        dex: 'sushiswap',
        token0: basePairSnapshot.token1, // USDC first
        token1: basePairSnapshot.token0, // WETH second
        reserve0: '3465000000000', // USDC reserve
        reserve1: '1000000000000000000000', // WETH reserve
      };

      const input: ArbitrageDetectionInput = {
        pair1: basePairSnapshot,
        pair2,
        minProfitThreshold: 0.003,
        chainConfig: baseChainConfig,
        timestamp: Date.now(),
      };

      const result = detectArbitrage(input);

      // Should still detect opportunity with correct price adjustment
      expect(result.found).toBe(true);
      expect(result.calculations).toBeDefined();
      expect(result.calculations!.price2Adjusted).not.toBe(result.calculations!.price2);
    });

    it('should include calculation details in result', () => {
      const pair2: PairSnapshot = {
        ...basePairSnapshot,
        address: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000',
        reserve1: '3465000000000',
      };

      const input: ArbitrageDetectionInput = {
        pair1: basePairSnapshot,
        pair2,
        minProfitThreshold: 0.003,
        chainConfig: baseChainConfig,
        timestamp: Date.now(),
      };

      const result = detectArbitrage(input);

      expect(result.calculations).toBeDefined();
      expect(result.calculations!.price1).toBeGreaterThan(0);
      expect(result.calculations!.price2).toBeGreaterThan(0);
      expect(result.calculations!.grossSpread).toBeGreaterThan(0);
      expect(result.calculations!.totalFees).toBeGreaterThan(0);
    });

    it('should correctly identify buy/sell direction', () => {
      // pair1 has lower price (should buy here)
      // pair2 has higher price (should sell here)
      const pair2: PairSnapshot = {
        ...basePairSnapshot,
        address: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
        dex: 'sushiswap',
        reserve0: '1000000000000000000000',
        reserve1: '3465000000000', // Higher WETH price
      };

      const input: ArbitrageDetectionInput = {
        pair1: basePairSnapshot,
        pair2,
        minProfitThreshold: 0.003,
        chainConfig: baseChainConfig,
        timestamp: Date.now(),
      };

      const result = detectArbitrage(input);

      expect(result.found).toBe(true);
      expect(result.opportunity!.buyPrice).toBeLessThan(result.opportunity!.sellPrice);
    });
  });

  // ===========================================================================
  // detectArbitrageForTokenPair
  // ===========================================================================
  describe('detectArbitrageForTokenPair', () => {
    it('should detect opportunities across multiple pairs', () => {
      const pairs: PairSnapshot[] = [
        basePairSnapshot,
        {
          ...basePairSnapshot,
          address: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
          dex: 'sushiswap',
          reserve1: '3465000000000', // 1% higher price
        },
        {
          ...basePairSnapshot,
          address: '0x0d4a11d5EEaaC28EC3F61d100daF4d40471f1852',
          dex: 'curve',
          reserve1: '3535000000000', // 1% lower price
        },
      ];

      const opportunities = detectArbitrageForTokenPair(pairs, {
        minProfitThreshold: 0.003,
        chainConfig: baseChainConfig,
        chain: 'ethereum',
      });

      expect(opportunities.length).toBeGreaterThan(0);
      // Should be sorted by profit
      for (let i = 1; i < opportunities.length; i++) {
        expect(opportunities[i - 1].expectedProfit).toBeGreaterThanOrEqual(
          opportunities[i].expectedProfit
        );
      }
    });

    it('should return empty array for single pair', () => {
      const opportunities = detectArbitrageForTokenPair([basePairSnapshot], {
        minProfitThreshold: 0.003,
        chainConfig: baseChainConfig,
        chain: 'ethereum',
      });

      expect(opportunities).toEqual([]);
    });

    it('should respect maxOpportunities limit', () => {
      const pairs: PairSnapshot[] = Array(10)
        .fill(null)
        .map((_, i) => ({
          ...basePairSnapshot,
          address: `0x${i.toString(16).padStart(40, '0')}`,
          dex: `dex${i}`,
          reserve1: `${3500000000000 - i * 35000000000}`, // Varying prices
        }));

      const opportunities = detectArbitrageForTokenPair(pairs, {
        minProfitThreshold: 0.001, // Low threshold
        chainConfig: baseChainConfig,
        chain: 'ethereum',
        maxOpportunities: 5,
      });

      expect(opportunities.length).toBeLessThanOrEqual(5);
    });

    it('should set chain from options', () => {
      const pairs: PairSnapshot[] = [
        basePairSnapshot,
        {
          ...basePairSnapshot,
          address: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
          dex: 'sushiswap',
          reserve1: '3465000000000',
        },
      ];

      const opportunities = detectArbitrageForTokenPair(pairs, {
        minProfitThreshold: 0.003,
        chainConfig: baseChainConfig,
        chain: 'polygon',
      });

      if (opportunities.length > 0) {
        expect(opportunities[0].chain).toBe('polygon');
      }
    });
  });

  // ===========================================================================
  // calculateArbitrageProfit
  // ===========================================================================
  describe('calculateArbitrageProfit', () => {
    it('should calculate profit between two sources', () => {
      const source1 = { price: 3500, fee: 0.003, source: 'uniswap' };
      const source2 = { price: 3535, fee: 0.003, source: 'sushiswap' };

      const result = calculateArbitrageProfit(source1, source2);

      expect(result.grossSpread).toBeCloseTo(0.01, 2);
      expect(result.totalFees).toBeCloseTo(0.006, 4);
      expect(result.netProfit).toBeCloseTo(0.004, 3);
      expect(result.isProfitable).toBe(true);
    });

    it('should identify unprofitable trades', () => {
      const source1 = { price: 3500, fee: 0.003, source: 'uniswap' };
      const source2 = { price: 3510, fee: 0.003, source: 'sushiswap' };

      const result = calculateArbitrageProfit(source1, source2);

      expect(result.isProfitable).toBe(false);
      expect(result.netProfit).toBeLessThan(0);
    });
  });

  // ===========================================================================
  // Token Order Utilities
  // ===========================================================================
  describe('Token Order Utilities', () => {
    describe('isReverseTokenOrder', () => {
      it('should return false for same token order', () => {
        expect(isReverseTokenOrder('0xAAA', '0xAAA')).toBe(false);
        expect(isReverseTokenOrder('0xaaa', '0xAAA')).toBe(false); // Case insensitive
      });

      it('should return true for different token order', () => {
        expect(isReverseTokenOrder('0xAAA', '0xBBB')).toBe(true);
      });
    });

    describe('normalizeTokenOrder', () => {
      it('should return tokens in alphabetical order', () => {
        const [first, second] = normalizeTokenOrder('0xBBB', '0xAAA');
        expect(first).toBe('0xaaa');
        expect(second).toBe('0xbbb');
      });

      it('should be case insensitive', () => {
        const [first1, second1] = normalizeTokenOrder('0xAAA', '0xBBB');
        const [first2, second2] = normalizeTokenOrder('0xaaa', '0xbbb');
        expect(first1).toBe(first2);
        expect(second1).toBe(second2);
      });
    });

    describe('getTokenPairKey', () => {
      it('should generate consistent key regardless of order', () => {
        const key1 = getTokenPairKey('0xAAA', '0xBBB');
        const key2 = getTokenPairKey('0xBBB', '0xAAA');
        expect(key1).toBe(key2);
      });

      it('should be case insensitive', () => {
        const key1 = getTokenPairKey('0xAAA', '0xBBB');
        const key2 = getTokenPairKey('0xaaa', '0xbbb');
        expect(key1).toBe(key2);
      });
    });

    describe('adjustPriceForTokenOrder', () => {
      it('should invert price for reversed order', () => {
        const price = adjustPriceForTokenOrder(2, '0xAAA', '0xBBB');
        expect(price).toBe(0.5);
      });

      it('should keep price for same order', () => {
        const price = adjustPriceForTokenOrder(2, '0xAAA', '0xAAA');
        expect(price).toBe(2);
      });

      it('should handle zero price', () => {
        const price = adjustPriceForTokenOrder(0, '0xAAA', '0xBBB');
        expect(price).toBe(0);
      });
    });
  });

  // ===========================================================================
  // Validation Functions
  // ===========================================================================
  describe('Validation Functions', () => {
    describe('isValidPairSnapshot', () => {
      it('should return true for valid snapshot', () => {
        expect(isValidPairSnapshot(basePairSnapshot)).toBe(true);
      });

      it('should return false for null/undefined', () => {
        expect(isValidPairSnapshot(null)).toBe(false);
        expect(isValidPairSnapshot(undefined)).toBe(false);
      });

      it('should return false for missing required fields', () => {
        expect(isValidPairSnapshot({ ...basePairSnapshot, address: '' })).toBe(false);
        expect(isValidPairSnapshot({ ...basePairSnapshot, reserve0: '' })).toBe(false);
        expect(isValidPairSnapshot({ ...basePairSnapshot, reserve0: '0' })).toBe(false);
      });
    });

    describe('validateDetectionInput', () => {
      it('should validate correct input', () => {
        const input: ArbitrageDetectionInput = {
          pair1: basePairSnapshot,
          pair2: { ...basePairSnapshot, address: '0x1234' },
          minProfitThreshold: 0.003,
          chainConfig: baseChainConfig,
        };

        const result = validateDetectionInput(input);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should detect invalid pair1', () => {
        const input: ArbitrageDetectionInput = {
          pair1: { ...basePairSnapshot, reserve0: '0' },
          pair2: basePairSnapshot,
          minProfitThreshold: 0.003,
          chainConfig: baseChainConfig,
        };

        const result = validateDetectionInput(input);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Invalid pair1 snapshot');
      });

      it('should detect invalid threshold', () => {
        const input: ArbitrageDetectionInput = {
          pair1: basePairSnapshot,
          pair2: { ...basePairSnapshot, address: '0x1234' },
          minProfitThreshold: -0.003,
          chainConfig: baseChainConfig,
        };

        const result = validateDetectionInput(input);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('Invalid minProfitThreshold');
      });
    });
  });

  // ===========================================================================
  // Regression Tests
  // ===========================================================================
  describe('Regression Tests', () => {
    it('should calculate spread using minPrice denominator (canonical formula)', () => {
      // This test ensures we use: spread = |p1-p2| / min(p1,p2)
      // NOT: spread = |p1-p2| / ((p1+p2)/2)
      const pair2: PairSnapshot = {
        ...basePairSnapshot,
        address: '0x397FF1542f962076d0BFE58eA045FfA2d347ACa0',
        dex: 'sushiswap',
        reserve1: '3182000000000', // Creates 10% spread
      };

      const input: ArbitrageDetectionInput = {
        pair1: basePairSnapshot,
        pair2,
        minProfitThreshold: 0.001,
        chainConfig: baseChainConfig,
        timestamp: Date.now(),
      };

      const result = detectArbitrage(input);

      // With minPrice formula: spread should be ~10%
      // With avgPrice formula: spread would be ~9.52%
      expect(result.calculations!.grossSpread).toBeCloseTo(0.10, 2);
    });

    it('should handle fee resolution correctly for different DEXes', () => {
      // Test with explicit fees matching DEX defaults
      const curvePair: PairSnapshot = {
        ...basePairSnapshot,
        address: '0xCurve0000000000000000000000000000000001',
        dex: 'curve',
        fee: 0.0004, // Curve default fee (0.04%)
      };

      const uniswapPair: PairSnapshot = {
        ...basePairSnapshot,
        address: '0xUniswap000000000000000000000000000001',
        dex: 'uniswap',
        fee: 0.003, // Uniswap default fee (0.3%)
      };

      // The fee difference should be reflected in calculations
      // Curve: 0.04%, Uniswap: 0.3% - significant difference
      const input: ArbitrageDetectionInput = {
        pair1: curvePair,
        pair2: uniswapPair,
        minProfitThreshold: 0.001,
        chainConfig: baseChainConfig,
        timestamp: Date.now(),
      };

      const result = detectArbitrage(input);

      // Total fees should be approximately 0.34% (0.0004 + 0.003)
      expect(result.calculations!.totalFees).toBeCloseTo(0.0034, 4);
    });
  });
});
