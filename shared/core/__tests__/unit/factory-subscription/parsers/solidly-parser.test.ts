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

function createValidSolidlyLog(isStable: boolean = false) {
  // Data: stable bool (32 bytes) + pair address (32 bytes) + pair index (32 bytes)
  const stableWord = isStable
    ? '0'.repeat(63) + '1'
    : '0'.repeat(64);
  const pairWord = PAIR_ADDRESS.replace('0x', '').padStart(64, '0');
  const indexWord = '0'.repeat(63) + '1';

  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0xc4805696c66d7cf352fc1d6bb633ad5ee82f6cb577c453024b6e0eb8306c6fc9', // PairCreated signature
      toTopic(TOKEN0),
      toTopic(TOKEN1),
    ],
    data: '0x' + stableWord + pairWord + indexWord,
    blockNumber: 50000,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000003',
  };
}

// =============================================================================
// parseSolidlyPairCreatedEvent Tests
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
      // Set stable word to a non-zero but non-one value
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

  describe('Missing/insufficient topics', () => {
    it('should return null when topics is missing', () => {
      const log = createValidSolidlyLog();
      delete (log as any).topics;
      expect(parseSolidlyPairCreatedEvent(log)).toBeNull();
    });

    it('should return null when topics has fewer than 3 entries', () => {
      const log = createValidSolidlyLog();
      log.topics = [log.topics[0], log.topics[1]];
      expect(parseSolidlyPairCreatedEvent(log)).toBeNull();
    });
  });

  describe('Missing/insufficient data', () => {
    it('should return null when data is missing', () => {
      const log = createValidSolidlyLog();
      delete (log as any).data;
      expect(parseSolidlyPairCreatedEvent(log)).toBeNull();
    });

    it('should return null when data has fewer than 3 words', () => {
      const log = createValidSolidlyLog();
      log.data = '0x' + '0'.repeat(128); // Only 2 words, need 3
      expect(parseSolidlyPairCreatedEvent(log)).toBeNull();
    });

    it('should return null when data is just the prefix', () => {
      const log = createValidSolidlyLog();
      log.data = '0x';
      expect(parseSolidlyPairCreatedEvent(log)).toBeNull();
    });
  });

  describe('Null/undefined log', () => {
    it('should return null for null log', () => {
      expect(parseSolidlyPairCreatedEvent(null as unknown as RawEventLog)).toBeNull();
    });

    it('should return null for undefined log', () => {
      expect(parseSolidlyPairCreatedEvent(undefined as unknown as RawEventLog)).toBeNull();
    });

    it('should return null for empty object', () => {
      expect(parseSolidlyPairCreatedEvent({} as RawEventLog)).toBeNull();
    });
  });

  describe('Field extraction', () => {
    it('should lowercase factory address', () => {
      const log = createValidSolidlyLog();
      log.address = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
      const result = parseSolidlyPairCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.factoryAddress).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });

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
