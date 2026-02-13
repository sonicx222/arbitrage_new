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

function createValidAlgebraLog() {
  // Data: pool address (32 bytes)
  const poolWord = POOL_ADDRESS.replace('0x', '').padStart(64, '0');
  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0x91ccaa7a278130b65b4aea6c4e1a22c68e0392bf1c14e29cb2e5e82ae2c3d919', // Pool signature
      toTopic(TOKEN0),
      toTopic(TOKEN1),
    ],
    data: '0x' + poolWord,
    blockNumber: 80000000,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000004',
  };
}

// =============================================================================
// parseAlgebraPoolCreatedEvent Tests
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

  describe('Missing/insufficient topics', () => {
    it('should return null when topics is missing', () => {
      const log = createValidAlgebraLog();
      delete (log as any).topics;
      expect(parseAlgebraPoolCreatedEvent(log)).toBeNull();
    });

    it('should return null when topics has fewer than 3 entries', () => {
      const log = createValidAlgebraLog();
      log.topics = [log.topics[0], log.topics[1]];
      expect(parseAlgebraPoolCreatedEvent(log)).toBeNull();
    });

    it('should return null when topics is empty', () => {
      const log = createValidAlgebraLog();
      log.topics = [];
      expect(parseAlgebraPoolCreatedEvent(log)).toBeNull();
    });
  });

  describe('Missing/insufficient data', () => {
    it('should return null when data is missing', () => {
      const log = createValidAlgebraLog();
      delete (log as any).data;
      expect(parseAlgebraPoolCreatedEvent(log)).toBeNull();
    });

    it('should return null when data is too short (less than 1 word)', () => {
      const log = createValidAlgebraLog();
      log.data = '0x' + '0'.repeat(32); // Only half a word
      expect(parseAlgebraPoolCreatedEvent(log)).toBeNull();
    });

    it('should return null when data is just the prefix', () => {
      const log = createValidAlgebraLog();
      log.data = '0x';
      expect(parseAlgebraPoolCreatedEvent(log)).toBeNull();
    });
  });

  describe('Null/undefined log', () => {
    it('should return null for null log', () => {
      expect(parseAlgebraPoolCreatedEvent(null)).toBeNull();
    });

    it('should return null for undefined log', () => {
      expect(parseAlgebraPoolCreatedEvent(undefined)).toBeNull();
    });

    it('should return null for empty object', () => {
      expect(parseAlgebraPoolCreatedEvent({})).toBeNull();
    });
  });

  describe('Field extraction', () => {
    it('should lowercase factory address', () => {
      const log = createValidAlgebraLog();
      log.address = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
      const result = parseAlgebraPoolCreatedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.factoryAddress).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    });

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
