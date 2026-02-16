/**
 * Shared utilities for Solana pool parsers.
 *
 * @module solana/pricing/pool-parsers/utils
 */

import { PublicKey } from '@solana/web3.js';
import { MIN_SAFE_PRICE } from '../../../utils/bigint-utils';

/**
 * Read a u128 (16-byte unsigned integer) from buffer in little-endian order.
 * Used for sqrtPriceX64, liquidity, and fee growth fields in CLMM pools.
 *
 * @param buffer - The buffer to read from
 * @param offset - Starting offset in the buffer
 * @returns The u128 value as a bigint
 */
export function readU128LE(buffer: Buffer, offset: number): bigint {
  const low = buffer.readBigUInt64LE(offset);
  const high = buffer.readBigUInt64LE(offset + 8);
  return low + (high << BigInt(64));
}

/**
 * Read a public key from buffer at the specified offset.
 *
 * @param buffer - The buffer to read from
 * @param offset - Starting offset in the buffer
 * @returns Base58-encoded public key string
 */
export function readPubkey(buffer: Buffer, offset: number): string {
  return new PublicKey(buffer.subarray(offset, offset + 32)).toBase58();
}

/**
 * Safely calculate inverse price to prevent Infinity.
 * Returns null if the result would be Infinity or exceed safe bounds.
 *
 * @param price - The price to invert
 * @returns The inverse price, or null if calculation would result in invalid value
 */
export function safeInversePrice(price: number): number | null {
  // Use MIN_SAFE_PRICE from bigint-utils (single source of truth for price bounds).
  // At 1e-18: 1/price = 1e18, which is within Number's safe range.
  if (price < MIN_SAFE_PRICE) {
    return null;
  }

  const inverse = 1 / price;

  // Double check the result is finite
  if (!Number.isFinite(inverse)) {
    return null;
  }

  return inverse;
}

/**
 * Calculate price from CLMM sqrtPriceX64.
 * Formula: Price = (sqrtPriceX64 / 2^64)^2 * 10^(token0Decimals - token1Decimals)
 *
 * Used by both Raydium CLMM and Orca Whirlpool.
 *
 * @param sqrtPriceX64 - The sqrt price in Q64.64 fixed point format
 * @param token0Decimals - Decimals for token 0
 * @param token1Decimals - Decimals for token 1
 * @returns Calculated price, or 0 if sqrtPriceX64 is 0
 */
export function calculateClmmPriceFromSqrt(
  sqrtPriceX64: bigint,
  token0Decimals: number,
  token1Decimals: number
): number {
  if (sqrtPriceX64 === 0n) return 0;

  // Split into integer and fractional parts relative to 2^64 to preserve precision.
  // Direct Number(sqrtPriceX64) loses precision for values > 2^53.
  const TWO_64 = 1n << 64n;
  const intPart = sqrtPriceX64 / TWO_64;
  const fracPart = sqrtPriceX64 % TWO_64;
  const sqrtPrice = Number(intPart) + Number(fracPart) / Number(TWO_64);

  // price = sqrtPrice^2
  const rawPrice = sqrtPrice * sqrtPrice;

  // Adjust for decimals
  const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);

  return rawPrice * decimalAdjustment;
}

/**
 * Convert tick to price.
 * Formula: Price = 1.0001^tick * 10^(token0Decimals - token1Decimals)
 *
 * @param tick - The tick index
 * @param token0Decimals - Decimals for token 0
 * @param token1Decimals - Decimals for token 1
 * @returns The calculated price
 */
export function tickToPrice(
  tick: number,
  token0Decimals: number,
  token1Decimals: number
): number {
  const rawPrice = Math.pow(1.0001, tick);
  const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
  return rawPrice * decimalAdjustment;
}

/**
 * Convert price to tick.
 * Formula: Tick = log(price / 10^(token0Decimals - token1Decimals)) / log(1.0001)
 *
 * @param price - The price to convert
 * @param token0Decimals - Decimals for token 0
 * @param token1Decimals - Decimals for token 1
 * @returns The calculated tick (rounded to nearest integer)
 */
export function priceToTick(
  price: number,
  token0Decimals: number,
  token1Decimals: number
): number {
  const decimalAdjustment = Math.pow(10, token0Decimals - token1Decimals);
  const rawPrice = price / decimalAdjustment;
  return Math.round(Math.log(rawPrice) / Math.log(1.0001));
}
