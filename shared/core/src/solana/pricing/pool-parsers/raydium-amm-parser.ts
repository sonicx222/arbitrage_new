/**
 * Raydium AMM V4 Pool Parser
 *
 * Parses Raydium AMM (Constant Product) pool account data.
 * Account structure follows Raydium's non-Anchor layout.
 *
 * @module solana/pricing/pool-parsers/raydium-amm-parser
 * @see https://github.com/raydium-io/raydium-amm
 */

import { PublicKey } from '@solana/web3.js';
import type { PoolParserLogger, BaseParsedPoolState, ParsedPriceData } from './types';
import { safeInversePrice } from './utils';

// =============================================================================
// Constants
// =============================================================================

/**
 * Raydium AMM V4 account data layout offsets.
 * These offsets define where each field is located in the account data buffer.
 */
export const RAYDIUM_AMM_LAYOUT = {
  STATUS: 0,
  NONCE: 1,
  ORDER_NUM: 2,
  DEPTH: 4,
  BASE_DECIMALS: 6,
  QUOTE_DECIMALS: 7,
  STATE: 8,
  RESET_FLAG: 9,
  MIN_SIZE: 10,
  VOL_MAX_CUT_RATIO: 18,
  AMM_OPEN_ORDERS: 26,
  LP_MINT: 58,
  COIN_MINT: 90,     // Base mint (token0)
  PC_MINT: 122,      // Quote mint (token1)
  COIN_VAULT: 154,   // Base vault
  PC_VAULT: 186,     // Quote vault
  NEED_TAKE_COIN: 218,
  NEED_TAKE_PC: 226,
  TOTAL_COIN: 234,   // Base reserve (u64)
  TOTAL_PC: 242,     // Quote reserve (u64)
  POOL_OPEN_TIME: 250,
  PUNISH_PC_AMOUNT: 258,
  PUNISH_COIN_AMOUNT: 266,
  ORDERBOOK_TO_INIT_TIME: 274,
  SWAP_COIN_IN_AMOUNT: 282,
  SWAP_PC_OUT_AMOUNT: 290,
  SWAP_COIN_2_PC_FEE: 298,
  SWAP_PC_IN_AMOUNT: 306,
  SWAP_COIN_OUT_AMOUNT: 314,
  SWAP_PC_2_COIN_FEE: 322,
  MARKET_ID: 330,
  ACCOUNT_SIZE: 752
} as const;

// =============================================================================
// Types
// =============================================================================

/**
 * Raydium AMM pool state structure (V4).
 * Account data layout for Raydium liquidity pools.
 */
export interface RaydiumAmmPoolState extends BaseParsedPoolState {
  /** Nonce for PDA derivation */
  nonce: number;
  /** Base token mint address (token0) */
  baseMint: string;
  /** Quote token mint address (token1) */
  quoteMint: string;
  /** Base token vault address */
  baseVault: string;
  /** Quote token vault address */
  quoteVault: string;
  /** Base token reserves (raw amount) */
  baseReserve: bigint;
  /** Quote token reserves (raw amount) */
  quoteReserve: bigint;
  /** Base token decimals */
  baseDecimals: number;
  /** Quote token decimals */
  quoteDecimals: number;
  /** LP token mint address */
  lpMint: string;
  /** Open orders account */
  openOrders: string;
  /** Market ID (Serum/OpenBook) */
  marketId: string;
  /** Fee rate numerator */
  feeNumerator: number;
  /** Fee rate denominator */
  feeDenominator: number;
}

// =============================================================================
// Parser Functions
// =============================================================================

/**
 * Parse Raydium AMM pool state from account data.
 *
 * @param data - The raw account data buffer
 * @param logger - Optional logger for warnings/errors
 * @returns Parsed pool state, or null if parsing failed
 */
export function parseRaydiumAmmState(
  data: Buffer,
  logger?: PoolParserLogger
): RaydiumAmmPoolState | null {
  if (data.length < RAYDIUM_AMM_LAYOUT.ACCOUNT_SIZE) {
    logger?.warn('Invalid Raydium AMM account size', {
      expected: RAYDIUM_AMM_LAYOUT.ACCOUNT_SIZE,
      actual: data.length
    });
    return null;
  }

  try {
    const status = data.readUInt8(RAYDIUM_AMM_LAYOUT.STATUS);
    const nonce = data.readUInt8(RAYDIUM_AMM_LAYOUT.NONCE);
    const baseDecimals = data.readUInt8(RAYDIUM_AMM_LAYOUT.BASE_DECIMALS);
    const quoteDecimals = data.readUInt8(RAYDIUM_AMM_LAYOUT.QUOTE_DECIMALS);

    // Read reserves (u64)
    const baseReserve = data.readBigUInt64LE(RAYDIUM_AMM_LAYOUT.TOTAL_COIN);
    const quoteReserve = data.readBigUInt64LE(RAYDIUM_AMM_LAYOUT.TOTAL_PC);

    // Read pubkeys (32 bytes each)
    const baseMint = new PublicKey(data.subarray(
      RAYDIUM_AMM_LAYOUT.COIN_MINT,
      RAYDIUM_AMM_LAYOUT.COIN_MINT + 32
    )).toBase58();

    const quoteMint = new PublicKey(data.subarray(
      RAYDIUM_AMM_LAYOUT.PC_MINT,
      RAYDIUM_AMM_LAYOUT.PC_MINT + 32
    )).toBase58();

    const baseVault = new PublicKey(data.subarray(
      RAYDIUM_AMM_LAYOUT.COIN_VAULT,
      RAYDIUM_AMM_LAYOUT.COIN_VAULT + 32
    )).toBase58();

    const quoteVault = new PublicKey(data.subarray(
      RAYDIUM_AMM_LAYOUT.PC_VAULT,
      RAYDIUM_AMM_LAYOUT.PC_VAULT + 32
    )).toBase58();

    const lpMint = new PublicKey(data.subarray(
      RAYDIUM_AMM_LAYOUT.LP_MINT,
      RAYDIUM_AMM_LAYOUT.LP_MINT + 32
    )).toBase58();

    const openOrders = new PublicKey(data.subarray(
      RAYDIUM_AMM_LAYOUT.AMM_OPEN_ORDERS,
      RAYDIUM_AMM_LAYOUT.AMM_OPEN_ORDERS + 32
    )).toBase58();

    const marketId = new PublicKey(data.subarray(
      RAYDIUM_AMM_LAYOUT.MARKET_ID,
      RAYDIUM_AMM_LAYOUT.MARKET_ID + 32
    )).toBase58();

    return {
      status,
      nonce,
      baseMint,
      quoteMint,
      baseVault,
      quoteVault,
      baseReserve,
      quoteReserve,
      baseDecimals,
      quoteDecimals,
      lpMint,
      openOrders,
      marketId,
      feeNumerator: 25, // Default Raydium fee: 0.25%
      feeDenominator: 10000,
      // BaseParsedPoolState fields (for consistency)
      token0Mint: baseMint,
      token1Mint: quoteMint,
      token0Decimals: baseDecimals,
      token1Decimals: quoteDecimals
    };
  } catch (error) {
    logger?.error('Error parsing Raydium AMM state', { error });
    return null;
  }
}

/**
 * Calculate price from AMM reserves.
 * Formula: Price = (quoteReserve / baseReserve) * 10^(baseDecimals - quoteDecimals)
 *
 * @param state - Parsed pool state
 * @returns Price (token1 per token0), or 0 if baseReserve is 0
 */
export function calculateAmmPrice(state: RaydiumAmmPoolState): number {
  if (state.baseReserve === BigInt(0)) return 0;

  const rawPrice = Number(state.quoteReserve) / Number(state.baseReserve);
  const decimalAdjustment = Math.pow(10, state.baseDecimals - state.quoteDecimals);

  return rawPrice * decimalAdjustment;
}

/**
 * Parse a full price update from Raydium AMM account data.
 *
 * @param poolAddress - The pool account address
 * @param data - The raw account data buffer
 * @param slot - Current Solana slot
 * @param logger - Optional logger for warnings/errors
 * @returns Parsed price data, or null if parsing failed or pool is inactive
 */
export function parseRaydiumAmmPriceUpdate(
  poolAddress: string,
  data: Buffer,
  slot: number,
  logger?: PoolParserLogger
): ParsedPriceData | null {
  const state = parseRaydiumAmmState(data, logger);
  if (!state) return null;

  // Check if pool is active (status 1 = active)
  if (state.status !== 1) {
    logger?.debug('Raydium AMM pool not active', { poolAddress, status: state.status });
    return null;
  }

  // Calculate price
  const price = calculateAmmPrice(state);
  if (price === 0 || !Number.isFinite(price)) return null;

  // Safely calculate inverse price
  const inversePrice = safeInversePrice(price);
  if (inversePrice === null) {
    logger?.debug('Price too small for safe inverse calculation', { poolAddress, price });
    return null;
  }

  return {
    poolAddress,
    dex: 'raydium-amm',
    token0: state.baseMint,
    token1: state.quoteMint,
    price,
    inversePrice,
    reserve0: state.baseReserve.toString(),
    reserve1: state.quoteReserve.toString(),
    slot,
    timestamp: Date.now()
  };
}

/**
 * Get DEX name for this parser.
 */
export function getDexName(): string {
  return 'raydium-amm';
}

/**
 * Get minimum account size required for parsing.
 */
export function getMinAccountSize(): number {
  return RAYDIUM_AMM_LAYOUT.ACCOUNT_SIZE;
}
