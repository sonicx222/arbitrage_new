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
// Chain Constants
// =============================================================================

/**
 * Block times in milliseconds for different chains.
 * Used for calculating data freshness/staleness in confidence scoring.
 */
export const BLOCK_TIMES_MS: Record<string, number> = {
  ethereum: 12000,
  polygon: 2000,
  bsc: 3000,
  arbitrum: 250,
  optimism: 2000,
  base: 2000,
  avalanche: 2000,
  solana: 400,
};

// P0-FIX 10.4: Cache for normalized chain names to avoid toLowerCase() in hot path
const normalizedChainCache: Map<string, string> = new Map();

/**
 * Get block time for a chain in milliseconds.
 * Defaults to Ethereum block time (12s) for unknown chains.
 *
 * P0-FIX 10.4: Uses caching to avoid toLowerCase() string allocation in hot path.
 * Callers should normalize chain names at system boundaries, not per-call.
 *
 * @param chain - Chain name (case-insensitive)
 * @returns Block time in milliseconds
 */
export function getBlockTimeMs(chain: string): number {
  // Fast path: direct lookup for already lowercase chains
  let lookupKey = BLOCK_TIMES_MS[chain];
  if (lookupKey !== undefined) {
    return lookupKey;
  }

  // P0-FIX 10.4: Check cache before creating new lowercase string
  let normalized = normalizedChainCache.get(chain);
  if (!normalized) {
    normalized = chain.toLowerCase();
    // Limit cache size to prevent memory leak from malicious input
    if (normalizedChainCache.size < 100) {
      normalizedChainCache.set(chain, normalized);
    }
  }

  return BLOCK_TIMES_MS[normalized] ?? 12000;
}

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
  return Number(scaledResult) / PRICE_PRECISION_NUMBER;
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
  return Number(scaledResult) / PRICE_PRECISION_NUMBER;
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
 * @param price1 - First price
 * @param price2 - Second price
 * @returns Spread as decimal, or 0 if invalid
 */
export function calculateSpreadSafe(price1: number, price2: number): number {
  try {
    return calculateSpread(price1, price2);
  } catch {
    return 0;
  }
}

/**
 * Calculate net profit after fees.
 *
 * @param grossSpread - Gross spread as decimal (from calculateSpread)
 * @param fee1 - First swap fee as decimal (e.g., 0.003 = 0.3%)
 * @param fee2 - Second swap fee as decimal
 * @returns Net profit as decimal (may be negative)
 */
export function calculateNetProfit(
  grossSpread: number,
  fee1: number,
  fee2: number
): number {
  const totalFees = fee1 + fee2;
  return grossSpread - totalFees;
}

/**
 * Calculate complete spread result between two price sources.
 * This is the main entry point for profit calculations.
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

  // Calculate spread using canonical formula
  const grossSpread = calculateSpreadSafe(price1, price2);

  // Calculate total fees
  const totalFees = source1.fee + source2.fee;

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
// Fee Utilities
// =============================================================================

/**
 * Default fees by DEX type.
 * Low-fee DEXes like Curve and Balancer use 0.04%.
 * Most AMMs use 0.3%.
 */
const LOW_FEE_DEXES = new Set(['curve', 'balancer']);
const DEFAULT_AMM_FEE = 0.003; // 0.3%
const DEFAULT_LOW_FEE = 0.0004; // 0.04%

/**
 * Get default fee for a DEX.
 *
 * @param dexName - Name of the DEX (case-insensitive)
 * @returns Default fee as decimal
 */
export function getDefaultFee(dexName?: string): number {
  if (dexName && LOW_FEE_DEXES.has(dexName.toLowerCase())) {
    return DEFAULT_LOW_FEE;
  }
  return DEFAULT_AMM_FEE;
}

/**
 * Resolve fee from multiple sources with fallback.
 * Uses nullish coalescing to correctly handle fee: 0.
 *
 * @param explicitFee - Explicit fee value (may be undefined)
 * @param dexName - DEX name for default lookup
 * @returns Resolved fee as decimal
 */
export function resolveFee(explicitFee: number | undefined, dexName?: string): number {
  // Use ?? to correctly handle fee: 0
  return explicitFee ?? getDefaultFee(dexName);
}

/**
 * Convert basis points to decimal fee.
 * E.g., 30 basis points = 0.003 (0.3%)
 *
 * @param basisPoints - Fee in basis points
 * @returns Fee as decimal
 */
export function basisPointsToDecimal(basisPoints: number): number {
  return basisPoints / 10000;
}

/**
 * Convert decimal fee to basis points.
 * E.g., 0.003 = 30 basis points
 *
 * @param decimalFee - Fee as decimal
 * @returns Fee in basis points
 */
export function decimalToBasisPoints(decimalFee: number): number {
  return decimalFee * 10000;
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
  // Base confidence on spread magnitude (capped at 0.5 spread = 100% base)
  let confidence = Math.min(spread / 0.5, 1.0);

  // Apply freshness penalty
  // Formula: freshnessScore = max(0.5, 1.0 - (ageMs / maxAgeMs))
  const freshnessScore = Math.max(0.5, 1.0 - ageMs / maxAgeMs);
  confidence *= freshnessScore;

  // Cap at 95%
  return Math.min(confidence, 0.95);
}

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Validate that a price is valid for calculations.
 *
 * @param price - Price to validate
 * @returns True if valid
 */
export function isValidPrice(price: number): boolean {
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
 *
 * @param fee - Fee to validate
 * @returns True if valid (0 <= fee < 1)
 */
export function isValidFee(fee: number): boolean {
  return typeof fee === 'number' && isFinite(fee) && fee >= 0 && fee < 1;
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
