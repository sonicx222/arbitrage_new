/**
 * Regression tests for shared env parsing utilities.
 *
 * @see shared/config/src/utils/env-parsing.ts
 * @see Fix #14 in .agent-reports/services-deep-analysis.md
 */
import {
  safeParseInt,
  safeParseFloat,
  safeParseFloatBounded,
  safeParseIntBounded,
  safeParseBigInt,
} from '../../../src/utils/env-parsing';

describe('safeParseInt', () => {
  it('should parse valid integer string', () => {
    expect(safeParseInt('42', 0)).toBe(42);
  });

  it('should return default for undefined', () => {
    expect(safeParseInt(undefined, 99)).toBe(99);
  });

  it('should return default for empty string', () => {
    expect(safeParseInt('', 99)).toBe(99);
  });

  it('should return default for non-numeric string', () => {
    expect(safeParseInt('abc', 99)).toBe(99);
  });

  it('should parse negative integers', () => {
    expect(safeParseInt('-5', 0)).toBe(-5);
  });

  it('should parse zero', () => {
    expect(safeParseInt('0', 99)).toBe(0);
  });

  it('should truncate floats to integers', () => {
    expect(safeParseInt('3.14', 0)).toBe(3);
  });

  it('should handle leading/trailing whitespace', () => {
    expect(safeParseInt('  42  ', 0)).toBe(42);
  });
});

describe('safeParseFloat', () => {
  it('should parse valid float string', () => {
    expect(safeParseFloat('3.14', 0)).toBeCloseTo(3.14);
  });

  it('should return default for undefined', () => {
    expect(safeParseFloat(undefined, 0.5)).toBe(0.5);
  });

  it('should return default for empty string', () => {
    expect(safeParseFloat('', 0.5)).toBe(0.5);
  });

  it('should return default for non-numeric string', () => {
    expect(safeParseFloat('abc', 0.5)).toBe(0.5);
  });

  it('should parse negative floats', () => {
    expect(safeParseFloat('-1.5', 0)).toBeCloseTo(-1.5);
  });

  it('should parse zero', () => {
    expect(safeParseFloat('0', 99)).toBe(0);
  });

  it('should parse zero point zero', () => {
    expect(safeParseFloat('0.0', 99)).toBe(0);
  });

  it('should parse integers as floats', () => {
    expect(safeParseFloat('42', 0)).toBe(42);
  });
});

describe('safeParseFloatBounded', () => {
  it('should parse a value within bounds', () => {
    expect(safeParseFloatBounded('0.5', 0, 0, 1)).toBeCloseTo(0.5);
  });

  it('should return default for undefined', () => {
    expect(safeParseFloatBounded(undefined, 0.3, 0, 1)).toBe(0.3);
  });

  it('should return default for empty string', () => {
    expect(safeParseFloatBounded('', 0.3, 0, 1)).toBe(0.3);
  });

  it('should return default for NaN', () => {
    expect(safeParseFloatBounded('abc', 0.3, 0, 1)).toBe(0.3);
  });

  it('should return default for value below minimum', () => {
    expect(safeParseFloatBounded('-0.1', 0.3, 0, 1)).toBe(0.3);
  });

  it('should return default for value above maximum', () => {
    expect(safeParseFloatBounded('1.5', 0.3, 0, 1)).toBe(0.3);
  });

  it('should accept value at minimum boundary', () => {
    expect(safeParseFloatBounded('0', 0.3, 0, 1)).toBe(0);
  });

  it('should accept value at maximum boundary', () => {
    expect(safeParseFloatBounded('1', 0.3, 0, 1)).toBe(1);
  });

  it('should warn with label on out-of-range value', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    safeParseFloatBounded('2.0', 0.5, 0, 1, 'MY_ENV_VAR');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MY_ENV_VAR'));
    warnSpy.mockRestore();
  });
});

describe('safeParseIntBounded', () => {
  it('should parse a valid integer at or above minimum', () => {
    expect(safeParseIntBounded('5', 1, 1)).toBe(5);
  });

  it('should return default for undefined', () => {
    expect(safeParseIntBounded(undefined, 10, 1)).toBe(10);
  });

  it('should return default for NaN', () => {
    expect(safeParseIntBounded('abc', 10, 1)).toBe(10);
  });

  it('should clamp to minimum when below minimum', () => {
    expect(safeParseIntBounded('0', 10, 1)).toBe(1);
  });

  it('should accept value exactly at minimum', () => {
    expect(safeParseIntBounded('1', 10, 1)).toBe(1);
  });

  it('should warn with label when clamped', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    safeParseIntBounded('0', 10, 1, 'WORKER_COUNT');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('WORKER_COUNT'));
    warnSpy.mockRestore();
  });
});

describe('safeParseBigInt', () => {
  it('should parse a valid positive integer', () => {
    expect(safeParseBigInt('42', '0')).toBe(BigInt(42));
  });

  it('should return default BigInt for undefined', () => {
    expect(safeParseBigInt(undefined, '100')).toBe(BigInt(100));
  });

  it('should return default BigInt for empty string', () => {
    expect(safeParseBigInt('', '100')).toBe(BigInt(100));
  });

  it('should return default BigInt for non-integer string', () => {
    expect(safeParseBigInt('abc', '0')).toBe(BigInt(0));
  });

  it('should return default BigInt for float string', () => {
    expect(safeParseBigInt('3.14', '0')).toBe(BigInt(0));
  });

  it('should parse negative integers', () => {
    expect(safeParseBigInt('-5', '0')).toBe(BigInt(-5));
  });

  it('should parse zero', () => {
    expect(safeParseBigInt('0', '99')).toBe(BigInt(0));
  });

  it('should handle leading/trailing whitespace', () => {
    expect(safeParseBigInt('  42  ', '0')).toBe(BigInt(42));
  });
});
