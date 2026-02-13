/**
 * Utils Unit Tests
 *
 * Tests for shared parsing utility functions used across all factory event parsers.
 *
 * @see factory-subscription/parsers/utils.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  extractAddressFromTopic,
  extractAddressFromDataWord,
  extractBigIntFromDataWord,
  extractUint256FromDataWord,
  parseSignedInt24,
  validateLogStructure,
  HEX_PREFIX_LENGTH,
  WORD_SIZE_HEX,
  ADDRESS_PADDING_OFFSET,
  FIRST_ADDRESS_START,
  SECOND_VALUE_START,
  ZERO_ADDRESS,
} from '../../../../src/factory-subscription/parsers/utils';

// =============================================================================
// Constants Tests
// =============================================================================

describe('Constants', () => {
  it('should have correct HEX_PREFIX_LENGTH', () => {
    expect(HEX_PREFIX_LENGTH).toBe(2);
  });

  it('should have correct WORD_SIZE_HEX', () => {
    expect(WORD_SIZE_HEX).toBe(64);
  });

  it('should have correct ADDRESS_PADDING_OFFSET', () => {
    expect(ADDRESS_PADDING_OFFSET).toBe(24);
  });

  it('should have correct FIRST_ADDRESS_START', () => {
    // HEX_PREFIX_LENGTH + ADDRESS_PADDING_OFFSET = 2 + 24 = 26
    expect(FIRST_ADDRESS_START).toBe(26);
  });

  it('should have correct SECOND_VALUE_START', () => {
    // HEX_PREFIX_LENGTH + WORD_SIZE_HEX + ADDRESS_PADDING_OFFSET = 2 + 64 + 24 = 90
    expect(SECOND_VALUE_START).toBe(90);
  });

  it('should have correct ZERO_ADDRESS', () => {
    expect(ZERO_ADDRESS).toBe('0x0000000000000000000000000000000000000000');
  });
});

// =============================================================================
// extractAddressFromTopic Tests
// =============================================================================

describe('extractAddressFromTopic', () => {
  it('should extract address from 0x-prefixed 32-byte padded topic', () => {
    const topic = '0x000000000000000000000000aabbccddee11223344556677889900aabbccddee';
    const result = extractAddressFromTopic(topic);
    expect(result).toBe('0xaabbccddee11223344556677889900aabbccddee');
  });

  it('should extract address from non-prefixed 32-byte padded topic', () => {
    const topic = '000000000000000000000000aabbccddee11223344556677889900aabbccddee';
    const result = extractAddressFromTopic(topic);
    expect(result).toBe('0xaabbccddee11223344556677889900aabbccddee');
  });

  it('should return lowercase address', () => {
    const topic = '0x000000000000000000000000AABBCCDDEE11223344556677889900AABBCCDDEE';
    const result = extractAddressFromTopic(topic);
    expect(result).toBe('0xaabbccddee11223344556677889900aabbccddee');
  });

  it('should handle topic with all zeros (zero address)', () => {
    const topic = '0x0000000000000000000000000000000000000000000000000000000000000000';
    const result = extractAddressFromTopic(topic);
    expect(result).toBe('0x0000000000000000000000000000000000000000');
  });

  it('should handle topic with maximum address value', () => {
    const topic = '0x000000000000000000000000ffffffffffffffffffffffffffffffffffffffff';
    const result = extractAddressFromTopic(topic);
    expect(result).toBe('0xffffffffffffffffffffffffffffffffffffffff');
  });
});

// =============================================================================
// extractAddressFromDataWord Tests
// =============================================================================

describe('extractAddressFromDataWord', () => {
  it('should extract address from word index 0', () => {
    const data = '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
                 '000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const result = extractAddressFromDataWord(data, 0);
    expect(result).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('should extract address from word index 1', () => {
    const data = '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
                 '000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const result = extractAddressFromDataWord(data, 1);
    expect(result).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('should extract address from word index 2', () => {
    const data = '0x' +
                 '000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' +
                 '000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' +
                 '000000000000000000000000cccccccccccccccccccccccccccccccccccccccc';
    const result = extractAddressFromDataWord(data, 2);
    expect(result).toBe('0xcccccccccccccccccccccccccccccccccccccccc');
  });

  it('should return lowercase address', () => {
    const data = '0x000000000000000000000000AABBCCDDEE11223344556677889900AABBCCDDEE';
    const result = extractAddressFromDataWord(data, 0);
    expect(result).toBe('0xaabbccddee11223344556677889900aabbccddee');
  });
});

// =============================================================================
// extractBigIntFromDataWord Tests
// =============================================================================

describe('extractBigIntFromDataWord', () => {
  it('should extract zero value', () => {
    const data = '0x' + '0'.repeat(64);
    const result = extractBigIntFromDataWord(data, 0);
    expect(result).toBe(0n);
  });

  it('should extract value of 1', () => {
    const data = '0x' + '0'.repeat(63) + '1';
    const result = extractBigIntFromDataWord(data, 0);
    expect(result).toBe(1n);
  });

  it('should extract large uint256 value', () => {
    // MAX_SAFE_INTEGER + 1 = 9007199254740993
    const data = '0x' + '0'.repeat(48) + '0020000000000001';
    const result = extractBigIntFromDataWord(data, 0);
    expect(result).toBe(9007199254740993n);
  });

  it('should extract maximum uint256 value', () => {
    const data = '0x' + 'f'.repeat(64);
    const result = extractBigIntFromDataWord(data, 0);
    expect(result).toBe(BigInt('0x' + 'f'.repeat(64)));
  });

  it('should extract from correct word index', () => {
    const data = '0x' +
                 '0'.repeat(63) + '1' + // word 0 = 1
                 '0'.repeat(63) + '2';  // word 1 = 2
    expect(extractBigIntFromDataWord(data, 0)).toBe(1n);
    expect(extractBigIntFromDataWord(data, 1)).toBe(2n);
  });

  it('should handle hex value 0x64 (100 decimal)', () => {
    const data = '0x' + '0'.repeat(62) + '64';
    const result = extractBigIntFromDataWord(data, 0);
    expect(result).toBe(100n);
  });
});

// =============================================================================
// extractUint256FromDataWord Tests
// =============================================================================

describe('extractUint256FromDataWord', () => {
  it('should extract small values as number', () => {
    const data = '0x' + '0'.repeat(62) + '64'; // 100 in decimal
    const result = extractUint256FromDataWord(data, 0);
    expect(result).toBe(100);
  });

  it('should extract zero', () => {
    const data = '0x' + '0'.repeat(64);
    const result = extractUint256FromDataWord(data, 0);
    expect(result).toBe(0);
  });

  it('should return -1 for values exceeding MAX_SAFE_INTEGER', () => {
    // Number.MAX_SAFE_INTEGER = 9007199254740991 = 0x1FFFFFFFFFFFFF
    // We use a value larger than that
    const data = '0x' + '0'.repeat(48) + '0020000000000000'; // 2^53 = 9007199254740992
    const result = extractUint256FromDataWord(data, 0);
    expect(result).toBe(-1);
  });

  it('should return exact Number.MAX_SAFE_INTEGER without overflow', () => {
    // Number.MAX_SAFE_INTEGER = 9007199254740991 = 0x1FFFFFFFFFFFFF
    const data = '0x' + '0'.repeat(50) + '1fffffffffffff';
    const result = extractUint256FromDataWord(data, 0);
    expect(result).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('should return -1 for maximum uint256 value', () => {
    const data = '0x' + 'f'.repeat(64);
    const result = extractUint256FromDataWord(data, 0);
    expect(result).toBe(-1);
  });

  it('should extract from correct word index', () => {
    const data = '0x' +
                 '0'.repeat(62) + '0a' + // word 0 = 10
                 '0'.repeat(62) + '14';  // word 1 = 20
    expect(extractUint256FromDataWord(data, 0)).toBe(10);
    expect(extractUint256FromDataWord(data, 1)).toBe(20);
  });
});

// =============================================================================
// parseSignedInt24 Tests
// =============================================================================

describe('parseSignedInt24', () => {
  it('should parse zero', () => {
    expect(parseSignedInt24('000000')).toBe(0);
  });

  it('should parse positive values', () => {
    expect(parseSignedInt24('000001')).toBe(1);
    expect(parseSignedInt24('00003c')).toBe(60);  // Uniswap V3 common tick spacing
    expect(parseSignedInt24('0000c8')).toBe(200);
  });

  it('should parse maximum positive int24 (8388607)', () => {
    expect(parseSignedInt24('7fffff')).toBe(8388607);
  });

  it('should parse negative values using two\'s complement', () => {
    // -1 in 24-bit two's complement = 0xFFFFFF
    expect(parseSignedInt24('ffffff')).toBe(-1);
    // -60 in 24-bit two's complement = 0xFFFFC4
    expect(parseSignedInt24('ffffc4')).toBe(-60);
  });

  it('should parse minimum negative int24 (-8388608)', () => {
    // -8388608 in 24-bit two's complement = 0x800000
    expect(parseSignedInt24('800000')).toBe(-8388608);
  });

  it('should correctly handle boundary between positive and negative', () => {
    // 0x7FFFFF = 8388607 (max positive)
    expect(parseSignedInt24('7fffff')).toBe(8388607);
    // 0x800000 = -8388608 (min negative)
    expect(parseSignedInt24('800000')).toBe(-8388608);
    // 0x800001 = -8388607
    expect(parseSignedInt24('800001')).toBe(-8388607);
  });

  it('should parse common Uniswap V3 tick spacings', () => {
    // Tick spacing of 10 (0.05% fee tier)
    expect(parseSignedInt24('00000a')).toBe(10);
    // Tick spacing of 60 (0.30% fee tier)
    expect(parseSignedInt24('00003c')).toBe(60);
    // Tick spacing of 200 (1.00% fee tier)
    expect(parseSignedInt24('0000c8')).toBe(200);
  });
});

// =============================================================================
// validateLogStructure Tests
// =============================================================================

describe('validateLogStructure', () => {
  it('should return true for valid log with sufficient topics and data', () => {
    const log = {
      topics: ['0xsig', '0xtopic1', '0xtopic2'],
      data: '0x' + '0'.repeat(64), // 1 word
    };
    expect(validateLogStructure(log, 3, 1)).toBe(true);
  });

  it('should return true when log exceeds minimum requirements', () => {
    const log = {
      topics: ['0xsig', '0xtopic1', '0xtopic2', '0xtopic3'],
      data: '0x' + '0'.repeat(128), // 2 words
    };
    expect(validateLogStructure(log, 3, 1)).toBe(true);
  });

  it('should return false for null log', () => {
    expect(validateLogStructure(null, 1, 1)).toBe(false);
  });

  it('should return false for undefined log', () => {
    expect(validateLogStructure(undefined, 1, 1)).toBe(false);
  });

  it('should return false for log without topics', () => {
    const log = { data: '0x' + '0'.repeat(64) };
    expect(validateLogStructure(log, 1, 1)).toBe(false);
  });

  it('should return false for log without data', () => {
    const log = { topics: ['0xsig'] };
    expect(validateLogStructure(log, 1, 1)).toBe(false);
  });

  it('should return false for insufficient topics', () => {
    const log = {
      topics: ['0xsig'],
      data: '0x' + '0'.repeat(64),
    };
    expect(validateLogStructure(log, 3, 1)).toBe(false);
  });

  it('should return false for insufficient data words', () => {
    const log = {
      topics: ['0xsig', '0xtopic1', '0xtopic2'],
      data: '0x' + '0'.repeat(32), // Less than 1 full word (64 hex chars)
    };
    expect(validateLogStructure(log, 3, 1)).toBe(false);
  });

  it('should handle minTopics of 0', () => {
    const log = {
      topics: [],
      data: '0x' + '0'.repeat(64),
    };
    expect(validateLogStructure(log, 0, 1)).toBe(true);
  });

  it('should handle minDataWords of 0', () => {
    const log = {
      topics: ['0xsig'],
      data: '0x', // Just the prefix
    };
    expect(validateLogStructure(log, 1, 0)).toBe(true);
  });

  it('should validate data length correctly for multiple words', () => {
    const log = {
      topics: ['0xsig'],
      data: '0x' + '0'.repeat(128), // Exactly 2 words
    };
    expect(validateLogStructure(log, 1, 2)).toBe(true);
    expect(validateLogStructure(log, 1, 3)).toBe(false);
  });

  it('should return false for empty object', () => {
    expect(validateLogStructure({}, 1, 1)).toBe(false);
  });
});
