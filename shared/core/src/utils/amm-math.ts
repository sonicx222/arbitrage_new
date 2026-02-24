/**
 * Shared AMM (Automated Market Maker) math utilities.
 *
 * Extracted from cross-dex-triangular-arbitrage.ts and multi-leg-path-finder.ts
 * where these were duplicated byte-for-byte.
 *
 * @module utils/amm-math
 * @see cross-dex-triangular-arbitrage.ts
 * @see multi-leg-path-finder.ts
 */

// =============================================================================
// BigInt Precision Constants
// =============================================================================

/** 18 decimal places for wei precision */
export const PRECISION_MULTIPLIER = 10n ** 18n;

/** Basis points divisor (10000 = 100%) */
export const BASIS_POINTS_DIVISOR = 10000n;

/** 1 ETH in wei */
export const ONE_ETH_WEI = 10n ** 18n;

// =============================================================================
// Dynamic Slippage
// =============================================================================

/**
 * T1.2: Dynamic slippage configuration for liquidity-aware calculations.
 * Instead of using a static maxSlippage, we calculate slippage dynamically
 * based on trade size relative to pool reserves.
 */
export interface DynamicSlippageConfig {
  /** Base slippage floor (minimum slippage regardless of liquidity) */
  baseSlippage: number;
  /** Scale factor for price impact contribution */
  priceImpactScale: number;
  /** Maximum allowed slippage (hard cap) */
  maxSlippage: number;
  /** Minimum liquidity (USD) for confident trades */
  minLiquidityUsd: number;
  /** Liquidity penalty scale (higher = more penalty for low liquidity) */
  liquidityPenaltyScale: number;
}

/**
 * Default slippage configuration.
 * Can be overridden via environment variables for different deployment environments.
 *
 * Environment variables:
 * - SLIPPAGE_BASE: Base slippage floor (default: 0.003 = 0.3%)
 * - SLIPPAGE_MAX: Maximum slippage cap (default: 0.10 = 10%)
 * - SLIPPAGE_MIN_LIQUIDITY_USD: Minimum liquidity for full confidence (default: 100000)
 */
export const DEFAULT_SLIPPAGE_CONFIG: DynamicSlippageConfig = {
  baseSlippage: parseFloat(process.env.SLIPPAGE_BASE || '0.003'),
  priceImpactScale: 5.0,
  maxSlippage: parseFloat(process.env.SLIPPAGE_MAX || '0.10'),
  minLiquidityUsd: parseInt(process.env.SLIPPAGE_MIN_LIQUIDITY_USD || '100000', 10),
  liquidityPenaltyScale: 2.0
};

// =============================================================================
// AMM Constant-Product Formula
// =============================================================================

/**
 * Calculate the output amount for a constant-product AMM swap using BigInt arithmetic.
 *
 * Formula: amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee)
 * where amountInWithFee = amountIn * (10000 - feeBps) / 10000
 *
 * @param amountInBigInt Input amount in wei (BigInt)
 * @param reserveInBigInt Reserve of input token in wei (BigInt)
 * @param reserveOutBigInt Reserve of output token in wei (BigInt)
 * @param feeBigInt Fee in basis points (BigInt, e.g. 30n for 0.3%)
 * @returns Output amount in wei, or null if denominator is zero (empty pool)
 */
export function calculateAmmAmountOut(
  amountInBigInt: bigint,
  reserveInBigInt: bigint,
  reserveOutBigInt: bigint,
  feeBigInt: bigint
): bigint | null {
  const feeMultiplierNumerator = BASIS_POINTS_DIVISOR - feeBigInt;
  const amountInWithFee = (amountInBigInt * feeMultiplierNumerator) / BASIS_POINTS_DIVISOR;

  const numerator = amountInWithFee * reserveOutBigInt;
  const denominator = reserveInBigInt + amountInWithFee;

  if (denominator === 0n) return null;

  return numerator / denominator;
}

// =============================================================================
// Dynamic Slippage Calculation
// =============================================================================

/**
 * Calculate dynamic slippage based on trade size, reserves, and pool liquidity.
 *
 * Components:
 * - Base slippage floor (always applied)
 * - Price impact: tradeSize / (reserveIn + tradeSize) * priceImpactScale
 * - Liquidity penalty: for pools below minLiquidityUsd threshold
 *
 * @param tradeSize Trade size in pool units
 * @param reserveIn Reserve of input token
 * @param liquidityUsd Total pool liquidity in USD
 * @param config Dynamic slippage configuration
 * @returns Dynamic slippage value (capped at config.maxSlippage)
 */
export function calculateDynamicSlippage(
  tradeSize: number,
  reserveIn: number,
  liquidityUsd: number = 0,
  config: DynamicSlippageConfig = DEFAULT_SLIPPAGE_CONFIG
): number {
  // Base slippage floor
  let slippage = config.baseSlippage;

  // Price impact contribution (standard AMM formula)
  if (reserveIn > 0) {
    const priceImpact = tradeSize / (reserveIn + tradeSize);
    slippage += priceImpact * config.priceImpactScale;
  }

  // Liquidity penalty for low-liquidity pools
  if (liquidityUsd > 0 && liquidityUsd < config.minLiquidityUsd) {
    const liquidityRatio = liquidityUsd / config.minLiquidityUsd;
    const liquidityPenalty = (1 - liquidityRatio) * config.liquidityPenaltyScale * 0.01;
    slippage += liquidityPenalty;
  }

  // Cap at maximum slippage
  return Math.min(slippage, config.maxSlippage);
}
