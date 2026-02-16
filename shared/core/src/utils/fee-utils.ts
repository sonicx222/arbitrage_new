/**
 * Fee Conversion Utilities - Single Source of Truth
 *
 * This module provides all fee-related type definitions, constants, and
 * conversion functions used throughout the arbitrage system.
 *
 * ## Fee Format Convention
 *
 * The codebase uses three distinct fee representations:
 *
 * 1. **Basis Points (BPS)** - Integer format (30 = 0.30%)
 *    - Used in: DEX config, flash loan fees
 *    - Denominator: 10,000
 *    - Range: 0-10000 (0% to 100%)
 *
 * 2. **Decimal** - Internal calculation format (0.003 = 0.30%)
 *    - Used in: All internal calculations, Pair.fee, PriceUpdate.fee
 *    - Denominator: 1
 *    - Range: 0-1 (0% to 100%)
 *
 * 3. **Uniswap V3 Fee Tiers** - Per-million format (3000 = 0.30%)
 *    - Used in: Uniswap V3 router encoding, PendingSwapIntent.fee
 *    - Denominator: 1,000,000
 *    - Range: 100-10000 (0.01% to 1%)
 *
 * ## Usage Examples
 *
 * ```typescript
 * import {
 *   bpsToDecimal,
 *   decimalToBps,
 *   v3TierToDecimal,
 *   validateFee,
 *   FEE_DEFAULT_DECIMAL,
 *   type FeeBasisPoints,
 *   type FeeDecimal,
 *   type UniswapV3FeeTier
 * } from '@arbitrage/core';
 *
 * // Convert DEX config fee (BPS) to internal format (decimal)
 * const dexFee = 30; // 0.30% in basis points
 * const decimalFee = bpsToDecimal(dexFee); // 0.003
 *
 * // Convert Uniswap V3 fee tier to decimal
 * const v3Fee: UniswapV3FeeTier = 3000;
 * const v3Decimal = v3TierToDecimal(v3Fee); // 0.003
 *
 * // Validate and sanitize fee values
 * const safeFee = validateFee(maybeUndefined); // Returns default if invalid
 * ```
 *
 * @module fee-utils
 */

// =============================================================================
// Fee Type Definitions (Branded Types for Type Safety)
// =============================================================================

/**
 * Fee in basis points (30 = 0.30%).
 *
 * Branded type for compile-time safety to prevent mixing fee formats.
 * Range: 0-10000 (0% to 100%)
 *
 * @example
 * const fee: FeeBasisPoints = 30 as FeeBasisPoints; // 0.30%
 */
export type FeeBasisPoints = number & { readonly __brand: 'FeeBasisPoints' };

/**
 * Fee as decimal (0.003 = 0.30%).
 *
 * Branded type for compile-time safety. This is the standard internal format
 * used in all calculations.
 * Range: 0-1 (0% to 100%)
 *
 * @example
 * const fee: FeeDecimal = 0.003 as FeeDecimal; // 0.30%
 */
export type FeeDecimal = number & { readonly __brand: 'FeeDecimal' };

/**
 * Uniswap V3 fee tier values.
 *
 * Only these specific values are valid Uniswap V3 fee tiers:
 * - 100:   0.01% (exotic/stablecoin pairs)
 * - 500:   0.05% (low-volatility pairs)
 * - 3000:  0.30% (most pairs)
 * - 10000: 1.00% (high-volatility/exotic pairs)
 *
 * Note: Uses per-million denominator (1,000,000), NOT basis points.
 */
export type UniswapV3FeeTier = 100 | 500 | 3000 | 10000;

// =============================================================================
// Constants
// =============================================================================

/**
 * Basis points denominator (10,000).
 * 1 basis point = 0.01% = 0.0001
 */
export const BPS_DENOMINATOR = 10000;

/**
 * Uniswap V3 fee tier denominator (1,000,000).
 */
export const V3_FEE_DENOMINATOR = 1_000_000;

/**
 * Percentage denominator (100).
 */
export const PERCENT_DENOMINATOR = 100;

/**
 * Standard fee constants in DECIMAL format.
 *
 * These are the most common fee values across different DEX types.
 */
export const FEE_CONSTANTS = {
  /** Standard Uniswap V2 / SushiSwap fee: 0.30% */
  UNISWAP_V2: 0.003 as FeeDecimal,
  /** Uniswap V3 lowest fee tier: 0.01% */
  V3_LOWEST: 0.0001 as FeeDecimal,
  /** Uniswap V3 low fee tier: 0.05% */
  V3_LOW: 0.0005 as FeeDecimal,
  /** Uniswap V3 medium fee tier: 0.30% */
  V3_MEDIUM: 0.003 as FeeDecimal,
  /** Uniswap V3 high fee tier: 1.00% */
  V3_HIGH: 0.01 as FeeDecimal,
  /** Curve/Balancer style low fee: 0.04% */
  LOW_FEE: 0.0004 as FeeDecimal,
  /** Default fee when unknown (conservative): 0.30% */
  DEFAULT: 0.003 as FeeDecimal,
  /** Zero fee (promotional pools): 0.00% */
  ZERO: 0 as FeeDecimal,
} as const;

// Individual exports for backward compatibility
//
// NOTE: These legacy names predate the V3_LOWEST (0.01%) tier being added.
// The naming shifted by one tier but was kept for backward compatibility:
//   "LOW"    (legacy) → V3_LOWEST  = 0.0001 (0.01%, tier 100)
//   "MEDIUM" (legacy) → V3_LOW     = 0.0005 (0.05%, tier 500)
//   "HIGH"   (legacy) → V3_MEDIUM  = 0.003  (0.30%, tier 3000)
//
// Prefer FEE_CONSTANTS.V3_LOWEST / V3_LOW / V3_MEDIUM / V3_HIGH for clarity.

/** @deprecated Use FEE_CONSTANTS.UNISWAP_V2 (0.003 = 0.30%) */
export const FEE_UNISWAP_V2_DECIMAL = FEE_CONSTANTS.UNISWAP_V2;
/** @deprecated Use FEE_CONSTANTS.V3_LOWEST — despite the name, this is 0.0001 (0.01%, tier 100) */
export const FEE_UNISWAP_V3_LOW_DECIMAL = FEE_CONSTANTS.V3_LOWEST;
/** @deprecated Use FEE_CONSTANTS.V3_LOW — despite the name, this is 0.0005 (0.05%, tier 500) */
export const FEE_UNISWAP_V3_MEDIUM_DECIMAL = FEE_CONSTANTS.V3_LOW;
/** @deprecated Use FEE_CONSTANTS.V3_MEDIUM — despite the name, this is 0.003 (0.30%, tier 3000) */
export const FEE_UNISWAP_V3_HIGH_DECIMAL = FEE_CONSTANTS.V3_MEDIUM;
/** @deprecated Use FEE_CONSTANTS.DEFAULT (0.003 = 0.30%) */
export const FEE_DEFAULT_DECIMAL = FEE_CONSTANTS.DEFAULT;

/**
 * Valid Uniswap V3 fee tiers as a Set for O(1) validation.
 */
export const VALID_V3_FEE_TIERS = new Set<UniswapV3FeeTier>([100, 500, 3000, 10000]);

/**
 * DEX names that typically have low fees (0.04%).
 */
export const LOW_FEE_DEXES = new Set(['curve', 'balancer']);

// =============================================================================
// Conversion Functions
// =============================================================================

/**
 * Convert basis points to decimal fee.
 *
 * @param bps - Fee in basis points (e.g., 30 = 0.30%)
 * @returns Fee as decimal (e.g., 0.003)
 *
 * @example
 * bpsToDecimal(30);  // 0.003 (0.30%)
 * bpsToDecimal(4);   // 0.0004 (0.04%)
 * bpsToDecimal(100); // 0.01 (1.00%)
 */
export function bpsToDecimal(bps: number): FeeDecimal {
  return (bps / BPS_DENOMINATOR) as FeeDecimal;
}

/**
 * Convert decimal fee to basis points.
 *
 * @param decimal - Fee as decimal (e.g., 0.003 = 0.30%)
 * @returns Fee in basis points (e.g., 30), rounded to nearest integer
 *
 * @example
 * decimalToBps(0.003);  // 30 (0.30%)
 * decimalToBps(0.0004); // 4 (0.04%)
 * decimalToBps(0.01);   // 100 (1.00%)
 */
export function decimalToBps(decimal: number): FeeBasisPoints {
  return Math.round(decimal * BPS_DENOMINATOR) as FeeBasisPoints;
}

/**
 * Convert Uniswap V3 fee tier to decimal.
 *
 * @param feeTier - V3 fee tier (100, 500, 3000, or 10000)
 * @returns Fee as decimal
 *
 * @example
 * v3TierToDecimal(100);   // 0.0001 (0.01%)
 * v3TierToDecimal(500);   // 0.0005 (0.05%)
 * v3TierToDecimal(3000);  // 0.003 (0.30%)
 * v3TierToDecimal(10000); // 0.01 (1.00%)
 */
export function v3TierToDecimal(feeTier: UniswapV3FeeTier | number): FeeDecimal {
  return (feeTier / V3_FEE_DENOMINATOR) as FeeDecimal;
}

/**
 * Convert decimal fee to Uniswap V3 fee tier format.
 *
 * Note: This returns a number, not a validated UniswapV3FeeTier.
 * Use isValidV3FeeTier() to check if the result is a valid tier.
 *
 * @param decimal - Fee as decimal (e.g., 0.003 = 0.30%)
 * @returns Fee in V3 format (e.g., 3000)
 *
 * @example
 * decimalToV3Tier(0.003); // 3000
 */
export function decimalToV3Tier(decimal: number): number {
  return Math.round(decimal * V3_FEE_DENOMINATOR);
}

/**
 * Convert percentage (0.3 = 0.3%) to decimal (0.003).
 *
 * @param percentage - Fee as percentage (e.g., 0.3 = 0.3%)
 * @returns Fee as decimal (e.g., 0.003)
 *
 * @example
 * percentToDecimal(0.3); // 0.003 (0.30%)
 * percentToDecimal(1.0); // 0.01 (1.00%)
 */
export function percentToDecimal(percentage: number): FeeDecimal {
  return (percentage / PERCENT_DENOMINATOR) as FeeDecimal;
}

/**
 * Convert decimal to percentage format.
 *
 * @param decimal - Fee as decimal (e.g., 0.003)
 * @returns Fee as percentage (e.g., 0.3 = 0.3%)
 */
export function decimalToPercent(decimal: number): number {
  return decimal * PERCENT_DENOMINATOR;
}

// =============================================================================
// Backward Compatibility Aliases
// =============================================================================

/**
 * @deprecated Use bpsToDecimal instead
 */
export const basisPointsToDecimal = bpsToDecimal;

/**
 * @deprecated Use decimalToBps instead
 */
export const decimalToBasisPoints = decimalToBps;

/**
 * @deprecated Use bpsToDecimal instead
 * Convert DEX fee from basis points to percentage (decimal).
 */
export function dexFeeToPercentage(feeBasisPoints: number): number {
  return bpsToDecimal(feeBasisPoints);
}

/**
 * @deprecated Use decimalToBps instead
 * Convert percentage (decimal) to basis points.
 */
export function percentageToBasisPoints(percentage: number): number {
  return decimalToBps(percentage);
}

/**
 * @deprecated Use v3TierToDecimal instead
 * Convert Uniswap V3 per-million fee to decimal.
 */
export function perMillionToDecimal(perMillion: number): number {
  return v3TierToDecimal(perMillion);
}

/**
 * @deprecated Use percentToDecimal instead
 * Convert percentage to decimal.
 */
export function percentageToDecimal(percentage: number): number {
  return percentToDecimal(percentage);
}

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Check if a value is a valid Uniswap V3 fee tier.
 *
 * @param value - Value to check
 * @returns true if value is 100, 500, 3000, or 10000
 */
export function isValidV3FeeTier(value: number): value is UniswapV3FeeTier {
  return VALID_V3_FEE_TIERS.has(value as UniswapV3FeeTier);
}

/**
 * Check if a decimal fee value is valid.
 *
 * Valid fees must be:
 * - A finite number
 * - Non-negative (>= 0)
 * - Less than 1 (< 100%)
 *
 * @param fee - Fee value to validate
 * @returns true if fee is valid
 */
export function isValidFeeDecimal(fee: number): boolean {
  return Number.isFinite(fee) && fee >= 0 && fee < 1;
}

/**
 * Check if a basis points fee value is valid.
 *
 * @param bps - Basis points value to validate
 * @returns true if bps is valid (0-10000)
 */
export function isValidFeeBps(bps: number): boolean {
  return Number.isFinite(bps) && Number.isInteger(bps) && bps >= 0 && bps <= BPS_DENOMINATOR;
}

/**
 * Validate and sanitize a fee value, returning a default if invalid.
 *
 * This function guards against:
 * - undefined/null values
 * - NaN (from invalid conversions)
 * - Infinity (from division errors)
 * - Negative values
 * - Fees >= 100% (clearly incorrect)
 *
 * @param fee - Raw fee value (may be undefined, null, NaN, etc.)
 * @param defaultFee - Default value to return if fee is invalid (default: 0.003)
 * @returns Validated fee as decimal, or defaultFee if invalid
 *
 * @example
 * validateFee(0.003);     // 0.003 (valid)
 * validateFee(0);         // 0 (valid - promotional fee)
 * validateFee(undefined); // 0.003 (default)
 * validateFee(NaN);       // 0.003 (default)
 * validateFee(-0.01);     // 0.003 (default - negative invalid)
 * validateFee(1.5);       // 0.003 (default - >100% invalid)
 */
export function validateFee(
  fee: number | undefined | null,
  defaultFee: number = FEE_DEFAULT_DECIMAL
): FeeDecimal {
  if (fee === undefined || fee === null) {
    return defaultFee as FeeDecimal;
  }

  if (!isValidFeeDecimal(fee)) {
    return defaultFee as FeeDecimal;
  }

  return fee as FeeDecimal;
}

/**
 * Get the default fee for a DEX based on its name.
 *
 * Low-fee DEXes (Curve, Balancer) return 0.04% (4 bps).
 * All other DEXes return 0.30% (30 bps).
 *
 * @param dexName - Name of the DEX (case-insensitive)
 * @returns Default fee as decimal
 */
export function getDefaultFeeForDex(dexName?: string): FeeDecimal {
  if (dexName && LOW_FEE_DEXES.has(dexName.toLowerCase())) {
    return FEE_CONSTANTS.LOW_FEE;
  }
  return FEE_CONSTANTS.DEFAULT;
}

/**
 * Resolve fee from explicit value or DEX default.
 *
 * Uses nullish coalescing (??) to correctly handle fee = 0.
 *
 * @param explicitFee - Explicit fee value (may be undefined)
 * @param dexName - DEX name for default lookup
 * @returns Resolved fee as decimal
 */
export function resolveFeeValue(
  explicitFee: number | undefined,
  dexName?: string
): FeeDecimal {
  // Guard against NaN: NaN ?? default returns NaN since NaN is not null/undefined.
  // Use ?? to correctly handle fee: 0 (promotional fees).
  if (explicitFee !== undefined && !isValidFeeDecimal(explicitFee)) {
    return getDefaultFeeForDex(dexName);
  }
  return (explicitFee ?? getDefaultFeeForDex(dexName)) as FeeDecimal;
}

// =============================================================================
// Type Guards for Branded Types
// =============================================================================

/**
 * Create a typed FeeBasisPoints value.
 *
 * @param value - Number to cast
 * @returns Typed FeeBasisPoints
 */
export function asBps(value: number): FeeBasisPoints {
  return value as FeeBasisPoints;
}

/**
 * Create a typed FeeDecimal value.
 *
 * @param value - Number to cast
 * @returns Typed FeeDecimal
 */
export function asDecimal(value: number): FeeDecimal {
  return value as FeeDecimal;
}
