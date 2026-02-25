/**
 * Shared Types for Unified Detector Modules
 *
 * ARCH-REFACTOR: Extracted shared types to reduce duplication
 * across modular components.
 */

// P0-FIX: Import canonical TimeoutError from @arbitrage/types (single source of truth)
import { TimeoutError, Pair } from '@arbitrage/types';
import type { ILogger } from '@arbitrage/types';

// FIX 6: Use shared price bounds constants from canonical source
import { MIN_SAFE_PRICE, MAX_SAFE_PRICE } from '@arbitrage/core/utils';

// =============================================================================
// Logger Interface
// =============================================================================

/**
 * Logger interface for dependency injection.
 * Now re-exported from @arbitrage/types for consolidation (Task A1).
 * ILogger uses Record<string, unknown> meta — compatible with object meta.
 */
export type Logger = ILogger;

// =============================================================================
// Chain Stats Interface
// =============================================================================

/**
 * Statistics for a single chain instance.
 *
 * FIX: Moved from unified-detector.ts to break circular dependency:
 * - chain-instance.ts imported ChainStats from unified-detector.ts
 * - unified-detector.ts imported ChainDetectorInstance from chain-instance.ts
 *
 * Now both can import ChainStats from types.ts without circular dependency.
 */
export interface ChainStats {
  /** Chain identifier (e.g., 'ethereum', 'bsc') */
  chainId: string;

  /** Current connection status */
  status: 'connected' | 'connecting' | 'disconnected' | 'error';

  /** Total events processed since startup */
  eventsProcessed: number;

  /** Total arbitrage opportunities found */
  opportunitiesFound: number;

  /** Last processed block number */
  lastBlockNumber: number;

  /** Average block latency in milliseconds */
  avgBlockLatencyMs: number;

  /** Number of pairs being monitored */
  pairsMonitored: number;

  /** Number of hot pairs (high activity) for volatility-based prioritization */
  hotPairsCount?: number;
}

// =============================================================================
// Extended Pair Interface (moved from chain-instance.ts for shared use)
// =============================================================================

/**
 * Extended pair interface with reserve data and hot-path cache fields.
 * Used by chain-instance.ts for pair tracking and by pair-initializer.ts for creation.
 *
 * Note: The detection module has its own ExtendedPair (in snapshot-manager.ts)
 * which is a simplified version for snapshot use. Chain-instance imports it
 * as `DetectionExtendedPair` to avoid conflicts.
 */
export interface ExtendedPair extends Pair {
  reserve0: string;
  reserve1: string;
  blockNumber: number;
  lastUpdate: number;
  // HOT-PATH OPT: Cache pairKey to avoid per-event string allocation in emitPriceUpdate()
  // Format: "${dex}_${token0Symbol}_${token1Symbol}"
  pairKey?: string;
  // FIX Perf 10.2: Cache chain:address key to avoid string allocation in activity tracking
  // Format: "${chainId}:${pairAddress}" - used by activityTracker.recordUpdate()
  chainPairKey?: string;
  // FIX Perf 10.2: Cache BigInt reserves to avoid re-parsing in emitPriceUpdate()
  // Updated atomically with string reserves in handleSyncEvent()
  // At 100-1000 Sync events/sec, this eliminates ~2000 BigInt parses/sec
  reserve0BigInt?: bigint;
  reserve1BigInt?: bigint;
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

// P0-FIX: TimeoutError now imported from @arbitrage/types (canonical source)
// Re-export for backward compatibility with code importing from this module
export { TimeoutError };

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
      // P0-FIX: Use canonical TimeoutError constructor (operation, timeoutMs, service?)
      // Canonical class auto-generates message: "Timeout: {operation} exceeded {timeoutMs}ms"
      reject(new TimeoutError(operationName, timeoutMs));
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

/**
 * Validate a price value for safe arithmetic operations.
 * FIX 4.1: Guards against values that would cause division by zero or overflow.
 *
 * FIX 2.1: Aligned thresholds with SimpleArbitrageDetector defaults (1e-18 to 1e18)
 * to support memecoin prices while maintaining safety for 1/price inversions.
 *
 * At 1e-18, inverting gives 1e18 which is still safe for Number (MAX_SAFE_INTEGER is ~9e15,
 * but JavaScript Numbers can represent up to ~1.8e308 with precision loss).
 *
 * @param price - Price value to validate
 * @returns true if price is safe for calculations
 * @see SimpleArbitrageDetector for consistent threshold usage
 */
export function isValidPrice(price: number): boolean {
  // Must be a finite positive number
  if (!Number.isFinite(price) || price <= 0) {
    return false;
  }
  // FIX 6: Use shared price bounds from @arbitrage/core
  // These are symmetric: MIN_SAFE_PRICE = 1e-18, MAX_SAFE_PRICE = 1e18
  // At 1e-18: supports low-value memecoins, 1/price = 1e18 is safe
  // At 1e18: prevents precision loss in floating-point
  if (price < MIN_SAFE_PRICE || price > MAX_SAFE_PRICE) {
    return false;
  }
  return true;
}

