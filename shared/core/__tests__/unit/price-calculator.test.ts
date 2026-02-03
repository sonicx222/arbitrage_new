/**
 * Price Calculator Unit Tests
 *
 * Tests for the price calculation module (components/price-calculator.ts).
 * Previously tested arbitrage-calculator.ts which has been removed.
 *
 * MIGRATION NOTE:
 * - Core price functions are now in components/price-calculator.ts
 * - isSameTokenPair/isReverseOrder are implemented locally in chain-instance.ts
 * - calculateIntraChainArbitrage is replaced by SimpleArbitrageDetector
 * - calculateCrossChainArbitrage is replaced by cross-chain-detector service
 *
 * @see components/price-calculator.ts
 * @see ADR-009: Test Architecture
 */

import { describe, it, expect } from '@jest/globals';
import {
  // Core price calculations from components/price-calculator
  safeBigIntDivision,
  safeBigIntDivisionOrNull,
  calculatePriceFromReserves,
  calculatePriceFromBigIntReserves,
  invertPrice,
  calculateSpread,
  calculateSpreadSafe,
  calculateProfitBetweenSources,
  getDefaultFee,
  getMinProfitThreshold,
  isValidPrice,
  isValidFee,
  areValidReserves,
  PriceCalculationError,
} from '../../src/components/price-calculator';

// =============================================================================
// P0-1 FIX: BigInt Precision Regression Tests
// =============================================================================

describe('P0-1: BigInt Precision (safeBigIntDivision)', () => {
  it('should handle simple division correctly', () => {
    expect(safeBigIntDivision(10n, 2n)).toBe(5);
    expect(safeBigIntDivision(100n, 4n)).toBe(25);
  });

  it('should handle division resulting in decimals', () => {
    expect(safeBigIntDivision(1n, 2n)).toBe(0.5);
    expect(safeBigIntDivision(1n, 3n)).toBeCloseTo(0.333333, 5);
    expect(safeBigIntDivision(2n, 3n)).toBeCloseTo(0.666666, 5);
  });

  // P0-FIX 4.4: Division by zero now throws PriceCalculationError
  it('should throw for zero denominator', () => {
    expect(() => safeBigIntDivision(100n, 0n)).toThrow(PriceCalculationError);
  });

  // Use safeBigIntDivisionOrNull for null-returning behavior
  it('safeBigIntDivisionOrNull should return null for zero denominator', () => {
    expect(safeBigIntDivisionOrNull(100n, 0n)).toBeNull();
  });

  it('should handle very large BigInt values (> 2^53) without precision loss', () => {
    // This is the key regression test for P0-1
    // JavaScript Number can only safely represent integers up to 2^53 - 1 (9007199254740991)
    // Reserve values in wei can easily exceed this (e.g., 1 billion tokens = 10^27 wei)

    // Test with values that would lose precision if converted to Number directly
    const reserve0 = BigInt('1000000000000000000000000000'); // 10^27 (1 billion tokens in wei)
    const reserve1 = BigInt('500000000000000000000000000');  // 5e26

    const result = safeBigIntDivision(reserve0, reserve1);

    // Should be exactly 2, not some imprecise value
    expect(result).toBe(2);
  });

  it('should preserve precision for realistic DeFi reserve values', () => {
    // Uniswap V3 pool reserves can be very large
    // ETH/USDC pool might have:
    // - 10,000 ETH (10^22 wei)
    // - 30,000,000 USDC (3*10^13 with 6 decimals)

    const ethReserve = BigInt('10000000000000000000000'); // 10,000 ETH in wei
    const usdcReserve = BigInt('30000000000000');         // 30,000,000 USDC (6 decimals)

    const price = safeBigIntDivision(ethReserve, usdcReserve);

    // Price = ethReserve / usdcReserve = 10^22 / (3*10^13) = 10^9 / 3 ≈ 333,333,333
    // This represents the raw ratio without decimal adjustment
    expect(price).toBeCloseTo(333333333.333, 0);
  });

  it('should handle small ratios accurately', () => {
    // Test small price ratios (like stablecoin pairs)
    const reserve0 = BigInt('1000000000000000000000000'); // 1M tokens
    const reserve1 = BigInt('1001000000000000000000000'); // 1.001M tokens (0.1% difference)

    const price = safeBigIntDivision(reserve0, reserve1);

    // Should be approximately 0.999001 (very close to 1)
    expect(price).toBeCloseTo(0.999001, 5);
  });

  it('should handle extreme ratios without overflow', () => {
    // Very large ratio
    const bigReserve = BigInt('1000000000000000000000000000000'); // 10^30
    const smallReserve = BigInt('1000000000000000000');           // 10^18

    const largeRatio = safeBigIntDivision(bigReserve, smallReserve);
    expect(largeRatio).toBe(1e12);

    // Very small ratio
    const smallRatio = safeBigIntDivision(smallReserve, bigReserve);
    expect(smallRatio).toBe(1e-12);
  });
});

describe('P0-1: calculatePriceFromBigIntReserves()', () => {
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
    // Values larger than Number.MAX_SAFE_INTEGER
    const reserve0 = BigInt('9007199254740992000000000000'); // > 2^53
    const reserve1 = BigInt('4503599627370496000000000000'); // > 2^52

    const result = calculatePriceFromBigIntReserves(reserve0, reserve1);

    // Should be exactly 2
    expect(result).toBe(2);
  });
});

// =============================================================================
// Price Calculation Tests
// =============================================================================

describe('Price Calculation Utilities', () => {
  describe('calculatePriceFromReserves()', () => {
    it('should calculate price correctly', () => {
      const price = calculatePriceFromReserves(
        '1000000000000000000000',
        '2000000000000000000000'
      );
      expect(price).toBe(0.5); // 1000/2000
    });

    it('should return null for zero reserve0', () => {
      const price = calculatePriceFromReserves('0', '2000000000000000000000');
      expect(price).toBeNull();
    });

    it('should return null for zero reserve1', () => {
      const price = calculatePriceFromReserves('1000000000000000000000', '0');
      expect(price).toBeNull();
    });

    it('should handle large numbers', () => {
      const price = calculatePriceFromReserves(
        '1000000000000000000000000000000', // 1e30
        '500000000000000000000000000000'   // 5e29
      );
      expect(price).toBe(2);
    });

    it('should accept BigInt reserves directly', () => {
      const price = calculatePriceFromReserves(
        BigInt('1000000000000000000000'),
        BigInt('2000000000000000000000')
      );
      expect(price).toBe(0.5);
    });
  });

  describe('invertPrice()', () => {
    it('should invert positive price', () => {
      expect(invertPrice(2)).toBe(0.5);
      expect(invertPrice(0.5)).toBe(2);
    });

    it('should return 0 for zero price', () => {
      expect(invertPrice(0)).toBe(0);
    });

    it('should handle very small prices', () => {
      const result = invertPrice(0.0001);
      expect(result).toBe(10000);
    });
  });

  describe('calculateSpread()', () => {
    it('should calculate positive spread', () => {
      const spread = calculateSpread(100, 110);
      expect(spread).toBeCloseTo(0.1, 5); // 10%
    });

    it('should calculate same result regardless of order', () => {
      const spread1 = calculateSpread(100, 110);
      const spread2 = calculateSpread(110, 100);
      expect(spread1).toBe(spread2);
    });

    it('should throw for zero prices', () => {
      expect(() => calculateSpread(0, 100)).toThrow(PriceCalculationError);
      expect(() => calculateSpread(100, 0)).toThrow(PriceCalculationError);
    });

    it('should calculate small spreads accurately', () => {
      const spread = calculateSpread(1000, 1001);
      expect(spread).toBeCloseTo(0.001, 5); // 0.1%
    });
  });

  describe('calculateSpreadSafe()', () => {
    it('should return 0 for invalid prices instead of throwing', () => {
      expect(calculateSpreadSafe(0, 100)).toBe(0);
      expect(calculateSpreadSafe(100, 0)).toBe(0);
    });

    it('should calculate spread for valid prices', () => {
      expect(calculateSpreadSafe(100, 110)).toBeCloseTo(0.1, 5);
    });
  });
});

// =============================================================================
// Profit Calculation Tests
// =============================================================================

describe('calculateProfitBetweenSources()', () => {
  it('should calculate profit between two price sources', () => {
    const result = calculateProfitBetweenSources(
      { price: 100, fee: 0.003, source: 'dex1' },
      { price: 110, fee: 0.003, source: 'dex2' }
    );

    expect(result.grossSpread).toBeCloseTo(0.1, 5); // 10%
    expect(result.totalFees).toBe(0.006); // 0.6%
    expect(result.netProfit).toBeCloseTo(0.094, 5); // 9.4%
    expect(result.isProfitable).toBe(true);
    expect(result.buySource).toBe('dex1');
    expect(result.sellSource).toBe('dex2');
    expect(result.buyPrice).toBe(100);
    expect(result.sellPrice).toBe(110);
  });

  it('should identify non-profitable opportunity', () => {
    const result = calculateProfitBetweenSources(
      { price: 100, fee: 0.003, source: 'dex1' },
      { price: 100.3, fee: 0.003, source: 'dex2' } // 0.3% spread, 0.6% fees
    );

    expect(result.isProfitable).toBe(false);
    expect(result.netProfit).toBeLessThan(0);
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

// =============================================================================
// Fee Utilities Tests
// =============================================================================

describe('Fee Utilities', () => {
  describe('getDefaultFee()', () => {
    it('should return 0.3% for standard DEXes', () => {
      expect(getDefaultFee('uniswap_v3')).toBe(0.003);
      expect(getDefaultFee('sushiswap')).toBe(0.003);
    });

    it('should return 0.04% for Curve', () => {
      expect(getDefaultFee('curve')).toBe(0.0004);
    });

    it('should return 0.04% for Balancer', () => {
      expect(getDefaultFee('balancer')).toBe(0.0004);
    });

    it('should return default for undefined', () => {
      expect(getDefaultFee(undefined)).toBe(0.003);
    });
  });
});

// =============================================================================
// Threshold Utilities Tests
// =============================================================================

describe('Threshold Utilities', () => {
  describe('getMinProfitThreshold()', () => {
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
});

// =============================================================================
// Validation Utilities Tests
// =============================================================================

describe('Validation Utilities', () => {
  describe('isValidPrice()', () => {
    it('should accept positive numbers', () => {
      expect(isValidPrice(100)).toBe(true);
      expect(isValidPrice(0.001)).toBe(true);
    });

    it('should reject zero', () => {
      expect(isValidPrice(0)).toBe(false);
    });

    it('should reject negative', () => {
      expect(isValidPrice(-100)).toBe(false);
    });

    it('should reject NaN', () => {
      expect(isValidPrice(NaN)).toBe(false);
    });

    it('should reject Infinity', () => {
      expect(isValidPrice(Infinity)).toBe(false);
    });
  });

  describe('isValidFee()', () => {
    it('should accept valid fees', () => {
      expect(isValidFee(0)).toBe(true);
      expect(isValidFee(0.003)).toBe(true);
      expect(isValidFee(0.1)).toBe(true);
    });

    it('should reject fees >= 1', () => {
      expect(isValidFee(1)).toBe(false);
      expect(isValidFee(1.5)).toBe(false);
    });

    it('should reject negative fees', () => {
      expect(isValidFee(-0.003)).toBe(false);
    });

    it('should reject NaN', () => {
      expect(isValidFee(NaN)).toBe(false);
    });
  });

  describe('areValidReserves()', () => {
    it('should accept valid reserves', () => {
      expect(areValidReserves('1000', '2000')).toBe(true);
      expect(areValidReserves(1000n, 2000n)).toBe(true);
    });

    it('should reject zero reserves', () => {
      expect(areValidReserves('0', '1000')).toBe(false);
      expect(areValidReserves('1000', '0')).toBe(false);
    });

    it('should reject invalid strings', () => {
      expect(areValidReserves('invalid', '1000')).toBe(false);
      expect(areValidReserves('1000', '')).toBe(false);
    });
  });
});
