/**
 * V2 Pair Parser Unit Tests
 *
 * Tests for parsing Uniswap V2-style PairCreated events.
 *
 * @see factory-subscription/parsers/v2-pair-parser.ts
 */

import { describe, it, expect } from '@jest/globals';
import { parseV2PairCreatedEvent } from '../../../../src/factory-subscription/parsers/v2-pair-parser';

// =============================================================================
// Test Helpers
// =============================================================================

const TOKEN0 = '0x1111111111111111111111111111111111111111';
const TOKEN1 = '0x2222222222222222222222222222222222222222';
const PAIR_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const FACTORY_ADDRESS = '0xFaCt0Ry000000000000000000000000000000001';

/** Pad an address to a 32-byte hex topic (with 0x prefix) */
function toTopic(address: string): string {
  const raw = address.replace('0x', '').toLowerCase();
  return '0x' + raw.padStart(64, '0');
}

function createValidV2Log() {
  // Data: pair address (32 bytes) + pair index (32 bytes)
  const pairWord = PAIR_ADDRESS.replace('0x', '').padStart(64, '0');
  const indexWord = '0'.repeat(63) + '1'; // pair index = 1
  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9', // PairCreated signature
      toTopic(TOKEN0),
      toTopic(TOKEN1),
    ],
    data: '0x' + pairWord + indexWord,
    blockNumber: 12345,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000001',
  };
}

// =============================================================================
// parseV2PairCreatedEvent Tests
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

    it('should lowercase factory address from log', () => {
      const log = createValidV2Log();
      log.address = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
      const result = parseV2PairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.factoryAddress).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });

    it('should extract correct addresses from topics', () => {
      const log = createValidV2Log();
      const result = parseV2PairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.token0).toBe(TOKEN0);
      expect(result!.token1).toBe(TOKEN1);
    });
  });

  describe('Missing/insufficient topics', () => {
    it('should return null when topics is missing', () => {
      const log = createValidV2Log();
      delete (log as any).topics;
      expect(parseV2PairCreatedEvent(log)).toBeNull();
    });

    it('should return null when topics has fewer than 3 entries', () => {
      const log = createValidV2Log();
      log.topics = [log.topics[0], log.topics[1]]; // Only 2 topics
      expect(parseV2PairCreatedEvent(log)).toBeNull();
    });

    it('should return null when topics is empty', () => {
      const log = createValidV2Log();
      log.topics = [];
      expect(parseV2PairCreatedEvent(log)).toBeNull();
    });
  });

  describe('Missing/insufficient data', () => {
    it('should return null when data is missing', () => {
      const log = createValidV2Log();
      delete (log as any).data;
      expect(parseV2PairCreatedEvent(log)).toBeNull();
    });

    it('should return null when data is too short', () => {
      const log = createValidV2Log();
      log.data = '0x' + '0'.repeat(32); // Less than 1 full word (64 hex chars needed)
      expect(parseV2PairCreatedEvent(log)).toBeNull();
    });

    it('should return null when data is just the prefix', () => {
      const log = createValidV2Log();
      log.data = '0x';
      expect(parseV2PairCreatedEvent(log)).toBeNull();
    });
  });

  describe('Null/undefined log', () => {
    it('should return null for null log', () => {
      expect(parseV2PairCreatedEvent(null)).toBeNull();
    });

    it('should return null for undefined log', () => {
      expect(parseV2PairCreatedEvent(undefined)).toBeNull();
    });

    it('should return null for empty object', () => {
      expect(parseV2PairCreatedEvent({})).toBeNull();
    });
  });

  describe('Edge cases', () => {
    it('should work with data containing exactly 1 word', () => {
      const log = createValidV2Log();
      // Only pair address word, no index word
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
