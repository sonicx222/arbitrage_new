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
import type { RawEventLog } from '../../../../src/factory-subscription/parsers/types';

// =============================================================================
// Test Helpers
// =============================================================================

const TOKEN0 = '0x1111111111111111111111111111111111111111';
const TOKEN1 = '0x2222222222222222222222222222222222222222';
const PAIR_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const FACTORY_ADDRESS = '0xFactory000000000000000000000000000000001';

/** Pad an address to a 32-byte hex topic (with 0x prefix) */
function toTopic(address: string): string {
  const raw = address.replace('0x', '').toLowerCase();
  return '0x' + raw.padStart(64, '0');
}

/** Convert a number to a 32-byte hex topic (with 0x prefix) */
function numberToTopic(value: number): string {
  return '0x' + value.toString(16).padStart(64, '0');
}

function createValidTraderJoeLog(binStep: number = 25) {
  // Data: LBPair address (32 bytes) + pid (32 bytes)
  const pairWord = PAIR_ADDRESS.replace('0x', '').padStart(64, '0');
  const pidWord = '0'.repeat(63) + '1'; // pid = 1

  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0x2c8e46e5ced9133f2ab5ee6dc9a1e0e8c060dbac21dc4eef7fc3fbc1a5a8e12d', // LBPairCreated signature
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
// parseTraderJoePairCreatedEvent Tests
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
      // Common bin steps: 1, 2, 5, 10, 15, 20, 25, 50, 100
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

  describe('Missing/insufficient topics', () => {
    it('should return null when topics is missing', () => {
      const log = createValidTraderJoeLog();
      delete (log as any).topics;
      expect(parseTraderJoePairCreatedEvent(log)).toBeNull();
    });

    it('should return null when topics has fewer than 4 entries', () => {
      const log = createValidTraderJoeLog();
      log.topics = log.topics.slice(0, 3); // Only 3 topics
      expect(parseTraderJoePairCreatedEvent(log)).toBeNull();
    });

    it('should return null when topics is empty', () => {
      const log = createValidTraderJoeLog();
      log.topics = [];
      expect(parseTraderJoePairCreatedEvent(log)).toBeNull();
    });
  });

  describe('Missing/insufficient data', () => {
    it('should return null when data is missing', () => {
      const log = createValidTraderJoeLog();
      delete (log as any).data;
      expect(parseTraderJoePairCreatedEvent(log)).toBeNull();
    });

    it('should return null when data has fewer than 2 words', () => {
      const log = createValidTraderJoeLog();
      log.data = '0x' + '0'.repeat(64); // Only 1 word, need 2
      expect(parseTraderJoePairCreatedEvent(log)).toBeNull();
    });

    it('should return null when data is just the prefix', () => {
      const log = createValidTraderJoeLog();
      log.data = '0x';
      expect(parseTraderJoePairCreatedEvent(log)).toBeNull();
    });
  });

  describe('Null/undefined log', () => {
    it('should return null for null log', () => {
      expect(parseTraderJoePairCreatedEvent(null as unknown as RawEventLog)).toBeNull();
    });

    it('should return null for undefined log', () => {
      expect(parseTraderJoePairCreatedEvent(undefined as unknown as RawEventLog)).toBeNull();
    });

    it('should return null for empty object', () => {
      expect(parseTraderJoePairCreatedEvent({} as RawEventLog)).toBeNull();
    });
  });

  describe('Field extraction', () => {
    it('should lowercase factory address', () => {
      const log = createValidTraderJoeLog();
      log.address = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
      const result = parseTraderJoePairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.factoryAddress).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });

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
