/**
 * Raydium CLMM Pool Parser
 *
 * Parses Raydium Concentrated Liquidity Market Maker pool account data.
 * Uses Anchor program layout with tick-based pricing similar to Uniswap V3.
 *
 * @module solana/pricing/pool-parsers/raydium-clmm-parser
 * @see https://github.com/raydium-io/raydium-clmm
 */

import type { PoolParserLogger, BaseParsedPoolState, ParsedPriceData } from './types';
import { readU128LE, readPubkey, safeInversePrice, calculateClmmPriceFromSqrt } from './utils';

// =============================================================================
// Constants
// =============================================================================

/**
 * Raydium CLMM pool account data layout offsets.
 */
export const RAYDIUM_CLMM_LAYOUT = {
  BUMP: 8,
  AMM_CONFIG: 9,
  POOL_CREATOR: 41,
  TOKEN_0_MINT: 73,
  TOKEN_1_MINT: 105,
  TOKEN_0_VAULT: 137,
  TOKEN_1_VAULT: 169,
  OBSERVATION_KEY: 201,
  MINT_DECIMALS_0: 233,
  MINT_DECIMALS_1: 234,
  TICK_SPACING: 235,
  LIQUIDITY: 237,       // u128 (16 bytes)
  SQRT_PRICE_X64: 253,  // u128 (16 bytes)
  TICK_CURRENT: 269,    // i32
  OBSERVATION_INDEX: 273,
  OBSERVATION_UPDATE_DURATION: 275,
  FEE_GROWTH_GLOBAL_0_X64: 277, // u128
  FEE_GROWTH_GLOBAL_1_X64: 293, // u128
  PROTOCOL_FEES_TOKEN_0: 309,   // u64
  PROTOCOL_FEES_TOKEN_1: 317,   // u64
  FEE_RATE: 325,        // u32
  STATUS: 329,
  ACCOUNT_SIZE: 1544
} as const;

// =============================================================================
// Types
// =============================================================================

/**
 * Raydium CLMM pool state structure.
 * Concentrated liquidity pool with tick-based pricing.
 */
export interface RaydiumClmmPoolState extends BaseParsedPoolState {
  /** Pool bump seed */
  bump: number;
  /** AMM config address */
  ammConfig: string;
  /** Pool creator address */
  poolCreator: string;
  /** Token 0 vault address */
  token0Vault: string;
  /** Token 1 vault address */
  token1Vault: string;
  /** Observation key */
  observationKey: string;
  /** Mint decimals for token 0 */
  mintDecimals0: number;
  /** Mint decimals for token 1 */
  mintDecimals1: number;
  /** Tick spacing for this pool */
  tickSpacing: number;
  /** Total liquidity in active tick range */
  liquidity: bigint;
  /** Current sqrt price as Q64.64 fixed point */
  sqrtPriceX64: bigint;
  /** Current tick index */
  tickCurrent: number;
  /** Fee growth for token 0 */
  feeGrowthGlobal0X64: bigint;
  /** Fee growth for token 1 */
  feeGrowthGlobal1X64: bigint;
  /** Protocol fees for token 0 */
  protocolFeesToken0: bigint;
  /** Protocol fees for token 1 */
  protocolFeesToken1: bigint;
  /** Fee rate in hundredths of basis points */
  feeRate: number;
}

// =============================================================================
// Parser Functions
// =============================================================================

/**
 * Parse Raydium CLMM pool state from account data.
 *
 * @param data - The raw account data buffer
 * @param logger - Optional logger for warnings/errors
 * @returns Parsed pool state, or null if parsing failed
 */
export function parseRaydiumClmmState(
  data: Buffer,
  logger?: PoolParserLogger
): RaydiumClmmPoolState | null {
  if (data.length < RAYDIUM_CLMM_LAYOUT.ACCOUNT_SIZE) {
    logger?.warn('Invalid Raydium CLMM account size', {
      expected: RAYDIUM_CLMM_LAYOUT.ACCOUNT_SIZE,
      actual: data.length
    });
    return null;
  }

  try {
    const bump = data.readUInt8(RAYDIUM_CLMM_LAYOUT.BUMP);
    const mintDecimals0 = data.readUInt8(RAYDIUM_CLMM_LAYOUT.MINT_DECIMALS_0);
    const mintDecimals1 = data.readUInt8(RAYDIUM_CLMM_LAYOUT.MINT_DECIMALS_1);
    const tickSpacing = data.readUInt16LE(RAYDIUM_CLMM_LAYOUT.TICK_SPACING);

    // Read u128 values (16 bytes each)
    const liquidity = readU128LE(data, RAYDIUM_CLMM_LAYOUT.LIQUIDITY);
    const sqrtPriceX64 = readU128LE(data, RAYDIUM_CLMM_LAYOUT.SQRT_PRICE_X64);

    const tickCurrent = data.readInt32LE(RAYDIUM_CLMM_LAYOUT.TICK_CURRENT);

    const feeGrowthGlobal0X64 = readU128LE(data, RAYDIUM_CLMM_LAYOUT.FEE_GROWTH_GLOBAL_0_X64);
    const feeGrowthGlobal1X64 = readU128LE(data, RAYDIUM_CLMM_LAYOUT.FEE_GROWTH_GLOBAL_1_X64);

    const protocolFeesToken0 = data.readBigUInt64LE(RAYDIUM_CLMM_LAYOUT.PROTOCOL_FEES_TOKEN_0);
    const protocolFeesToken1 = data.readBigUInt64LE(RAYDIUM_CLMM_LAYOUT.PROTOCOL_FEES_TOKEN_1);

    const feeRate = data.readUInt32LE(RAYDIUM_CLMM_LAYOUT.FEE_RATE);
    const status = data.readUInt8(RAYDIUM_CLMM_LAYOUT.STATUS);

    // Read pubkeys
    const ammConfig = readPubkey(data, RAYDIUM_CLMM_LAYOUT.AMM_CONFIG);
    const poolCreator = readPubkey(data, RAYDIUM_CLMM_LAYOUT.POOL_CREATOR);
    const token0Mint = readPubkey(data, RAYDIUM_CLMM_LAYOUT.TOKEN_0_MINT);
    const token1Mint = readPubkey(data, RAYDIUM_CLMM_LAYOUT.TOKEN_1_MINT);
    const token0Vault = readPubkey(data, RAYDIUM_CLMM_LAYOUT.TOKEN_0_VAULT);
    const token1Vault = readPubkey(data, RAYDIUM_CLMM_LAYOUT.TOKEN_1_VAULT);
    const observationKey = readPubkey(data, RAYDIUM_CLMM_LAYOUT.OBSERVATION_KEY);

    return {
      bump,
      ammConfig,
      poolCreator,
      token0Mint,
      token1Mint,
      token0Vault,
      token1Vault,
      observationKey,
      mintDecimals0,
      mintDecimals1,
      tickSpacing,
      liquidity,
      sqrtPriceX64,
      tickCurrent,
      feeGrowthGlobal0X64,
      feeGrowthGlobal1X64,
      protocolFeesToken0,
      protocolFeesToken1,
      feeRate,
      status,
      // BaseParsedPoolState fields
      token0Decimals: mintDecimals0,
      token1Decimals: mintDecimals1
    };
  } catch (error) {
    logger?.error('Error parsing Raydium CLMM state', { error });
    return null;
  }
}

/**
 * Calculate price from CLMM sqrtPriceX64.
 * Delegates to shared utility for CLMM price calculation.
 *
 * @param state - Parsed pool state
 * @returns Price (token1 per token0), or 0 if sqrtPriceX64 is 0
 */
export function calculateClmmPrice(state: RaydiumClmmPoolState): number {
  return calculateClmmPriceFromSqrt(
    state.sqrtPriceX64,
    state.mintDecimals0,
    state.mintDecimals1
  );
}

/**
 * Parse a full price update from Raydium CLMM account data.
 *
 * @param poolAddress - The pool account address
 * @param data - The raw account data buffer
 * @param slot - Current Solana slot
 * @param token0Decimals - Fallback decimals for token 0 (used if not in state)
 * @param token1Decimals - Fallback decimals for token 1 (used if not in state)
 * @param logger - Optional logger for warnings/errors
 * @returns Parsed price data, or null if parsing failed or pool is inactive
 */
export function parseRaydiumClmmPriceUpdate(
  poolAddress: string,
  data: Buffer,
  slot: number,
  token0Decimals: number,
  token1Decimals: number,
  logger?: PoolParserLogger
): ParsedPriceData | null {
  const state = parseRaydiumClmmState(data, logger);
  if (!state) return null;

  // Check if pool is active (status 1 = active)
  if (state.status !== 1) {
    logger?.debug('Raydium CLMM pool not active', { poolAddress, status: state.status });
    return null;
  }

  // Use state decimals if available, fallback to provided
  const decimals0 = state.mintDecimals0 ?? token0Decimals;
  const decimals1 = state.mintDecimals1 ?? token1Decimals;

  // Calculate price from sqrtPriceX64
  const price = calculateClmmPriceFromSqrt(state.sqrtPriceX64, decimals0, decimals1);
  if (price === 0 || !Number.isFinite(price)) return null;

  // Safely calculate inverse price
  const inversePrice = safeInversePrice(price);
  if (inversePrice === null) {
    logger?.debug('Price too small for safe inverse calculation', { poolAddress, price });
    return null;
  }

  return {
    poolAddress,
    dex: 'raydium-clmm',
    token0: state.token0Mint,
    token1: state.token1Mint,
    price,
    inversePrice,
    reserve0: '0', // CLMM doesn't have traditional reserves
    reserve1: '0',
    slot,
    timestamp: Date.now(),
    sqrtPriceX64: state.sqrtPriceX64.toString(),
    liquidity: state.liquidity.toString(),
    tickCurrentIndex: state.tickCurrent
  };
}

/**
 * Get DEX name for this parser.
 */
export function getDexName(): string {
  return 'raydium-clmm';
}

/**
 * Get minimum account size required for parsing.
 */
export function getMinAccountSize(): number {
  return RAYDIUM_CLMM_LAYOUT.ACCOUNT_SIZE;
}
