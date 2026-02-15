/**
 * PriceCalculator - Pure Functions for Price and Profit Calculations
 *
 * ARCH-REFACTOR: Extracted from base-detector.ts and arbitrage-calculator.ts
 * to create a single source of truth for all price/profit calculations.
 *
 * Design Principles:
 * - Pure functions (no side effects, no dependencies on external state)
 * - 100% unit testable without mocking
 * - BigInt precision for large reserve values (P0-1 FIX)
 * - Consistent formula: spread = |price1 - price2| / min(price1, price2)
 *
 * @see .claude/plans/detection-refactoring-plan.md
 * @see .claude/plans/component-architecture-proposal.md
 */

// Fee utilities - import from canonical source
import { isValidFeeDecimal } from '../utils/fee-utils';

// =============================================================================
// Types
// =============================================================================

/**
 * Input for price calculation from reserves.
 * Accepts both string and bigint reserves for flexibility.
 */
export interface ReserveInput {
  reserve0: string | bigint;
  reserve1: string | bigint;
}

/**
 * Result of price spread calculation.
 */
export interface SpreadResult {
  /** Gross spread as decimal (0.01 = 1%) */
  grossSpread: number;
  /** Total fees as decimal (0.006 = 0.6% for two 0.3% swaps) */
  totalFees: number;
  /** Net profit after fees as decimal */
  netProfit: number;
  /** Lower price (buy side) */
  buyPrice: number;
  /** Higher price (sell side) */
  sellPrice: number;
  /** Whether net profit is positive */
  isProfitable: boolean;
}

/**
 * Input for profit calculation between two price sources.
 */
export interface PriceSource {
  price: number;
  fee: number; // Fee as decimal (0.003 = 0.3%)
  source: string; // DEX or source identifier
}

/**
 * Result of profit calculation between two sources.
 */
export interface ProfitCalculationResult extends SpreadResult {
  /** Source with lower price (buy from) */
  buySource: string;
  /** Source with higher price (sell to) */
  sellSource: string;
}

/**
 * Error thrown for invalid price calculation inputs.
 */
export class PriceCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceCalculationError';
  }
}

// =============================================================================
// Precision Constants (P0-1 FIX)
// =============================================================================

/**
 * Precision scale for BigInt arithmetic to avoid floating point precision loss.
 * Using 10^18 (same as ETH wei) provides excellent precision for price calculations.
 */
const PRICE_PRECISION = 10n ** 18n;
const PRICE_PRECISION_NUMBER = 1e18;

// =============================================================================
// Chain Constants (Re-exported from @arbitrage/config)
// Single source of truth: shared/config/src/chains/index.ts
// =============================================================================

// Import from config module - the canonical source of truth
import {
  BLOCK_TIMES_MS as CONFIG_BLOCK_TIMES_MS,
  getBlockTimeMs as configGetBlockTimeMs,
} from '../../../config/src';

/**
 * Block times in milliseconds for different chains.
 * Used for calculating data freshness/staleness in confidence scoring.
 *
 * @deprecated Since v1.1.0. Import BLOCK_TIMES_MS from '@arbitrage/config' instead.
 * This re-export is kept for backward compatibility.
 */
export const BLOCK_TIMES_MS = CONFIG_BLOCK_TIMES_MS;

/**
 * Get block time for a chain in milliseconds.
 * Defaults to Ethereum block time (12s) for unknown chains.
 *
 * @deprecated Since v1.1.0. Import getBlockTimeMs from '@arbitrage/config' instead.
 * This re-export is kept for backward compatibility.
 *
 * @param chain - Chain name (case-insensitive)
 * @returns Block time in milliseconds
 */
export const getBlockTimeMs = configGetBlockTimeMs;

// =============================================================================
// Core Price Calculations
// =============================================================================

/**
 * Calculate price from reserves with full BigInt precision.
 * Price = reserve0 / reserve1 (price of token1 in terms of token0)
 *
 * P0-1 FIX: Uses scaled BigInt arithmetic to prevent precision loss
 * that occurs when converting large BigInt values directly to Number.
 *
 * @param reserve0 - Reserve of token0 (string or bigint)
 * @param reserve1 - Reserve of token1 (string or bigint)
 * @returns Price as number, or null if invalid reserves
 */
export function calculatePriceFromReserves(
  reserve0: string | bigint,
  reserve1: string | bigint
): number | null {
  try {
    const r0 = typeof reserve0 === 'string' ? BigInt(reserve0) : reserve0;
    const r1 = typeof reserve1 === 'string' ? BigInt(reserve1) : reserve1;

    if (r0 <= 0n || r1 <= 0n) {
      return null;
    }

    // P0-FIX 4.4: Use safeBigIntDivisionOrNull to return null instead of throwing
    return safeBigIntDivisionOrNull(r0, r1);
  } catch {
    // Handle invalid BigInt strings gracefully
    return null;
  }
}

/**
 * Safely convert BigInt division result to Number with precision scaling.
 * This prevents precision loss for large BigInt values.
 *
 * P0-1 FIX: Uses scaled division to preserve precision.
 * P0-FIX 4.4: Now throws PriceCalculationError for division by zero instead
 * of returning 0, which could cause false arbitrage opportunity detection.
 *
 * @param numerator - The numerator BigInt
 * @param denominator - The denominator BigInt (must be > 0)
 * @returns The result as a Number with preserved precision
 * @throws PriceCalculationError if denominator is 0
 */
export function safeBigIntDivision(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) {
    // P0-FIX 4.4: Throw instead of returning 0 to prevent false positives
    throw new PriceCalculationError('Division by zero: denominator cannot be 0');
  }

  // Scale up the numerator before division to preserve decimal places
  const scaledResult = (numerator * PRICE_PRECISION) / denominator;

  // Convert scaled result to number and divide by scale
  const result = Number(scaledResult) / PRICE_PRECISION_NUMBER;

  // Guard against precision loss for BigInt > 2^53
  if (!Number.isFinite(result)) {
    throw new PriceCalculationError('Precision loss: result is not finite after BigInt conversion');
  }

  return result;
}

/**
 * Safe version of safeBigIntDivision that returns null instead of throwing.
 * Use this when you want to handle invalid input gracefully.
 *
 * @param numerator - The numerator BigInt
 * @param denominator - The denominator BigInt
 * @returns The result as a Number, or null if denominator is 0
 */
export function safeBigIntDivisionOrNull(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) {
    return null;
  }

  const scaledResult = (numerator * PRICE_PRECISION) / denominator;
  const result = Number(scaledResult) / PRICE_PRECISION_NUMBER;

  // Guard against precision loss for BigInt > 2^53
  if (!Number.isFinite(result)) {
    return null;
  }

  return result;
}

/**
 * Invert price for reverse token order comparison.
 * Used when comparing pairs with reversed token order.
 *
 * @param price - Price to invert
 * @returns 1/price, or 0 if price is 0
 */
export function invertPrice(price: number): number {
  if (price === 0) return 0;
  return 1 / price;
}

// =============================================================================
// Spread and Profit Calculations
// =============================================================================

/**
 * Calculate price spread percentage using CANONICAL FORMULA.
 *
 * CANONICAL FORMULA (single source of truth):
 * spread = |price1 - price2| / min(price1, price2)
 *
 * This formula is preferred over avgPrice because:
 * 1. It represents the actual arbitrage opportunity size
 * 2. It's consistent with how MEV bots calculate profit
 * 3. It's symmetric (same result regardless of price order)
 *
 * @param price1 - First price (must be > 0)
 * @param price2 - Second price (must be > 0)
 * @returns Spread as decimal (0.01 = 1%)
 * @throws PriceCalculationError if prices are invalid
 */
export function calculateSpread(price1: number, price2: number): number {
  if (price1 <= 0 || price2 <= 0) {
    throw new PriceCalculationError('Prices must be positive');
  }

  if (!isFinite(price1) || !isFinite(price2)) {
    throw new PriceCalculationError('Prices must be finite numbers');
  }

  const minPrice = Math.min(price1, price2);
  return Math.abs(price1 - price2) / minPrice;
}

/**
 * Calculate price spread safely (returns 0 instead of throwing).
 * Use this for batch processing where some pairs may have invalid data.
 *
 * HOT-PATH: Inlines validation checks to avoid try/catch overhead.
 *
 * @param price1 - First price
 * @param price2 - Second price
 * @returns Spread as decimal, or 0 if invalid
 */
export function calculateSpreadSafe(price1: number, price2: number): number {
  if (price1 <= 0 || price2 <= 0 || !isFinite(price1) || !isFinite(price2)) {
    return 0;
  }
  const minPrice = Math.min(price1, price2);
  return Math.abs(price1 - price2) / minPrice;
}

/**
 * Calculate net profit after fees.
 *
 * P2-2 FIX: Added input validation for NaN and infinite values.
 *
 * @param grossSpread - Gross spread as decimal (from calculateSpread)
 * @param fee1 - First swap fee as decimal (e.g., 0.003 = 0.3%)
 * @param fee2 - Second swap fee as decimal
 * @returns Net profit as decimal (may be negative), or 0 if inputs invalid
 */
export function calculateNetProfit(
  grossSpread: number,
  fee1: number,
  fee2: number
): number {
  // P2-2 FIX: Guard against NaN/Infinity propagation
  if (!Number.isFinite(grossSpread) || !Number.isFinite(fee1) || !Number.isFinite(fee2)) {
    return 0;
  }

  // P2-2 FIX: Guard against negative fees (invalid input)
  if (fee1 < 0 || fee2 < 0) {
    return 0;
  }

  const totalFees = fee1 + fee2;
  return grossSpread - totalFees;
}

/**
 * Calculate complete spread result between two price sources.
 * This is the main entry point for profit calculations.
 *
 * P2-2 FIX: Added comprehensive input validation.
 *
 * @param source1 - First price source
 * @param source2 - Second price source
 * @returns Complete spread result with buy/sell info
 */
export function calculateProfitBetweenSources(
  source1: PriceSource,
  source2: PriceSource
): ProfitCalculationResult {
  const price1 = source1.price;
  const price2 = source2.price;

  // P2-2 FIX: Validate inputs early to prevent NaN propagation
  const validPrice1 = isValidPrice(price1);
  const validPrice2 = isValidPrice(price2);

  // If either price is invalid, return a "no opportunity" result
  if (!validPrice1 || !validPrice2) {
    return {
      grossSpread: 0,
      totalFees: 0,
      netProfit: 0,
      buyPrice: 0,
      sellPrice: 0,
      isProfitable: false,
      buySource: source1.source,
      sellSource: source2.source,
    };
  }

  // Calculate spread using canonical formula
  const grossSpread = calculateSpreadSafe(price1, price2);

  // P2-2 FIX: Validate fees (use 0 for invalid/negative fees)
  const fee1 = isValidFee(source1.fee) ? source1.fee : 0;
  const fee2 = isValidFee(source2.fee) ? source2.fee : 0;
  const totalFees = fee1 + fee2;

  // Net profit
  const netProfit = grossSpread - totalFees;

  // Determine buy/sell sides
  const isBuyFrom1 = price1 < price2;

  return {
    grossSpread,
    totalFees,
    netProfit,
    buyPrice: Math.min(price1, price2),
    sellPrice: Math.max(price1, price2),
    isProfitable: netProfit > 0,
    buySource: isBuyFrom1 ? source1.source : source2.source,
    sellSource: isBuyFrom1 ? source2.source : source1.source,
  };
}

// =============================================================================
// Threshold Utilities
// =============================================================================

/**
 * Check if a profit meets the minimum threshold.
 * Ensures consistent comparison across all detection paths.
 *
 * @param netProfit - Net profit as decimal
 * @param threshold - Minimum profit threshold as decimal
 * @returns True if profitable enough
 */
export function meetsThreshold(netProfit: number, threshold: number): boolean {
  return netProfit >= threshold;
}

/**
 * Calculate confidence score for an arbitrage opportunity.
 * Based on spread magnitude and price freshness.
 *
 * @param spread - Gross spread as decimal
 * @param ageMs - Age of price data in milliseconds
 * @param maxAgeMs - Maximum acceptable age (default 10 seconds)
 * @returns Confidence score 0-1
 */
export function calculateConfidence(
  spread: number,
  ageMs: number,
  maxAgeMs: number = 10000
): number {
  // FIX 4.2: Guard against invalid inputs that could produce NaN
  if (!Number.isFinite(spread) || !Number.isFinite(ageMs) || !Number.isFinite(maxAgeMs)) {
    return 0.5; // Return neutral confidence for invalid inputs
  }

  // Ensure non-negative values
  const safeSpread = Math.max(0, spread);
  const safeAgeMs = Math.max(0, ageMs);
  const safeMaxAgeMs = Math.max(1, maxAgeMs); // Prevent division by zero

  // Base confidence on spread magnitude (capped at 0.5 spread = 100% base)
  let confidence = Math.min(safeSpread / 0.5, 1.0);

  // Apply freshness penalty
  // Formula: freshnessScore = max(0.5, 1.0 - (ageMs / maxAgeMs))
  const freshnessScore = Math.max(0.5, 1.0 - safeAgeMs / safeMaxAgeMs);
  confidence *= freshnessScore;

  // Cap at 95% and ensure valid number
  const result = Math.min(confidence, 0.95);
  return Number.isFinite(result) ? result : 0.5;
}

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Type guard that validates a price is valid for calculations.
 * Accepts `unknown` to allow validation of potentially undefined values.
 *
 * HOT-PATH: Used in execution strategies for price validation.
 *
 * @param price - Price to validate (can be any type)
 * @returns True if valid, and narrows type to `number`
 *
 * @example
 * ```typescript
 * if (isValidPrice(opportunity.buyPrice)) {
 *   // TypeScript knows buyPrice is a valid number
 *   const profit = calculateProfit(opportunity.buyPrice);
 * }
 * ```
 */
export function isValidPrice(price: unknown): price is number {
  return typeof price === 'number' && isFinite(price) && price > 0;
}

/**
 * Validate that reserves are valid for price calculation.
 *
 * @param reserve0 - First reserve
 * @param reserve1 - Second reserve
 * @returns True if both reserves are valid
 */
export function areValidReserves(
  reserve0: string | bigint,
  reserve1: string | bigint
): boolean {
  try {
    const r0 = typeof reserve0 === 'string' ? BigInt(reserve0) : reserve0;
    const r1 = typeof reserve1 === 'string' ? BigInt(reserve1) : reserve1;
    return r0 > 0n && r1 > 0n;
  } catch {
    return false;
  }
}

/**
 * Validate that a fee is in valid decimal format.
 * @deprecated Use isValidFeeDecimal from '@arbitrage/core' instead
 */
export function isValidFee(fee: number): boolean {
  return isValidFeeDecimal(fee);
}

// =============================================================================
// Additional Functions (migrated from arbitrage-calculator.ts)
// =============================================================================

/**
 * Calculate price from BigInt reserves directly (avoids string parsing overhead).
 * P0-1 FIX: Optimized version for when reserves are already BigInt.
 * P0-FIX 4.4: Uses safeBigIntDivisionOrNull to return null instead of throwing.
 *
 * @param reserve0 - Reserve of token0 as BigInt
 * @param reserve1 - Reserve of token1 as BigInt
 * @returns Price as number, or null if invalid reserves
 */
export function calculatePriceFromBigIntReserves(reserve0: bigint, reserve1: bigint): number | null {
  if (reserve0 === 0n || reserve1 === 0n) {
    return null;
  }

  return safeBigIntDivisionOrNull(reserve0, reserve1);
}

/**
 * Calculate price difference as percentage of lower price.
 * Alias for calculateSpreadSafe for backward compatibility.
 *
 * @param price1 - First price
 * @param price2 - Second price
 * @returns Difference as decimal (0.01 = 1%)
 */
export function calculatePriceDifferencePercent(price1: number, price2: number): number {
  return calculateSpreadSafe(price1, price2);
}

// Re-export getMinProfitThreshold from config (single source of truth)
// This maintains backward compatibility for code importing from components
export { getMinProfitThreshold } from '../../../config/src/thresholds';
