/**
 * Unit Tests for PriceCalculator
 *
 * Tests pure functions for price and profit calculations.
 * These tests verify the canonical formulas used across all detectors.
 *
 * Consolidated from:
 * - shared/core/__tests__/unit/components/price-calculator.test.ts (canonical location)
 * - shared/core/__tests__/unit/price-calculator.test.ts (merged, then deleted)
 *
 * @see components/price-calculator.ts
 * @see ADR-009: Test Architecture
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
  getMinProfitThreshold,
  meetsThreshold,
  calculateConfidence,
  isValidPrice,
  areValidReserves,
  isValidFee,
  PriceCalculationError,
} from '../../../src/components/price-calculator';

import {
  getDefaultFeeForDex as getDefaultFee,
  resolveFeeValue as resolveFee,
  bpsToDecimal,
  decimalToBps,
} from '../../../src/utils/fee-utils';

describe('PriceCalculator', () => {
  // ==========================================================================
  // calculatePriceFromReserves
  // ==========================================================================
  describe('calculatePriceFromReserves', () => {
    it('should calculate price from string reserves', () => {
      // ETH/USDC pool with 100 ETH (18 decimals) and 350000 USDC (6 decimals)
      // price = r0/r1 = (100 * 10^18) / (350000 * 10^6) ≈ 285714285.71
      // This is raw price without decimal adjustment
      const price = calculatePriceFromReserves('100000000000000000000', '350000000000');
      expect(price).toBeCloseTo(285714285.71, 0);
    });

    it('should calculate price from bigint reserves', () => {
      // Same calculation: price ≈ 285714285.71
      const price = calculatePriceFromReserves(100n * 10n ** 18n, 350000n * 10n ** 6n);
      expect(price).toBeCloseTo(285714285.71, 0);
    });

    it('should return null for zero reserves', () => {
      expect(calculatePriceFromReserves('0', '100')).toBeNull();
      expect(calculatePriceFromReserves('100', '0')).toBeNull();
      expect(calculatePriceFromReserves(0n, 100n)).toBeNull();
    });

    it('should return null for negative reserves', () => {
      expect(calculatePriceFromReserves(-100n, 100n)).toBeNull();
      expect(calculatePriceFromReserves(100n, -100n)).toBeNull();
    });

    it('should return null for invalid string reserves', () => {
      expect(calculatePriceFromReserves('invalid', '100')).toBeNull();
      expect(calculatePriceFromReserves('100', 'invalid')).toBeNull();
    });

    it('should handle very large reserves (10^30)', () => {
      const largeReserve = '1' + '0'.repeat(30);
      const price = calculatePriceFromReserves(largeReserve, largeReserve);
      expect(price).toBeCloseTo(1, 6);
    });

    it('should preserve precision for typical reserve values', () => {
      // 1000 ETH and 3500000 USDC in raw reserves (no decimal normalization)
      const r0 = '1000' + '0'.repeat(18); // 1000 ETH in wei (10^21)
      const r1 = '3500000' + '0'.repeat(6); // 3500000 USDC in 6 decimals (3.5 * 10^12)
      const price = calculatePriceFromReserves(r0, r1);
      // price = r0 / r1 = 10^21 / (3.5 * 10^12) ≈ 285714285.71
      expect(price).toBeCloseTo(285714285.71, 0);
    });
  });

  // ==========================================================================
  // safeBigIntDivision
  // ==========================================================================
  describe('safeBigIntDivision', () => {
    // P0-FIX 4.4: Division by zero now throws PriceCalculationError instead of returning 0
    // This prevents false arbitrage opportunity detection where price appears to be 0
    it('should throw PriceCalculationError for zero denominator', () => {
      expect(() => safeBigIntDivision(100n, 0n)).toThrow(PriceCalculationError);
      expect(() => safeBigIntDivision(100n, 0n)).toThrow('Division by zero');
    });

    it('should calculate simple division', () => {
      expect(safeBigIntDivision(100n, 50n)).toBeCloseTo(2, 10);
    });

    it('should preserve decimal precision', () => {
      expect(safeBigIntDivision(1n, 3n)).toBeCloseTo(0.333333, 5);
    });

    it('should handle large numerators', () => {
      const large = 10n ** 30n;
      expect(safeBigIntDivision(large, large)).toBeCloseTo(1, 10);
    });

    it('should handle very large BigInt values (> 2^53) without precision loss', () => {
      const reserve0 = BigInt('1000000000000000000000000000'); // 10^27
      const reserve1 = BigInt('500000000000000000000000000');  // 5e26
      const result = safeBigIntDivision(reserve0, reserve1);
      expect(result).toBe(2);
    });

    it('should preserve precision for realistic DeFi reserve values', () => {
      const ethReserve = BigInt('10000000000000000000000'); // 10,000 ETH in wei
      const usdcReserve = BigInt('30000000000000');         // 30,000,000 USDC (6 decimals)
      const price = safeBigIntDivision(ethReserve, usdcReserve);
      expect(price).toBeCloseTo(333333333.333, 0);
    });

    it('should handle small ratios accurately', () => {
      const reserve0 = BigInt('1000000000000000000000000'); // 1M tokens
      const reserve1 = BigInt('1001000000000000000000000'); // 1.001M tokens
      const price = safeBigIntDivision(reserve0, reserve1);
      expect(price).toBeCloseTo(0.999001, 5);
    });

    it('should handle extreme ratios without overflow', () => {
      const bigReserve = BigInt('1000000000000000000000000000000'); // 10^30
      const smallReserve = BigInt('1000000000000000000');           // 10^18
      expect(safeBigIntDivision(bigReserve, smallReserve)).toBe(1e12);
      expect(safeBigIntDivision(smallReserve, bigReserve)).toBe(1e-12);
    });
  });

  // ==========================================================================
  // safeBigIntDivisionOrNull
  // ==========================================================================
  describe('safeBigIntDivisionOrNull', () => {
    it('should return null for zero denominator', () => {
      expect(safeBigIntDivisionOrNull(100n, 0n)).toBeNull();
    });

    it('should return result for valid division', () => {
      expect(safeBigIntDivisionOrNull(100n, 50n)).toBe(2);
    });
  });

  // ==========================================================================
  // calculatePriceFromBigIntReserves
  // ==========================================================================
  describe('calculatePriceFromBigIntReserves', () => {
    it('should calculate price from BigInt reserves', () => {
      const result = calculatePriceFromBigIntReserves(
        BigInt('1000000000000000000000'),
        BigInt('2000000000000000000000')
      );
      expect(result).toBe(0.5);
    });

    it('should return null for zero reserves', () => {
      expect(calculatePriceFromBigIntReserves(0n, 100n)).toBeNull();
      expect(calculatePriceFromBigIntReserves(100n, 0n)).toBeNull();
      expect(calculatePriceFromBigIntReserves(0n, 0n)).toBeNull();
    });

    it('should handle large reserves that would overflow Number', () => {
      const reserve0 = BigInt('9007199254740992000000000000'); // > 2^53
      const reserve1 = BigInt('4503599627370496000000000000'); // > 2^52
      const result = calculatePriceFromBigIntReserves(reserve0, reserve1);
      expect(result).toBe(2);
    });
  });

  // ==========================================================================
  // invertPrice
  // ==========================================================================
  describe('invertPrice', () => {
    it('should invert price', () => {
      expect(invertPrice(2)).toBe(0.5);
      expect(invertPrice(0.5)).toBe(2);
    });

    it('should return 0 for zero price', () => {
      expect(invertPrice(0)).toBe(0);
    });

    it('should handle very small prices', () => {
      expect(invertPrice(0.0001)).toBeCloseTo(10000, 1);
    });
  });

  // ==========================================================================
  // calculateSpread
  // ==========================================================================
  describe('calculateSpread', () => {
    it('should calculate spread using canonical formula (min denominator)', () => {
      // 1% spread: |101 - 100| / min(100, 101) = 1/100 = 0.01
      const spread = calculateSpread(100, 101);
      expect(spread).toBeCloseTo(0.01, 6);
    });

    it('should be symmetric (same result regardless of order)', () => {
      const spread1 = calculateSpread(100, 110);
      const spread2 = calculateSpread(110, 100);
      expect(spread1).toBeCloseTo(spread2, 10);
    });

    it('should return 0 for equal prices', () => {
      expect(calculateSpread(100, 100)).toBe(0);
    });

    it('should handle small spreads', () => {
      // 0.1% spread
      const spread = calculateSpread(1000, 1001);
      expect(spread).toBeCloseTo(0.001, 6);
    });

    it('should handle large spreads', () => {
      // 100% spread (price doubled)
      const spread = calculateSpread(100, 200);
      expect(spread).toBeCloseTo(1.0, 6);
    });

    it('should throw for zero prices', () => {
      expect(() => calculateSpread(0, 100)).toThrow(PriceCalculationError);
      expect(() => calculateSpread(100, 0)).toThrow(PriceCalculationError);
    });

    it('should throw for negative prices', () => {
      expect(() => calculateSpread(-100, 100)).toThrow(PriceCalculationError);
      expect(() => calculateSpread(100, -100)).toThrow(PriceCalculationError);
    });

    it('should throw for non-finite prices', () => {
      expect(() => calculateSpread(Infinity, 100)).toThrow(PriceCalculationError);
      expect(() => calculateSpread(100, NaN)).toThrow(PriceCalculationError);
    });
  });

  // ==========================================================================
  // calculateSpreadSafe
  // ==========================================================================
  describe('calculateSpreadSafe', () => {
    it('should calculate spread for valid prices', () => {
      const spread = calculateSpreadSafe(100, 101);
      expect(spread).toBeCloseTo(0.01, 6);
    });

    it('should return 0 for invalid prices (no throw)', () => {
      expect(calculateSpreadSafe(0, 100)).toBe(0);
      expect(calculateSpreadSafe(100, 0)).toBe(0);
      expect(calculateSpreadSafe(-100, 100)).toBe(0);
      expect(calculateSpreadSafe(Infinity, 100)).toBe(0);
      expect(calculateSpreadSafe(100, NaN)).toBe(0);
    });
  });

  // ==========================================================================
  // calculateNetProfit
  // ==========================================================================
  describe('calculateNetProfit', () => {
    it('should calculate net profit after fees', () => {
      // 1% spread - 0.3% - 0.3% = 0.4% net
      const netProfit = calculateNetProfit(0.01, 0.003, 0.003);
      expect(netProfit).toBeCloseTo(0.004, 6);
    });

    it('should return negative for unprofitable trades', () => {
      // 0.5% spread - 0.3% - 0.3% = -0.1% net
      const netProfit = calculateNetProfit(0.005, 0.003, 0.003);
      expect(netProfit).toBeCloseTo(-0.001, 6);
    });

    it('should handle zero fees', () => {
      const netProfit = calculateNetProfit(0.01, 0, 0);
      expect(netProfit).toBeCloseTo(0.01, 6);
    });

    it('should handle asymmetric fees', () => {
      // 1% spread - 0.3% - 0.04% = 0.66% net (Uniswap + Curve)
      const netProfit = calculateNetProfit(0.01, 0.003, 0.0004);
      expect(netProfit).toBeCloseTo(0.0066, 6);
    });
  });

  // ==========================================================================
  // calculateProfitBetweenSources
  // ==========================================================================
  describe('calculateProfitBetweenSources', () => {
    it('should calculate profit between two sources', () => {
      const source1 = { price: 100, fee: 0.003, source: 'uniswap' };
      const source2 = { price: 101, fee: 0.003, source: 'sushiswap' };

      const result = calculateProfitBetweenSources(source1, source2);

      expect(result.grossSpread).toBeCloseTo(0.01, 6);
      expect(result.totalFees).toBeCloseTo(0.006, 6);
      expect(result.netProfit).toBeCloseTo(0.004, 6);
      expect(result.buyPrice).toBe(100);
      expect(result.sellPrice).toBe(101);
      expect(result.buySource).toBe('uniswap');
      expect(result.sellSource).toBe('sushiswap');
      expect(result.isProfitable).toBe(true);
    });

    it('should correctly identify unprofitable trades', () => {
      const source1 = { price: 100, fee: 0.003, source: 'uniswap' };
      const source2 = { price: 100.3, fee: 0.003, source: 'sushiswap' };

      const result = calculateProfitBetweenSources(source1, source2);

      expect(result.netProfit).toBeLessThan(0);
      expect(result.isProfitable).toBe(false);
    });

    it('should handle reversed prices (buy from higher source)', () => {
      const source1 = { price: 101, fee: 0.003, source: 'uniswap' };
      const source2 = { price: 100, fee: 0.003, source: 'sushiswap' };

      const result = calculateProfitBetweenSources(source1, source2);

      expect(result.buySource).toBe('sushiswap'); // Lower price
      expect(result.sellSource).toBe('uniswap'); // Higher price
    });

    it('should handle invalid prices gracefully', () => {
      const result = calculateProfitBetweenSources(
        { price: 0, fee: 0.003, source: 'dex1' },
        { price: 100, fee: 0.003, source: 'dex2' }
      );
      expect(result.isProfitable).toBe(false);
      expect(result.grossSpread).toBe(0);
    });
  });

  // ==========================================================================
  // Fee Utilities
  // ==========================================================================
  describe('Fee Utilities', () => {
    describe('getDefaultFee', () => {
      it('should return 0.3% for standard DEXes', () => {
        expect(getDefaultFee('uniswap')).toBe(0.003);
        expect(getDefaultFee('sushiswap')).toBe(0.003);
        expect(getDefaultFee(undefined)).toBe(0.003);
      });

      it('should return 0.04% for low-fee DEXes', () => {
        expect(getDefaultFee('curve')).toBe(0.0004);
        expect(getDefaultFee('Curve')).toBe(0.0004);
        expect(getDefaultFee('balancer')).toBe(0.0004);
        expect(getDefaultFee('BALANCER')).toBe(0.0004);
      });
    });

    describe('resolveFee', () => {
      it('should use explicit fee when provided', () => {
        expect(resolveFee(0.001, 'uniswap')).toBe(0.001);
      });

      it('should use default fee when undefined', () => {
        expect(resolveFee(undefined, 'uniswap')).toBe(0.003);
        expect(resolveFee(undefined, 'curve')).toBe(0.0004);
      });

      it('should correctly handle fee: 0 (nullish coalescing)', () => {
        expect(resolveFee(0, 'uniswap')).toBe(0);
      });
    });

    describe('bpsToDecimal', () => {
      it('should convert basis points to decimal', () => {
        expect(bpsToDecimal(30)).toBe(0.003);
        expect(bpsToDecimal(100)).toBe(0.01);
        expect(bpsToDecimal(4)).toBe(0.0004);
      });
    });

    describe('decimalToBps', () => {
      it('should convert decimal to basis points', () => {
        expect(decimalToBps(0.003)).toBe(30);
        expect(decimalToBps(0.01)).toBe(100);
        expect(decimalToBps(0.0004)).toBe(4);
      });
    });
  });

  // ==========================================================================
  // Threshold Utilities
  // ==========================================================================
  describe('Threshold Utilities', () => {
    describe('getMinProfitThreshold', () => {
      it('should return Ethereum threshold (0.5%)', () => {
        expect(getMinProfitThreshold('ethereum')).toBe(0.005);
      });

      it('should return Arbitrum threshold (0.2%)', () => {
        expect(getMinProfitThreshold('arbitrum')).toBe(0.002);
      });

      it('should return Optimism threshold (0.2%)', () => {
        expect(getMinProfitThreshold('optimism')).toBe(0.002);
      });

      it('should return BSC threshold (0.3%)', () => {
        expect(getMinProfitThreshold('bsc')).toBe(0.003);
      });

      it('should return default threshold for unknown chain', () => {
        expect(getMinProfitThreshold('unknown_chain')).toBe(0.003);
      });
    });

    describe('meetsThreshold', () => {
      it('should return true when profit meets threshold', () => {
        expect(meetsThreshold(0.005, 0.003)).toBe(true);
        expect(meetsThreshold(0.003, 0.003)).toBe(true);
      });

      it('should return false when profit below threshold', () => {
        expect(meetsThreshold(0.002, 0.003)).toBe(false);
      });

      it('should handle zero threshold', () => {
        expect(meetsThreshold(0.001, 0)).toBe(true);
        expect(meetsThreshold(0, 0)).toBe(true);
      });
    });

    describe('calculateConfidence', () => {
      it('should return higher confidence for larger spreads', () => {
        const lowSpread = calculateConfidence(0.01, 0);
        const highSpread = calculateConfidence(0.1, 0);
        expect(highSpread).toBeGreaterThan(lowSpread);
      });

      it('should reduce confidence for stale data', () => {
        const fresh = calculateConfidence(0.1, 0, 10000);
        const slightlyStale = calculateConfidence(0.1, 2000, 10000);
        const moreStale = calculateConfidence(0.1, 4000, 10000);

        // Fresh data (age=0) should have higher confidence than older data
        expect(fresh).toBeGreaterThan(slightlyStale);
        expect(slightlyStale).toBeGreaterThan(moreStale);
      });

      it('should cap confidence at 95%', () => {
        const confidence = calculateConfidence(1.0, 0);
        expect(confidence).toBeLessThanOrEqual(0.95);
      });

      it('should maintain minimum 50% freshness score', () => {
        const veryStale = calculateConfidence(0.5, 100000, 10000);
        expect(veryStale).toBeGreaterThan(0);
      });
    });
  });

  // ==========================================================================
  // Validation Utilities
  // ==========================================================================
  describe('Validation Utilities', () => {
    describe('isValidPrice', () => {
      it('should return true for valid prices', () => {
        expect(isValidPrice(100)).toBe(true);
        expect(isValidPrice(0.0001)).toBe(true);
        expect(isValidPrice(1e18)).toBe(true);
      });

      it('should return false for invalid prices', () => {
        expect(isValidPrice(0)).toBe(false);
        expect(isValidPrice(-100)).toBe(false);
        expect(isValidPrice(NaN)).toBe(false);
        expect(isValidPrice(Infinity)).toBe(false);
        expect(isValidPrice(undefined as any)).toBe(false);
        expect(isValidPrice('100' as any)).toBe(false);
      });
    });

    describe('areValidReserves', () => {
      it('should return true for valid reserves', () => {
        expect(areValidReserves('100', '200')).toBe(true);
        expect(areValidReserves(100n, 200n)).toBe(true);
        expect(areValidReserves('1', '1')).toBe(true);
      });

      it('should return false for zero reserves', () => {
        expect(areValidReserves('0', '100')).toBe(false);
        expect(areValidReserves('100', '0')).toBe(false);
        expect(areValidReserves(0n, 100n)).toBe(false);
      });

      it('should return false for invalid reserves', () => {
        expect(areValidReserves('invalid', '100')).toBe(false);
        expect(areValidReserves('100', 'invalid')).toBe(false);
      });

      it('should return false for negative reserves', () => {
        expect(areValidReserves(-100n, 100n)).toBe(false);
      });
    });

    describe('isValidFee', () => {
      it('should return true for valid fees', () => {
        expect(isValidFee(0)).toBe(true);
        expect(isValidFee(0.003)).toBe(true);
        expect(isValidFee(0.999)).toBe(true);
      });

      it('should return false for invalid fees', () => {
        expect(isValidFee(-0.001)).toBe(false);
        expect(isValidFee(1)).toBe(false);
        expect(isValidFee(1.5)).toBe(false);
        expect(isValidFee(NaN)).toBe(false);
        expect(isValidFee(Infinity)).toBe(false);
        expect(isValidFee(undefined as any)).toBe(false);
      });
    });
  });

  // ==========================================================================
  // Phase 3 Regression Tests
  // ==========================================================================
  describe('Phase 3 Regression Tests', () => {
    describe('Fix #20: calculateSpreadSafe inlined validation', () => {
      it('should return 0 for negative prices without throwing', () => {
        expect(calculateSpreadSafe(-1, 100)).toBe(0);
        expect(calculateSpreadSafe(100, -1)).toBe(0);
        expect(calculateSpreadSafe(-1, -1)).toBe(0);
      });

      it('should return 0 for NaN and Infinity without throwing', () => {
        expect(calculateSpreadSafe(NaN, 100)).toBe(0);
        expect(calculateSpreadSafe(100, NaN)).toBe(0);
        expect(calculateSpreadSafe(Infinity, 100)).toBe(0);
        expect(calculateSpreadSafe(100, -Infinity)).toBe(0);
      });

      it('should match calculateSpread for valid inputs', () => {
        // Ensure the inlined version produces identical results
        expect(calculateSpreadSafe(100, 110)).toBeCloseTo(calculateSpread(100, 110), 10);
        expect(calculateSpreadSafe(3500, 3535)).toBeCloseTo(calculateSpread(3500, 3535), 10);
        expect(calculateSpreadSafe(0.001, 0.002)).toBeCloseTo(calculateSpread(0.001, 0.002), 10);
      });
    });

    describe('Fix #25: BigInt precision guard', () => {
      it('should return null for extremely large BigInt values that overflow Number', () => {
        // 10^500 would overflow to Infinity when converted to Number
        const huge = 10n ** 500n;
        expect(safeBigIntDivisionOrNull(huge, 1n)).toBeNull();
      });

      it('should throw PriceCalculationError for non-finite result in safeBigIntDivision', () => {
        const huge = 10n ** 500n;
        expect(() => safeBigIntDivision(huge, 1n)).toThrow(PriceCalculationError);
        expect(() => safeBigIntDivision(huge, 1n)).toThrow('Precision loss');
      });

      it('should return null from calculatePriceFromReserves for overflow reserves', () => {
        const huge = (10n ** 500n).toString();
        expect(calculatePriceFromReserves(huge, '1')).toBeNull();
      });
    });

    describe('Fix #21: Fee utility API preservation', () => {
      it('should export fee utilities from canonical source', () => {
        // Verify the re-exported functions work correctly
        expect(typeof getDefaultFee).toBe('function');
        expect(typeof resolveFee).toBe('function');
        expect(typeof bpsToDecimal).toBe('function');
        expect(typeof decimalToBps).toBe('function');
      });

      it('should resolve fees correctly via re-exported functions', () => {
        expect(resolveFee(0.001, 'uniswap')).toBe(0.001);
        expect(resolveFee(undefined, 'curve')).toBe(0.0004);
        expect(bpsToDecimal(30)).toBe(0.003);
        expect(decimalToBps(0.003)).toBe(30);
      });
    });
  });

  // ==========================================================================
  // Regression Tests (Canonical Formula)
  // ==========================================================================
  describe('Regression Tests', () => {
    it('should use minPrice denominator (not avgPrice)', () => {
      // This test ensures we use the canonical formula:
      // spread = |price1 - price2| / min(price1, price2)
      // NOT the buggy formula: spread = |price1 - price2| / ((price1 + price2) / 2)

      const price1 = 100;
      const price2 = 110;

      // Canonical formula: (110 - 100) / 100 = 0.10 (10%)
      const correctSpread = 0.10;

      // Buggy formula (avgPrice): (110 - 100) / 105 = 0.0952... (9.52%)
      const buggySpread = 10 / ((100 + 110) / 2);

      const actualSpread = calculateSpread(price1, price2);

      expect(actualSpread).toBeCloseTo(correctSpread, 6);
      // 0.10 vs 0.0952 - use precision 3 (tolerance 0.0005) to ensure we're not using avgPrice
      expect(actualSpread).not.toBeCloseTo(buggySpread, 3);
    });

    it('should match expected values for ETH/USDC arbitrage scenario', () => {
      // Realistic scenario: ETH at $3500 on Uniswap, $3510.50 on Sushiswap
      // Spread = (3510.50 - 3500) / 3500 = 0.003 (0.3%)
      // Total fees = 0.003 + 0.003 = 0.006 (0.6%)
      // Net = 0.003 - 0.006 = -0.003 (unprofitable)

      const source1 = { price: 3500, fee: 0.003, source: 'uniswap' };
      const source2 = { price: 3510.50, fee: 0.003, source: 'sushiswap' };

      const result = calculateProfitBetweenSources(source1, source2);

      expect(result.grossSpread).toBeCloseTo(0.003, 4);
      expect(result.totalFees).toBeCloseTo(0.006, 6);
      expect(result.netProfit).toBeCloseTo(-0.003, 4);
      expect(result.isProfitable).toBe(false);
    });

    it('should match expected values for profitable arbitrage scenario', () => {
      // ETH at $3500 on Uniswap, $3535 on Sushiswap
      // Spread = (3535 - 3500) / 3500 = 0.01 (1%)
      // Total fees = 0.003 + 0.003 = 0.006 (0.6%)
      // Net = 0.01 - 0.006 = 0.004 (0.4% profit)

      const source1 = { price: 3500, fee: 0.003, source: 'uniswap' };
      const source2 = { price: 3535, fee: 0.003, source: 'sushiswap' };

      const result = calculateProfitBetweenSources(source1, source2);

      expect(result.grossSpread).toBeCloseTo(0.01, 4);
      expect(result.netProfit).toBeCloseTo(0.004, 4);
      expect(result.isProfitable).toBe(true);
    });
  });
});
