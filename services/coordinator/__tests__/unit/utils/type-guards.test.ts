/**
 * H-04: Unit tests for type-guards utility functions.
 *
 * Covers all 8 exported functions with focus on Redis stream deserialization
 * edge cases, where all values arrive as strings via .toString().
 *
 * @see services/coordinator/src/utils/type-guards.ts
 */
import {
  getString,
  getNumber,
  getNonNegativeNumber,
  getBoolean,
  getOptionalString,
  getOptionalNumber,
  unwrapMessageData,
  hasRequiredString,
} from '../../../src/utils/type-guards';

describe('type-guards', () => {
  // ===========================================================================
  // getString
  // ===========================================================================

  describe('getString()', () => {
    it('should return string value', () => {
      expect(getString({ key: 'hello' }, 'key')).toBe('hello');
    });

    it('should return empty string for missing key', () => {
      expect(getString({}, 'key')).toBe('');
    });

    it('should return default for non-string value', () => {
      expect(getString({ key: 42 }, 'key')).toBe('');
      expect(getString({ key: true }, 'key')).toBe('');
      expect(getString({ key: null }, 'key')).toBe('');
      expect(getString({ key: undefined }, 'key')).toBe('');
    });

    it('should return custom default', () => {
      expect(getString({}, 'key', 'fallback')).toBe('fallback');
    });

    it('should preserve empty string as valid value', () => {
      expect(getString({ key: '' }, 'key', 'fallback')).toBe('');
    });
  });

  // ===========================================================================
  // getNumber — H-01 regression tests
  // ===========================================================================

  describe('getNumber()', () => {
    it('should return number value', () => {
      expect(getNumber({ key: 42 }, 'key')).toBe(42);
      expect(getNumber({ key: 3.14 }, 'key')).toBe(3.14);
      expect(getNumber({ key: 0 }, 'key')).toBe(0);
      expect(getNumber({ key: -1 }, 'key')).toBe(-1);
    });

    it('should parse string-encoded numerics (H-01 fix)', () => {
      expect(getNumber({ key: '42' }, 'key')).toBe(42);
      expect(getNumber({ key: '3.14' }, 'key')).toBe(3.14);
      expect(getNumber({ key: '0' }, 'key')).toBe(0);
      expect(getNumber({ key: '-1.5' }, 'key')).toBe(-1.5);
      expect(getNumber({ key: '1e3' }, 'key')).toBe(1000);
    });

    it('should return default for missing key', () => {
      expect(getNumber({}, 'key')).toBe(0);
      expect(getNumber({}, 'key', 99)).toBe(99);
    });

    it('should return default for NaN', () => {
      expect(getNumber({ key: NaN }, 'key')).toBe(0);
      expect(getNumber({ key: NaN }, 'key', 5)).toBe(5);
    });

    it('should return default for non-numeric strings', () => {
      expect(getNumber({ key: 'not-a-number' }, 'key')).toBe(0);
      expect(getNumber({ key: 'abc123' }, 'key')).toBe(0);
      expect(getNumber({ key: '' }, 'key')).toBe(0);
    });

    it('should return default for non-number/non-string types', () => {
      expect(getNumber({ key: true }, 'key')).toBe(0);
      expect(getNumber({ key: null }, 'key')).toBe(0);
      expect(getNumber({ key: undefined }, 'key')).toBe(0);
      expect(getNumber({ key: {} }, 'key')).toBe(0);
      expect(getNumber({ key: [] }, 'key')).toBe(0);
    });

    it('should handle Infinity as valid number', () => {
      expect(getNumber({ key: Infinity }, 'key')).toBe(Infinity);
      expect(getNumber({ key: -Infinity }, 'key')).toBe(-Infinity);
    });

    it('should preserve zero (not fall through to default)', () => {
      expect(getNumber({ key: 0 }, 'key', 99)).toBe(0);
      expect(getNumber({ key: '0' }, 'key', 99)).toBe(0);
    });
  });

  // ===========================================================================
  // getNonNegativeNumber
  // ===========================================================================

  describe('getNonNegativeNumber()', () => {
    it('should return positive number', () => {
      expect(getNonNegativeNumber({ key: 42 }, 'key')).toBe(42);
    });

    it('should return zero', () => {
      expect(getNonNegativeNumber({ key: 0 }, 'key')).toBe(0);
    });

    it('should return default for negative number', () => {
      expect(getNonNegativeNumber({ key: -5 }, 'key')).toBe(0);
      expect(getNonNegativeNumber({ key: -5 }, 'key', 10)).toBe(10);
    });

    it('should parse string-encoded numerics', () => {
      expect(getNonNegativeNumber({ key: '42' }, 'key')).toBe(42);
      expect(getNonNegativeNumber({ key: '-5' }, 'key')).toBe(0);
    });

    it('should return default for missing key', () => {
      expect(getNonNegativeNumber({}, 'key')).toBe(0);
    });
  });

  // ===========================================================================
  // getBoolean
  // ===========================================================================

  describe('getBoolean()', () => {
    it('should return boolean value', () => {
      expect(getBoolean({ key: true }, 'key')).toBe(true);
      expect(getBoolean({ key: false }, 'key')).toBe(false);
    });

    it('should return default for missing key', () => {
      expect(getBoolean({}, 'key')).toBe(false);
      expect(getBoolean({}, 'key', true)).toBe(true);
    });

    it('should parse string "true" and "false" from Redis deserialization', () => {
      expect(getBoolean({ key: 'true' }, 'key')).toBe(true);
      expect(getBoolean({ key: 'false' }, 'key')).toBe(false);
      expect(getBoolean({ key: 'false' }, 'key', true)).toBe(false);
    });

    it('should return default for non-boolean types', () => {
      expect(getBoolean({ key: 1 }, 'key')).toBe(false);
      expect(getBoolean({ key: 0 }, 'key')).toBe(false);
      expect(getBoolean({ key: null }, 'key')).toBe(false);
      expect(getBoolean({ key: 'yes' }, 'key')).toBe(false);
      expect(getBoolean({ key: 'TRUE' }, 'key')).toBe(false);
      expect(getBoolean({ key: '' }, 'key')).toBe(false);
    });

    it('should preserve false (not fall through to default)', () => {
      expect(getBoolean({ key: false }, 'key', true)).toBe(false);
    });
  });

  // ===========================================================================
  // getOptionalString
  // ===========================================================================

  describe('getOptionalString()', () => {
    it('should return string value', () => {
      expect(getOptionalString({ key: 'hello' }, 'key')).toBe('hello');
    });

    it('should return undefined for missing key', () => {
      expect(getOptionalString({}, 'key')).toBeUndefined();
    });

    it('should return undefined for non-string value', () => {
      expect(getOptionalString({ key: 42 }, 'key')).toBeUndefined();
      expect(getOptionalString({ key: null }, 'key')).toBeUndefined();
    });

    it('should preserve empty string as valid value', () => {
      expect(getOptionalString({ key: '' }, 'key')).toBe('');
    });
  });

  // ===========================================================================
  // getOptionalNumber
  // ===========================================================================

  describe('getOptionalNumber()', () => {
    it('should return number value', () => {
      expect(getOptionalNumber({ key: 42 }, 'key')).toBe(42);
      expect(getOptionalNumber({ key: 0 }, 'key')).toBe(0);
    });

    it('should parse string-encoded numerics', () => {
      expect(getOptionalNumber({ key: '42.5' }, 'key')).toBe(42.5);
      expect(getOptionalNumber({ key: '0' }, 'key')).toBe(0);
    });

    it('should return undefined for missing key', () => {
      expect(getOptionalNumber({}, 'key')).toBeUndefined();
    });

    it('should return undefined for NaN', () => {
      expect(getOptionalNumber({ key: NaN }, 'key')).toBeUndefined();
    });

    it('should return undefined for non-numeric strings', () => {
      expect(getOptionalNumber({ key: 'abc' }, 'key')).toBeUndefined();
      expect(getOptionalNumber({ key: '' }, 'key')).toBeUndefined();
    });

    it('should return undefined for non-number/non-string types', () => {
      expect(getOptionalNumber({ key: true }, 'key')).toBeUndefined();
      expect(getOptionalNumber({ key: null }, 'key')).toBeUndefined();
    });
  });

  // ===========================================================================
  // unwrapMessageData
  // ===========================================================================

  describe('unwrapMessageData()', () => {
    it('should unwrap { type, data } envelope', () => {
      const inner = { id: '1', chain: 'ethereum' };
      const wrapped = { type: 'opportunity', data: inner };
      expect(unwrapMessageData(wrapped)).toBe(inner);
    });

    it('should return original data if not wrapped', () => {
      const data = { id: '1', chain: 'ethereum' };
      expect(unwrapMessageData(data)).toBe(data);
    });

    it('should return original data if type is not string', () => {
      const data = { type: 42, data: { id: '1' } };
      expect(unwrapMessageData(data)).toBe(data);
    });

    it('should return original data if data is not object', () => {
      const data = { type: 'test', data: 'not-object' };
      expect(unwrapMessageData(data)).toBe(data);
    });

    it('should return original data if data is null', () => {
      const data = { type: 'test', data: null };
      expect(unwrapMessageData(data)).toBe(data);
    });
  });

  // ===========================================================================
  // hasRequiredString
  // ===========================================================================

  describe('hasRequiredString()', () => {
    it('should return true for non-empty string', () => {
      expect(hasRequiredString({ id: 'abc-123' }, 'id')).toBe(true);
    });

    it('should return false for empty string', () => {
      expect(hasRequiredString({ id: '' }, 'id')).toBe(false);
    });

    it('should return false for missing key', () => {
      expect(hasRequiredString({}, 'id')).toBe(false);
    });

    it('should return false for non-string types', () => {
      expect(hasRequiredString({ id: 42 }, 'id')).toBe(false);
      expect(hasRequiredString({ id: null }, 'id')).toBe(false);
      expect(hasRequiredString({ id: true }, 'id')).toBe(false);
    });
  });
});
