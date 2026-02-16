/**
 * BigInt Utilities Unit Tests
 *
 * Tests for safe BigInt <-> Number conversion utilities.
 *
 * P0 FIX: These tests cover the safeBigIntToDecimal function which
 * prevents precision loss for extremely large token amounts.
 *
 * @see bigint-utils.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  safeBigIntToDecimal,
  safeBigIntBatchToDecimal,
  MAX_SAFE_BIGINT,
  bigIntToNumber,
  fractionToBigInt,
  bigIntToFraction,
  applyFraction,
  formatWeiAsEth,
} from '../../src/utils/bigint-utils';

// =============================================================================
// safeBigIntToDecimal Tests
// =============================================================================

describe('safeBigIntToDecimal', () => {
  describe('Basic Conversions', () => {
    it('should convert 1 ETH (18 decimals) correctly', () => {
      const oneEth = BigInt('1000000000000000000'); // 1e18
      const result = safeBigIntToDecimal(oneEth, 18);
      expect(result).toBe(1);
    });

    it('should convert 1.5 ETH correctly', () => {
      const oneAndHalfEth = BigInt('1500000000000000000');
      const result = safeBigIntToDecimal(oneAndHalfEth, 18);
      expect(result).toBeCloseTo(1.5, 10);
    });

    it('should convert small amounts correctly', () => {
      const smallAmount = BigInt('1000000'); // 1 USDC (6 decimals)
      const result = safeBigIntToDecimal(smallAmount, 6);
      expect(result).toBe(1);
    });

    it('should handle zero', () => {
      const result = safeBigIntToDecimal(0n, 18);
      expect(result).toBe(0);
    });

    it('should accept string input', () => {
      const result = safeBigIntToDecimal('1000000000000000000', 18);
      expect(result).toBe(1);
    });
  });

  describe('Precision Handling', () => {
    it('should preserve precision for values within MAX_SAFE_INTEGER', () => {
      // 9007199254740991n (MAX_SAFE_INTEGER) / 1e18 = 0.009007199254740991
      const result = safeBigIntToDecimal(MAX_SAFE_BIGINT, 18);
      expect(result).not.toBeNull();
      expect(result).toBeCloseTo(0.009007199254740991, 10);
    });

    it('should handle values just above MAX_SAFE_INTEGER', () => {
      // 10^19 (10 quintillion) - larger than MAX_SAFE_INTEGER (9 * 10^15)
      const largeAmount = BigInt('10000000000000000000'); // 10 ETH in wei
      const result = safeBigIntToDecimal(largeAmount, 18);
      expect(result).not.toBeNull();
      expect(result).toBeCloseTo(10, 5);
    });

    it('should handle very large amounts (1 million ETH)', () => {
      // 1,000,000 ETH in wei
      const millionEth = BigInt('1000000000000000000000000'); // 10^24
      const result = safeBigIntToDecimal(millionEth, 18);
      expect(result).not.toBeNull();
      expect(result).toBeCloseTo(1_000_000, 0);
    });
  });

  describe('Edge Cases', () => {
    it('should return null for astronomically large values', () => {
      // 10^60 - way beyond safe integer range even after division
      const astronomicalAmount = BigInt('1' + '0'.repeat(60));
      const result = safeBigIntToDecimal(astronomicalAmount, 18);
      expect(result).toBeNull();
    });

    it('should handle invalid string input gracefully', () => {
      const result = safeBigIntToDecimal('not-a-number', 18);
      expect(result).toBeNull();
    });

    it('should handle negative values', () => {
      const negativeAmount = BigInt('-1000000000000000000');
      const result = safeBigIntToDecimal(negativeAmount, 18);
      expect(result).not.toBeNull();
      expect(result).toBe(-1);
    });

    it('should handle 0 decimals', () => {
      const result = safeBigIntToDecimal(BigInt('12345'), 0);
      expect(result).toBe(12345);
    });

    it('should handle high decimals (24)', () => {
      const amount = BigInt('1' + '0'.repeat(24)); // 1e24
      const result = safeBigIntToDecimal(amount, 24);
      expect(result).toBe(1);
    });
  });

  describe('Real-World Token Amounts', () => {
    it('should handle USDC swap (6 decimals)', () => {
      // $1,000,000 USDC swap
      const usdcAmount = BigInt('1000000000000'); // 1e12 = 1M USDC
      const result = safeBigIntToDecimal(usdcAmount, 6);
      expect(result).toBe(1_000_000);
    });

    it('should handle WBTC (8 decimals)', () => {
      // 100 BTC
      const wbtcAmount = BigInt('10000000000'); // 100 * 10^8
      const result = safeBigIntToDecimal(wbtcAmount, 8);
      expect(result).toBe(100);
    });

    it('should handle large memecoin balance (18 decimals)', () => {
      // 1 trillion tokens
      const memecoinAmount = BigInt('1000000000000000000000000000000'); // 10^30
      const result = safeBigIntToDecimal(memecoinAmount, 18);
      expect(result).not.toBeNull();
      expect(result).toBeCloseTo(1_000_000_000_000, 0);
    });
  });
});

// =============================================================================
// safeBigIntBatchToDecimal Tests
// =============================================================================

describe('safeBigIntBatchToDecimal', () => {
  it('should convert batch of amounts with same decimals', () => {
    const amounts = {
      amount0In: '1000000000000000000',
      amount0Out: '0',
      amount1In: '0',
      amount1Out: '2000000000000000000',
    };

    const result = safeBigIntBatchToDecimal(amounts, 18);
    expect(result).not.toBeNull();
    expect(result!.amount0In).toBe(1);
    expect(result!.amount0Out).toBe(0);
    expect(result!.amount1In).toBe(0);
    expect(result!.amount1Out).toBe(2);
  });

  it('should convert batch with different decimals per field', () => {
    const amounts = {
      ethAmount: '1000000000000000000', // 18 decimals
      usdcAmount: '1000000',            // 6 decimals
    };

    const decimals = {
      ethAmount: 18,
      usdcAmount: 6,
    };

    const result = safeBigIntBatchToDecimal(amounts, decimals);
    expect(result).not.toBeNull();
    expect(result!.ethAmount).toBe(1);
    expect(result!.usdcAmount).toBe(1);
  });

  it('should return null if any conversion fails', () => {
    const amounts = {
      normalAmount: '1000000000000000000',
      invalidAmount: 'not-a-number',
    };

    const result = safeBigIntBatchToDecimal(amounts, 18);
    expect(result).toBeNull();
  });
});

// =============================================================================
// Existing bigint-utils Functions (Regression Tests)
// =============================================================================

describe('bigIntToNumber', () => {
  it('should convert small bigint to number', () => {
    expect(bigIntToNumber(1000n)).toBe(1000);
  });

  it('should return Infinity for very large positive bigint', () => {
    const veryLarge = BigInt('1' + '0'.repeat(400));
    expect(bigIntToNumber(veryLarge)).toBe(Infinity);
  });

  it('should return -Infinity for very large negative bigint', () => {
    const veryNegative = BigInt('-1' + '0'.repeat(400));
    expect(bigIntToNumber(veryNegative)).toBe(-Infinity);
  });
});

describe('fractionToBigInt and bigIntToFraction', () => {
  it('should round-trip 5%', () => {
    const fraction = 0.05;
    const scaled = fractionToBigInt(fraction);
    const roundTripped = bigIntToFraction(scaled);
    expect(roundTripped).toBeCloseTo(fraction, 4);
  });

  it('should handle zero', () => {
    expect(fractionToBigInt(0)).toBe(0n);
    expect(bigIntToFraction(0n)).toBe(0);
  });

  it('should handle NaN input', () => {
    expect(fractionToBigInt(NaN)).toBe(0n);
  });

  it('should handle Infinity input', () => {
    expect(fractionToBigInt(Infinity)).toBe(0n);
  });

  it('should handle fractions > 1 without clamping (P2 fix)', () => {
    // 150% profit should produce 15000n with default scale 10000
    expect(fractionToBigInt(1.5)).toBe(15000n);
    expect(fractionToBigInt(2.0)).toBe(20000n);
  });

  it('should handle negative fractions', () => {
    expect(fractionToBigInt(-0.05)).toBe(-500n);
    expect(fractionToBigInt(-1.5)).toBe(-15000n);
  });
});

describe('applyFraction', () => {
  it('should calculate 5% of 1 ETH', () => {
    const oneEth = BigInt('1000000000000000000');
    const fivePercent = applyFraction(oneEth, 0.05);
    const expected = BigInt('50000000000000000'); // 0.05 ETH
    expect(fivePercent).toBe(expected);
  });

  it('should handle zero fraction', () => {
    const oneEth = BigInt('1000000000000000000');
    expect(applyFraction(oneEth, 0)).toBe(0n);
  });
});

// =============================================================================
// formatWeiAsEth Tests
// =============================================================================

describe('formatWeiAsEth', () => {
  it('should format 1.5 ETH correctly', () => {
    expect(formatWeiAsEth(1500000000000000000n)).toBe('1.5');
  });

  it('should format 1 ETH as integer string', () => {
    expect(formatWeiAsEth(1000000000000000000n)).toBe('1');
  });

  it('should format with custom decimal places', () => {
    expect(formatWeiAsEth(1234567890000000000n, 4)).toBe('1.2345');
  });

  it('should format zero', () => {
    expect(formatWeiAsEth(0n)).toBe('0');
  });

  it('should format small amounts', () => {
    // 0.001 ETH
    expect(formatWeiAsEth(1000000000000000n)).toBe('0.001');
  });

  it('should format negative values', () => {
    expect(formatWeiAsEth(-1500000000000000000n)).toBe('-1.5');
    expect(formatWeiAsEth(-1000000000000000000n)).toBe('-1');
  });

  it('should handle negative zero as positive', () => {
    expect(formatWeiAsEth(0n)).toBe('0');
  });

  it('should throw RangeError for decimals > 18', () => {
    expect(() => formatWeiAsEth(1000000000000000000n, 19)).toThrow(RangeError);
    expect(() => formatWeiAsEth(1000000000000000000n, 19)).toThrow(
      'decimals must be between 0 and 18'
    );
  });

  it('should throw RangeError for negative decimals', () => {
    expect(() => formatWeiAsEth(1000000000000000000n, -1)).toThrow(RangeError);
  });

  it('should handle 0 decimal places', () => {
    expect(formatWeiAsEth(1500000000000000000n, 0)).toBe('1');
  });
});
