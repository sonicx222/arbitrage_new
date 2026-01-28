/**
 * Shared Types for Unified Detector Modules
 *
 * ARCH-REFACTOR: Extracted shared types to reduce duplication
 * across modular components.
 */

// =============================================================================
// Logger Interface
// =============================================================================

/**
 * Logger interface for dependency injection.
 * Compatible with winston, pino, and @arbitrage/core createLogger.
 */
export interface Logger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * FIX Inconsistency 6.3: Helper function to cast RecordingLogger to Logger.
 * Use this in tests for consistent type casting across all test files.
 *
 * @example
 * import { asLogger } from '../../types';
 * const logger = asLogger(new RecordingLogger());
 */
export function asLogger<T extends Logger>(logger: T): Logger {
  return logger as Logger;
}

// =============================================================================
// Fee Types
// =============================================================================

/**
 * FIX Inconsistency 6.4: Fee representation types.
 * Use these branded types to make fee representation explicit.
 *
 * @example
 * const fee: FeeBasisPoints = 30 as FeeBasisPoints; // 0.30%
 * const feeDecimal: FeeDecimal = 0.003 as FeeDecimal; // 0.30%
 */

/** Fee in basis points (30 = 0.30%). Range: 0-10000 */
export type FeeBasisPoints = number & { readonly __brand: 'FeeBasisPoints' };

/** Fee as decimal (0.003 = 0.30%). Range: 0-1 */
export type FeeDecimal = number & { readonly __brand: 'FeeDecimal' };

/**
 * Convert basis points to decimal fee.
 * @param basisPoints - Fee in basis points (e.g., 30 = 0.30%)
 * @returns Fee as decimal (e.g., 0.003)
 */
export function basisPointsToDecimal(basisPoints: number): FeeDecimal {
  return (basisPoints / 10000) as FeeDecimal;
}

/**
 * Convert decimal fee to basis points.
 * @param decimal - Fee as decimal (e.g., 0.003 = 0.30%)
 * @returns Fee in basis points (e.g., 30)
 */
export function decimalToBasisPoints(decimal: number): FeeBasisPoints {
  return Math.round(decimal * 10000) as FeeBasisPoints;
}

// =============================================================================
// Environment Variable Utilities
// =============================================================================

/**
 * Parse and validate an integer environment variable within bounds.
 *
 * FIX Config 3.1: Validates simulation config to prevent unsafe values.
 *
 * @param value - Raw environment variable value (or undefined)
 * @param defaultValue - Default value if env var is not set
 * @param min - Minimum allowed value (inclusive)
 * @param max - Maximum allowed value (inclusive)
 * @returns Validated integer value
 */
export function parseIntEnvVar(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    return defaultValue;
  }

  return Math.max(min, Math.min(max, parsed));
}

/**
 * Parse and validate a float environment variable within bounds.
 *
 * FIX Config 3.1: Validates simulation config to prevent unsafe values.
 *
 * @param value - Raw environment variable value (or undefined)
 * @param defaultValue - Default value if env var is not set
 * @param min - Minimum allowed value (inclusive)
 * @param max - Maximum allowed value (inclusive)
 * @returns Validated float value
 */
export function parseFloatEnvVar(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const parsed = parseFloat(value);

  if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
    return defaultValue;
  }

  return Math.max(min, Math.min(max, parsed));
}

// =============================================================================
// WebSocket URL Utilities
// =============================================================================

/**
 * Result of WebSocket URL conversion.
 */
export interface WebSocketUrlResult {
  /** The converted WebSocket URL */
  url: string;
  /** Whether a conversion was performed */
  converted: boolean;
  /** Original URL before conversion (if converted) */
  originalUrl?: string;
}

/**
 * Convert an HTTP/HTTPS URL to WebSocket URL, or validate existing WS URL.
 *
 * FIX Refactor 9.1: Extracted from chain-instance.ts for reusability.
 *
 * @param url - The URL to convert or validate
 * @returns WebSocketUrlResult with the converted/validated URL
 * @throws Error if URL cannot be converted to WebSocket
 */
export function toWebSocketUrl(url: string): WebSocketUrlResult {
  if (!url) {
    throw new Error('URL is required for WebSocket conversion');
  }

  // Already a WebSocket URL
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return { url, converted: false };
  }

  // Convert HTTP to WS
  if (url.startsWith('http://')) {
    return {
      url: url.replace('http://', 'ws://'),
      converted: true,
      originalUrl: url,
    };
  }

  // Convert HTTPS to WSS
  if (url.startsWith('https://')) {
    return {
      url: url.replace('https://', 'wss://'),
      converted: true,
      originalUrl: url,
    };
  }

  throw new Error(`Cannot convert URL to WebSocket: ${url}. URL must start with http://, https://, ws://, or wss://`);
}

/**
 * Check if a chain is known to have unstable WebSocket connections.
 *
 * FIX Config 3.2: Uses centralized UNSTABLE_WEBSOCKET_CHAINS constant.
 *
 * @param chainId - Chain identifier to check
 * @param unstableChains - List of unstable chain IDs
 * @returns true if the chain is considered unstable
 */
export function isUnstableChain(
  chainId: string,
  unstableChains: readonly string[]
): boolean {
  return unstableChains.includes(chainId.toLowerCase());
}

// =============================================================================
// Async Utilities (FIX 9.1: Timeout-Race Pattern)
// =============================================================================

/**
 * Timeout error for withTimeout utility.
 */
export class TimeoutError extends Error {
  constructor(message: string, public readonly timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Execute a promise with a timeout.
 * FIX 9.1: Centralized timeout-race pattern to avoid code duplication
 * and ensure proper timer cleanup (prevents memory leaks).
 *
 * @param operation - Promise to execute
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @param operationName - Name for error messages (optional)
 * @returns Result of the operation
 * @throws TimeoutError if operation exceeds timeout
 *
 * @example
 * // Basic usage
 * const result = await withTimeout(fetchData(), 5000, 'fetchData');
 *
 * // With cleanup on timeout
 * try {
 *   await withTimeout(wsManager.disconnect(), 5000, 'WebSocket disconnect');
 * } catch (e) {
 *   if (e instanceof TimeoutError) {
 *     logger.warn('Operation timed out', { operation: e.message });
 *   }
 * }
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  operationName: string = 'operation'
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new TimeoutError(`${operationName} timed out after ${timeoutMs}ms`, timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([operation, timeoutPromise]);
    return result;
  } finally {
    // CRITICAL: Always clear timeout to prevent memory leak
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Execute a promise with timeout, returning a result object instead of throwing.
 * Useful when timeout is a valid outcome rather than an error.
 *
 * @param operation - Promise to execute
 * @param timeoutMs - Maximum time to wait in milliseconds
 * @returns Object with success/timeout status and result/error
 */
export async function withTimeoutResult<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<{ success: true; result: T } | { success: false; timedOut: boolean; error?: Error }> {
  try {
    const result = await withTimeout(operation, timeoutMs);
    return { success: true, result };
  } catch (error) {
    if (error instanceof TimeoutError) {
      return { success: false, timedOut: true };
    }
    return { success: false, timedOut: false, error: error as Error };
  }
}

// =============================================================================
// Fee Validation Utilities (FIX 9.3: Centralized Fee Handling)
// =============================================================================

/**
 * Validate and sanitize a fee value for safe calculations.
 * FIX 9.3: Centralized fee validation to prevent NaN/Infinity in arbitrage calculations.
 *
 * Guards against:
 * - undefined/null values
 * - NaN (from invalid conversions)
 * - Infinity (from division errors)
 * - Negative values (invalid fees)
 * - Fees > 100% (clearly incorrect)
 *
 * @param fee - Fee value to validate (as decimal, e.g., 0.003 = 0.3%)
 * @param defaultFee - Default value if invalid (default: 0.003 = 0.3%)
 * @returns Valid fee value
 */
export function validateFee(fee: number | undefined | null, defaultFee: number = 0.003): number {
  if (fee === undefined || fee === null) {
    return defaultFee;
  }
  if (!Number.isFinite(fee) || fee < 0 || fee > 1) {
    return defaultFee;
  }
  return fee;
}

/**
 * Validate a price value for safe arithmetic operations.
 * FIX 4.1: Guards against values that would cause division by zero or overflow.
 *
 * @param price - Price value to validate
 * @returns true if price is safe for calculations
 */
export function isValidPrice(price: number): boolean {
  // Must be a finite positive number
  if (!Number.isFinite(price) || price <= 0) {
    return false;
  }
  // Must not be too small (would cause overflow when inverted)
  // 1e-15 is the threshold - inverting gives 1e15 which is still safe
  if (price < 1e-15) {
    return false;
  }
  // Must not be too large (would cause precision loss)
  if (price > 1e15) {
    return false;
  }
  return true;
}

// =============================================================================
// Data Structure Utilities (FIX 10.5: Consolidated to @arbitrage/core)
// =============================================================================

/**
 * Re-export MinHeap and related utilities from @arbitrage/core.
 * FIX 10.5: Consolidated to avoid code duplication across services.
 *
 * @see shared/core/src/data-structures/min-heap.ts for implementation
 */
export { MinHeap, findKSmallest, findKLargest } from '@arbitrage/core';
