/**
 * Raydium CLMM Parser Tests
 *
 * Tests for parsing Raydium Concentrated Liquidity pool account data,
 * CLMM price calculation from sqrtPriceX64, and price update parsing.
 *
 * @see shared/core/src/solana/pricing/pool-parsers/raydium-clmm-parser.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createMockLogger } from '@arbitrage/test-utils';
import {
  parseRaydiumClmmState,
  calculateClmmPrice,
  parseRaydiumClmmPriceUpdate,
  getDexName,
  getMinAccountSize,
  RAYDIUM_CLMM_LAYOUT,
  RaydiumClmmPoolState,
} from '../../../../src/solana/pricing/pool-parsers/raydium-clmm-parser';
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
      return this.data.toString('hex').slice(0, 44);
    }
  },
}));

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a valid Raydium CLMM buffer with configurable fields.
 */
function createValidClmmBuffer(overrides: {
  status?: number;
  mintDecimals0?: number;
  mintDecimals1?: number;
  tickSpacing?: number;
  sqrtPriceX64?: bigint;
  liquidity?: bigint;
  tickCurrent?: number;
  feeRate?: number;
} = {}): Buffer {
  const buf = Buffer.alloc(RAYDIUM_CLMM_LAYOUT.ACCOUNT_SIZE);

  // Bump (offset 8)
  buf.writeUInt8(255, RAYDIUM_CLMM_LAYOUT.BUMP);

  // Mint decimals
  buf.writeUInt8(overrides.mintDecimals0 ?? 9, RAYDIUM_CLMM_LAYOUT.MINT_DECIMALS_0);
  buf.writeUInt8(overrides.mintDecimals1 ?? 6, RAYDIUM_CLMM_LAYOUT.MINT_DECIMALS_1);

  // Tick spacing
  buf.writeUInt16LE(overrides.tickSpacing ?? 10, RAYDIUM_CLMM_LAYOUT.TICK_SPACING);

  // Liquidity (u128 = 16 bytes LE)
  const liq = overrides.liquidity ?? BigInt('1000000000000');
  buf.writeBigUInt64LE(liq & BigInt('0xFFFFFFFFFFFFFFFF'), RAYDIUM_CLMM_LAYOUT.LIQUIDITY);
  buf.writeBigUInt64LE(liq >> BigInt(64), RAYDIUM_CLMM_LAYOUT.LIQUIDITY + 8);

  // sqrtPriceX64 (u128 = 16 bytes LE)
  // For a price of ~100 SOL/USDC with 9/6 decimals:
  // price = (sqrtPrice / 2^64)^2 * 10^(9-6)
  // We want price ~100, so (sqrtPrice/2^64)^2 = 100/1000 = 0.1
  // sqrtPrice/2^64 = sqrt(0.1) ~= 0.3162
  // sqrtPrice = 0.3162 * 2^64 ~= 5832724741504768000
  const sqrtPriceX64 = overrides.sqrtPriceX64 ?? BigInt('5832724741504768000');
  buf.writeBigUInt64LE(sqrtPriceX64 & BigInt('0xFFFFFFFFFFFFFFFF'), RAYDIUM_CLMM_LAYOUT.SQRT_PRICE_X64);
  buf.writeBigUInt64LE(sqrtPriceX64 >> BigInt(64), RAYDIUM_CLMM_LAYOUT.SQRT_PRICE_X64 + 8);

  // Tick current (i32)
  buf.writeInt32LE(overrides.tickCurrent ?? -23028, RAYDIUM_CLMM_LAYOUT.TICK_CURRENT);

  // Fee growth global (u128)
  buf.writeBigUInt64LE(BigInt(0), RAYDIUM_CLMM_LAYOUT.FEE_GROWTH_GLOBAL_0_X64);
  buf.writeBigUInt64LE(BigInt(0), RAYDIUM_CLMM_LAYOUT.FEE_GROWTH_GLOBAL_0_X64 + 8);
  buf.writeBigUInt64LE(BigInt(0), RAYDIUM_CLMM_LAYOUT.FEE_GROWTH_GLOBAL_1_X64);
  buf.writeBigUInt64LE(BigInt(0), RAYDIUM_CLMM_LAYOUT.FEE_GROWTH_GLOBAL_1_X64 + 8);

  // Protocol fees (u64)
  buf.writeBigUInt64LE(BigInt(0), RAYDIUM_CLMM_LAYOUT.PROTOCOL_FEES_TOKEN_0);
  buf.writeBigUInt64LE(BigInt(0), RAYDIUM_CLMM_LAYOUT.PROTOCOL_FEES_TOKEN_1);

  // Fee rate (u32)
  buf.writeUInt32LE(overrides.feeRate ?? 2500, RAYDIUM_CLMM_LAYOUT.FEE_RATE);

  // Status
  buf.writeUInt8(overrides.status ?? 1, RAYDIUM_CLMM_LAYOUT.STATUS);

  // Write dummy pubkeys (32 bytes each)
  const dummyPubkey = Buffer.alloc(32, 1);
  dummyPubkey.copy(buf, RAYDIUM_CLMM_LAYOUT.AMM_CONFIG);
  dummyPubkey.copy(buf, RAYDIUM_CLMM_LAYOUT.POOL_CREATOR);
  dummyPubkey.copy(buf, RAYDIUM_CLMM_LAYOUT.TOKEN_0_MINT);
  dummyPubkey.copy(buf, RAYDIUM_CLMM_LAYOUT.TOKEN_1_MINT);
  dummyPubkey.copy(buf, RAYDIUM_CLMM_LAYOUT.TOKEN_0_VAULT);
  dummyPubkey.copy(buf, RAYDIUM_CLMM_LAYOUT.TOKEN_1_VAULT);
  dummyPubkey.copy(buf, RAYDIUM_CLMM_LAYOUT.OBSERVATION_KEY);

  return buf;
}

// =============================================================================
// Tests
// =============================================================================

describe('RAYDIUM_CLMM_LAYOUT', () => {
  it('should have correct account size', () => {
    expect(RAYDIUM_CLMM_LAYOUT.ACCOUNT_SIZE).toBe(1544);
  });

  it('should have SQRT_PRICE_X64 at offset 253', () => {
    expect(RAYDIUM_CLMM_LAYOUT.SQRT_PRICE_X64).toBe(253);
  });

  it('should have LIQUIDITY at offset 237', () => {
    expect(RAYDIUM_CLMM_LAYOUT.LIQUIDITY).toBe(237);
  });

  it('should have FEE_RATE at offset 325', () => {
    expect(RAYDIUM_CLMM_LAYOUT.FEE_RATE).toBe(325);
  });

  it('should have STATUS at offset 329', () => {
    expect(RAYDIUM_CLMM_LAYOUT.STATUS).toBe(329);
  });
});

describe('parseRaydiumClmmState', () => {
  let logger: PoolParserLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should return null for buffer smaller than ACCOUNT_SIZE', () => {
    const shortBuffer = Buffer.alloc(100);

    const result = parseRaydiumClmmState(shortBuffer, logger);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should parse valid account data', () => {
    const buf = createValidClmmBuffer({
      mintDecimals0: 9,
      mintDecimals1: 6,
      tickSpacing: 10,
      feeRate: 2500,
      status: 1,
    });

    const result = parseRaydiumClmmState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.mintDecimals0).toBe(9);
    expect(result!.mintDecimals1).toBe(6);
    expect(result!.tickSpacing).toBe(10);
    expect(result!.feeRate).toBe(2500);
    expect(result!.status).toBe(1);
  });

  it('should read bump value', () => {
    const buf = createValidClmmBuffer();

    const result = parseRaydiumClmmState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.bump).toBe(255);
  });

  it('should read sqrtPriceX64 as bigint', () => {
    const sqrtPriceX64 = BigInt('5832724741504768000');
    const buf = createValidClmmBuffer({ sqrtPriceX64 });

    const result = parseRaydiumClmmState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.sqrtPriceX64).toBe(sqrtPriceX64);
  });

  it('should read liquidity as bigint', () => {
    const liquidity = BigInt('999888777666');
    const buf = createValidClmmBuffer({ liquidity });

    const result = parseRaydiumClmmState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.liquidity).toBe(liquidity);
  });

  it('should read tick current as signed int32', () => {
    const buf = createValidClmmBuffer({ tickCurrent: -50000 });

    const result = parseRaydiumClmmState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.tickCurrent).toBe(-50000);
  });

  it('should set BaseParsedPoolState fields', () => {
    const buf = createValidClmmBuffer({ mintDecimals0: 9, mintDecimals1: 6 });

    const result = parseRaydiumClmmState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.token0Decimals).toBe(9);
    expect(result!.token1Decimals).toBe(6);
  });

  it('should work without logger', () => {
    const buf = createValidClmmBuffer();

    const result = parseRaydiumClmmState(buf);

    expect(result).not.toBeNull();
  });
});

describe('calculateClmmPrice', () => {
  it('should return 0 when sqrtPriceX64 is 0', () => {
    const state = {
      sqrtPriceX64: BigInt(0),
      mintDecimals0: 9,
      mintDecimals1: 6,
    } as RaydiumClmmPoolState;

    expect(calculateClmmPrice(state)).toBe(0);
  });

  it('should calculate price with same decimals', () => {
    // sqrtPrice = 2^64 means price = 1
    // (2^64 / 2^64)^2 * 10^(18-18) = 1
    const state = {
      sqrtPriceX64: BigInt('18446744073709551616'), // 2^64
      mintDecimals0: 18,
      mintDecimals1: 18,
    } as RaydiumClmmPoolState;

    const price = calculateClmmPrice(state);

    expect(price).toBeCloseTo(1, 4);
  });

  it('should return a positive number for valid sqrtPriceX64', () => {
    const state = {
      sqrtPriceX64: BigInt('5832724741504768000'),
      mintDecimals0: 9,
      mintDecimals1: 6,
    } as RaydiumClmmPoolState;

    const price = calculateClmmPrice(state);

    expect(price).toBeGreaterThan(0);
    expect(Number.isFinite(price)).toBe(true);
  });
});

describe('parseRaydiumClmmPriceUpdate', () => {
  let logger: PoolParserLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should return null for invalid buffer', () => {
    const result = parseRaydiumClmmPriceUpdate('pool-1', Buffer.alloc(10), 100, 9, 6, logger);

    expect(result).toBeNull();
  });

  it('should return null for inactive pool', () => {
    const buf = createValidClmmBuffer({ status: 0 });

    const result = parseRaydiumClmmPriceUpdate('pool-1', buf, 100, 9, 6, logger);

    expect(result).toBeNull();
  });

  it('should return null when sqrtPriceX64 is 0', () => {
    const buf = createValidClmmBuffer({ sqrtPriceX64: BigInt(0) });

    const result = parseRaydiumClmmPriceUpdate('pool-1', buf, 100, 9, 6, logger);

    expect(result).toBeNull();
  });

  it('should parse valid price update', () => {
    const buf = createValidClmmBuffer({
      status: 1,
      sqrtPriceX64: BigInt('5832724741504768000'),
    });

    const result = parseRaydiumClmmPriceUpdate('pool-1', buf, 12345, 9, 6, logger);

    expect(result).not.toBeNull();
    expect(result!.poolAddress).toBe('pool-1');
    expect(result!.dex).toBe('raydium-clmm');
    expect(result!.slot).toBe(12345);
    expect(result!.price).toBeGreaterThan(0);
    expect(result!.inversePrice).toBeGreaterThan(0);
    expect(typeof result!.timestamp).toBe('number');
  });

  it('should include CLMM-specific fields', () => {
    const buf = createValidClmmBuffer({
      status: 1,
      sqrtPriceX64: BigInt('5832724741504768000'),
      liquidity: BigInt('999888777'),
      tickCurrent: -23028,
    });

    const result = parseRaydiumClmmPriceUpdate('pool-1', buf, 100, 9, 6, logger);

    expect(result).not.toBeNull();
    expect(result!.sqrtPriceX64).toBeDefined();
    expect(result!.liquidity).toBeDefined();
    expect(result!.tickCurrentIndex).toBe(-23028);
  });

  it('should set reserve0 and reserve1 to 0 for CLMM', () => {
    const buf = createValidClmmBuffer({
      status: 1,
      sqrtPriceX64: BigInt('5832724741504768000'),
    });

    const result = parseRaydiumClmmPriceUpdate('pool-1', buf, 100, 9, 6, logger);

    expect(result).not.toBeNull();
    expect(result!.reserve0).toBe('0');
    expect(result!.reserve1).toBe('0');
  });

  it('should calculate valid inverse price', () => {
    const buf = createValidClmmBuffer({
      status: 1,
      sqrtPriceX64: BigInt('5832724741504768000'),
    });

    const result = parseRaydiumClmmPriceUpdate('pool-1', buf, 100, 9, 6, logger);

    expect(result).not.toBeNull();
    expect(result!.price * result!.inversePrice).toBeCloseTo(1, 4);
  });

  it('should work without logger', () => {
    const buf = createValidClmmBuffer({
      status: 1,
      sqrtPriceX64: BigInt('5832724741504768000'),
    });

    const result = parseRaydiumClmmPriceUpdate('pool-1', buf, 100, 9, 6);

    expect(result).not.toBeNull();
  });
});

describe('getDexName', () => {
  it('should return raydium-clmm', () => {
    expect(getDexName()).toBe('raydium-clmm');
  });
});

describe('getMinAccountSize', () => {
  it('should return ACCOUNT_SIZE constant', () => {
    expect(getMinAccountSize()).toBe(RAYDIUM_CLMM_LAYOUT.ACCOUNT_SIZE);
    expect(getMinAccountSize()).toBe(1544);
  });
});
