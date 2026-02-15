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
