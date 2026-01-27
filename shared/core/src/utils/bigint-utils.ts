/**
 * BigInt Utilities
 *
 * FIX 9.3: Standardized BigInt <-> Number conversion utilities.
 *
 * IMPORTANT: BigInt cannot represent decimals. These utilities use
 * scale factors to maintain precision when converting between formats.
 *
 * Conventions:
 * - Wei values (token amounts, gas costs): Use bigint directly
 * - Percentages/fractions: Use number (0-1 range)
 * - Scaling: Use 10000n (4 decimal places) for most conversions
 *
 * @example
 * // Convert 5% to scaled bigint
 * const scaledPercent = fractionToBigInt(0.05); // 500n
 *
 * // Convert back
 * const fraction = bigIntToFraction(500n); // 0.05
 *
 * // Calculate 5% of 1 ETH
 * const amount = applyFraction(1000000000000000000n, 0.05);
 * // Result: 50000000000000000n (0.05 ETH)
 */

// =============================================================================
// Scale Factors
// =============================================================================

/**
 * Default scale factor for fraction conversions.
 * 10000 provides 4 decimal places of precision (0.01% granularity).
 */
export const DEFAULT_SCALE = 10000n;

/**
 * High precision scale factor for calculations needing more accuracy.
 * 1000000 provides 6 decimal places of precision.
 */
export const HIGH_PRECISION_SCALE = 1000000n;

// =============================================================================
// Fraction Conversions
// =============================================================================

/**
 * Convert a decimal fraction (0-1) to scaled bigint.
 *
 * @param fraction - Decimal value (e.g., 0.05 for 5%)
 * @param scale - Scale factor (default: 10000)
 * @returns Scaled bigint value
 *
 * @example
 * fractionToBigInt(0.05) // 500n (5% scaled by 10000)
 * fractionToBigInt(0.333, 1000000n) // 333000n (33.3% scaled by 1000000)
 */
export function fractionToBigInt(fraction: number, scale: bigint = DEFAULT_SCALE): bigint {
  if (!Number.isFinite(fraction)) {
    return 0n;
  }
  // Clamp to reasonable range to prevent overflow
  const clamped = Math.max(-1, Math.min(1, fraction));
  return BigInt(Math.floor(clamped * Number(scale)));
}

/**
 * Convert a scaled bigint back to decimal fraction.
 *
 * @param scaled - Scaled bigint value
 * @param scale - Scale factor used (default: 10000)
 * @returns Decimal fraction
 *
 * @example
 * bigIntToFraction(500n) // 0.05 (5%)
 * bigIntToFraction(333000n, 1000000n) // 0.333 (33.3%)
 */
export function bigIntToFraction(scaled: bigint, scale: bigint = DEFAULT_SCALE): number {
  if (scale === 0n) {
    return 0;
  }
  return Number(scaled) / Number(scale);
}

// =============================================================================
// Arithmetic with Fractions
// =============================================================================

/**
 * Apply a fraction to a bigint value.
 * Useful for calculating percentages of wei amounts.
 *
 * @param value - Base value (e.g., capital in wei)
 * @param fraction - Fraction to apply (0-1)
 * @param scale - Scale factor for precision (default: 10000)
 * @returns Calculated value
 *
 * @example
 * // Calculate 5% of 1 ETH
 * applyFraction(1000000000000000000n, 0.05)
 * // Result: 50000000000000000n (0.05 ETH)
 */
export function applyFraction(
  value: bigint,
  fraction: number,
  scale: bigint = DEFAULT_SCALE
): bigint {
  const scaledFraction = fractionToBigInt(fraction, scale);
  return (value * scaledFraction) / scale;
}

/**
 * Calculate the fraction of one bigint relative to another.
 *
 * @param numerator - Numerator value
 * @param denominator - Denominator value
 * @param scale - Scale factor for precision (default: 10000)
 * @returns Fraction as number (0-1 range typically)
 *
 * @example
 * // What fraction is 50 of 1000?
 * calculateFraction(50n, 1000n) // 0.05 (5%)
 */
export function calculateFraction(
  numerator: bigint,
  denominator: bigint,
  scale: bigint = DEFAULT_SCALE
): number {
  if (denominator === 0n) {
    return 0;
  }
  return Number((numerator * scale) / denominator) / Number(scale);
}

// =============================================================================
// Safe Conversions
// =============================================================================

/**
 * Safely convert bigint to number for display/logging.
 * Returns Infinity/-Infinity for values outside safe integer range.
 *
 * @param value - BigInt value to convert
 * @returns Number representation
 *
 * @example
 * bigIntToNumber(1000000000000000000n) // 1e18 (may lose precision)
 * bigIntToNumber(9007199254740993n) // Loses precision warning
 */
export function bigIntToNumber(value: bigint): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return value > 0 ? Infinity : -Infinity;
  }
  return num;
}

/**
 * Safely convert number to bigint, truncating decimals.
 *
 * @param value - Number to convert
 * @returns BigInt representation
 *
 * @example
 * numberToBigInt(1.5) // 1n (truncates decimal)
 * numberToBigInt(Infinity) // 0n (invalid input)
 */
export function numberToBigInt(value: number): bigint {
  if (!Number.isFinite(value)) {
    return 0n;
  }
  return BigInt(Math.trunc(value));
}

// =============================================================================
// Comparison Utilities
// =============================================================================

/**
 * Get the minimum of two bigint values.
 */
export function bigIntMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Get the maximum of two bigint values.
 */
export function bigIntMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Clamp a bigint value between min and max.
 */
export function bigIntClamp(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Get absolute value of a bigint.
 */
export function bigIntAbs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

// =============================================================================
// Formatting
// =============================================================================

/**
 * Format a bigint wei value as a human-readable ETH string.
 *
 * @param wei - Value in wei
 * @param decimals - Number of decimal places (default: 6)
 * @returns Formatted string
 *
 * @example
 * formatWeiAsEth(1500000000000000000n) // "1.5"
 * formatWeiAsEth(1234567890000000000n, 4) // "1.2345"
 */
export function formatWeiAsEth(wei: bigint, decimals: number = 6): string {
  const ETH_DECIMALS = 18;
  const divisor = 10n ** BigInt(ETH_DECIMALS - decimals);
  const scaled = wei / divisor;
  const intPart = scaled / (10n ** BigInt(decimals));
  const fracPart = scaled % (10n ** BigInt(decimals));

  const fracStr = fracPart.toString().padStart(decimals, '0');
  // Remove trailing zeros
  const trimmedFrac = fracStr.replace(/0+$/, '');

  if (trimmedFrac.length === 0) {
    return intPart.toString();
  }
  return `${intPart}.${trimmedFrac}`;
}
