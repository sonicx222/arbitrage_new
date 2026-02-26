/**
 * Balancer V2 Parser Unit Tests
 *
 * Tests for parsing Balancer V2 PoolRegistered and TokensRegistered events.
 *
 * @see factory-subscription/parsers/balancer-v2-parser.ts
 */

import { describe, it, expect } from '@jest/globals';
import {
  parseBalancerPoolRegisteredEvent,
  parseBalancerTokensRegisteredEvent,
  BALANCER_TOKENS_REGISTERED_SIGNATURE,
} from '../../../../src/factory-subscription/parsers/balancer-v2-parser';
import type { RawEventLog } from '../../../../src/factory-subscription/parsers/types';

// =============================================================================
// Test Helpers
// =============================================================================

const POOL_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const POOL_ID = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd000200000000000000000001';
const FACTORY_ADDRESS = '0xFactory000000000000000000000000000000001';
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Pad an address to a 32-byte hex topic (with 0x prefix) */
function toTopic(address: string): string {
  const raw = address.replace('0x', '').toLowerCase();
  return '0x' + raw.padStart(64, '0');
}

/** Encode a uint256 as 32-byte word (no 0x prefix) */
function uint256Word(value: number): string {
  return value.toString(16).padStart(64, '0');
}

/** Pad an address to a 32-byte word (no 0x prefix) */
function addressWord(addr: string): string {
  return addr.replace('0x', '').toLowerCase().padStart(64, '0');
}

function createValidPoolRegisteredLog(specialization: number = 0) {
  // Data: specialization (uint8 in 32-byte word)
  const data = '0x' + uint256Word(specialization);

  return {
    address: FACTORY_ADDRESS,
    topics: [
      '0x3c13bc30b8e878c53fd2c36a5e4c8893d1d0b84e3b3aaf1e6c94a0ef72039384', // PoolRegistered signature
      POOL_ID.toLowerCase(), // poolId (bytes32)
      toTopic(POOL_ADDRESS),
    ],
    data,
    blockNumber: 16000000,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000007',
  };
}

function createValidTokensRegisteredLog(tokens: string[] = [TOKEN_A, TOKEN_B]) {
  // Dynamic array encoding for TokensRegistered(bytes32 indexed poolId, address[] tokens, address[] assetManagers)
  // Data layout:
  //   word 0: offset to tokens array (0x40 = 64 bytes = 2 words)
  //   word 1: offset to assetManagers array
  //   word 2: tokens array length
  //   word 3+: token addresses
  //   then: assetManagers array length + addresses

  const tokensArrayLength = tokens.length;
  const managersArrayLength = tokens.length;
  const tokensOffset = 64; // 2 words * 32 bytes
  const managersOffset = tokensOffset + 32 + tokensArrayLength * 32; // after tokens array

  let data = '0x';
  data += uint256Word(tokensOffset);                  // word 0: offset to tokens
  data += uint256Word(managersOffset);                // word 1: offset to managers
  data += uint256Word(tokensArrayLength);             // word 2: tokens length
  for (const token of tokens) {                       // words 3+: token addresses
    data += addressWord(token);
  }
  data += uint256Word(managersArrayLength);           // managers length
  for (const token of tokens) {                       // manager addresses (same as tokens for simplicity)
    data += addressWord(token);
  }

  return {
    address: FACTORY_ADDRESS,
    topics: [
      BALANCER_TOKENS_REGISTERED_SIGNATURE,
      POOL_ID.toLowerCase(),
    ],
    data,
    blockNumber: 16000001,
    transactionHash: '0xtxhash0000000000000000000000000000000000000000000000000000000008',
  };
}

// =============================================================================
// parseBalancerPoolRegisteredEvent Tests
// =============================================================================

describe('parseBalancerPoolRegisteredEvent', () => {
  describe('Happy path', () => {
    it('should parse a valid PoolRegistered event with General specialization', () => {
      const log = createValidPoolRegisteredLog(0);
      const result = parseBalancerPoolRegisteredEvent(log);

      expect(result).not.toBeNull();
      expect(result!.pairAddress).toBe(POOL_ADDRESS);
      expect(result!.poolId).toBe(POOL_ID.toLowerCase());
      expect(result!.factoryAddress).toBe(FACTORY_ADDRESS.toLowerCase());
      expect(result!.factoryType).toBe('balancer_v2');
      expect(result!.specialization).toBe(0);
      expect(result!.requiresTokenLookup).toBe(true);
      expect(result!.token0).toBe(ZERO_ADDRESS);
      expect(result!.token1).toBe(ZERO_ADDRESS);
      expect(result!.blockNumber).toBe(16000000);
    });

    it('should parse MinimalSwap specialization (1)', () => {
      const log = createValidPoolRegisteredLog(1);
      const result = parseBalancerPoolRegisteredEvent(log);
      expect(result).not.toBeNull();
      expect(result!.specialization).toBe(1);
    });

    it('should parse TwoToken specialization (2)', () => {
      const log = createValidPoolRegisteredLog(2);
      const result = parseBalancerPoolRegisteredEvent(log);
      expect(result).not.toBeNull();
      expect(result!.specialization).toBe(2);
    });
  });

  describe('Token lookup flag', () => {
    it('should always set requiresTokenLookup to true', () => {
      const log = createValidPoolRegisteredLog();
      const result = parseBalancerPoolRegisteredEvent(log);
      expect(result).not.toBeNull();
      expect(result!.requiresTokenLookup).toBe(true);
    });

    it('should set token0 and token1 to zero address', () => {
      const log = createValidPoolRegisteredLog();
      const result = parseBalancerPoolRegisteredEvent(log);
      expect(result).not.toBeNull();
      expect(result!.token0).toBe(ZERO_ADDRESS);
      expect(result!.token1).toBe(ZERO_ADDRESS);
    });
  });

  describe('Missing/insufficient topics', () => {
    it('should return null when topics is missing', () => {
      const log = createValidPoolRegisteredLog();
      delete (log as any).topics;
      expect(parseBalancerPoolRegisteredEvent(log)).toBeNull();
    });

    it('should return null when topics has fewer than 3 entries', () => {
      const log = createValidPoolRegisteredLog();
      log.topics = [log.topics[0], log.topics[1]];
      expect(parseBalancerPoolRegisteredEvent(log)).toBeNull();
    });

    it('should return null when topics is empty', () => {
      const log = createValidPoolRegisteredLog();
      log.topics = [];
      expect(parseBalancerPoolRegisteredEvent(log)).toBeNull();
    });
  });

  describe('Missing/insufficient data', () => {
    it('should return null when data is missing', () => {
      const log = createValidPoolRegisteredLog();
      delete (log as any).data;
      expect(parseBalancerPoolRegisteredEvent(log)).toBeNull();
    });

    it('should return null when data is too short', () => {
      const log = createValidPoolRegisteredLog();
      log.data = '0x' + '0'.repeat(32); // Less than 1 word
      expect(parseBalancerPoolRegisteredEvent(log)).toBeNull();
    });

    it('should return null when data is just the prefix', () => {
      const log = createValidPoolRegisteredLog();
      log.data = '0x';
      expect(parseBalancerPoolRegisteredEvent(log)).toBeNull();
    });
  });

  describe('Null/undefined log', () => {
    it('should return null for null log', () => {
      expect(parseBalancerPoolRegisteredEvent(null as unknown as RawEventLog)).toBeNull();
    });

    it('should return null for undefined log', () => {
      expect(parseBalancerPoolRegisteredEvent(undefined as unknown as RawEventLog)).toBeNull();
    });

    it('should return null for empty object', () => {
      expect(parseBalancerPoolRegisteredEvent({} as RawEventLog)).toBeNull();
    });
  });
});

// =============================================================================
// parseBalancerTokensRegisteredEvent Tests
// =============================================================================

describe('parseBalancerTokensRegisteredEvent', () => {
  describe('Happy path', () => {
    it('should parse a valid 2-token TokensRegistered event', () => {
      const log = createValidTokensRegisteredLog([TOKEN_A, TOKEN_B]);
      const result = parseBalancerTokensRegisteredEvent(log);

      expect(result).not.toBeNull();
      expect(result!.poolId).toBe(POOL_ID.toLowerCase());
      expect(result!.tokens).toEqual([TOKEN_A, TOKEN_B]);
    });

    it('should parse a valid 3-token TokensRegistered event', () => {
      const log = createValidTokensRegisteredLog([TOKEN_A, TOKEN_B, TOKEN_C]);
      const result = parseBalancerTokensRegisteredEvent(log);

      expect(result).not.toBeNull();
      expect(result!.tokens).toHaveLength(3);
      expect(result!.tokens).toEqual([TOKEN_A, TOKEN_B, TOKEN_C]);
    });
  });

  describe('Token filtering', () => {
    it('should filter out zero addresses from tokens', () => {
      const log = createValidTokensRegisteredLog([TOKEN_A, '0x0000000000000000000000000000000000000000', TOKEN_B]);
      const result = parseBalancerTokensRegisteredEvent(log);

      expect(result).not.toBeNull();
      expect(result!.tokens).toEqual([TOKEN_A, TOKEN_B]);
    });
  });

  describe('Missing/insufficient topics', () => {
    it('should return null when topics is missing', () => {
      const log = createValidTokensRegisteredLog();
      delete (log as any).topics;
      expect(parseBalancerTokensRegisteredEvent(log)).toBeNull();
    });

    it('should return null when topics has fewer than 2 entries', () => {
      const log = createValidTokensRegisteredLog();
      log.topics = [log.topics[0]];
      expect(parseBalancerTokensRegisteredEvent(log)).toBeNull();
    });
  });

  describe('Missing data', () => {
    it('should return null when data is missing', () => {
      const log = createValidTokensRegisteredLog();
      delete (log as any).data;
      expect(parseBalancerTokensRegisteredEvent(log)).toBeNull();
    });
  });

  describe('Null/undefined log', () => {
    it('should return null for null log', () => {
      expect(parseBalancerTokensRegisteredEvent(null as unknown as RawEventLog)).toBeNull();
    });

    it('should return null for undefined log', () => {
      expect(parseBalancerTokensRegisteredEvent(undefined as unknown as RawEventLog)).toBeNull();
    });

    it('should return null for empty object', () => {
      expect(parseBalancerTokensRegisteredEvent({} as RawEventLog)).toBeNull();
    });
  });

  describe('Exported constants', () => {
    it('should export BALANCER_TOKENS_REGISTERED_SIGNATURE', () => {
      expect(BALANCER_TOKENS_REGISTERED_SIGNATURE).toBe(
        '0xf5847d3f2197b16cdcd2098ec95d0905cd1abdaf415f07571c3b5a3e0be8d461'
      );
    });
  });
});
