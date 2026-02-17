/**
 * Unit tests for validators.js
 *
 * Tests validation utilities extracted during P2 refactoring.
 * @see scripts/lib/validators.js
 */

const { describe, it, expect } = require('@jest/globals');
const {
  validatePort,
  validateString,
  validateOptionalString,
  validateEnum
} = require('../validators');

describe('validators', () => {
  describe('validatePort', () => {
    it('should accept valid port numbers', () => {
      expect(validatePort(80, 'HTTP')).toBe(80);
      expect(validatePort(3000, 'App')).toBe(3000);
      expect(validatePort(65535, 'Max')).toBe(65535);
      expect(validatePort(1, 'Min')).toBe(1);
    });

    it('should reject non-number type', () => {
      expect(() => validatePort('3000', 'test')).toThrow('expected number, got string');
      expect(() => validatePort(undefined, 'test')).toThrow('expected number, got undefined');
      expect(() => validatePort(null, 'test')).toThrow('expected number, got object');
    });

    it('should reject NaN', () => {
      expect(() => validatePort(NaN, 'test')).toThrow('NaN');
    });

    it('should reject out-of-range ports', () => {
      expect(() => validatePort(0, 'test')).toThrow('Invalid port for test: 0');
      expect(() => validatePort(-1, 'test')).toThrow('Invalid port for test: -1');
      expect(() => validatePort(65536, 'test')).toThrow('Invalid port for test: 65536');
      expect(() => validatePort(99999, 'test')).toThrow('Invalid port for test: 99999');
    });

    it('should include context in error message', () => {
      expect(() => validatePort(-1, 'Redis')).toThrow('Invalid port for Redis');
    });
  });

  describe('validateString', () => {
    it('should accept valid strings', () => {
      expect(validateString('hello', 'field')).toBe('hello');
      expect(validateString('a', 'field')).toBe('a');
    });

    it('should reject non-string types', () => {
      expect(() => validateString(123, 'name')).toThrow('Invalid name: expected string, got number');
      expect(() => validateString(undefined, 'name')).toThrow('expected string, got undefined');
      expect(() => validateString(null, 'name')).toThrow('expected string, got object');
    });

    it('should reject empty string by default (minLength=1)', () => {
      expect(() => validateString('', 'name')).toThrow('too short');
    });

    it('should respect minLength option', () => {
      expect(validateString('ab', 'field', { minLength: 2 })).toBe('ab');
      expect(() => validateString('a', 'field', { minLength: 2 })).toThrow('too short');
    });

    it('should respect maxLength option', () => {
      expect(validateString('abc', 'field', { maxLength: 5 })).toBe('abc');
      expect(() => validateString('abcdef', 'field', { maxLength: 5 })).toThrow('too long');
    });

    it('should respect pattern option', () => {
      expect(validateString('abc', 'field', { pattern: /^[a-z]+$/ })).toBe('abc');
      expect(() => validateString('ABC', 'field', { pattern: /^[a-z]+$/ })).toThrow('does not match');
    });
  });

  describe('validateOptionalString', () => {
    it('should return undefined for null/undefined', () => {
      expect(validateOptionalString(null, 'field')).toBeUndefined();
      expect(validateOptionalString(undefined, 'field')).toBeUndefined();
    });

    it('should validate when value is provided', () => {
      expect(validateOptionalString('hello', 'field')).toBe('hello');
    });

    it('should reject invalid non-null values', () => {
      expect(() => validateOptionalString(123, 'field')).toThrow('expected string');
    });
  });

  describe('validateEnum', () => {
    it('should accept values in the allowed list', () => {
      expect(validateEnum('node', ['node', 'docker', 'redis'], 'type')).toBe('node');
      expect(validateEnum('docker', ['node', 'docker', 'redis'], 'type')).toBe('docker');
    });

    it('should reject values not in the allowed list', () => {
      expect(() => validateEnum('invalid', ['node', 'docker'], 'type'))
        .toThrow('Invalid type: "invalid"');
    });

    it('should reject undefined', () => {
      expect(() => validateEnum(undefined, ['a', 'b'], 'field'))
        .toThrow('Invalid field: "undefined"');
    });
  });

});
