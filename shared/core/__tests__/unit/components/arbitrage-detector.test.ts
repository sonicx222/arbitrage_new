/**
 * Arbitrage Detector Unit Tests
 *
 * Tests for pure arbitrage detection functions.
 * These tests validate the core detection logic without mocks.
 */

import {
  detectArbitrage,
  isReverseTokenOrder,
  normalizeTokenOrder,
  adjustPriceForTokenOrder,
  isValidPairSnapshot,
  validateDetectionInput,
  type ArbitrageDetectionInput,
} from '../../../src/components/arbitrage-detector';

import type { PairSnapshot } from '../../../src/components/pair-repository';

describe('ArbitrageDetector', () => {
  // ===========================================================================
  // Test Fixtures
  // ===========================================================================

  /**
   * Create a PairSnapshot with reserves that produce a target price.
   * Price = reserve0 / reserve1
   * For price of 2000: reserve0=2000e18, reserve1=1e18
   */
  const createPairSnapshot = (
    overrides: Partial<PairSnapshot> & { targetPrice?: number } = {}
  ): PairSnapshot => {
    const { targetPrice, ...rest } = overrides;

    // Default price is 2000 (2000 USDT per WETH)
    // If targetPrice is provided, adjust reserves accordingly
    const price = targetPrice ?? 2000;

    // To get price = reserve0/reserve1 = targetPrice
    // Set reserve0 = price * 1e18, reserve1 = 1e18
    const defaultReserve0 = (BigInt(Math.floor(price * 1000)) * 10n ** 15n).toString(); // price * 1e18
    const defaultReserve1 = (10n ** 18n).toString(); // 1e18

    return {
      address: '0x0d4a11d5eeaac28ec3f61d100daf4d40471f1852', // USDT-WETH
      dex: 'uniswap',
      token0: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
      token1: '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
      reserve0: defaultReserve0,
      reserve1: defaultReserve1,
      fee: 0.003,
      blockNumber: 18000000,
      ...rest,
    };
  };

  const createDetectionInput = (
    pair1Overrides: Partial<PairSnapshot> & { targetPrice?: number } = {},
    pair2Overrides: Partial<PairSnapshot> & { targetPrice?: number } = {},
    inputOverrides: Partial<Omit<ArbitrageDetectionInput, 'pair1' | 'pair2'>> = {}
  ): ArbitrageDetectionInput => ({
    pair1: createPairSnapshot(pair1Overrides),
    pair2: createPairSnapshot({
      address: '0xd3d2e2692501a5c9ca623199d38826e513033a17', // Different pair
      dex: 'sushiswap',
      ...pair2Overrides,
    }),
    minProfitThreshold: 0.003, // 0.3%
    chainConfig: {
      gasEstimate: '200000',
      confidence: 0.8,
      expiryMs: 10000,
    },
    timestamp: Date.now(),
    ...inputOverrides,
  });

  // ===========================================================================
  // detectArbitrage
  // ===========================================================================

  describe('detectArbitrage', () => {
    it('should detect profitable arbitrage opportunity', () => {
      // Create pairs with 5% price difference (profitable after fees)
      const input = createDetectionInput(
        { targetPrice: 2000, dex: 'uniswap' },
        { targetPrice: 2100, dex: 'sushiswap' } // 5% higher
      );

      const result = detectArbitrage(input);

      expect(result.found).toBe(true);
      expect(result.opportunity).toBeDefined();
      expect(result.opportunity?.buyDex).toBe('uniswap'); // Lower price
      expect(result.opportunity?.sellDex).toBe('sushiswap'); // Higher price
      expect(result.opportunity?.expectedProfit).toBeGreaterThan(0);
    });

    it('should not detect unprofitable arbitrage (spread < fees)', () => {
      // Create pairs with 0.3% price difference (not profitable after 0.6% fees)
      const input = createDetectionInput(
        { targetPrice: 2000, dex: 'uniswap' },
        { targetPrice: 2006, dex: 'sushiswap' } // 0.3% higher
      );

      const result = detectArbitrage(input);

      expect(result.found).toBe(false);
      expect(result.reason).toContain('threshold');
    });

    it('should handle same DEX pairs (intra-dex arbitrage)', () => {
      const input = createDetectionInput(
        { targetPrice: 2000, dex: 'uniswap' },
        { targetPrice: 2100, dex: 'uniswap' } // Same DEX
      );

      const result = detectArbitrage(input);

      // Should still detect opportunity on same DEX (intra-dex)
      expect(result.found).toBe(true);
      expect(result.opportunity?.type).toBe('intra-dex');
    });

    it('should handle reversed token order', () => {
      // Create pair with reversed token order
      // For reversed pair: if original price is 2100, reversed gives 1/2100
      // reserve0/reserve1 = 1/2100, so reserve0 = 1e18, reserve1 = 2100e18
      const input = createDetectionInput(
        {
          targetPrice: 2000,
          token0: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH first
          token1: '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT second
        },
        {
          // Reversed token order - USDT first, WETH second
          // Price is reserve0/reserve1, for reversed pair we want the equivalent of 2100 USDT/WETH
          // So we set reserve0 = 1e18, reserve1 = 2100e18 (gives 0.000476...)
          reserve0: (10n ** 18n).toString(),
          reserve1: (2100n * 10n ** 18n).toString(),
          token0: '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT first
          token1: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH second
        }
      );

      const result = detectArbitrage(input);

      expect(result.found).toBe(true);
      // The adjusted price should be close to 2100 after inversion
      expect(result.calculations?.price2Adjusted).toBeCloseTo(2100, 0);
    });

    it('should return calculations for debugging', () => {
      const input = createDetectionInput(
        { targetPrice: 2000 },
        { targetPrice: 2100 }
      );

      const result = detectArbitrage(input);

      expect(result.calculations).toBeDefined();
      expect(result.calculations?.price1).toBeCloseTo(2000, 0);
      expect(result.calculations?.grossSpread).toBeCloseTo(0.05, 2); // 5%
      expect(result.calculations?.totalFees).toBeCloseTo(0.006, 4); // 0.6%
      expect(result.calculations?.netProfit).toBeCloseTo(0.044, 2); // ~4.4%
    });

    it('should generate unique opportunity IDs', () => {
      const input1 = createDetectionInput({ targetPrice: 2000 }, { targetPrice: 2100 });
      const input2 = createDetectionInput({ targetPrice: 2000 }, { targetPrice: 2100 });

      const result1 = detectArbitrage(input1);
      const result2 = detectArbitrage(input2);

      expect(result1.opportunity?.id).toBeDefined();
      expect(result2.opportunity?.id).toBeDefined();
      // IDs should be unique even for same input (due to counter suffix)
      expect(result1.opportunity?.id).not.toBe(result2.opportunity?.id);
    });

    it('should generate monotonically increasing counter in IDs (Fix #19)', () => {
      // Fix #19: Counter-based ID generation replaces random suffix
      const timestamp = 1700000000000;
      const input1 = createDetectionInput(
        { targetPrice: 2000 },
        { targetPrice: 2100 },
        { timestamp }
      );
      const input2 = createDetectionInput(
        { targetPrice: 2000 },
        { targetPrice: 2100 },
        { timestamp }
      );

      const result1 = detectArbitrage(input1);
      const result2 = detectArbitrage(input2);

      // Extract counter suffix (last segment after the timestamp)
      const id1Parts = result1.opportunity!.id.split('-');
      const id2Parts = result2.opportunity!.id.split('-');
      const counter1 = parseInt(id1Parts[id1Parts.length - 1], 10);
      const counter2 = parseInt(id2Parts[id2Parts.length - 1], 10);

      // Counter should be monotonically increasing
      expect(counter2).toBeGreaterThan(counter1);
    });

    it('should handle invalid pair snapshots (zero reserves)', () => {
      const input = createDetectionInput(
        { reserve0: '0', reserve1: '1000000000000000000' }, // Invalid reserve0
        { targetPrice: 2100 }
      );

      const result = detectArbitrage(input);

      expect(result.found).toBe(false);
      expect(result.reason).toContain('Invalid');
    });
  });

  // ===========================================================================
  // Token Order Utilities
  // ===========================================================================

  describe('isReverseTokenOrder', () => {
    it('should return false when token order matches', () => {
      const result = isReverseTokenOrder('0xaaa', '0xaaa');
      expect(result).toBe(false);
    });

    it('should return true when token order is reversed', () => {
      const result = isReverseTokenOrder('0xaaa', '0xbbb');
      expect(result).toBe(true);
    });

    it('should be case-insensitive', () => {
      const result = isReverseTokenOrder('0xAAA', '0xaaa');
      expect(result).toBe(false);
    });
  });

  describe('normalizeTokenOrder', () => {
    it('should return tokens in alphabetical order', () => {
      const [t0, t1] = normalizeTokenOrder('0xbbb', '0xaaa');
      expect(t0).toBe('0xaaa');
      expect(t1).toBe('0xbbb');
    });

    it('should not change order when already sorted', () => {
      const [t0, t1] = normalizeTokenOrder('0xaaa', '0xbbb');
      expect(t0).toBe('0xaaa');
      expect(t1).toBe('0xbbb');
    });

    it('should normalize to lowercase', () => {
      const [t0, t1] = normalizeTokenOrder('0xAAA', '0xBBB');
      expect(t0).toBe('0xaaa');
      expect(t1).toBe('0xbbb');
    });
  });

  describe('adjustPriceForTokenOrder', () => {
    it('should not adjust price when order matches', () => {
      const adjusted = adjustPriceForTokenOrder(2000, '0xaaa', '0xaaa');
      expect(adjusted).toBe(2000);
    });

    it('should invert price when order is reversed', () => {
      const adjusted = adjustPriceForTokenOrder(2000, '0xaaa', '0xbbb');
      expect(adjusted).toBeCloseTo(0.0005, 6); // 1/2000
    });

    it('should handle zero price gracefully', () => {
      const adjusted = adjustPriceForTokenOrder(0, '0xaaa', '0xbbb');
      expect(adjusted).toBe(0);
    });
  });

  // ===========================================================================
  // Validation Utilities
  // ===========================================================================

  describe('isValidPairSnapshot', () => {
    it('should return true for valid snapshot', () => {
      const snapshot = createPairSnapshot();
      expect(isValidPairSnapshot(snapshot)).toBe(true);
    });

    it('should return false for missing address', () => {
      const snapshot = createPairSnapshot({ address: '' });
      expect(isValidPairSnapshot(snapshot)).toBe(false);
    });

    it('should return false for zero reserves', () => {
      const snapshot = createPairSnapshot({ reserve0: '0' });
      expect(isValidPairSnapshot(snapshot)).toBe(false);
    });

    it('should return false for null/undefined', () => {
      expect(isValidPairSnapshot(null)).toBe(false);
      expect(isValidPairSnapshot(undefined)).toBe(false);
    });
  });

  describe('validateDetectionInput', () => {
    it('should return valid for correct input', () => {
      const input = createDetectionInput();
      const result = validateDetectionInput(input);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return invalid for invalid pair1', () => {
      const input = createDetectionInput({ reserve0: '0' }, {});
      const result = validateDetectionInput(input);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid pair1 snapshot');
    });

    it('should return invalid for negative threshold', () => {
      const input = createDetectionInput({}, {}, { minProfitThreshold: -0.01 });
      const result = validateDetectionInput(input);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid minProfitThreshold');
    });
  });
});
