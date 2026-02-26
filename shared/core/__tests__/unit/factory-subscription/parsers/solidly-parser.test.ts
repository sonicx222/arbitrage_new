/**
 * Solidly Parser Unit Tests
 *
 * Tests for parsing Solidly-style PairCreated events.
 * Used by Velodrome, Aerodrome, Equalizer, and other Solidly forks.
 *
 * @see factory-subscription/parsers/solidly-parser.ts
 */

import { describe, it, expect } from '@jest/globals';
import { parseSolidlyPairCreatedEvent } from '../../../../src/factory-subscription/parsers/solidly-parser';
import { testParserValidation, toTopic, PARSER_TEST_CONSTANTS } from './parser-test.harness';

const { TOKEN0, TOKEN1, PAIR_ADDRESS, FACTORY_ADDRESS } = PARSER_TEST_CONSTANTS;

// =============================================================================
// Test Helpers
// =============================================================================

function createValidSolidlyLog(isStable: boolean = false) {
  const stableWord = isStable
    ? '0'.repeat(63) + '1'
    : '0'.repeat(64);
  const pairWord = PAIR_ADDRESS.replace('0x', '').padStart(64, '0');
  const indexWord = '0'.repeat(63) + '1';

  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0xc4805696c66d7cf352fc1d6bb633ad5ee82f6cb577c453024b6e0eb8306c6fc9',
      toTopic(TOKEN0),
      toTopic(TOKEN1),
    ],
    data: '0x' + stableWord + pairWord + indexWord,
    blockNumber: 50000,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000003',
  };
}

// =============================================================================
// Shared Validation Tests (10 tests)
// =============================================================================

testParserValidation({
  parserName: 'parseSolidlyPairCreatedEvent',
  parseFunction: parseSolidlyPairCreatedEvent,
  createValidLog: createValidSolidlyLog,
  minTopics: 3,
  minDataWords: 3,
});

// =============================================================================
// Solidly-Specific Tests
// =============================================================================

describe('parseSolidlyPairCreatedEvent', () => {
  describe('Happy path', () => {
    it('should parse a valid volatile pair event (isStable=false)', () => {
      const log = createValidSolidlyLog(false);
      const result = parseSolidlyPairCreatedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.token0).toBe(TOKEN0);
      expect(result!.token1).toBe(TOKEN1);
      expect(result!.pairAddress).toBe(PAIR_ADDRESS);
      expect(result!.factoryAddress).toBe(FACTORY_ADDRESS.toLowerCase());
      expect(result!.factoryType).toBe('solidly');
      expect(result!.dexName).toBe('');
      expect(result!.blockNumber).toBe(50000);
      expect(result!.isStable).toBe(false);
    });

    it('should parse a valid stable pair event (isStable=true)', () => {
      const log = createValidSolidlyLog(true);
      const result = parseSolidlyPairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.isStable).toBe(true);
      expect(result!.factoryType).toBe('solidly');
    });
  });

  describe('Stable flag parsing', () => {
    it('should treat non-zero value as true for stable flag', () => {
      const log = createValidSolidlyLog(false);
      const stableWord = '0'.repeat(62) + 'ff';
      const pairWord = PAIR_ADDRESS.replace('0x', '').padStart(64, '0');
      const indexWord = '0'.repeat(63) + '1';
      log.data = '0x' + stableWord + pairWord + indexWord;

      const result = parseSolidlyPairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.isStable).toBe(true);
    });

    it('should treat all zeros as false for stable flag', () => {
      const log = createValidSolidlyLog(false);
      const result = parseSolidlyPairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.isStable).toBe(false);
    });
  });

  describe('Field extraction', () => {
    it('should not have V3-specific fields', () => {
      const log = createValidSolidlyLog();
      const result = parseSolidlyPairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.fee).toBeUndefined();
      expect(result!.tickSpacing).toBeUndefined();
      expect(result!.binStep).toBeUndefined();
    });
  });
});
