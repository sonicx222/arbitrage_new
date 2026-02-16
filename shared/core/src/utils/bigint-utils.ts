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
// Price Bounds (Single Source of Truth)
// =============================================================================

/**
 * Minimum safe price value for arbitrage calculations.
 *
 * At 1e-18:
 * - Supports tokens with 18 decimals at extremely low prices (memecoins)
 * - 1/price = 1e18 which is still within Number's safe range
 * - Matches SimpleArbitrageDetector and isValidPrice() defaults
 *
 * @see SimpleArbitrageDetector.minSafePrice
 * @see isValidPrice() in unified-detector/types.ts
 */
export const MIN_SAFE_PRICE = 1e-18;

/**
 * Maximum safe price value for arbitrage calculations.
 *
 * At 1e18:
 * - Symmetric with MIN_SAFE_PRICE (1/MIN = MAX)
 * - Prevents precision loss in floating-point calculations
 * - Beyond this, Number precision degrades significantly
 *
 * @see SimpleArbitrageDetector.maxSafePrice
 * @see isValidPrice() in unified-detector/types.ts
 */
export const MAX_SAFE_PRICE = 1e18;

// =============================================================================
// Fraction Conversions
// =============================================================================

/**
 * Convert a decimal fraction to scaled bigint.
 *
 * Commonly used for percentages (0-1 range), but accepts any finite number.
 * Non-finite values (NaN, Infinity) return 0n.
 *
 * @param fraction - Decimal value (e.g., 0.05 for 5%)
 * @param scale - Scale factor (default: 10000)
 * @returns Scaled bigint value
 *
 * @example
 * fractionToBigInt(0.05) // 500n (5% scaled by 10000)
 * fractionToBigInt(0.333, 1000000n) // 333000n (33.3% scaled by 1000000)
 * fractionToBigInt(1.5) // 15000n (150% scaled by 10000)
 */
export function fractionToBigInt(fraction: number, scale: bigint = DEFAULT_SCALE): bigint {
  if (!Number.isFinite(fraction)) {
    return 0n;
  }
  return BigInt(Math.floor(fraction * Number(scale)));
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
// Safe Division for Token Amounts
// =============================================================================

/**
 * Maximum safe integer for precise conversion (2^53 - 1).
 * Beyond this, Number loses precision.
 */
export const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Safely convert a BigInt token amount to a human-readable number by dividing
 * by the token's decimal places.
 *
 * CRITICAL: This function handles the precision loss problem when converting
 * very large BigInt values (> 2^53) to Number. Instead of converting the raw
 * BigInt first (which loses precision), it:
 * 1. Performs integer division in BigInt space
 * 2. Handles the fractional part separately
 * 3. Only converts to Number when values are safe
 *
 * @param amount - Token amount as BigInt or string
 * @param decimals - Token decimals (default: 18)
 * @returns Human-readable number, or null if conversion would be unsafe
 *
 * @example
 * // Convert 1.5 ETH (18 decimals) to number
 * safeBigIntToDecimal(1500000000000000000n, 18) // 1.5
 *
 * // Very large amount that would overflow
 * safeBigIntToDecimal(BigInt('999999999999999999999999999999999999'), 18) // null
 */
export function safeBigIntToDecimal(
  amount: bigint | string,
  decimals: number = 18
): number | null {
  try {
    // Parse if string
    const bigAmount = typeof amount === 'string' ? BigInt(amount) : amount;

    // Fast path: if the raw BigInt is within safe range, direct conversion is fine
    if (bigAmount <= MAX_SAFE_BIGINT && bigAmount >= -MAX_SAFE_BIGINT) {
      const divisor = Math.pow(10, decimals);
      return Number(bigAmount) / divisor;
    }

    // Slow path for large values: divide in BigInt space first
    const divisor = 10n ** BigInt(decimals);

    // Integer division in BigInt space (safe, no precision loss)
    const integerPart = bigAmount / divisor;
    const remainder = bigAmount % divisor;

    // Check if the integer part is safe to convert
    if (integerPart > MAX_SAFE_BIGINT || integerPart < -MAX_SAFE_BIGINT) {
      // Value is astronomically large (> 9 quadrillion tokens)
      // Return null to indicate unsafe conversion
      return null;
    }

    // Convert parts to Number (both are now in safe range).
    // Safety: remainder < divisor (modulo), and divisor = 10^decimals.
    // Real-world tokens have at most 18 decimals, so divisor <= 10^18 < 2^53.
    // Number(remainder) and Number(divisor) are therefore always precise.
    const intNum = Number(integerPart);
    const fracNum = Number(remainder) / Number(divisor);

    const result = intNum + fracNum;

    // Final safety check
    if (!Number.isFinite(result)) {
      return null;
    }

    return result;
  } catch {
    // Invalid BigInt string or other error
    return null;
  }
}

/**
 * Batch convert multiple BigInt amounts to decimals safely.
 * Returns an object with all converted values, or null if any conversion fails.
 *
 * @param amounts - Object with BigInt/string values
 * @param decimals - Token decimals for each field (or single value for all)
 * @returns Object with converted numbers, or null if any conversion fails
 *
 * @example
 * safeBigIntBatchToDecimal(
 *   { amount0In: '1000000', amount1Out: '2000000' },
 *   { amount0In: 6, amount1Out: 18 }
 * )
 */
export function safeBigIntBatchToDecimal<K extends string>(
  amounts: Record<K, bigint | string>,
  decimals: Record<K, number> | number
): Record<K, number> | null {
  const result = {} as Record<K, number>;

  for (const key of Object.keys(amounts) as K[]) {
    const dec = typeof decimals === 'number' ? decimals : decimals[key];
    const converted = safeBigIntToDecimal(amounts[key], dec);
    if (converted === null) {
      return null; // One failure means whole batch fails
    }
    result[key] = converted;
  }

  return result;
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

  if (decimals < 0 || decimals > ETH_DECIMALS) {
    throw new RangeError(
      `decimals must be between 0 and ${ETH_DECIMALS}, got: ${decimals}`
    );
  }

  // Handle negative values: format absolute value, prepend sign
  const negative = wei < 0n;
  const absWei = negative ? -wei : wei;

  const divisor = 10n ** BigInt(ETH_DECIMALS - decimals);
  const scaled = absWei / divisor;
  const intPart = scaled / (10n ** BigInt(decimals));
  const fracPart = scaled % (10n ** BigInt(decimals));

  const fracStr = fracPart.toString().padStart(decimals, '0');
  // Remove trailing zeros
  const trimmedFrac = fracStr.replace(/0+$/, '');

  const sign = negative ? '-' : '';

  if (trimmedFrac.length === 0) {
    return `${sign}${intPart.toString()}`;
  }
  return `${sign}${intPart}.${trimmedFrac}`;
}
