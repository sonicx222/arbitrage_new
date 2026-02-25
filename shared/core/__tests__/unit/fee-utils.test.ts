/**
 * Fee Utilities Unit Tests
 *
 * Tests for the canonical fee conversion and validation utilities.
 *
 * @see FEE_REPRESENTATION_ANALYSIS.md for context on fee formats
 */

import {
  // Types
  type FeeBasisPoints,
  type FeeDecimal,
  type UniswapV3FeeTier,

  // Constants
  BPS_DENOMINATOR,
  V3_FEE_DENOMINATOR,
  PERCENT_DENOMINATOR,
  FEE_CONSTANTS,
  VALID_V3_FEE_TIERS,
  LOW_FEE_DEXES,

  // Conversion functions
  bpsToDecimal,
  decimalToBps,
  v3TierToDecimal,
  decimalToV3Tier,
  percentToDecimal,
  decimalToPercent,

  // Validation
  isValidV3FeeTier,
  isValidFeeDecimal,
  isValidFeeBps,
  validateFee,
  getDefaultFeeForDex,
  resolveFeeValue,

  // Type helpers
  asBps,
  asDecimal,
} from '../../src/utils/fee-utils';

describe('Fee Utilities', () => {
  // ===========================================================================
  // Constants
  // ===========================================================================

  describe('Constants', () => {
    it('should have correct denominator values', () => {
      expect(BPS_DENOMINATOR).toBe(10000);
      expect(V3_FEE_DENOMINATOR).toBe(1_000_000);
      expect(PERCENT_DENOMINATOR).toBe(100);
    });

    it('should have correct fee constant values', () => {
      expect(FEE_CONSTANTS.UNISWAP_V2).toBe(0.003);
      expect(FEE_CONSTANTS.V3_LOWEST).toBe(0.0001);
      expect(FEE_CONSTANTS.V3_LOW).toBe(0.0005);
      expect(FEE_CONSTANTS.V3_MEDIUM).toBe(0.003);
      expect(FEE_CONSTANTS.V3_HIGH).toBe(0.01);
      expect(FEE_CONSTANTS.LOW_FEE).toBe(0.0004);
      expect(FEE_CONSTANTS.DEFAULT).toBe(0.003);
      expect(FEE_CONSTANTS.ZERO).toBe(0);
    });

    it('should have valid V3 fee tier set', () => {
      expect(VALID_V3_FEE_TIERS.has(100)).toBe(true);
      expect(VALID_V3_FEE_TIERS.has(500)).toBe(true);
      expect(VALID_V3_FEE_TIERS.has(3000)).toBe(true);
      expect(VALID_V3_FEE_TIERS.has(10000)).toBe(true);
      expect(VALID_V3_FEE_TIERS.size).toBe(4);
    });

    it('should have low fee DEX set', () => {
      expect(LOW_FEE_DEXES.has('curve')).toBe(true);
      expect(LOW_FEE_DEXES.has('balancer')).toBe(true);
      expect(LOW_FEE_DEXES.has('uniswap')).toBe(false);
    });
  });

  // ===========================================================================
  // Conversion Functions
  // ===========================================================================

  describe('bpsToDecimal', () => {
    const testCases = [
      { bps: 30, decimal: 0.003, description: '0.30%' },
      { bps: 25, decimal: 0.0025, description: '0.25%' },
      { bps: 10, decimal: 0.001, description: '0.10%' },
      { bps: 4, decimal: 0.0004, description: '0.04%' },
      { bps: 9, decimal: 0.0009, description: '0.09% (AAVE flash loan)' },
      { bps: 100, decimal: 0.01, description: '1.00%' },
      { bps: 0, decimal: 0, description: '0.00% (promotional)' },
      { bps: 10000, decimal: 1, description: '100.00%' },
    ];

    testCases.forEach(({ bps, decimal, description }) => {
      it(`should convert ${bps} bps to ${decimal} (${description})`, () => {
        expect(bpsToDecimal(bps)).toBeCloseTo(decimal, 10);
      });
    });

    it('should handle floating point precision', () => {
      expect(bpsToDecimal(1)).toBeCloseTo(0.0001, 10);
      expect(bpsToDecimal(5)).toBeCloseTo(0.0005, 10);
    });
  });

  describe('decimalToBps', () => {
    const testCases = [
      { decimal: 0.003, bps: 30, description: '0.30%' },
      { decimal: 0.0025, bps: 25, description: '0.25%' },
      { decimal: 0.001, bps: 10, description: '0.10%' },
      { decimal: 0.0004, bps: 4, description: '0.04%' },
      { decimal: 0.0009, bps: 9, description: '0.09%' },
      { decimal: 0, bps: 0, description: '0.00%' },
    ];

    testCases.forEach(({ decimal, bps, description }) => {
      it(`should convert ${decimal} to ${bps} bps (${description})`, () => {
        expect(decimalToBps(decimal)).toBe(bps);
      });
    });

    it('should round to nearest integer', () => {
      expect(decimalToBps(0.00035)).toBe(4); // rounds up from 3.5
      expect(decimalToBps(0.00034)).toBe(3); // rounds down from 3.4
    });
  });

  describe('v3TierToDecimal', () => {
    const testCases = [
      { tier: 100, decimal: 0.0001, description: '0.01%' },
      { tier: 500, decimal: 0.0005, description: '0.05%' },
      { tier: 3000, decimal: 0.003, description: '0.30%' },
      { tier: 10000, decimal: 0.01, description: '1.00%' },
    ];

    testCases.forEach(({ tier, decimal, description }) => {
      it(`should convert V3 tier ${tier} to ${decimal} (${description})`, () => {
        expect(v3TierToDecimal(tier as UniswapV3FeeTier)).toBeCloseTo(decimal, 10);
      });
    });
  });

  describe('decimalToV3Tier', () => {
    const testCases = [
      { decimal: 0.0001, tier: 100 },
      { decimal: 0.0005, tier: 500 },
      { decimal: 0.003, tier: 3000 },
      { decimal: 0.01, tier: 10000 },
    ];

    testCases.forEach(({ decimal, tier }) => {
      it(`should convert ${decimal} to V3 tier ${tier}`, () => {
        expect(decimalToV3Tier(decimal)).toBe(tier);
      });
    });
  });

  describe('percentToDecimal', () => {
    const testCases = [
      { percent: 0.3, decimal: 0.003 },
      { percent: 1, decimal: 0.01 },
      { percent: 0.06, decimal: 0.0006 },
      { percent: 0, decimal: 0 },
    ];

    testCases.forEach(({ percent, decimal }) => {
      it(`should convert ${percent}% to ${decimal}`, () => {
        expect(percentToDecimal(percent)).toBeCloseTo(decimal, 10);
      });
    });
  });

  describe('decimalToPercent', () => {
    const testCases = [
      { decimal: 0.003, percent: 0.3 },
      { decimal: 0.01, percent: 1 },
      { decimal: 0.0006, percent: 0.06 },
    ];

    testCases.forEach(({ decimal, percent }) => {
      it(`should convert ${decimal} to ${percent}%`, () => {
        expect(decimalToPercent(decimal)).toBeCloseTo(percent, 10);
      });
    });
  });

  describe('Roundtrip Conversions', () => {
    it('should roundtrip BPS -> decimal -> BPS', () => {
      const original = 30;
      const decimal = bpsToDecimal(original);
      const backToBps = decimalToBps(decimal);
      expect(backToBps).toBe(original);
    });

    it('should roundtrip V3 tier -> decimal -> V3 tier', () => {
      const tiers: UniswapV3FeeTier[] = [100, 500, 3000, 10000];
      tiers.forEach((tier) => {
        const decimal = v3TierToDecimal(tier);
        const backToTier = decimalToV3Tier(decimal);
        expect(backToTier).toBe(tier);
      });
    });
  });

  // ===========================================================================
  // Validation Functions
  // ===========================================================================

  describe('isValidV3FeeTier', () => {
    it('should return true for valid tiers', () => {
      expect(isValidV3FeeTier(100)).toBe(true);
      expect(isValidV3FeeTier(500)).toBe(true);
      expect(isValidV3FeeTier(3000)).toBe(true);
      expect(isValidV3FeeTier(10000)).toBe(true);
    });

    it('should return false for invalid tiers', () => {
      expect(isValidV3FeeTier(0)).toBe(false);
      expect(isValidV3FeeTier(30)).toBe(false);
      expect(isValidV3FeeTier(1000)).toBe(false);
      expect(isValidV3FeeTier(5000)).toBe(false);
      expect(isValidV3FeeTier(-100)).toBe(false);
    });
  });

  describe('isValidFeeDecimal', () => {
    it('should return true for valid fees', () => {
      expect(isValidFeeDecimal(0)).toBe(true);
      expect(isValidFeeDecimal(0.003)).toBe(true);
      expect(isValidFeeDecimal(0.5)).toBe(true);
      expect(isValidFeeDecimal(0.9999)).toBe(true);
    });

    it('should return false for invalid fees', () => {
      expect(isValidFeeDecimal(-0.001)).toBe(false);
      expect(isValidFeeDecimal(1)).toBe(false);
      expect(isValidFeeDecimal(1.5)).toBe(false);
      expect(isValidFeeDecimal(NaN)).toBe(false);
      expect(isValidFeeDecimal(Infinity)).toBe(false);
      expect(isValidFeeDecimal(-Infinity)).toBe(false);
    });
  });

  describe('isValidFeeBps', () => {
    it('should return true for valid BPS values', () => {
      expect(isValidFeeBps(0)).toBe(true);
      expect(isValidFeeBps(30)).toBe(true);
      expect(isValidFeeBps(10000)).toBe(true);
    });

    it('should return false for invalid BPS values', () => {
      expect(isValidFeeBps(-1)).toBe(false);
      expect(isValidFeeBps(10001)).toBe(false);
      expect(isValidFeeBps(30.5)).toBe(false); // not integer
      expect(isValidFeeBps(NaN)).toBe(false);
      expect(isValidFeeBps(Infinity)).toBe(false);
    });
  });

  describe('validateFee', () => {
    it('should return valid fees unchanged', () => {
      expect(validateFee(0.003)).toBe(0.003);
      expect(validateFee(0)).toBe(0);
      expect(validateFee(0.5)).toBe(0.5);
    });

    it('should return default for undefined/null', () => {
      expect(validateFee(undefined)).toBe(FEE_CONSTANTS.DEFAULT);
      expect(validateFee(null)).toBe(FEE_CONSTANTS.DEFAULT);
    });

    it('should return default for invalid values', () => {
      expect(validateFee(NaN)).toBe(FEE_CONSTANTS.DEFAULT);
      expect(validateFee(Infinity)).toBe(FEE_CONSTANTS.DEFAULT);
      expect(validateFee(-Infinity)).toBe(FEE_CONSTANTS.DEFAULT);
      expect(validateFee(-0.01)).toBe(FEE_CONSTANTS.DEFAULT);
      expect(validateFee(1.5)).toBe(FEE_CONSTANTS.DEFAULT);
    });

    it('should use custom default when provided', () => {
      const customDefault = 0.0001;
      expect(validateFee(undefined, customDefault)).toBe(customDefault);
      expect(validateFee(NaN, customDefault)).toBe(customDefault);
    });

    it('should handle edge case: fee = 0 is valid (promotional)', () => {
      // This is the bug that would occur with || instead of ??
      expect(validateFee(0)).toBe(0);
      expect(validateFee(0, 0.003)).toBe(0);
    });
  });

  describe('getDefaultFeeForDex', () => {
    it('should return low fee for Curve and Balancer', () => {
      expect(getDefaultFeeForDex('curve')).toBe(FEE_CONSTANTS.LOW_FEE);
      expect(getDefaultFeeForDex('Curve')).toBe(FEE_CONSTANTS.LOW_FEE);
      expect(getDefaultFeeForDex('CURVE')).toBe(FEE_CONSTANTS.LOW_FEE);
      expect(getDefaultFeeForDex('balancer')).toBe(FEE_CONSTANTS.LOW_FEE);
      expect(getDefaultFeeForDex('Balancer')).toBe(FEE_CONSTANTS.LOW_FEE);
    });

    it('should return default fee for other DEXes', () => {
      expect(getDefaultFeeForDex('uniswap')).toBe(FEE_CONSTANTS.DEFAULT);
      expect(getDefaultFeeForDex('sushiswap')).toBe(FEE_CONSTANTS.DEFAULT);
      expect(getDefaultFeeForDex('pancakeswap')).toBe(FEE_CONSTANTS.DEFAULT);
    });

    it('should return default fee when dex name is undefined', () => {
      expect(getDefaultFeeForDex(undefined)).toBe(FEE_CONSTANTS.DEFAULT);
    });
  });

  describe('resolveFeeValue', () => {
    it('should return explicit fee when provided', () => {
      expect(resolveFeeValue(0.005, 'uniswap')).toBe(0.005);
      expect(resolveFeeValue(0.001, 'curve')).toBe(0.001);
    });

    it('should return default when fee is undefined', () => {
      expect(resolveFeeValue(undefined, 'uniswap')).toBe(FEE_CONSTANTS.DEFAULT);
      expect(resolveFeeValue(undefined, 'curve')).toBe(FEE_CONSTANTS.LOW_FEE);
    });

    it('should handle fee = 0 correctly (nullish coalescing)', () => {
      // This is the critical bug fix - 0 should not fall back to default
      expect(resolveFeeValue(0, 'uniswap')).toBe(0);
      expect(resolveFeeValue(0, 'curve')).toBe(0);
    });

    it('should fall back to default for NaN fee', () => {
      expect(resolveFeeValue(NaN, 'uniswap')).toBe(FEE_CONSTANTS.DEFAULT);
      expect(resolveFeeValue(NaN, 'curve')).toBe(FEE_CONSTANTS.LOW_FEE);
    });

    it('should fall back to default for Infinity fee', () => {
      expect(resolveFeeValue(Infinity, 'uniswap')).toBe(FEE_CONSTANTS.DEFAULT);
      expect(resolveFeeValue(-Infinity, 'curve')).toBe(FEE_CONSTANTS.LOW_FEE);
    });

    it('should fall back to default for negative fee', () => {
      expect(resolveFeeValue(-0.01, 'uniswap')).toBe(FEE_CONSTANTS.DEFAULT);
    });

    it('should fall back to default for fee >= 1 (100%)', () => {
      expect(resolveFeeValue(1.5, 'uniswap')).toBe(FEE_CONSTANTS.DEFAULT);
    });
  });

  // ===========================================================================
  // Type Helpers
  // ===========================================================================

  describe('Type Helpers', () => {
    it('asBps should create FeeBasisPoints type', () => {
      const bps: FeeBasisPoints = asBps(30);
      expect(bps).toBe(30);
    });

    it('asDecimal should create FeeDecimal type', () => {
      const decimal: FeeDecimal = asDecimal(0.003);
      expect(decimal).toBe(0.003);
    });
  });

  // ===========================================================================
  // Cross-Format Consistency
  // ===========================================================================

  describe('Cross-Format Consistency', () => {
    /**
     * Test cases from FEE_REPRESENTATION_ANALYSIS.md
     * Ensures all formats are correctly related
     */
    const crossFormatCases = [
      { bps: 30, decimal: 0.003, percent: 0.3, v3Tier: 3000 },
      { bps: 25, decimal: 0.0025, percent: 0.25, v3Tier: 2500 },
      { bps: 4, decimal: 0.0004, percent: 0.04, v3Tier: 400 },
      { bps: 9, decimal: 0.0009, percent: 0.09, v3Tier: 900 },
      { bps: 100, decimal: 0.01, percent: 1, v3Tier: 10000 },
      { bps: 1, decimal: 0.0001, percent: 0.01, v3Tier: 100 },
      { bps: 5, decimal: 0.0005, percent: 0.05, v3Tier: 500 },
    ];

    crossFormatCases.forEach(({ bps, decimal, percent, v3Tier }) => {
      describe(`${bps} BPS = ${decimal} decimal = ${percent}% = ${v3Tier} V3 tier`, () => {
        it('BPS to decimal', () => {
          expect(bpsToDecimal(bps)).toBeCloseTo(decimal, 10);
        });

        it('decimal to BPS', () => {
          expect(decimalToBps(decimal)).toBe(bps);
        });

        it('percent to decimal', () => {
          expect(percentToDecimal(percent)).toBeCloseTo(decimal, 10);
        });

        it('decimal to percent', () => {
          expect(decimalToPercent(decimal)).toBeCloseTo(percent, 10);
        });

        it('V3 tier to decimal', () => {
          expect(v3TierToDecimal(v3Tier)).toBeCloseTo(decimal, 10);
        });

        it('decimal to V3 tier', () => {
          expect(decimalToV3Tier(decimal)).toBe(v3Tier);
        });
      });
    });
  });
});
