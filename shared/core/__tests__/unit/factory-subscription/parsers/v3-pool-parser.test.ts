/**
 * V3 Pool Parser Unit Tests
 *
 * Tests for parsing Uniswap V3-style PoolCreated events.
 *
 * @see factory-subscription/parsers/v3-pool-parser.ts
 */

import { describe, it, expect } from '@jest/globals';
import { parseV3PoolCreatedEvent } from '../../../../src/factory-subscription/parsers/v3-pool-parser';
import { testParserValidation, toTopic, numberToTopic, PARSER_TEST_CONSTANTS } from './parser-test.harness';

const { TOKEN0, TOKEN1, FACTORY_ADDRESS } = PARSER_TEST_CONSTANTS;
const POOL_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

// =============================================================================
// Test Helpers
// =============================================================================

function createValidV3Log(options: { fee?: number; tickSpacing?: number } = {}) {
  const fee = options.fee ?? 3000;
  const tickSpacing = options.tickSpacing ?? 60;

  const tickSpacingHex = (tickSpacing >= 0)
    ? tickSpacing.toString(16).padStart(6, '0')
    : (tickSpacing + 0x1000000).toString(16);
  const tickSpacingWord = '0'.repeat(58) + tickSpacingHex;
  const poolWord = POOL_ADDRESS.replace('0x', '').padStart(64, '0');

  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118',
      toTopic(TOKEN0),
      toTopic(TOKEN1),
      numberToTopic(fee),
    ],
    data: '0x' + tickSpacingWord + poolWord,
    blockNumber: 15000000,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000002',
  };
}

// =============================================================================
// Shared Validation Tests (10 tests)
// =============================================================================

testParserValidation({
  parserName: 'parseV3PoolCreatedEvent',
  parseFunction: parseV3PoolCreatedEvent,
  createValidLog: createValidV3Log,
  minTopics: 4,
  minDataWords: 2,
});

// =============================================================================
// V3-Specific Tests
// =============================================================================

describe('parseV3PoolCreatedEvent', () => {
  describe('Happy path', () => {
    it('should parse a valid V3 PoolCreated event with 0.30% fee', () => {
      const log = createValidV3Log({ fee: 3000, tickSpacing: 60 });
      const result = parseV3PoolCreatedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.token0).toBe(TOKEN0);
      expect(result!.token1).toBe(TOKEN1);
      expect(result!.pairAddress).toBe(POOL_ADDRESS);
      expect(result!.factoryAddress).toBe(FACTORY_ADDRESS.toLowerCase());
      expect(result!.factoryType).toBe('uniswap_v3');
      expect(result!.dexName).toBe('');
      expect(result!.blockNumber).toBe(15000000);
      expect(result!.fee).toBe(3000);
      expect(result!.tickSpacing).toBe(60);
    });

    it('should parse 0.05% fee tier (fee=500, tickSpacing=10)', () => {
      const log = createValidV3Log({ fee: 500, tickSpacing: 10 });
      const result = parseV3PoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.fee).toBe(500);
      expect(result!.tickSpacing).toBe(10);
    });

    it('should parse 1.00% fee tier (fee=10000, tickSpacing=200)', () => {
      const log = createValidV3Log({ fee: 10000, tickSpacing: 200 });
      const result = parseV3PoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.fee).toBe(10000);
      expect(result!.tickSpacing).toBe(200);
    });

    it('should parse 0.01% fee tier (fee=100, tickSpacing=1)', () => {
      const log = createValidV3Log({ fee: 100, tickSpacing: 1 });
      const result = parseV3PoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.fee).toBe(100);
      expect(result!.tickSpacing).toBe(1);
    });
  });

  describe('Tick spacing parsing', () => {
    it('should parse positive tick spacing', () => {
      const log = createValidV3Log({ tickSpacing: 60 });
      const result = parseV3PoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.tickSpacing).toBe(60);
    });

    it('should parse negative tick spacing', () => {
      const log = createValidV3Log({ tickSpacing: -60 });
      const result = parseV3PoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.tickSpacing).toBe(-60);
    });

    it('should parse zero tick spacing', () => {
      const log = createValidV3Log({ tickSpacing: 0 });
      const result = parseV3PoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.tickSpacing).toBe(0);
    });
  });

  describe('Field extraction', () => {
    it('should extract fee from topics[3]', () => {
      const log = createValidV3Log({ fee: 500 });
      const result = parseV3PoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.fee).toBe(500);
    });

    it('should not have Solidly/TraderJoe-specific fields', () => {
      const log = createValidV3Log();
      const result = parseV3PoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.isStable).toBeUndefined();
      expect(result!.binStep).toBeUndefined();
    });
  });
});
