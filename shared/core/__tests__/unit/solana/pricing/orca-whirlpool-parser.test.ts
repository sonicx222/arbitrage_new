/**
 * Orca Whirlpool Parser Tests
 *
 * Tests for parsing Orca Whirlpool concentrated liquidity pool account data,
 * price calculation from sqrtPrice, and price update parsing.
 *
 * @see shared/core/src/solana/pricing/pool-parsers/orca-whirlpool-parser.ts
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createMockLogger } from '@arbitrage/test-utils';
import {
  parseOrcaWhirlpoolState,
  calculateWhirlpoolPrice,
  parseOrcaWhirlpoolPriceUpdate,
  getDexName,
  getMinAccountSize,
  ORCA_WHIRLPOOL_LAYOUT,
  OrcaWhirlpoolState,
} from '../../../../src/solana/pricing/pool-parsers/orca-whirlpool-parser';
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
 * Create a valid Orca Whirlpool buffer with configurable fields.
 */
function createValidWhirlpoolBuffer(overrides: {
  tickSpacing?: number;
  feeRate?: number;
  protocolFeeRate?: number;
  sqrtPrice?: bigint;
  liquidity?: bigint;
  tickCurrentIndex?: number;
} = {}): Buffer {
  const buf = Buffer.alloc(ORCA_WHIRLPOOL_LAYOUT.ACCOUNT_SIZE);

  // Discriminator (8 bytes at offset 0)
  // Just leave as zeros for testing

  // Whirlpool bump
  buf.writeUInt8(255, ORCA_WHIRLPOOL_LAYOUT.WHIRLPOOL_BUMP);

  // Tick spacing
  buf.writeUInt16LE(overrides.tickSpacing ?? 64, ORCA_WHIRLPOOL_LAYOUT.TICK_SPACING);

  // Tick spacing seed
  buf.writeUInt8(1, ORCA_WHIRLPOOL_LAYOUT.TICK_SPACING_SEED);

  // Fee rate
  buf.writeUInt16LE(overrides.feeRate ?? 3000, ORCA_WHIRLPOOL_LAYOUT.FEE_RATE);

  // Protocol fee rate
  buf.writeUInt16LE(overrides.protocolFeeRate ?? 300, ORCA_WHIRLPOOL_LAYOUT.PROTOCOL_FEE_RATE);

  // Liquidity (u128 = 16 bytes LE)
  const liq = overrides.liquidity ?? BigInt('5000000000000');
  buf.writeBigUInt64LE(liq & BigInt('0xFFFFFFFFFFFFFFFF'), ORCA_WHIRLPOOL_LAYOUT.LIQUIDITY);
  buf.writeBigUInt64LE(liq >> BigInt(64), ORCA_WHIRLPOOL_LAYOUT.LIQUIDITY + 8);

  // sqrtPrice (u128 = 16 bytes LE)
  // For price ~100 with 9/6 decimals:
  // (sqrtPrice / 2^64)^2 * 10^(9-6) = 100
  // (sqrtPrice / 2^64)^2 = 0.1
  // sqrtPrice / 2^64 = sqrt(0.1) ~= 0.3162
  // sqrtPrice = 0.3162 * 2^64 ~= 5832724741504768000
  const sqrtPrice = overrides.sqrtPrice ?? BigInt('5832724741504768000');
  buf.writeBigUInt64LE(sqrtPrice & BigInt('0xFFFFFFFFFFFFFFFF'), ORCA_WHIRLPOOL_LAYOUT.SQRT_PRICE);
  buf.writeBigUInt64LE(sqrtPrice >> BigInt(64), ORCA_WHIRLPOOL_LAYOUT.SQRT_PRICE + 8);

  // Tick current index (i32)
  buf.writeInt32LE(overrides.tickCurrentIndex ?? -23028, ORCA_WHIRLPOOL_LAYOUT.TICK_CURRENT_INDEX);

  // Protocol fee owed (u64)
  buf.writeBigUInt64LE(BigInt(0), ORCA_WHIRLPOOL_LAYOUT.PROTOCOL_FEE_OWED_A);
  buf.writeBigUInt64LE(BigInt(0), ORCA_WHIRLPOOL_LAYOUT.PROTOCOL_FEE_OWED_B);

  // Fee growth global (u128)
  buf.writeBigUInt64LE(BigInt(0), ORCA_WHIRLPOOL_LAYOUT.FEE_GROWTH_GLOBAL_A);
  buf.writeBigUInt64LE(BigInt(0), ORCA_WHIRLPOOL_LAYOUT.FEE_GROWTH_GLOBAL_A + 8);
  buf.writeBigUInt64LE(BigInt(0), ORCA_WHIRLPOOL_LAYOUT.FEE_GROWTH_GLOBAL_B);
  buf.writeBigUInt64LE(BigInt(0), ORCA_WHIRLPOOL_LAYOUT.FEE_GROWTH_GLOBAL_B + 8);

  // Reward last updated timestamp (u64)
  buf.writeBigUInt64LE(BigInt(Date.now()), ORCA_WHIRLPOOL_LAYOUT.REWARD_LAST_UPDATED_TIMESTAMP);

  // Write dummy pubkeys (32 bytes each)
  const dummyPubkey = Buffer.alloc(32, 1);
  dummyPubkey.copy(buf, ORCA_WHIRLPOOL_LAYOUT.WHIRLPOOLS_CONFIG);
  dummyPubkey.copy(buf, ORCA_WHIRLPOOL_LAYOUT.TOKEN_MINT_A);
  dummyPubkey.copy(buf, ORCA_WHIRLPOOL_LAYOUT.TOKEN_MINT_B);
  dummyPubkey.copy(buf, ORCA_WHIRLPOOL_LAYOUT.TOKEN_VAULT_A);
  dummyPubkey.copy(buf, ORCA_WHIRLPOOL_LAYOUT.TOKEN_VAULT_B);

  return buf;
}

// =============================================================================
// Tests
// =============================================================================

describe('ORCA_WHIRLPOOL_LAYOUT', () => {
  it('should have correct account size', () => {
    expect(ORCA_WHIRLPOOL_LAYOUT.ACCOUNT_SIZE).toBe(653);
  });

  it('should have DISCRIMINATOR at offset 0', () => {
    expect(ORCA_WHIRLPOOL_LAYOUT.DISCRIMINATOR).toBe(0);
  });

  it('should have SQRT_PRICE at offset 65', () => {
    expect(ORCA_WHIRLPOOL_LAYOUT.SQRT_PRICE).toBe(65);
  });

  it('should have LIQUIDITY at offset 49', () => {
    expect(ORCA_WHIRLPOOL_LAYOUT.LIQUIDITY).toBe(49);
  });

  it('should have FEE_RATE at offset 45', () => {
    expect(ORCA_WHIRLPOOL_LAYOUT.FEE_RATE).toBe(45);
  });

  it('should have TOKEN_MINT_A at offset 101', () => {
    expect(ORCA_WHIRLPOOL_LAYOUT.TOKEN_MINT_A).toBe(101);
  });

  it('should have TOKEN_MINT_B at offset 133', () => {
    expect(ORCA_WHIRLPOOL_LAYOUT.TOKEN_MINT_B).toBe(133);
  });
});

describe('parseOrcaWhirlpoolState', () => {
  let logger: PoolParserLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should return null for buffer smaller than ACCOUNT_SIZE', () => {
    const shortBuffer = Buffer.alloc(100);

    const result = parseOrcaWhirlpoolState(shortBuffer, logger);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should parse valid account data', () => {
    const buf = createValidWhirlpoolBuffer({
      tickSpacing: 64,
      feeRate: 3000,
      protocolFeeRate: 300,
    });

    const result = parseOrcaWhirlpoolState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.tickSpacing).toBe(64);
    expect(result!.feeRate).toBe(3000);
    expect(result!.protocolFeeRate).toBe(300);
  });

  it('should read whirlpoolBump as array', () => {
    const buf = createValidWhirlpoolBuffer();

    const result = parseOrcaWhirlpoolState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.whirlpoolBump).toEqual([255]);
  });

  it('should read sqrtPrice as bigint', () => {
    const sqrtPrice = BigInt('5832724741504768000');
    const buf = createValidWhirlpoolBuffer({ sqrtPrice });

    const result = parseOrcaWhirlpoolState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.sqrtPrice).toBe(sqrtPrice);
  });

  it('should read liquidity as bigint', () => {
    const liquidity = BigInt('999888777666');
    const buf = createValidWhirlpoolBuffer({ liquidity });

    const result = parseOrcaWhirlpoolState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.liquidity).toBe(liquidity);
  });

  it('should read tickCurrentIndex as signed int32', () => {
    const buf = createValidWhirlpoolBuffer({ tickCurrentIndex: -50000 });

    const result = parseOrcaWhirlpoolState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.tickCurrentIndex).toBe(-50000);
  });

  it('should set status to 1 (active) for parseable pools', () => {
    const buf = createValidWhirlpoolBuffer();

    const result = parseOrcaWhirlpoolState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(1);
  });

  it('should set token0Decimals and token1Decimals to 0 (must be provided externally)', () => {
    const buf = createValidWhirlpoolBuffer();

    const result = parseOrcaWhirlpoolState(buf, logger);

    expect(result).not.toBeNull();
    expect(result!.token0Decimals).toBe(0);
    expect(result!.token1Decimals).toBe(0);
  });

  it('should set token0Mint and token1Mint from buffer', () => {
    const buf = createValidWhirlpoolBuffer();

    const result = parseOrcaWhirlpoolState(buf, logger);

    expect(result).not.toBeNull();
    expect(typeof result!.token0Mint).toBe('string');
    expect(typeof result!.token1Mint).toBe('string');
    expect(result!.tokenMintA).toBe(result!.token0Mint);
    expect(result!.tokenMintB).toBe(result!.token1Mint);
  });

  it('should work without logger', () => {
    const buf = createValidWhirlpoolBuffer();

    const result = parseOrcaWhirlpoolState(buf);

    expect(result).not.toBeNull();
  });
});

describe('calculateWhirlpoolPrice', () => {
  it('should return 0 when sqrtPrice is 0', () => {
    expect(calculateWhirlpoolPrice(BigInt(0), 9, 6)).toBe(0);
  });

  it('should calculate price with same decimals', () => {
    // sqrtPrice = 2^64 means (2^64/2^64)^2 = 1
    const sqrtPrice = BigInt('18446744073709551616'); // 2^64

    const price = calculateWhirlpoolPrice(sqrtPrice, 18, 18);

    expect(price).toBeCloseTo(1, 4);
  });

  it('should return a positive number for valid sqrtPrice', () => {
    const price = calculateWhirlpoolPrice(BigInt('5832724741504768000'), 9, 6);

    expect(price).toBeGreaterThan(0);
    expect(Number.isFinite(price)).toBe(true);
  });

  it('should adjust for different token decimals', () => {
    // Same sqrtPrice, different decimal adjustment
    const sqrtPrice = BigInt('18446744073709551616'); // 2^64

    const sameDecimals = calculateWhirlpoolPrice(sqrtPrice, 9, 9);
    const diffDecimals = calculateWhirlpoolPrice(sqrtPrice, 9, 6);

    // With 9-6=3 more decimals, price should be 1000x larger
    expect(diffDecimals).toBeCloseTo(sameDecimals * 1000, -1);
  });
});

describe('parseOrcaWhirlpoolPriceUpdate', () => {
  let logger: PoolParserLogger;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('should return null for invalid buffer', () => {
    const result = parseOrcaWhirlpoolPriceUpdate('pool-1', Buffer.alloc(10), 100, 9, 6, logger);

    expect(result).toBeNull();
  });

  it('should return null when sqrtPrice is 0', () => {
    const buf = createValidWhirlpoolBuffer({ sqrtPrice: BigInt(0) });

    const result = parseOrcaWhirlpoolPriceUpdate('pool-1', buf, 100, 9, 6, logger);

    expect(result).toBeNull();
  });

  it('should parse valid price update', () => {
    const buf = createValidWhirlpoolBuffer({
      sqrtPrice: BigInt('5832724741504768000'),
    });

    const result = parseOrcaWhirlpoolPriceUpdate('pool-1', buf, 12345, 9, 6, logger);

    expect(result).not.toBeNull();
    expect(result!.poolAddress).toBe('pool-1');
    expect(result!.dex).toBe('orca-whirlpool');
    expect(result!.slot).toBe(12345);
    expect(result!.price).toBeGreaterThan(0);
    expect(result!.inversePrice).toBeGreaterThan(0);
    expect(typeof result!.timestamp).toBe('number');
  });

  it('should include CLMM-specific fields', () => {
    const buf = createValidWhirlpoolBuffer({
      sqrtPrice: BigInt('5832724741504768000'),
      liquidity: BigInt('999888777'),
      tickCurrentIndex: -23028,
    });

    const result = parseOrcaWhirlpoolPriceUpdate('pool-1', buf, 100, 9, 6, logger);

    expect(result).not.toBeNull();
    expect(result!.sqrtPriceX64).toBeDefined();
    expect(result!.liquidity).toBeDefined();
    expect(result!.tickCurrentIndex).toBe(-23028);
  });

  it('should set reserve0 and reserve1 to 0 for Whirlpool', () => {
    const buf = createValidWhirlpoolBuffer({
      sqrtPrice: BigInt('5832724741504768000'),
    });

    const result = parseOrcaWhirlpoolPriceUpdate('pool-1', buf, 100, 9, 6, logger);

    expect(result).not.toBeNull();
    expect(result!.reserve0).toBe('0');
    expect(result!.reserve1).toBe('0');
  });

  it('should calculate valid inverse price', () => {
    const buf = createValidWhirlpoolBuffer({
      sqrtPrice: BigInt('5832724741504768000'),
    });

    const result = parseOrcaWhirlpoolPriceUpdate('pool-1', buf, 100, 9, 6, logger);

    expect(result).not.toBeNull();
    expect(result!.price * result!.inversePrice).toBeCloseTo(1, 4);
  });

  it('should use provided decimals for price calculation', () => {
    const buf = createValidWhirlpoolBuffer({
      sqrtPrice: BigInt('18446744073709551616'), // 2^64
    });

    const result9_6 = parseOrcaWhirlpoolPriceUpdate('pool-1', buf, 100, 9, 6, logger);
    const result18_18 = parseOrcaWhirlpoolPriceUpdate('pool-1', buf, 100, 18, 18, logger);

    expect(result9_6).not.toBeNull();
    expect(result18_18).not.toBeNull();
    // Different decimals should yield different prices
    expect(result9_6!.price).not.toBeCloseTo(result18_18!.price, 1);
  });

  it('should work without logger', () => {
    const buf = createValidWhirlpoolBuffer({
      sqrtPrice: BigInt('5832724741504768000'),
    });

    const result = parseOrcaWhirlpoolPriceUpdate('pool-1', buf, 100, 9, 6);

    expect(result).not.toBeNull();
  });
});

describe('getDexName', () => {
  it('should return orca-whirlpool', () => {
    expect(getDexName()).toBe('orca-whirlpool');
  });
});

describe('getMinAccountSize', () => {
  it('should return ACCOUNT_SIZE constant', () => {
    expect(getMinAccountSize()).toBe(ORCA_WHIRLPOOL_LAYOUT.ACCOUNT_SIZE);
    expect(getMinAccountSize()).toBe(653);
  });
});
