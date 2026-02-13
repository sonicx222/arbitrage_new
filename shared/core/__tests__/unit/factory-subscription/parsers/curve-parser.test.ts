/**
 * Curve Parser Unit Tests
 *
 * Tests for parsing Curve pool creation events including PlainPoolDeployed,
 * MetaPoolDeployed, and the routing function parseCurvePoolCreatedEvent.
 *
 * @see factory-subscription/parsers/curve-parser.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  parseCurvePlainPoolDeployedEvent,
  parseCurveMetaPoolDeployedEvent,
  parseCurvePoolCreatedEvent,
  CURVE_PLAIN_POOL_SIGNATURE,
  CURVE_META_POOL_SIGNATURE,
} from '../../../../src/factory-subscription/parsers/curve-parser';

// =============================================================================
// Test Helpers
// =============================================================================

const COIN0 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COIN1 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const COIN2 = '0xcccccccccccccccccccccccccccccccccccccccc';
const POOL_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const BASE_POOL = '0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef';
const DEPLOYER = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead';
const FACTORY_ADDRESS = '0xFactory000000000000000000000000000000001';
const ZERO_ADDR_HEX = '0'.repeat(64);

/** Pad an address to a 32-byte word (no 0x prefix) */
function addressWord(addr: string): string {
  return addr.replace('0x', '').padStart(64, '0');
}

/** Encode a uint256 as 32-byte word (no 0x prefix) */
function uint256Word(value: number): string {
  return value.toString(16).padStart(64, '0');
}

function createValidPlainPoolLog(options: { numCoins?: number; A?: number; fee?: number } = {}) {
  const numCoins = options.numCoins ?? 2;
  const A = options.A ?? 100;
  const fee = options.fee ?? 4000000; // 0.04% in Curve's format

  // coins[0..3] (4 words) - unused slots are zero address
  const coins = [COIN0, COIN1, COIN2, '0x0000000000000000000000000000000000000000'];
  const coinWords = coins.map((c, i) => (i < numCoins ? addressWord(c) : ZERO_ADDR_HEX));

  // A (word 4), fee (word 5), deployer (word 6), pool (word 7)
  const data = '0x' +
    coinWords.join('') +
    uint256Word(A) +
    uint256Word(fee) +
    addressWord(DEPLOYER) +
    addressWord(POOL_ADDRESS);

  return {
    address: FACTORY_ADDRESS,
    topics: [CURVE_PLAIN_POOL_SIGNATURE],
    data,
    blockNumber: 17000000,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000005',
  };
}

function createValidMetaPoolLog(options: { A?: number; fee?: number } = {}) {
  const A = options.A ?? 500;
  const fee = options.fee ?? 4000000;

  // coin (word 0), base_pool (word 1), A (word 2), fee (word 3), deployer (word 4), pool (word 5)
  const data = '0x' +
    addressWord(COIN0) +
    addressWord(BASE_POOL) +
    uint256Word(A) +
    uint256Word(fee) +
    addressWord(DEPLOYER) +
    addressWord(POOL_ADDRESS);

  return {
    address: FACTORY_ADDRESS,
    topics: [CURVE_META_POOL_SIGNATURE],
    data,
    blockNumber: 17000001,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000006',
  };
}

// =============================================================================
// parseCurvePlainPoolDeployedEvent Tests
// =============================================================================

describe('parseCurvePlainPoolDeployedEvent', () => {
  describe('Happy path', () => {
    it('should parse a valid 2-coin plain pool', () => {
      const log = createValidPlainPoolLog({ numCoins: 2 });
      const result = parseCurvePlainPoolDeployedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.token0).toBe(COIN0);
      expect(result!.token1).toBe(COIN1);
      expect(result!.pairAddress).toBe(POOL_ADDRESS);
      expect(result!.factoryAddress).toBe(FACTORY_ADDRESS.toLowerCase());
      expect(result!.factoryType).toBe('curve');
      expect(result!.isMetaPool).toBe(false);
      expect(result!.coins).toEqual([COIN0, COIN1]);
      expect(result!.amplificationCoefficient).toBe(100);
      expect(result!.fee).toBe(4000000);
      expect(result!.blockNumber).toBe(17000000);
    });

    it('should parse a valid 3-coin plain pool', () => {
      const log = createValidPlainPoolLog({ numCoins: 3 });
      const result = parseCurvePlainPoolDeployedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.coins).toHaveLength(3);
      expect(result!.coins).toEqual([COIN0, COIN1, COIN2]);
      expect(result!.token0).toBe(COIN0);
      expect(result!.token1).toBe(COIN1);
    });

    it('should extract amplification coefficient correctly', () => {
      const log = createValidPlainPoolLog({ A: 2000 });
      const result = parseCurvePlainPoolDeployedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.amplificationCoefficient).toBe(2000);
    });

    it('should extract fee correctly', () => {
      const log = createValidPlainPoolLog({ fee: 10000000 });
      const result = parseCurvePlainPoolDeployedEvent(log);
      expect(result).not.toBeNull();
      expect(result!.fee).toBe(10000000);
    });
  });

  describe('Coin filtering', () => {
    it('should filter out zero addresses from coins array', () => {
      const log = createValidPlainPoolLog({ numCoins: 2 });
      const result = parseCurvePlainPoolDeployedEvent(log);
      expect(result).not.toBeNull();
      // Only 2 non-zero coins, remaining 2 slots are zero addresses
      expect(result!.coins).toHaveLength(2);
    });

    it('should return null when fewer than 2 non-zero coins', () => {
      const log = createValidPlainPoolLog({ numCoins: 1 });
      const result = parseCurvePlainPoolDeployedEvent(log);
      expect(result).toBeNull();
    });
  });

  describe('Missing/insufficient data', () => {
    it('should return null when data is missing', () => {
      const log = createValidPlainPoolLog();
      delete (log as any).data;
      expect(parseCurvePlainPoolDeployedEvent(log)).toBeNull();
    });

    it('should return null when data has fewer than 8 words', () => {
      const log = createValidPlainPoolLog();
      log.data = '0x' + '0'.repeat(64 * 7); // Only 7 words, need 8
      expect(parseCurvePlainPoolDeployedEvent(log)).toBeNull();
    });

    it('should return null when topics is missing', () => {
      const log = createValidPlainPoolLog();
      delete (log as any).topics;
      expect(parseCurvePlainPoolDeployedEvent(log)).toBeNull();
    });

    it('should return null when topics is empty', () => {
      const log = createValidPlainPoolLog();
      log.topics = [];
      expect(parseCurvePlainPoolDeployedEvent(log)).toBeNull();
    });
  });

  describe('Null/undefined log', () => {
    it('should return null for null log', () => {
      expect(parseCurvePlainPoolDeployedEvent(null)).toBeNull();
    });

    it('should return null for undefined log', () => {
      expect(parseCurvePlainPoolDeployedEvent(undefined)).toBeNull();
    });

    it('should return null for empty object', () => {
      expect(parseCurvePlainPoolDeployedEvent({})).toBeNull();
    });
  });
});

// =============================================================================
// parseCurveMetaPoolDeployedEvent Tests
// =============================================================================

describe('parseCurveMetaPoolDeployedEvent', () => {
  describe('Happy path', () => {
    it('should parse a valid MetaPool deployed event', () => {
      const log = createValidMetaPoolLog();
      const result = parseCurveMetaPoolDeployedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.token0).toBe(COIN0);
      expect(result!.token1).toBe(BASE_POOL); // base_pool acts as virtual token
      expect(result!.pairAddress).toBe(POOL_ADDRESS);
      expect(result!.factoryAddress).toBe(FACTORY_ADDRESS.toLowerCase());
      expect(result!.factoryType).toBe('curve');
      expect(result!.isMetaPool).toBe(true);
      expect(result!.basePool).toBe(BASE_POOL);
      expect(result!.coins).toEqual([COIN0]);
      expect(result!.amplificationCoefficient).toBe(500);
      expect(result!.fee).toBe(4000000);
      expect(result!.blockNumber).toBe(17000001);
    });
  });

  describe('Zero address validation', () => {
    it('should return null when coin is zero address', () => {
      const log = createValidMetaPoolLog();
      // Replace coin with zero address in data
      log.data = '0x' +
        ZERO_ADDR_HEX +
        addressWord(BASE_POOL) +
        uint256Word(500) +
        uint256Word(4000000) +
        addressWord(DEPLOYER) +
        addressWord(POOL_ADDRESS);
      expect(parseCurveMetaPoolDeployedEvent(log)).toBeNull();
    });

    it('should return null when base_pool is zero address', () => {
      const log = createValidMetaPoolLog();
      log.data = '0x' +
        addressWord(COIN0) +
        ZERO_ADDR_HEX +
        uint256Word(500) +
        uint256Word(4000000) +
        addressWord(DEPLOYER) +
        addressWord(POOL_ADDRESS);
      expect(parseCurveMetaPoolDeployedEvent(log)).toBeNull();
    });
  });

  describe('Missing/insufficient data', () => {
    it('should return null when data has fewer than 6 words', () => {
      const log = createValidMetaPoolLog();
      log.data = '0x' + '0'.repeat(64 * 5); // Only 5 words, need 6
      expect(parseCurveMetaPoolDeployedEvent(log)).toBeNull();
    });

    it('should return null when data is missing', () => {
      const log = createValidMetaPoolLog();
      delete (log as any).data;
      expect(parseCurveMetaPoolDeployedEvent(log)).toBeNull();
    });
  });

  describe('Null/undefined log', () => {
    it('should return null for null log', () => {
      expect(parseCurveMetaPoolDeployedEvent(null)).toBeNull();
    });

    it('should return null for undefined log', () => {
      expect(parseCurveMetaPoolDeployedEvent(undefined)).toBeNull();
    });
  });
});

// =============================================================================
// parseCurvePoolCreatedEvent (Router) Tests
// =============================================================================

describe('parseCurvePoolCreatedEvent', () => {
  describe('Signature-based routing', () => {
    it('should route PlainPoolDeployed events to plain pool parser', () => {
      const log = createValidPlainPoolLog();
      const result = parseCurvePoolCreatedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.isMetaPool).toBe(false);
      expect(result!.coins).toHaveLength(2);
    });

    it('should route MetaPoolDeployed events to meta pool parser', () => {
      const log = createValidMetaPoolLog();
      const result = parseCurvePoolCreatedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.isMetaPool).toBe(true);
      expect(result!.basePool).toBe(BASE_POOL);
    });
  });

  describe('Fallback detection by data length', () => {
    it('should try plain pool parser when data has 8+ words and unknown signature', () => {
      const log = createValidPlainPoolLog();
      log.topics = ['0xunknownsignature00000000000000000000000000000000000000000000000'];
      const result = parseCurvePoolCreatedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.isMetaPool).toBe(false);
    });

    it('should try meta pool parser when data has 6-7 words and unknown signature', () => {
      const log = createValidMetaPoolLog();
      log.topics = ['0xunknownsignature00000000000000000000000000000000000000000000000'];
      const result = parseCurvePoolCreatedEvent(log);

      expect(result).not.toBeNull();
      expect(result!.isMetaPool).toBe(true);
    });

    it('should return null for unknown signature with insufficient data', () => {
      const log = {
        address: FACTORY_ADDRESS,
        topics: ['0xunknownsignature00000000000000000000000000000000000000000000000'],
        data: '0x' + '0'.repeat(64 * 3), // Only 3 words, too short for either
        blockNumber: 17000000,
        transactionHash: '0xtxhash',
      };
      expect(parseCurvePoolCreatedEvent(log)).toBeNull();
    });
  });

  describe('Null/undefined log', () => {
    it('should return null for null log', () => {
      expect(parseCurvePoolCreatedEvent(null)).toBeNull();
    });

    it('should return null for undefined log', () => {
      expect(parseCurvePoolCreatedEvent(undefined)).toBeNull();
    });

    it('should return null for log without topics', () => {
      expect(parseCurvePoolCreatedEvent({ data: '0x' })).toBeNull();
    });

    it('should return null for log without data', () => {
      expect(parseCurvePoolCreatedEvent({ topics: ['0xsig'] })).toBeNull();
    });

    it('should return null for log with empty topics', () => {
      expect(parseCurvePoolCreatedEvent({ topics: [], data: '0x' })).toBeNull();
    });
  });

  describe('Exported constants', () => {
    it('should export CURVE_PLAIN_POOL_SIGNATURE', () => {
      expect(CURVE_PLAIN_POOL_SIGNATURE).toBe('0xb8f6972d6e56d21c47621efd7f02fe68f07a17c999c42245b3abd300f34d61eb');
    });

    it('should export CURVE_META_POOL_SIGNATURE', () => {
      expect(CURVE_META_POOL_SIGNATURE).toBe('0x01f31cd2abdec67d966a3f6d992026644a5765d127b8b35ae4dd240b2baa0b9f');
    });
  });
});
