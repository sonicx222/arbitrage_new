/**
 * Common Validators Unit Tests
 *
 * Tests for lightweight, pure-function validators used across the codebase.
 * Covers type guards, throwing validators, safe parsers, and address validators.
 */

import {
  // Type Guards
  isDefined,
  isNonEmptyString,
  isPositiveNumber,
  isNonNegativeNumber,
  isFiniteNumber,
  isValidPrice,
  isInteger,
  isPositiveInteger,

  // Validation (throw on failure)
  validateNonEmptyString,
  validatePositiveNumber,
  validateNonNegativeNumber,
  validatePositiveInteger,
  validateInRange,

  // Safe Parsing
  parseNumberSafe,
  parseIntegerSafe,
  parseBooleanSafe,

  // Array/Object
  isNonEmptyArray,
  isPlainObject,
  hasKey,

  // Address Validators
  looksLikeEthereumAddress,
  looksLikeSolanaAddress,

  // Assertions
  assert,
  assertDefined,
} from '../../src/utils/common-validators';

// =============================================================================
// Type Guards
// =============================================================================

describe('common-validators', () => {
  describe('isDefined', () => {
    it('should return true for defined values', () => {
      expect(isDefined(0)).toBe(true);
      expect(isDefined('')).toBe(true);
      expect(isDefined(false)).toBe(true);
      expect(isDefined([])).toBe(true);
      expect(isDefined({})).toBe(true);
    });

    it('should return false for null and undefined', () => {
      expect(isDefined(null)).toBe(false);
      expect(isDefined(undefined)).toBe(false);
    });
  });

  describe('isNonEmptyString', () => {
    it('should return true for non-empty strings', () => {
      expect(isNonEmptyString('hello')).toBe(true);
      expect(isNonEmptyString(' ')).toBe(true);
      expect(isNonEmptyString('0')).toBe(true);
    });

    it('should return false for empty string', () => {
      expect(isNonEmptyString('')).toBe(false);
    });

    it('should return false for non-string types', () => {
      expect(isNonEmptyString(0)).toBe(false);
      expect(isNonEmptyString(null)).toBe(false);
      expect(isNonEmptyString(undefined)).toBe(false);
      expect(isNonEmptyString(true)).toBe(false);
      expect(isNonEmptyString([])).toBe(false);
      expect(isNonEmptyString({})).toBe(false);
    });
  });

  describe('isPositiveNumber', () => {
    it('should return true for positive numbers', () => {
      expect(isPositiveNumber(1)).toBe(true);
      expect(isPositiveNumber(0.001)).toBe(true);
      expect(isPositiveNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
    });

    it('should return false for zero and negative', () => {
      expect(isPositiveNumber(0)).toBe(false);
      expect(isPositiveNumber(-1)).toBe(false);
      expect(isPositiveNumber(-0.001)).toBe(false);
    });

    it('should return false for NaN', () => {
      expect(isPositiveNumber(NaN)).toBe(false);
    });

    it('should reject Infinity', () => {
      expect(isPositiveNumber(Infinity)).toBe(false);
      expect(isPositiveNumber(-Infinity)).toBe(false);
    });

    it('should return false for non-number types', () => {
      expect(isPositiveNumber('1')).toBe(false);
      expect(isPositiveNumber(null)).toBe(false);
      expect(isPositiveNumber(undefined)).toBe(false);
      expect(isPositiveNumber(true)).toBe(false);
    });
  });

  describe('isNonNegativeNumber', () => {
    it('should return true for zero and positive', () => {
      expect(isNonNegativeNumber(0)).toBe(true);
      expect(isNonNegativeNumber(1)).toBe(true);
      expect(isNonNegativeNumber(0.001)).toBe(true);
    });

    it('should return false for negative', () => {
      expect(isNonNegativeNumber(-1)).toBe(false);
      expect(isNonNegativeNumber(-0.001)).toBe(false);
    });

    it('should return false for NaN', () => {
      expect(isNonNegativeNumber(NaN)).toBe(false);
    });

    it('should reject Infinity', () => {
      expect(isNonNegativeNumber(Infinity)).toBe(false);
      expect(isNonNegativeNumber(-Infinity)).toBe(false);
    });

    it('should return false for non-number types', () => {
      expect(isNonNegativeNumber('0')).toBe(false);
      expect(isNonNegativeNumber(null)).toBe(false);
      expect(isNonNegativeNumber(undefined)).toBe(false);
    });
  });

  describe('isFiniteNumber', () => {
    it('should return true for finite numbers', () => {
      expect(isFiniteNumber(0)).toBe(true);
      expect(isFiniteNumber(1)).toBe(true);
      expect(isFiniteNumber(-1)).toBe(true);
      expect(isFiniteNumber(0.001)).toBe(true);
      expect(isFiniteNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
    });

    it('should return false for Infinity and NaN', () => {
      expect(isFiniteNumber(Infinity)).toBe(false);
      expect(isFiniteNumber(-Infinity)).toBe(false);
      expect(isFiniteNumber(NaN)).toBe(false);
    });

    it('should return false for non-number types', () => {
      expect(isFiniteNumber('0')).toBe(false);
      expect(isFiniteNumber(null)).toBe(false);
      expect(isFiniteNumber(undefined)).toBe(false);
    });
  });

  describe('isValidPrice', () => {
    it('should return true for valid prices', () => {
      expect(isValidPrice(1500)).toBe(true);
      expect(isValidPrice(0.001)).toBe(true);
      expect(isValidPrice(1e-18)).toBe(true); // memecoin price
      expect(isValidPrice(100000)).toBe(true); // BTC-level price
    });

    it('should return false for zero', () => {
      expect(isValidPrice(0)).toBe(false);
    });

    it('should return false for negative', () => {
      expect(isValidPrice(-1)).toBe(false);
    });

    it('should return false for Infinity (unlike isPositiveNumber)', () => {
      expect(isValidPrice(Infinity)).toBe(false);
      expect(isValidPrice(-Infinity)).toBe(false);
    });

    it('should return false for NaN', () => {
      expect(isValidPrice(NaN)).toBe(false);
    });

    it('should return false for non-number types', () => {
      expect(isValidPrice('1500')).toBe(false);
      expect(isValidPrice(null)).toBe(false);
      expect(isValidPrice(undefined)).toBe(false);
    });
  });

  describe('isInteger', () => {
    it('should return true for integers', () => {
      expect(isInteger(0)).toBe(true);
      expect(isInteger(1)).toBe(true);
      expect(isInteger(-1)).toBe(true);
      expect(isInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    });

    it('should return false for non-integers', () => {
      expect(isInteger(0.5)).toBe(false);
      expect(isInteger(1.1)).toBe(false);
    });

    it('should return false for NaN and Infinity', () => {
      expect(isInteger(NaN)).toBe(false);
      expect(isInteger(Infinity)).toBe(false);
    });

    it('should return false for non-number types', () => {
      expect(isInteger('1')).toBe(false);
      expect(isInteger(null)).toBe(false);
    });
  });

  describe('isPositiveInteger', () => {
    it('should return true for positive integers', () => {
      expect(isPositiveInteger(1)).toBe(true);
      expect(isPositiveInteger(100)).toBe(true);
    });

    it('should return false for zero and negative integers', () => {
      expect(isPositiveInteger(0)).toBe(false);
      expect(isPositiveInteger(-1)).toBe(false);
    });

    it('should return false for non-integers', () => {
      expect(isPositiveInteger(1.5)).toBe(false);
      expect(isPositiveInteger(NaN)).toBe(false);
    });
  });

  // ===========================================================================
  // Validation Functions (throw on failure)
  // ===========================================================================

  describe('validateNonEmptyString', () => {
    it('should return value for valid strings', () => {
      expect(validateNonEmptyString('hello', 'field')).toBe('hello');
    });

    it('should throw for empty string', () => {
      expect(() => validateNonEmptyString('', 'field')).toThrow(
        'field must be a non-empty string'
      );
    });

    it('should throw for non-string types', () => {
      expect(() => validateNonEmptyString(null, 'field')).toThrow(
        'field must be a non-empty string'
      );
      expect(() => validateNonEmptyString(undefined, 'field')).toThrow(
        'field must be a non-empty string'
      );
      expect(() => validateNonEmptyString(42, 'field')).toThrow(
        'field must be a non-empty string'
      );
    });
  });

  describe('validatePositiveNumber', () => {
    it('should return value for positive numbers', () => {
      expect(validatePositiveNumber(1, 'amount')).toBe(1);
      expect(validatePositiveNumber(0.001, 'amount')).toBe(0.001);
    });

    it('should throw for zero', () => {
      expect(() => validatePositiveNumber(0, 'amount')).toThrow(
        'amount must be a positive number'
      );
    });

    it('should throw for negative', () => {
      expect(() => validatePositiveNumber(-1, 'amount')).toThrow(
        'amount must be a positive number'
      );
    });

    it('should throw for NaN', () => {
      expect(() => validatePositiveNumber(NaN, 'amount')).toThrow(
        'amount must be a positive number'
      );
    });

    it('should throw for non-number types', () => {
      expect(() => validatePositiveNumber('1', 'amount')).toThrow(
        'amount must be a positive number'
      );
    });
  });

  describe('validateNonNegativeNumber', () => {
    it('should return value for zero and positive', () => {
      expect(validateNonNegativeNumber(0, 'fee')).toBe(0);
      expect(validateNonNegativeNumber(1, 'fee')).toBe(1);
    });

    it('should throw for negative', () => {
      expect(() => validateNonNegativeNumber(-1, 'fee')).toThrow(
        'fee must be a non-negative number'
      );
    });

    it('should throw for NaN', () => {
      expect(() => validateNonNegativeNumber(NaN, 'fee')).toThrow(
        'fee must be a non-negative number'
      );
    });
  });

  describe('validatePositiveInteger', () => {
    it('should return value for positive integers', () => {
      expect(validatePositiveInteger(1, 'count')).toBe(1);
      expect(validatePositiveInteger(100, 'count')).toBe(100);
    });

    it('should throw for zero', () => {
      expect(() => validatePositiveInteger(0, 'count')).toThrow(
        'count must be a positive integer'
      );
    });

    it('should throw for non-integer', () => {
      expect(() => validatePositiveInteger(1.5, 'count')).toThrow(
        'count must be a positive integer'
      );
    });
  });

  describe('validateInRange', () => {
    it('should return value when in range', () => {
      expect(validateInRange(5, 0, 10, 'value')).toBe(5);
      expect(validateInRange(0, 0, 10, 'value')).toBe(0);
      expect(validateInRange(10, 0, 10, 'value')).toBe(10);
    });

    it('should throw when below range', () => {
      expect(() => validateInRange(-1, 0, 10, 'value')).toThrow(
        'value must be between 0 and 10'
      );
    });

    it('should throw when above range', () => {
      expect(() => validateInRange(11, 0, 10, 'value')).toThrow(
        'value must be between 0 and 10'
      );
    });

    it('should throw for NaN', () => {
      expect(() => validateInRange(NaN, 0, 10, 'value')).toThrow(
        'value must be between 0 and 10'
      );
    });

    it('should throw for Infinity', () => {
      expect(() => validateInRange(Infinity, 0, 10, 'value')).toThrow(
        'value must be between 0 and 10'
      );
    });
  });

  // ===========================================================================
  // Safe Parsing
  // ===========================================================================

  describe('parseNumberSafe', () => {
    it('should parse valid number strings', () => {
      expect(parseNumberSafe('42')).toBe(42);
      expect(parseNumberSafe('3.14')).toBe(3.14);
      expect(parseNumberSafe('-1.5')).toBe(-1.5);
      expect(parseNumberSafe('0')).toBe(0);
    });

    it('should return null for invalid strings', () => {
      expect(parseNumberSafe('abc')).toBeNull();
      expect(parseNumberSafe('NaN')).toBeNull();
      expect(parseNumberSafe('Infinity')).toBeNull();
    });

    it('should return null for undefined/empty', () => {
      expect(parseNumberSafe(undefined)).toBeNull();
      expect(parseNumberSafe('')).toBeNull();
    });

    it('should return default when provided and input is invalid', () => {
      expect(parseNumberSafe(undefined, 10)).toBe(10);
      expect(parseNumberSafe('', 10)).toBe(10);
      expect(parseNumberSafe('abc', 10)).toBe(10);
    });

    it('should handle hex strings', () => {
      // Number('0x1') = 1, which is finite, so it parses
      expect(parseNumberSafe('0x1')).toBe(1);
    });
  });

  describe('parseIntegerSafe', () => {
    it('should parse valid integer strings', () => {
      expect(parseIntegerSafe('42')).toBe(42);
      expect(parseIntegerSafe('-10')).toBe(-10);
      expect(parseIntegerSafe('0')).toBe(0);
    });

    it('should truncate float strings to integer', () => {
      expect(parseIntegerSafe('3.14')).toBe(3);
      expect(parseIntegerSafe('9.99')).toBe(9);
    });

    it('should return null for invalid strings', () => {
      expect(parseIntegerSafe('abc')).toBeNull();
    });

    it('should return null for undefined/empty', () => {
      expect(parseIntegerSafe(undefined)).toBeNull();
      expect(parseIntegerSafe('')).toBeNull();
    });

    it('should return default when provided and input is invalid', () => {
      expect(parseIntegerSafe(undefined, 5)).toBe(5);
      expect(parseIntegerSafe('abc', 5)).toBe(5);
    });
  });

  describe('parseBooleanSafe', () => {
    it('should parse truthy strings', () => {
      expect(parseBooleanSafe('true')).toBe(true);
      expect(parseBooleanSafe('TRUE')).toBe(true);
      expect(parseBooleanSafe('1')).toBe(true);
      expect(parseBooleanSafe('yes')).toBe(true);
      expect(parseBooleanSafe('Yes')).toBe(true);
    });

    it('should parse falsy strings', () => {
      expect(parseBooleanSafe('false')).toBe(false);
      expect(parseBooleanSafe('FALSE')).toBe(false);
      expect(parseBooleanSafe('0')).toBe(false);
      expect(parseBooleanSafe('no')).toBe(false);
      expect(parseBooleanSafe('No')).toBe(false);
    });

    it('should return null for unrecognized strings', () => {
      expect(parseBooleanSafe('maybe')).toBeNull();
      expect(parseBooleanSafe('2')).toBeNull();
    });

    it('should return null for undefined/empty', () => {
      expect(parseBooleanSafe(undefined)).toBeNull();
      expect(parseBooleanSafe('')).toBeNull();
    });

    it('should return default when provided', () => {
      expect(parseBooleanSafe(undefined, true)).toBe(true);
      expect(parseBooleanSafe('', false)).toBe(false);
      expect(parseBooleanSafe('maybe', true)).toBe(true);
    });
  });

  // ===========================================================================
  // Array/Object Validators
  // ===========================================================================

  describe('isNonEmptyArray', () => {
    it('should return true for non-empty arrays', () => {
      expect(isNonEmptyArray([1])).toBe(true);
      expect(isNonEmptyArray([1, 2, 3])).toBe(true);
      expect(isNonEmptyArray([undefined])).toBe(true);
    });

    it('should return false for empty arrays', () => {
      expect(isNonEmptyArray([])).toBe(false);
    });

    it('should return false for non-arrays', () => {
      expect(isNonEmptyArray(null)).toBe(false);
      expect(isNonEmptyArray(undefined)).toBe(false);
      expect(isNonEmptyArray('hello')).toBe(false);
      expect(isNonEmptyArray({})).toBe(false);
    });
  });

  describe('isPlainObject', () => {
    it('should return true for plain objects', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ key: 'value' })).toBe(true);
    });

    it('should return false for null', () => {
      expect(isPlainObject(null)).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject([1, 2])).toBe(false);
    });

    it('should return false for primitives', () => {
      expect(isPlainObject(42)).toBe(false);
      expect(isPlainObject('string')).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
    });
  });

  describe('hasKey', () => {
    it('should return true when object has key', () => {
      expect(hasKey({ name: 'test' }, 'name')).toBe(true);
      expect(hasKey({ count: 0 }, 'count')).toBe(true);
      expect(hasKey({ value: undefined }, 'value')).toBe(true);
    });

    it('should return false when object does not have key', () => {
      expect(hasKey({ name: 'test' }, 'age')).toBe(false);
      expect(hasKey({}, 'key')).toBe(false);
    });

    it('should return false for non-objects', () => {
      expect(hasKey(null, 'key')).toBe(false);
      expect(hasKey(undefined, 'key')).toBe(false);
      expect(hasKey(42, 'key')).toBe(false);
      expect(hasKey([], 'key')).toBe(false);
    });
  });

  // ===========================================================================
  // Address Validators
  // ===========================================================================

  describe('looksLikeEthereumAddress', () => {
    it('should match valid Ethereum addresses', () => {
      expect(looksLikeEthereumAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(true);
      expect(looksLikeEthereumAddress('0xdead000000000000000000000000000000000000')).toBe(true);
      expect(looksLikeEthereumAddress('0xABCDEF1234567890ABCDEF1234567890ABCDEF12')).toBe(true);
    });

    it('should reject invalid Ethereum addresses', () => {
      expect(looksLikeEthereumAddress('0x123')).toBe(false); // too short
      expect(looksLikeEthereumAddress('1234567890abcdef1234567890abcdef12345678')).toBe(false); // no 0x
      expect(looksLikeEthereumAddress('0xGGGG567890abcdef1234567890abcdef12345678')).toBe(false); // invalid hex
      expect(looksLikeEthereumAddress('')).toBe(false);
      expect(looksLikeEthereumAddress('0x1234567890abcdef1234567890abcdef1234567890')).toBe(false); // too long
    });
  });

  describe('looksLikeSolanaAddress', () => {
    it('should match valid Solana addresses', () => {
      // Typical Solana address (44 chars base58)
      expect(looksLikeSolanaAddress('11111111111111111111111111111111')).toBe(true); // 32 chars
      expect(looksLikeSolanaAddress('So11111111111111111111111111111111111111112')).toBe(true);
    });

    it('should reject invalid Solana addresses', () => {
      expect(looksLikeSolanaAddress('short')).toBe(false); // too short
      expect(looksLikeSolanaAddress('')).toBe(false);
      // Base58 excludes 0, O, I, l
      expect(looksLikeSolanaAddress('0OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO')).toBe(false);
    });
  });

  // ===========================================================================
  // Assertion Helpers
  // ===========================================================================

  describe('assert', () => {
    it('should not throw for true condition', () => {
      expect(() => assert(true, 'should not throw')).not.toThrow();
    });

    it('should throw for false condition with message', () => {
      expect(() => assert(false, 'custom error')).toThrow('custom error');
    });
  });

  describe('assertDefined', () => {
    it('should return value for defined values', () => {
      expect(assertDefined(42, 'num')).toBe(42);
      expect(assertDefined('hello', 'str')).toBe('hello');
      expect(assertDefined(0, 'zero')).toBe(0);
      expect(assertDefined('', 'empty')).toBe('');
      expect(assertDefined(false, 'bool')).toBe(false);
    });

    it('should throw for null', () => {
      expect(() => assertDefined(null, 'field')).toThrow(
        'field must be defined, got: null'
      );
    });

    it('should throw for undefined', () => {
      expect(() => assertDefined(undefined, 'field')).toThrow(
        'field must be defined, got: undefined'
      );
    });
  });
});
