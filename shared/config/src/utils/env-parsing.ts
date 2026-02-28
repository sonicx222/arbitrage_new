/**
 * Shared Environment Variable Parsing Utilities
 *
 * Value-based parsing functions that accept a raw string value and return
 * a parsed number or a safe default. Unlike the name-based `parseEnvInt`
 * in `@arbitrage/core` (which reads process.env internally), these functions
 * work with pre-read values, making them composable with `??` and `||`.
 *
 * Conventions:
 * - Returns `defaultValue` for `undefined`, empty string, or NaN results
 * - Does NOT throw -- always returns a valid number
 * - Use `??` (not `||`) when the caller needs to preserve `0` as valid
 *
 * @see @arbitrage/core env-utils.ts for strict (throwing) variants
 */

/**
 * Parse a string value as an integer, returning `defaultValue` if
 * the value is undefined, empty, or not a valid integer.
 *
 * @param value - Raw string to parse (typically from process.env)
 * @param defaultValue - Fallback when value is missing or invalid
 * @returns Parsed integer or defaultValue
 *
 * @example
 * ```typescript
 * const port = safeParseInt(process.env.PORT, 3000);
 * const ttl = safeParseInt(process.env.TTL_MS, 60000);
 * ```
 */
export function safeParseInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse a string value as a float, returning `defaultValue` if
 * the value is undefined, empty, or not a valid number.
 *
 * @param value - Raw string to parse (typically from process.env)
 * @param defaultValue - Fallback when value is missing or invalid
 * @returns Parsed float or defaultValue
 *
 * @example
 * ```typescript
 * const rate = safeParseFloat(process.env.SUCCESS_RATE, 0.85);
 * const fee = safeParseFloat(process.env.FEE_MULTIPLIER, 0.1);
 * ```
 */
export function safeParseFloat(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse a string value as a float with bounds validation.
 * Returns `defaultValue` if the value is missing, invalid, or out of range.
 *
 * @param value - Raw string to parse (typically from process.env)
 * @param defaultValue - Fallback when value is missing, invalid, or out of range
 * @param min - Minimum allowed value (inclusive)
 * @param max - Maximum allowed value (inclusive)
 * @param label - Optional label for warning messages (e.g., env var name)
 * @returns Validated float or defaultValue
 */
export function safeParseFloatBounded(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  label?: string
): number {
  if (!value) return defaultValue;
  const parsed = parseFloat(value);
  if (Number.isNaN(parsed)) {
    if (label) console.warn(`[CONFIG] Invalid float value for ${label}: "${value}" - using default`);
    return defaultValue;
  }
  if (parsed < min || parsed > max) {
    if (label) console.warn(`[CONFIG] Value for ${label} (${parsed}) out of range [${min}, ${max}] - using default`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse a string value as an integer with minimum bound validation.
 * Returns `defaultValue` if missing or invalid, `min` if below minimum.
 *
 * @param value - Raw string to parse (typically from process.env)
 * @param defaultValue - Fallback when value is missing or invalid
 * @param min - Minimum allowed value (inclusive, defaults to 1)
 * @param label - Optional label for warning messages
 * @returns Validated integer or defaultValue
 */
export function safeParseIntBounded(
  value: string | undefined,
  defaultValue: number,
  min = 1,
  label?: string
): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    if (label) console.warn(`[CONFIG] Invalid integer value for ${label}: "${value}" - using default`);
    return defaultValue;
  }
  if (parsed < min) {
    if (label) console.warn(`[CONFIG] Value for ${label} (${parsed}) below minimum ${min} - using minimum`);
    return min;
  }
  return parsed;
}

/**
 * Parse a string value as a BigInt with validation.
 * Returns `BigInt(defaultValue)` if missing or invalid.
 *
 * @param value - Raw string to parse (typically from process.env)
 * @param defaultValue - Default value as string
 * @param label - Optional label for warning messages
 * @returns Parsed BigInt
 */
export function safeParseBigInt(
  value: string | undefined,
  defaultValue: string,
  label?: string
): bigint {
  if (!value) return BigInt(defaultValue);
  try {
    if (!/^-?\d+$/.test(value.trim())) {
      if (label) console.warn(`[CONFIG] Invalid BigInt value for ${label}: "${value}" - using default`);
      return BigInt(defaultValue);
    }
    return BigInt(value.trim());
  } catch {
    if (label) console.warn(`[CONFIG] Failed to parse BigInt for ${label}: "${value}" - using default`);
    return BigInt(defaultValue);
  }
}
