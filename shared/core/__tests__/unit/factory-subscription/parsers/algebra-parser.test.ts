/**
 * Algebra Parser Unit Tests
 *
 * Tests for parsing Algebra-style Pool events.
 * Used by Algebra DEX (e.g., Camelot on Arbitrum).
 *
 * @see factory-subscription/parsers/algebra-parser.ts
 */

import { describe, it, expect } from '@jest/globals';
import { parseAlgebraPoolCreatedEvent } from '../../../../src/factory-subscription/parsers/algebra-parser';
import { testParserValidation, toTopic, PARSER_TEST_CONSTANTS } from './parser-test.harness';

const { TOKEN0, TOKEN1, FACTORY_ADDRESS } = PARSER_TEST_CONSTANTS;
const POOL_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

// =============================================================================
// Test Helpers
// =============================================================================

function createValidAlgebraLog() {
  const poolWord = POOL_ADDRESS.replace('0x', '').padStart(64, '0');
  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0x91ccaa7a278130b65b4aea6c4e1a22c68e0392bf1c14e29cb2e5e82ae2c3d919',
      toTopic(TOKEN0),
      toTopic(TOKEN1),
    ],
    data: '0x' + poolWord,
    blockNumber: 80000000,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000004',
  };
}

// =============================================================================
// Shared Validation Tests (10 tests)
// =============================================================================

testParserValidation({
  parserName: 'parseAlgebraPoolCreatedEvent',
  parseFunction: parseAlgebraPoolCreatedEvent,
  createValidLog: createValidAlgebraLog,
  minTopics: 3,
  minDataWords: 1,
});

// =============================================================================
// Algebra-Specific Tests
// =============================================================================

describe('parseAlgebraPoolCreatedEvent', () => {
  describe('Happy path', () => {
    it('should parse a valid Algebra Pool event', () => {
      const log = createValidAlgebraLog();
      const result = parseAlgebraPoolCreatedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.token0).toBe(TOKEN0);
      expect(result!.token1).toBe(TOKEN1);
      expect(result!.pairAddress).toBe(POOL_ADDRESS);
      expect(result!.factoryAddress).toBe(FACTORY_ADDRESS.toLowerCase());
      expect(result!.factoryType).toBe('algebra');
      expect(result!.dexName).toBe('');
      expect(result!.blockNumber).toBe(80000000);
      expect(result!.transactionHash).toBe('0xtxhash0000000000000000000000000000000000000000000000000000000004');
    });
  });

  describe('Field extraction', () => {
    it('should not have fee, tickSpacing, isStable, or binStep fields', () => {
      const log = createValidAlgebraLog();
      const result = parseAlgebraPoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.fee).toBeUndefined();
      expect(result!.tickSpacing).toBeUndefined();
      expect(result!.isStable).toBeUndefined();
      expect(result!.binStep).toBeUndefined();
    });

    it('should extract pool address from data correctly', () => {
      const log = createValidAlgebraLog();
      const result = parseAlgebraPoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.pairAddress).toBe(POOL_ADDRESS);
    });

    it('should handle different token addresses', () => {
      const log = createValidAlgebraLog();
      const customToken0 = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      const customToken1 = '0xcafebabecafebabecafebabecafebabecafebabe';
      log.topics[1] = toTopic(customToken0);
      log.topics[2] = toTopic(customToken1);
      const result = parseAlgebraPoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.token0).toBe(customToken0);
      expect(result!.token1).toBe(customToken1);
    });
  });
});
