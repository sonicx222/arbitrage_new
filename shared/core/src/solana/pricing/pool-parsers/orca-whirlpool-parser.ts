/**
 * Orca Whirlpool Pool Parser
 *
 * Parses Orca Whirlpool concentrated liquidity pool account data.
 * Uses Anchor program layout similar to Uniswap V3.
 *
 * @module solana/pricing/pool-parsers/orca-whirlpool-parser
 * @see https://github.com/orca-so/whirlpools
 */

import type { PoolParserLogger, BaseParsedPoolState, ParsedPriceData } from './types';
import { readU128LE, readPubkey, safeInversePrice, calculateClmmPriceFromSqrt } from './utils';

// =============================================================================
// Constants
// =============================================================================

/**
 * Orca Whirlpool account data layout offsets.
 * Based on Whirlpool program account structure.
 */
export const ORCA_WHIRLPOOL_LAYOUT = {
  DISCRIMINATOR: 0,           // 8 bytes (Anchor discriminator)
  WHIRLPOOLS_CONFIG: 8,       // Pubkey (32 bytes)
  WHIRLPOOL_BUMP: 40,         // [u8; 1]
  TICK_SPACING: 41,           // u16
  TICK_SPACING_SEED: 43,      // [u8; 2]
  FEE_RATE: 45,               // u16
  PROTOCOL_FEE_RATE: 47,      // u16
  LIQUIDITY: 49,              // u128 (16 bytes)
  SQRT_PRICE: 65,             // u128 (16 bytes)
  TICK_CURRENT_INDEX: 81,     // i32
  PROTOCOL_FEE_OWED_A: 85,    // u64
  PROTOCOL_FEE_OWED_B: 93,    // u64
  TOKEN_MINT_A: 101,          // Pubkey (32 bytes)
  TOKEN_MINT_B: 133,          // Pubkey (32 bytes)
  TOKEN_VAULT_A: 165,         // Pubkey (32 bytes)
  TOKEN_VAULT_B: 197,         // Pubkey (32 bytes)
  FEE_GROWTH_GLOBAL_A: 229,   // u128 (16 bytes)
  FEE_GROWTH_GLOBAL_B: 245,   // u128 (16 bytes)
  REWARD_LAST_UPDATED_TIMESTAMP: 261, // u64
  REWARD_INFOS: 269,          // 3 * RewardInfo
  ACCOUNT_SIZE: 653
} as const;

// =============================================================================
// Types
// =============================================================================

/**
 * Orca Whirlpool state structure.
 * Concentrated liquidity pool similar to Uniswap V3.
 */
export interface OrcaWhirlpoolState extends BaseParsedPoolState {
  /** Whirlpool config address */
  whirlpoolsConfig: string;
  /** Whirlpool bump seeds */
  whirlpoolBump: number[];
  /** Tick spacing bump */
  tickSpacingBump: number;
  /** Fee rate in hundredths of a basis point (e.g., 3000 = 0.30%) */
  feeRate: number;
  /** Protocol fee rate (percentage of fee) */
  protocolFeeRate: number;
  /** Total liquidity in active tick range */
  liquidity: bigint;
  /** Current sqrt price as Q64.64 fixed point */
  sqrtPrice: bigint;
  /** Current tick index */
  tickCurrentIndex: number;
  /** Protocol fees owed for token A */
  protocolFeeOwedA: bigint;
  /** Protocol fees owed for token B */
  protocolFeeOwedB: bigint;
  /** Token mint A address */
  tokenMintA: string;
  /** Token mint B address */
  tokenMintB: string;
  /** Token vault A address */
  tokenVaultA: string;
  /** Token vault B address */
  tokenVaultB: string;
  /** Fee growth for token A */
  feeGrowthGlobalA: bigint;
  /** Fee growth for token B */
  feeGrowthGlobalB: bigint;
  /** Reward last updated timestamp */
  rewardLastUpdatedTimestamp: bigint;
  /** Tick spacing for this pool */
  tickSpacing: number;
}

// =============================================================================
// Parser Functions
// =============================================================================

/**
 * Parse Orca Whirlpool state from account data.
 *
 * @param data - The raw account data buffer
 * @param logger - Optional logger for warnings/errors
 * @returns Parsed pool state, or null if parsing failed
 */
export function parseOrcaWhirlpoolState(
  data: Buffer,
  logger?: PoolParserLogger
): OrcaWhirlpoolState | null {
  if (data.length < ORCA_WHIRLPOOL_LAYOUT.ACCOUNT_SIZE) {
    logger?.warn('Invalid Orca Whirlpool account size', {
      expected: ORCA_WHIRLPOOL_LAYOUT.ACCOUNT_SIZE,
      actual: data.length
    });
    return null;
  }

  try {
    // Read and log discriminator for debugging (first 8 bytes identify account type in Anchor)
    const discriminator = data.subarray(0, 8);
    logger?.debug('Orca Whirlpool discriminator', {
      discriminator: discriminator.toString('hex')
    });

    const whirlpoolsConfig = readPubkey(data, ORCA_WHIRLPOOL_LAYOUT.WHIRLPOOLS_CONFIG);

    const whirlpoolBump = [data.readUInt8(ORCA_WHIRLPOOL_LAYOUT.WHIRLPOOL_BUMP)];
    const tickSpacing = data.readUInt16LE(ORCA_WHIRLPOOL_LAYOUT.TICK_SPACING);
    const tickSpacingBump = data.readUInt8(ORCA_WHIRLPOOL_LAYOUT.TICK_SPACING_SEED);
    const feeRate = data.readUInt16LE(ORCA_WHIRLPOOL_LAYOUT.FEE_RATE);
    const protocolFeeRate = data.readUInt16LE(ORCA_WHIRLPOOL_LAYOUT.PROTOCOL_FEE_RATE);

    // Read u128 values
    const liquidity = readU128LE(data, ORCA_WHIRLPOOL_LAYOUT.LIQUIDITY);
    const sqrtPrice = readU128LE(data, ORCA_WHIRLPOOL_LAYOUT.SQRT_PRICE);

    const tickCurrentIndex = data.readInt32LE(ORCA_WHIRLPOOL_LAYOUT.TICK_CURRENT_INDEX);

    const protocolFeeOwedA = data.readBigUInt64LE(ORCA_WHIRLPOOL_LAYOUT.PROTOCOL_FEE_OWED_A);
    const protocolFeeOwedB = data.readBigUInt64LE(ORCA_WHIRLPOOL_LAYOUT.PROTOCOL_FEE_OWED_B);

    const tokenMintA = readPubkey(data, ORCA_WHIRLPOOL_LAYOUT.TOKEN_MINT_A);
    const tokenMintB = readPubkey(data, ORCA_WHIRLPOOL_LAYOUT.TOKEN_MINT_B);
    const tokenVaultA = readPubkey(data, ORCA_WHIRLPOOL_LAYOUT.TOKEN_VAULT_A);
    const tokenVaultB = readPubkey(data, ORCA_WHIRLPOOL_LAYOUT.TOKEN_VAULT_B);

    const feeGrowthGlobalA = readU128LE(data, ORCA_WHIRLPOOL_LAYOUT.FEE_GROWTH_GLOBAL_A);
    const feeGrowthGlobalB = readU128LE(data, ORCA_WHIRLPOOL_LAYOUT.FEE_GROWTH_GLOBAL_B);

    const rewardLastUpdatedTimestamp = data.readBigUInt64LE(
      ORCA_WHIRLPOOL_LAYOUT.REWARD_LAST_UPDATED_TIMESTAMP
    );

    return {
      whirlpoolsConfig,
      whirlpoolBump,
      tickSpacingBump,
      feeRate,
      protocolFeeRate,
      liquidity,
      sqrtPrice,
      tickCurrentIndex,
      protocolFeeOwedA,
      protocolFeeOwedB,
      tokenMintA,
      tokenMintB,
      tokenVaultA,
      tokenVaultB,
      feeGrowthGlobalA,
      feeGrowthGlobalB,
      rewardLastUpdatedTimestamp,
      tickSpacing,
      // BaseParsedPoolState fields
      // Note: Whirlpool doesn't store decimals in pool account, need to fetch from mint
      status: 1, // Whirlpool doesn't have explicit status, assume active if parseable
      token0Mint: tokenMintA,
      token1Mint: tokenMintB,
      token0Decimals: 0, // Must be provided externally
      token1Decimals: 0  // Must be provided externally
    };
  } catch (error) {
    logger?.error('Error parsing Orca Whirlpool state', { error });
    return null;
  }
}

/**
 * Calculate price from Whirlpool sqrtPrice.
 * Uses same formula as CLMM (Uniswap V3 style).
 *
 * @param sqrtPrice - The sqrt price in Q64.64 fixed point format
 * @param token0Decimals - Decimals for token A
 * @param token1Decimals - Decimals for token B
 * @returns Price (tokenB per tokenA), or 0 if sqrtPrice is 0
 */
export function calculateWhirlpoolPrice(
  sqrtPrice: bigint,
  token0Decimals: number,
  token1Decimals: number
): number {
  return calculateClmmPriceFromSqrt(sqrtPrice, token0Decimals, token1Decimals);
}

/**
 * Parse a full price update from Orca Whirlpool account data.
 *
 * @param poolAddress - The pool account address
 * @param data - The raw account data buffer
 * @param slot - Current Solana slot
 * @param token0Decimals - Decimals for token A (required, not stored in pool)
 * @param token1Decimals - Decimals for token B (required, not stored in pool)
 * @param logger - Optional logger for warnings/errors
 * @returns Parsed price data, or null if parsing failed
 */
export function parseOrcaWhirlpoolPriceUpdate(
  poolAddress: string,
  data: Buffer,
  slot: number,
  token0Decimals: number,
  token1Decimals: number,
  logger?: PoolParserLogger
): ParsedPriceData | null {
  const state = parseOrcaWhirlpoolState(data, logger);
  if (!state) return null;

  // Calculate price from sqrtPrice
  const price = calculateWhirlpoolPrice(state.sqrtPrice, token0Decimals, token1Decimals);
  if (price === 0 || !Number.isFinite(price)) return null;

  // Safely calculate inverse price
  const inversePrice = safeInversePrice(price);
  if (inversePrice === null) {
    logger?.debug('Price too small for safe inverse calculation', { poolAddress, price });
    return null;
  }

  return {
    poolAddress,
    dex: 'orca-whirlpool',
    token0: state.tokenMintA,
    token1: state.tokenMintB,
    price,
    inversePrice,
    reserve0: '0', // Whirlpool doesn't have traditional reserves
    reserve1: '0',
    slot,
    timestamp: Date.now(),
    sqrtPriceX64: state.sqrtPrice.toString(),
    liquidity: state.liquidity.toString(),
    tickCurrentIndex: state.tickCurrentIndex
  };
}

/**
 * Get DEX name for this parser.
 */
export function getDexName(): string {
  return 'orca-whirlpool';
}

/**
 * Get minimum account size required for parsing.
 */
export function getMinAccountSize(): number {
  return ORCA_WHIRLPOOL_LAYOUT.ACCOUNT_SIZE;
}
