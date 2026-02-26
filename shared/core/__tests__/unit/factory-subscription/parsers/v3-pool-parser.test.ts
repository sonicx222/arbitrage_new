/**
 * V3 Pool Parser Unit Tests
 *
 * Tests for parsing Uniswap V3-style PoolCreated events.
 *
 * @see factory-subscription/parsers/v3-pool-parser.ts
 */

import { describe, it, expect } from '@jest/globals';
import { parseV3PoolCreatedEvent } from '../../../../src/factory-subscription/parsers/v3-pool-parser';
import type { RawEventLog } from '../../../../src/factory-subscription/parsers/types';

// =============================================================================
// Test Helpers
// =============================================================================

const TOKEN0 = '0x1111111111111111111111111111111111111111';
const TOKEN1 = '0x2222222222222222222222222222222222222222';
const POOL_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
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

function createValidV3Log(options: { fee?: number; tickSpacing?: number } = {}) {
  const fee = options.fee ?? 3000; // 0.30% fee tier
  const tickSpacing = options.tickSpacing ?? 60;

  // tickSpacing as int24 in last 6 hex chars of first 32-byte word
  const tickSpacingHex = (tickSpacing >= 0)
    ? tickSpacing.toString(16).padStart(6, '0')
    : (tickSpacing + 0x1000000).toString(16); // two's complement for negative
  const tickSpacingWord = '0'.repeat(58) + tickSpacingHex;

  // Pool address in second 32-byte word
  const poolWord = POOL_ADDRESS.replace('0x', '').padStart(64, '0');

  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118', // PoolCreated signature
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
// parseV3PoolCreatedEvent Tests
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

  describe('Missing/insufficient topics', () => {
    it('should return null when topics is missing', () => {
      const log = createValidV3Log();
      delete (log as any).topics;
      expect(parseV3PoolCreatedEvent(log)).toBeNull();
    });

    it('should return null when topics has fewer than 4 entries', () => {
      const log = createValidV3Log();
      log.topics = log.topics.slice(0, 3); // Only 3 topics
      expect(parseV3PoolCreatedEvent(log)).toBeNull();
    });

    it('should return null when topics is empty', () => {
      const log = createValidV3Log();
      log.topics = [];
      expect(parseV3PoolCreatedEvent(log)).toBeNull();
    });
  });

  describe('Missing/insufficient data', () => {
    it('should return null when data is missing', () => {
      const log = createValidV3Log();
      delete (log as any).data;
      expect(parseV3PoolCreatedEvent(log)).toBeNull();
    });

    it('should return null when data has fewer than 2 words', () => {
      const log = createValidV3Log();
      log.data = '0x' + '0'.repeat(64); // Only 1 word, need 2
      expect(parseV3PoolCreatedEvent(log)).toBeNull();
    });

    it('should return null when data is just the prefix', () => {
      const log = createValidV3Log();
      log.data = '0x';
      expect(parseV3PoolCreatedEvent(log)).toBeNull();
    });
  });

  describe('Null/undefined log', () => {
    it('should return null for null log', () => {
      expect(parseV3PoolCreatedEvent(null as unknown as RawEventLog)).toBeNull();
    });

    it('should return null for undefined log', () => {
      expect(parseV3PoolCreatedEvent(undefined as unknown as RawEventLog)).toBeNull();
    });

    it('should return null for empty object', () => {
      expect(parseV3PoolCreatedEvent({} as RawEventLog)).toBeNull();
    });
  });

  describe('Field extraction', () => {
    it('should lowercase factory address', () => {
      const log = createValidV3Log();
      log.address = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
      const result = parseV3PoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.factoryAddress).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });

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
