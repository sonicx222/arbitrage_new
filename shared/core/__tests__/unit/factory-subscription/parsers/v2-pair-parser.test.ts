/**
 * V2 Pair Parser Unit Tests
 *
 * Tests for parsing Uniswap V2-style PairCreated events.
 *
 * @see factory-subscription/parsers/v2-pair-parser.ts
 */

import { describe, it, expect } from '@jest/globals';
import { parseV2PairCreatedEvent } from '../../../../src/factory-subscription/parsers/v2-pair-parser';
import { testParserValidation, toTopic, PARSER_TEST_CONSTANTS } from './parser-test.harness';

const { TOKEN0, TOKEN1, PAIR_ADDRESS, FACTORY_ADDRESS } = PARSER_TEST_CONSTANTS;

// =============================================================================
// Test Helpers
// =============================================================================

function createValidV2Log() {
  const pairWord = PAIR_ADDRESS.replace('0x', '').padStart(64, '0');
  const indexWord = '0'.repeat(63) + '1';
  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9',
      toTopic(TOKEN0),
      toTopic(TOKEN1),
    ],
    data: '0x' + pairWord + indexWord,
    blockNumber: 12345,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000001',
  };
}

// =============================================================================
// Shared Validation Tests (10 tests)
// =============================================================================

testParserValidation({
  parserName: 'parseV2PairCreatedEvent',
  parseFunction: parseV2PairCreatedEvent,
  createValidLog: createValidV2Log,
  minTopics: 3,
  minDataWords: 1,
});

// =============================================================================
// V2-Specific Tests
// =============================================================================

describe('parseV2PairCreatedEvent', () => {
  describe('Happy path', () => {
    it('should parse a valid V2 PairCreated event', () => {
      const log = createValidV2Log();
      const result = parseV2PairCreatedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.token0).toBe(TOKEN0);
      expect(result!.token1).toBe(TOKEN1);
      expect(result!.pairAddress).toBe(PAIR_ADDRESS);
      expect(result!.factoryAddress).toBe(FACTORY_ADDRESS.toLowerCase());
      expect(result!.factoryType).toBe('uniswap_v2');
      expect(result!.dexName).toBe('');
      expect(result!.blockNumber).toBe(12345);
      expect(result!.transactionHash).toBe('0xtxhash0000000000000000000000000000000000000000000000000000000001');
    });

    it('should extract correct addresses from topics', () => {
      const log = createValidV2Log();
      const result = parseV2PairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.token0).toBe(TOKEN0);
      expect(result!.token1).toBe(TOKEN1);
    });
  });

  describe('Edge cases', () => {
    it('should work with data containing exactly 1 word', () => {
      const log = createValidV2Log();
      const pairWord = PAIR_ADDRESS.replace('0x', '').padStart(64, '0');
      log.data = '0x' + pairWord;
      const result = parseV2PairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.pairAddress).toBe(PAIR_ADDRESS);
    });

    it('should not have V3-specific fields', () => {
      const log = createValidV2Log();
      const result = parseV2PairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.fee).toBeUndefined();
      expect(result!.tickSpacing).toBeUndefined();
      expect(result!.isStable).toBeUndefined();
      expect(result!.binStep).toBeUndefined();
    });
  });
});
