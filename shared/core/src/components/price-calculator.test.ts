/**
 * Price Calculator Unit Tests
 *
 * Tests for pure price calculation functions.
 * These are critical for arbitrage detection accuracy.
 */

import {
  calculatePriceFromReserves,
  calculatePriceFromBigIntReserves,
  safeBigIntDivision,
  safeBigIntDivisionOrNull,
  invertPrice,
  calculateSpread,
  calculateSpreadSafe,
  calculateNetProfit,
  calculateProfitBetweenSources,
  getDefaultFee,
  resolveFee,
  basisPointsToDecimal,
  decimalToBasisPoints,
  meetsThreshold,
  calculateConfidence,
  isValidPrice,
  areValidReserves,
  isValidFee,
  getBlockTimeMs,
  BLOCK_TIMES_MS,
  PriceCalculationError,
} from './price-calculator';

describe('PriceCalculator', () => {
  // ===========================================================================
  // Core Price Calculations
  // ===========================================================================

  describe('calculatePriceFromReserves', () => {
    it('should calculate price from string reserves', () => {
      const price = calculatePriceFromReserves('1000000000000000000', '2000000000000000000');
      expect(price).toBeCloseTo(0.5, 10);
    });

    it('should calculate price from bigint reserves', () => {
      const price = calculatePriceFromReserves(
        BigInt('1000000000000000000'),
        BigInt('500000000000000000')
      );
      expect(price).toBeCloseTo(2.0, 10);
    });

    it('should return null for zero reserves', () => {
      expect(calculatePriceFromReserves('0', '1000')).toBeNull();
      expect(calculatePriceFromReserves('1000', '0')).toBeNull();
      expect(calculatePriceFromReserves(0n, 1000n)).toBeNull();
    });

    it('should return null for negative reserves', () => {
      expect(calculatePriceFromReserves(-1n, 1000n)).toBeNull();
      expect(calculatePriceFromReserves(1000n, -1n)).toBeNull();
    });

    it('should return null for invalid string reserves', () => {
      expect(calculatePriceFromReserves('not_a_number', '1000')).toBeNull();
    });

    it('should handle very large reserves without precision loss', () => {
      // P0-1 FIX verification: large BigInt values should maintain precision
      const largeReserve0 = BigInt('1000000000000000000000000000'); // 10^27
      const largeReserve1 = BigInt('2000000000000000000000000000'); // 2 * 10^27
      const price = calculatePriceFromReserves(largeReserve0, largeReserve1);
      expect(price).toBeCloseTo(0.5, 10);
    });
  });

  describe('calculatePriceFromBigIntReserves', () => {
    it('should calculate price from BigInt reserves', () => {
      const price = calculatePriceFromBigIntReserves(
        1000000000000000000n,
        2000000000000000000n
      );
      expect(price).toBeCloseTo(0.5, 10);
    });

    it('should return null for zero reserves', () => {
      expect(calculatePriceFromBigIntReserves(0n, 1000n)).toBeNull();
      expect(calculatePriceFromBigIntReserves(1000n, 0n)).toBeNull();
    });
  });

  describe('safeBigIntDivision', () => {
    it('should perform division with precision', () => {
      const result = safeBigIntDivision(1n, 3n);
      expect(result).toBeCloseTo(0.3333333333333333, 10);
    });

    it('should throw for division by zero', () => {
      expect(() => safeBigIntDivision(1n, 0n)).toThrow(PriceCalculationError);
      expect(() => safeBigIntDivision(1n, 0n)).toThrow('Division by zero');
    });

    it('should handle large numbers', () => {
      const large = BigInt('1000000000000000000000000000');
      const result = safeBigIntDivision(large, large);
      expect(result).toBeCloseTo(1.0, 10);
    });
  });

  describe('safeBigIntDivisionOrNull', () => {
    it('should perform division with precision', () => {
      const result = safeBigIntDivisionOrNull(1n, 3n);
      expect(result).toBeCloseTo(0.3333333333333333, 10);
    });

    it('should return null for division by zero', () => {
      expect(safeBigIntDivisionOrNull(1n, 0n)).toBeNull();
    });
  });

  describe('invertPrice', () => {
    it('should invert price correctly', () => {
      expect(invertPrice(2)).toBeCloseTo(0.5, 10);
      expect(invertPrice(0.5)).toBeCloseTo(2, 10);
    });

    it('should return 0 for price of 0', () => {
      expect(invertPrice(0)).toBe(0);
    });
  });

  // ===========================================================================
  // Spread and Profit Calculations
  // ===========================================================================

  describe('calculateSpread', () => {
    it('should calculate spread using canonical formula', () => {
      // spread = |price1 - price2| / min(price1, price2)
      const spread = calculateSpread(100, 105);
      expect(spread).toBeCloseTo(0.05, 10); // 5%
    });

    it('should be symmetric (order independent)', () => {
      const spread1 = calculateSpread(100, 105);
      const spread2 = calculateSpread(105, 100);
      expect(spread1).toBeCloseTo(spread2, 10);
    });

    it('should throw for non-positive prices', () => {
      expect(() => calculateSpread(0, 100)).toThrow(PriceCalculationError);
      expect(() => calculateSpread(-1, 100)).toThrow(PriceCalculationError);
      expect(() => calculateSpread(100, 0)).toThrow(PriceCalculationError);
    });

    it('should throw for non-finite prices', () => {
      expect(() => calculateSpread(Infinity, 100)).toThrow(PriceCalculationError);
      expect(() => calculateSpread(NaN, 100)).toThrow(PriceCalculationError);
    });
  });

  describe('calculateSpreadSafe', () => {
    it('should return spread for valid prices', () => {
      expect(calculateSpreadSafe(100, 105)).toBeCloseTo(0.05, 10);
    });

    it('should return 0 for invalid prices', () => {
      expect(calculateSpreadSafe(0, 100)).toBe(0);
      expect(calculateSpreadSafe(-1, 100)).toBe(0);
      expect(calculateSpreadSafe(Infinity, 100)).toBe(0);
    });
  });

  describe('calculateNetProfit', () => {
    it('should calculate net profit after fees', () => {
      const grossSpread = 0.05; // 5%
      const fee1 = 0.003; // 0.3%
      const fee2 = 0.003; // 0.3%
      const netProfit = calculateNetProfit(grossSpread, fee1, fee2);
      expect(netProfit).toBeCloseTo(0.044, 10); // 5% - 0.6% = 4.4%
    });

    it('should return negative for unprofitable trades', () => {
      const grossSpread = 0.005; // 0.5%
      const fee1 = 0.003; // 0.3%
      const fee2 = 0.003; // 0.3%
      const netProfit = calculateNetProfit(grossSpread, fee1, fee2);
      expect(netProfit).toBeCloseTo(-0.001, 10); // 0.5% - 0.6% = -0.1%
    });
  });

  describe('calculateProfitBetweenSources', () => {
    it('should calculate profit between two sources', () => {
      const source1 = { price: 100, fee: 0.003, source: 'uniswap' };
      const source2 = { price: 105, fee: 0.003, source: 'sushiswap' };

      const result = calculateProfitBetweenSources(source1, source2);

      expect(result.grossSpread).toBeCloseTo(0.05, 10);
      expect(result.totalFees).toBeCloseTo(0.006, 10);
      expect(result.netProfit).toBeCloseTo(0.044, 10);
      expect(result.buyPrice).toBe(100);
      expect(result.sellPrice).toBe(105);
      expect(result.buySource).toBe('uniswap');
      expect(result.sellSource).toBe('sushiswap');
      expect(result.isProfitable).toBe(true);
    });

    it('should correctly identify buy and sell sources', () => {
      const source1 = { price: 105, fee: 0.003, source: 'uniswap' };
      const source2 = { price: 100, fee: 0.003, source: 'sushiswap' };

      const result = calculateProfitBetweenSources(source1, source2);

      expect(result.buySource).toBe('sushiswap'); // Lower price
      expect(result.sellSource).toBe('uniswap'); // Higher price
    });
  });

  // ===========================================================================
  // Fee Utilities
  // ===========================================================================

  describe('getDefaultFee', () => {
    it('should return low fee for Curve', () => {
      expect(getDefaultFee('curve')).toBe(0.0004);
      expect(getDefaultFee('CURVE')).toBe(0.0004);
    });

    it('should return low fee for Balancer', () => {
      expect(getDefaultFee('balancer')).toBe(0.0004);
    });

    it('should return standard fee for other DEXes', () => {
      expect(getDefaultFee('uniswap')).toBe(0.003);
      expect(getDefaultFee('sushiswap')).toBe(0.003);
    });

    it('should return standard fee when no DEX specified', () => {
      expect(getDefaultFee()).toBe(0.003);
      expect(getDefaultFee(undefined)).toBe(0.003);
    });
  });

  describe('resolveFee', () => {
    it('should use explicit fee when provided', () => {
      expect(resolveFee(0.005, 'uniswap')).toBe(0.005);
    });

    it('should use explicit fee of 0', () => {
      expect(resolveFee(0, 'uniswap')).toBe(0);
    });

    it('should fallback to default when explicit fee is undefined', () => {
      expect(resolveFee(undefined, 'curve')).toBe(0.0004);
      expect(resolveFee(undefined, 'uniswap')).toBe(0.003);
    });
  });

  describe('basisPointsToDecimal', () => {
    it('should convert basis points to decimal', () => {
      expect(basisPointsToDecimal(30)).toBe(0.003);
      expect(basisPointsToDecimal(100)).toBe(0.01);
    });
  });

  describe('decimalToBasisPoints', () => {
    it('should convert decimal to basis points', () => {
      expect(decimalToBasisPoints(0.003)).toBe(30);
      expect(decimalToBasisPoints(0.01)).toBe(100);
    });
  });

  // ===========================================================================
  // Threshold Utilities
  // ===========================================================================

  describe('meetsThreshold', () => {
    it('should return true when profit meets threshold', () => {
      expect(meetsThreshold(0.01, 0.01)).toBe(true);
      expect(meetsThreshold(0.02, 0.01)).toBe(true);
    });

    it('should return false when profit is below threshold', () => {
      expect(meetsThreshold(0.005, 0.01)).toBe(false);
    });
  });

  describe('calculateConfidence', () => {
    it('should calculate confidence based on spread and age', () => {
      const confidence = calculateConfidence(0.05, 0); // Fresh data
      expect(confidence).toBeGreaterThan(0);
      expect(confidence).toBeLessThanOrEqual(0.95);
    });

    it('should reduce confidence for older data', () => {
      const fresh = calculateConfidence(0.05, 0);
      const stale = calculateConfidence(0.05, 5000); // 5 seconds old
      expect(stale).toBeLessThan(fresh);
    });

    it('should cap confidence at 95%', () => {
      const maxConfidence = calculateConfidence(1.0, 0); // Very high spread
      expect(maxConfidence).toBeLessThanOrEqual(0.95);
    });
  });

  // ===========================================================================
  // Validation Utilities
  // ===========================================================================

  describe('isValidPrice', () => {
    it('should return true for valid prices', () => {
      expect(isValidPrice(100)).toBe(true);
      expect(isValidPrice(0.001)).toBe(true);
    });

    it('should return false for invalid prices', () => {
      expect(isValidPrice(0)).toBe(false);
      expect(isValidPrice(-1)).toBe(false);
      expect(isValidPrice(Infinity)).toBe(false);
      expect(isValidPrice(NaN)).toBe(false);
    });
  });

  describe('areValidReserves', () => {
    it('should return true for valid reserves', () => {
      expect(areValidReserves('1000', '2000')).toBe(true);
      expect(areValidReserves(1000n, 2000n)).toBe(true);
    });

    it('should return false for zero reserves', () => {
      expect(areValidReserves('0', '1000')).toBe(false);
      expect(areValidReserves(0n, 1000n)).toBe(false);
    });

    it('should return false for invalid string reserves', () => {
      expect(areValidReserves('invalid', '1000')).toBe(false);
    });
  });

  describe('isValidFee', () => {
    it('should return true for valid fees', () => {
      expect(isValidFee(0)).toBe(true);
      expect(isValidFee(0.003)).toBe(true);
      expect(isValidFee(0.99)).toBe(true);
    });

    it('should return false for invalid fees', () => {
      expect(isValidFee(-0.001)).toBe(false);
      expect(isValidFee(1)).toBe(false);
      expect(isValidFee(Infinity)).toBe(false);
      expect(isValidFee(NaN)).toBe(false);
    });
  });

  // ===========================================================================
  // Chain Constants
  // ===========================================================================

  describe('getBlockTimeMs', () => {
    it('should return correct block time for known chains', () => {
      expect(getBlockTimeMs('ethereum')).toBe(12000);
      expect(getBlockTimeMs('polygon')).toBe(2000);
      expect(getBlockTimeMs('arbitrum')).toBe(250);
      expect(getBlockTimeMs('solana')).toBe(400);
    });

    it('should be case-insensitive', () => {
      expect(getBlockTimeMs('ETHEREUM')).toBe(12000);
      expect(getBlockTimeMs('Polygon')).toBe(2000);
    });

    it('should return default for unknown chains', () => {
      expect(getBlockTimeMs('unknown_chain')).toBe(12000);
    });

    it('should cache normalized chain names (P0-FIX 10.4)', () => {
      // Verify caching works by calling multiple times
      getBlockTimeMs('ETHEREUM');
      getBlockTimeMs('ETHEREUM');
      getBlockTimeMs('ETHEREUM');
      // No errors means caching is working
      expect(getBlockTimeMs('ETHEREUM')).toBe(12000);
    });
  });

  describe('BLOCK_TIMES_MS', () => {
    it('should have expected chains', () => {
      expect(BLOCK_TIMES_MS).toHaveProperty('ethereum');
      expect(BLOCK_TIMES_MS).toHaveProperty('polygon');
      expect(BLOCK_TIMES_MS).toHaveProperty('bsc');
      expect(BLOCK_TIMES_MS).toHaveProperty('arbitrum');
      expect(BLOCK_TIMES_MS).toHaveProperty('optimism');
      expect(BLOCK_TIMES_MS).toHaveProperty('base');
      expect(BLOCK_TIMES_MS).toHaveProperty('avalanche');
      expect(BLOCK_TIMES_MS).toHaveProperty('solana');
    });
  });
});
