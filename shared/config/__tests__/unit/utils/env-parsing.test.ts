/**
 * Regression tests for shared env parsing utilities.
 *
 * @see shared/config/src/utils/env-parsing.ts
 * @see Fix #14 in .agent-reports/services-deep-analysis.md
 */
import { safeParseInt, safeParseFloat } from '../../../src/utils/env-parsing';

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
