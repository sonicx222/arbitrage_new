import { parseGasEstimate } from '../../src/index';

describe('parseGasEstimate', () => {
  describe('undefined/null inputs', () => {
    it('returns 0n for undefined', () => {
      expect(parseGasEstimate(undefined)).toBe(0n);
    });

    it('returns 0n for null (runtime safety)', () => {
      expect(parseGasEstimate(null as unknown as undefined)).toBe(0n);
    });
  });

  describe('bigint inputs', () => {
    it('returns the value unchanged for positive bigint', () => {
      expect(parseGasEstimate(21000n)).toBe(21000n);
    });

    it('returns 0n for zero bigint', () => {
      expect(parseGasEstimate(0n)).toBe(0n);
    });

    it('returns 0n for negative bigint', () => {
      expect(parseGasEstimate(-100n)).toBe(0n);
    });

    it('handles very large bigint values', () => {
      const large = BigInt('999999999999999999999');
      expect(parseGasEstimate(large)).toBe(large);
    });
  });

  describe('number inputs', () => {
    it('converts positive integer to bigint', () => {
      expect(parseGasEstimate(21000)).toBe(21000n);
    });

    it('floors floating point numbers', () => {
      expect(parseGasEstimate(21000.7)).toBe(21000n);
    });

    it('returns 0n for zero', () => {
      expect(parseGasEstimate(0)).toBe(0n);
    });

    it('returns 0n for negative numbers', () => {
      expect(parseGasEstimate(-5)).toBe(0n);
    });

    it('returns 0n for Infinity', () => {
      expect(parseGasEstimate(Infinity)).toBe(0n);
    });

    it('returns 0n for -Infinity', () => {
      expect(parseGasEstimate(-Infinity)).toBe(0n);
    });

    it('returns 0n for NaN', () => {
      expect(parseGasEstimate(NaN)).toBe(0n);
    });
  });

  describe('string inputs', () => {
    it('converts valid integer string', () => {
      expect(parseGasEstimate('21000')).toBe(21000n);
    });

    it('converts very large string values', () => {
      expect(parseGasEstimate('999999999999999999999')).toBe(BigInt('999999999999999999999'));
    });

    it('converts "0" to 0n', () => {
      expect(parseGasEstimate('0')).toBe(0n);
    });

    it('returns 0n for negative string values', () => {
      expect(parseGasEstimate('-100')).toBe(0n);
    });

    it('returns 0n for float strings (BigInt rejects them)', () => {
      expect(parseGasEstimate('1.5')).toBe(0n);
    });

    it('returns 0n for non-numeric strings', () => {
      expect(parseGasEstimate('abc')).toBe(0n);
    });

    it('returns 0n for empty string', () => {
      expect(parseGasEstimate('')).toBe(0n);
    });

    it('returns 0n for whitespace-only strings', () => {
      expect(parseGasEstimate('   ')).toBe(0n);
    });

    it('converts hex strings (BigInt supports 0x prefix)', () => {
      expect(parseGasEstimate('0x5208')).toBe(21000n);
    });
  });
});
