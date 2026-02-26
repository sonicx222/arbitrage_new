/**
 * Trader Joe Parser Unit Tests
 *
 * Tests for parsing Trader Joe LBPairCreated events.
 * Used by Trader Joe's Liquidity Book AMM on Avalanche and Arbitrum.
 *
 * @see factory-subscription/parsers/trader-joe-parser.ts
 */

import { describe, it, expect } from '@jest/globals';
import { parseTraderJoePairCreatedEvent } from '../../../../src/factory-subscription/parsers/trader-joe-parser';
import { testParserValidation, toTopic, numberToTopic, PARSER_TEST_CONSTANTS } from './parser-test.harness';

const { TOKEN0, TOKEN1, PAIR_ADDRESS, FACTORY_ADDRESS } = PARSER_TEST_CONSTANTS;

// =============================================================================
// Test Helpers
// =============================================================================

function createValidTraderJoeLog(binStep: number = 25) {
  const pairWord = PAIR_ADDRESS.replace('0x', '').padStart(64, '0');
  const pidWord = '0'.repeat(63) + '1';

  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0x2c8e46e5ced9133f2ab5ee6dc9a1e0e8c060dbac21dc4eef7fc3fbc1a5a8e12d',
      toTopic(TOKEN0),
      toTopic(TOKEN1),
      numberToTopic(binStep),
    ],
    data: '0x' + pairWord + pidWord,
    blockNumber: 25000000,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000009',
  };
}

// =============================================================================
// Shared Validation Tests (10 tests)
// =============================================================================

testParserValidation({
  parserName: 'parseTraderJoePairCreatedEvent',
  parseFunction: parseTraderJoePairCreatedEvent,
  createValidLog: createValidTraderJoeLog,
  minTopics: 4,
  minDataWords: 2,
});

// =============================================================================
// Trader Joe-Specific Tests
// =============================================================================

describe('parseTraderJoePairCreatedEvent', () => {
  describe('Happy path', () => {
    it('should parse a valid LBPairCreated event', () => {
      const log = createValidTraderJoeLog(25);
      const result = parseTraderJoePairCreatedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.token0).toBe(TOKEN0);
      expect(result!.token1).toBe(TOKEN1);
      expect(result!.pairAddress).toBe(PAIR_ADDRESS);
      expect(result!.factoryAddress).toBe(FACTORY_ADDRESS.toLowerCase());
      expect(result!.factoryType).toBe('trader_joe');
      expect(result!.dexName).toBe('');
      expect(result!.blockNumber).toBe(25000000);
      expect(result!.binStep).toBe(25);
    });

    it('should parse different bin step values', () => {
      for (const binStep of [1, 2, 5, 10, 15, 20, 25, 50, 100]) {
        const log = createValidTraderJoeLog(binStep);
        const result = parseTraderJoePairCreatedEvent(log);
        expect(result).not.toBeNull();
        expect(result!.binStep).toBe(binStep);
      }
    });
  });

  describe('Bin step extraction', () => {
    it('should extract bin step from topics[3]', () => {
      const log = createValidTraderJoeLog(50);
      const result = parseTraderJoePairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.binStep).toBe(50);
    });

    it('should handle bin step of 1', () => {
      const log = createValidTraderJoeLog(1);
      const result = parseTraderJoePairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.binStep).toBe(1);
    });

    it('should handle large bin step', () => {
      const log = createValidTraderJoeLog(200);
      const result = parseTraderJoePairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.binStep).toBe(200);
    });
  });

  describe('Field extraction', () => {
    it('should not have fee, tickSpacing, or isStable fields', () => {
      const log = createValidTraderJoeLog();
      const result = parseTraderJoePairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.fee).toBeUndefined();
      expect(result!.tickSpacing).toBeUndefined();
      expect(result!.isStable).toBeUndefined();
    });

    it('should extract correct token addresses from topics', () => {
      const log = createValidTraderJoeLog();
      const customToken0 = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      const customToken1 = '0xcafebabecafebabecafebabecafebabecafebabe';
      log.topics[1] = toTopic(customToken0);
      log.topics[2] = toTopic(customToken1);
      const result = parseTraderJoePairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.token0).toBe(customToken0);
      expect(result!.token1).toBe(customToken1);
    });
  });
});
