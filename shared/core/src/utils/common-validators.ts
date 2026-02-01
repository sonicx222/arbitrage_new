/**
 * Common Validators
 *
 * Lightweight, pure-function validators for common validation patterns.
 * These are designed for hot-path usage where Joi/Zod overhead is unacceptable.
 *
 * Design principles:
 * - No external dependencies
 * - Pure functions (no side effects)
 * - Type guards where applicable
 * - Consistent error messages
 *
 * @see validation.ts for Joi-based validation middleware
 * @see shared/config/src/schemas/ for Zod schemas
 */

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard for non-null values.
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Type guard for non-empty strings.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Type guard for positive numbers (> 0).
 */
export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value) && value > 0;
}

/**
 * Type guard for non-negative numbers (>= 0).
 */
export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value) && value >= 0;
}

/**
 * Type guard for finite numbers (not NaN, not Infinity).
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

/**
 * Type guard for integers.
 */
export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Type guard for positive integers (> 0).
 */
export function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

// =============================================================================
// Validation Functions (throw on failure)
// =============================================================================

/**
 * Validate that a value is a non-empty string.
 * @throws Error if validation fails
 */
export function validateNonEmptyString(value: unknown, name: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${name} must be a non-empty string, got: ${typeof value}`);
  }
  return value;
}

/**
 * Validate that a value is a positive number.
 * @throws Error if validation fails
 */
export function validatePositiveNumber(value: unknown, name: string): number {
  if (!isPositiveNumber(value)) {
    throw new Error(`${name} must be a positive number, got: ${value}`);
  }
  return value;
}

/**
 * Validate that a value is a non-negative number.
 * @throws Error if validation fails
 */
export function validateNonNegativeNumber(value: unknown, name: string): number {
  if (!isNonNegativeNumber(value)) {
    throw new Error(`${name} must be a non-negative number, got: ${value}`);
  }
  return value;
}

/**
 * Validate that a value is a positive integer.
 * @throws Error if validation fails
 */
export function validatePositiveInteger(value: unknown, name: string): number {
  if (!isPositiveInteger(value)) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return value;
}

/**
 * Validate that a value is within a range [min, max].
 * @throws Error if validation fails
 */
export function validateInRange(value: number, min: number, max: number, name: string): number {
  if (!isFiniteNumber(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got: ${value}`);
  }
  return value;
}

// =============================================================================
// Safe Validation Functions (return null on failure)
// =============================================================================

/**
 * Parse a string to number safely, returning null on failure.
 * Useful for parsing environment variables.
 */
export function parseNumberSafe(value: string | undefined, defaultValue?: number): number | null {
  if (value === undefined || value === '') {
    return defaultValue ?? null;
  }
  const num = Number(value);
  return isFiniteNumber(num) ? num : (defaultValue ?? null);
}

/**
 * Parse a string to integer safely, returning null on failure.
 */
export function parseIntegerSafe(value: string | undefined, defaultValue?: number): number | null {
  if (value === undefined || value === '') {
    return defaultValue ?? null;
  }
  const num = parseInt(value, 10);
  return isInteger(num) ? num : (defaultValue ?? null);
}

/**
 * Parse a string to boolean safely.
 * Returns true for 'true', '1', 'yes'; false for 'false', '0', 'no'; null otherwise.
 */
export function parseBooleanSafe(value: string | undefined, defaultValue?: boolean): boolean | null {
  if (value === undefined || value === '') {
    return defaultValue ?? null;
  }
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return defaultValue ?? null;
}

// =============================================================================
// Array/Object Validators
// =============================================================================

/**
 * Type guard for non-empty arrays.
 */
export function isNonEmptyArray<T>(value: unknown): value is T[] {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Type guard for plain objects (not null, not array).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check if an object has a specific key.
 */
export function hasKey<K extends string>(obj: unknown, key: K): obj is Record<K, unknown> {
  return isPlainObject(obj) && key in obj;
}

// =============================================================================
// Address Validators (lightweight versions)
// =============================================================================

/**
 * Quick check if string looks like an Ethereum address.
 * For full validation, use isValidEthereumAddress from @arbitrage/config.
 */
export function looksLikeEthereumAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

/**
 * Quick check if string looks like a Solana address (base58, 32-44 chars).
 */
export function looksLikeSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

// =============================================================================
// Assertion Helpers
// =============================================================================

/**
 * Assert a condition is true, throwing with the given message if not.
 * Useful for fail-fast validation in constructors.
 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Assert a value is not null/undefined, returning the narrowed type.
 */
export function assertDefined<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${name} must be defined, got: ${value}`);
  }
  return value;
}
