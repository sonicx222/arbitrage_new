/**
 * Raydium AMM Parser Tests
 *
 * Tests for parsing Raydium AMM V4 pool account data,
 * price calculation from reserves, and price update parsing.
 *
 * @see shared/core/src/solana/pricing/pool-parsers/raydium-amm-parser.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createMockLogger } from '@arbitrage/test-utils';
import {
  parseRaydiumAmmState,
  calculateAmmPrice,
  parseRaydiumAmmPriceUpdate,
  getDexName,
  getMinAccountSize,
  RAYDIUM_AMM_LAYOUT,
  RaydiumAmmPoolState,
} from '../../../../src/solana/pricing/pool-parsers/raydium-amm-parser';
import type { PoolParserLogger } from '../../../../src/solana/pricing/pool-parsers/types';

// Mock @solana/web3.js PublicKey
jest.mock('@solana/web3.js', () => ({
  PublicKey: class MockPublicKey {
    private data: Buffer;
    constructor(data: Buffer | string) {
      if (typeof data === 'string') {
        this.data = Buffer.alloc(32);
      } else {
        this.data = Buffer.from(data);
      }
    }
    toBase58(): string {
      // Return a deterministic base58 string from the buffer content
      return this.data.toString('hex').slice(0, 44);
    }
  },
}));

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a valid Raydium AMM buffer with configurable fields.
 */
function createValidAmmBuffer(overrides: {
  status?: number;
  baseDecimals?: number;
  quoteDecimals?: number;
  baseReserve?: bigint;
  quoteReserve?: bigint;
} = {}): Buffer {
  const buf = Buffer.alloc(RAYDIUM_AMM_LAYOUT.ACCOUNT_SIZE);

  // Status (offset 0)
  buf.writeUInt8(overrides.status ?? 1, RAYDIUM_AMM_LAYOUT.STATUS);

  // Nonce (offset 1)
  buf.writeUInt8(254, RAYDIUM_AMM_LAYOUT.NONCE);

  // Base decimals (offset 6)
  buf.writeUInt8(overrides.baseDecimals ?? 9, RAYDIUM_AMM_LAYOUT.BASE_DECIMALS);

  // Quote decimals (offset 7)
  buf.writeUInt8(overrides.quoteDecimals ?? 6, RAYDIUM_AMM_LAYOUT.QUOTE_DECIMALS);

  // Base reserve (offset 234, u64)
  buf.writeBigUInt64LE(overrides.baseReserve ?? BigInt('1000000000000'), RAYDIUM_AMM_LAYOUT.TOTAL_COIN);

  // Quote reserve (offset 242, u64)
  buf.writeBigUInt64LE(overrides.quoteReserve ?? BigInt('100000000000'), RAYDIUM_AMM_LAYOUT.TOTAL_PC);

  // Write some dummy pubkeys (32 bytes each) to avoid zero-key issues
  const dummyPubkey = Buffer.alloc(32, 1);
  dummyPubkey.copy(buf, RAYDIUM_AMM_LAYOUT.COIN_MINT);
  dummyPubkey.copy(buf, RAYDIUM_AMM_LAYOUT.PC_MINT);
  dummyPubkey.copy(buf, RAYDIUM_AMM_LAYOUT.COIN_VAULT);
  dummyPubkey.copy(buf, RAYDIUM_AMM_LAYOUT.PC_VAULT);
  dummyPubkey.copy(buf, RAYDIUM_AMM_LAYOUT.LP_MINT);
  dummyPubkey.copy(buf, RAYDIUM_AMM_LAYOUT.AMM_OPEN_ORDERS);
  dummyPubkey.copy(buf, RAYDIUM_AMM_LAYOUT.MARKET_ID);

  return buf;
}

// =============================================================================
// Tests
// =============================================================================

describe('RAYDIUM_AMM_LAYOUT', () => {
  it('should have correct account size', () => {
    expect(RAYDIUM_AMM_LAYOUT.ACCOUNT_SIZE).toBe(752);
  });

  it('should have COIN_MINT at offset 90', () => {
    expect(RAYDIUM_AMM_LAYOUT.COIN_MINT).toBe(90);
  });

  it('should have PC_MINT at offset 122', () => {
    expect(RAYDIUM_AMM_LAYOUT.PC_MINT).toBe(122);
  });

  it('should have TOTAL_COIN at offset 234', () => {
    expect(RAYDIUM_AMM_LAYOUT.TOTAL_COIN).toBe(234);
  });

  it('should have TOTAL_PC at offset 242', () => {
    expect(RAYDIUM_AMM_LAYOUT.TOTAL_PC).toBe(242);
  });
});

describe('parseRaydiumAmmState', () => {
  let logger: PoolParserLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should return null for buffer smaller than ACCOUNT_SIZE', () => {
    const shortBuffer = Buffer.alloc(100);

    const result = parseRaydiumAmmState(shortBuffer, logger);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should parse valid account data', () => {
    const buf = createValidAmmBuffer({ status: 1, baseDecimals: 9, quoteDecimals: 6 });

    const result = parseRaydiumAmmState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(1);
    expect(result!.baseDecimals).toBe(9);
    expect(result!.quoteDecimals).toBe(6);
    expect(result!.nonce).toBe(254);
  });

  it('should read reserve values', () => {
    const baseReserve = BigInt('5000000000000');
    const quoteReserve = BigInt('500000000000');
    const buf = createValidAmmBuffer({ baseReserve, quoteReserve });

    const result = parseRaydiumAmmState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.baseReserve).toBe(baseReserve);
    expect(result!.quoteReserve).toBe(quoteReserve);
  });

  it('should set default fee numerator/denominator', () => {
    const buf = createValidAmmBuffer();

    const result = parseRaydiumAmmState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.feeNumerator).toBe(25);
    expect(result!.feeDenominator).toBe(10000);
  });

  it('should set BaseParsedPoolState fields', () => {
    const buf = createValidAmmBuffer({ baseDecimals: 9, quoteDecimals: 6 });

    const result = parseRaydiumAmmState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.token0Decimals).toBe(9);
    expect(result!.token1Decimals).toBe(6);
    expect(typeof result!.token0Mint).toBe('string');
    expect(typeof result!.token1Mint).toBe('string');
  });

  it('should work without logger', () => {
    const buf = createValidAmmBuffer();

    const result = parseRaydiumAmmState(buf);

    expect(result).not.toBeNull();
  });
});

describe('calculateAmmPrice', () => {
  it('should return 0 when baseReserve is 0', () => {
    const state = {
      baseReserve: BigInt(0),
      quoteReserve: BigInt('100000000000'),
      baseDecimals: 9,
      quoteDecimals: 6,
    } as RaydiumAmmPoolState;

    expect(calculateAmmPrice(state)).toBe(0);
  });

  it('should calculate price with same decimals', () => {
    // 18 decimals for both tokens
    const state = {
      baseReserve: BigInt('1000000000000000000'), // 1 token (18 decimals)
      quoteReserve: BigInt('100000000000000000000'), // 100 tokens (18 decimals)
      baseDecimals: 18,
      quoteDecimals: 18,
    } as RaydiumAmmPoolState;

    const price = calculateAmmPrice(state);

    // rawPrice = 100/1 = 100, decimalAdj = 10^(18-18) = 1
    expect(price).toBeCloseTo(100, 4);
  });

  it('should adjust for different decimals (SOL 9 / USDC 6)', () => {
    // SOL: 9 decimals, USDC: 6 decimals
    const state = {
      baseReserve: BigInt('1000000000'), // 1 SOL (9 decimals)
      quoteReserve: BigInt('100000000'), // 100 USDC (6 decimals)
      baseDecimals: 9,
      quoteDecimals: 6,
    } as RaydiumAmmPoolState;

    const price = calculateAmmPrice(state);

    // rawPrice = 100000000/1000000000 = 0.1
    // decimalAdj = 10^(9-6) = 1000
    // price = 0.1 * 1000 = 100
    expect(price).toBeCloseTo(100, 4);
  });

  it('should handle very small reserves', () => {
    const state = {
      baseReserve: BigInt(1),
      quoteReserve: BigInt(1),
      baseDecimals: 9,
      quoteDecimals: 9,
    } as RaydiumAmmPoolState;

    const price = calculateAmmPrice(state);

    expect(price).toBeCloseTo(1, 4);
    expect(Number.isFinite(price)).toBe(true);
  });
});

describe('parseRaydiumAmmPriceUpdate', () => {
  let logger: PoolParserLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should return null for invalid buffer', () => {
    const result = parseRaydiumAmmPriceUpdate('pool-1', Buffer.alloc(10), 100, logger);

    expect(result).toBeNull();
  });

  it('should return null for inactive pool (status != 1)', () => {
    const buf = createValidAmmBuffer({ status: 0 });

    const result = parseRaydiumAmmPriceUpdate('pool-1', buf, 100, logger);

    expect(result).toBeNull();
  });

  it('should return null when baseReserve is 0 (price = 0)', () => {
    const buf = createValidAmmBuffer({ baseReserve: BigInt(0) });

    const result = parseRaydiumAmmPriceUpdate('pool-1', buf, 100, logger);

    expect(result).toBeNull();
  });

  it('should parse valid price update', () => {
    const buf = createValidAmmBuffer({
      status: 1,
      baseDecimals: 9,
      quoteDecimals: 6,
      baseReserve: BigInt('1000000000'),
      quoteReserve: BigInt('100000000'),
    });

    const result = parseRaydiumAmmPriceUpdate('pool-1', buf, 12345, logger);

    expect(result).not.toBeNull();
    expect(result!.poolAddress).toBe('pool-1');
    expect(result!.dex).toBe('raydium-amm');
    expect(result!.slot).toBe(12345);
    expect(result!.price).toBeGreaterThan(0);
    expect(result!.inversePrice).toBeGreaterThan(0);
    expect(typeof result!.reserve0).toBe('string');
    expect(typeof result!.reserve1).toBe('string');
    expect(typeof result!.timestamp).toBe('number');
  });

  it('should calculate valid inverse price', () => {
    const buf = createValidAmmBuffer({
      status: 1,
      baseDecimals: 9,
      quoteDecimals: 6,
      baseReserve: BigInt('1000000000'),
      quoteReserve: BigInt('100000000'),
    });

    const result = parseRaydiumAmmPriceUpdate('pool-1', buf, 100, logger);

    expect(result).not.toBeNull();
    expect(result!.price * result!.inversePrice).toBeCloseTo(1, 4);
  });

  it('should work without logger', () => {
    const buf = createValidAmmBuffer({
      status: 1,
      baseReserve: BigInt('1000000000'),
      quoteReserve: BigInt('100000000'),
    });

    const result = parseRaydiumAmmPriceUpdate('pool-1', buf, 100);

    expect(result).not.toBeNull();
  });
});

describe('getDexName', () => {
  it('should return raydium-amm', () => {
    expect(getDexName()).toBe('raydium-amm');
  });
});

describe('getMinAccountSize', () => {
  it('should return ACCOUNT_SIZE constant', () => {
    expect(getMinAccountSize()).toBe(RAYDIUM_AMM_LAYOUT.ACCOUNT_SIZE);
    expect(getMinAccountSize()).toBe(752);
  });
});
