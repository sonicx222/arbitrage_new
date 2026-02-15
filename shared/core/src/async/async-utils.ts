/**
 * Shared Async Utilities
 *
 * REF-4/ARCH-3 FIX: Centralized async utility functions used across services.
 * Provides consistent timeout handling, retry logic, and async patterns.
 *
 * Used by:
 * - coordinator/coordinator.ts (shutdown timeouts)
 * - execution-engine/engine.ts (operation timeouts)
 * - cross-chain-detector/detector.ts (connection timeouts)
 * - unified-detector/chain-instance.ts (WebSocket disconnection timeout)
 *
 * @see ARCHITECTURE_V2.md Section 4.4 (Async Patterns)
 */

// =============================================================================
// Timeout Utilities
// =============================================================================

// P0-FIX: Import canonical TimeoutError from @arbitrage/types (single source of truth)
// Re-export for backward compatibility with existing imports from this module
import { TimeoutError } from '@arbitrage/types';
export { TimeoutError };

/**
 * Execute a promise with a timeout.
 * If the promise doesn't resolve/reject within timeoutMs, throws TimeoutError.
 *
 * @param promise The promise to execute
 * @param timeoutMs Maximum time to wait in milliseconds
 * @param operationName Optional name for error messages
 * @returns The resolved value of the promise
 * @throws TimeoutError if the operation times out
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName?: string
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError(`withTimeout: timeoutMs must be a non-negative finite number, got ${timeoutMs}`);
  }

  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      // P0-FIX: Use canonical TimeoutError constructor (operation, timeoutMs, service?)
      // Canonical class auto-generates message: "Timeout: {operation} exceeded {timeoutMs}ms"
      reject(new TimeoutError(operationName || 'operation', timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (error) {
    clearTimeout(timeoutId!);
    throw error;
  }
}

/**
 * Execute a promise with a timeout, returning a default value on timeout.
 * Does not throw on timeout, returns defaultValue instead.
 *
 * @param promise The promise to execute
 * @param timeoutMs Maximum time to wait in milliseconds
 * @param defaultValue Value to return on timeout
 * @param onTimeout Optional callback when timeout occurs
 * @returns The resolved value or defaultValue on timeout
 */
export async function withTimeoutDefault<T>(
  promise: Promise<T>,
  timeoutMs: number,
  defaultValue: T,
  onTimeout?: () => void
): Promise<T> {
  try {
    return await withTimeout(promise, timeoutMs);
  } catch (error) {
    if (error instanceof TimeoutError) {
      onTimeout?.();
      return defaultValue;
    }
    throw error;
  }
}

/**
 * Execute a function with a timeout, swallowing both errors and timeouts.
 * Useful for non-critical operations during shutdown.
 *
 * @param fn Async function to execute
 * @param timeoutMs Maximum time to wait in milliseconds
 * @param onError Optional callback for errors (including timeout)
 */
export async function withTimeoutSafe(
  fn: () => Promise<void>,
  timeoutMs: number,
  onError?: (error: Error) => void
): Promise<void> {
  try {
    await withTimeout(fn(), timeoutMs);
  } catch (error) {
    onError?.(error as Error);
    // Swallow error - operation is non-critical
  }
}

// =============================================================================
// Retry Utilities
// =============================================================================

/**
 * Configuration for retry operations.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;
  /** Base delay between retries in milliseconds */
  baseDelayMs: number;
  /** Maximum delay between retries in milliseconds */
  maxDelayMs?: number;
  /** Use exponential backoff (default: true) */
  exponential?: boolean;
  /** Jitter factor (0-1) to add randomness to delays */
  jitterFactor?: number;
  /** Function to determine if error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Callback on each retry attempt */
  onRetry?: (error: Error, attempt: number, nextDelayMs: number) => void;
}

/**
 * Default retry configuration.
 */
const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  exponential: true,
  jitterFactor: 0.1,
  isRetryable: () => true,
  onRetry: () => {}
};

/**
 * Execute an async function with retry logic.
 *
 * @param fn Async function to execute
 * @param config Retry configuration
 * @returns The resolved value of the function
 * @throws The last error if all retries fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };

  if (!Number.isFinite(cfg.maxAttempts) || cfg.maxAttempts < 1) {
    throw new TypeError(`withRetry: maxAttempts must be a finite number >= 1, got ${cfg.maxAttempts}`);
  }
  if (!Number.isFinite(cfg.baseDelayMs) || cfg.baseDelayMs < 0) {
    throw new TypeError(`withRetry: baseDelayMs must be a non-negative finite number, got ${cfg.baseDelayMs}`);
  }

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Check if we should retry
      if (attempt === cfg.maxAttempts || !cfg.isRetryable(lastError)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff and jitter
      let delay = cfg.baseDelayMs;
      if (cfg.exponential) {
        delay = Math.min(cfg.baseDelayMs * Math.pow(2, attempt - 1), cfg.maxDelayMs);
      }

      // Add jitter
      if (cfg.jitterFactor > 0) {
        const jitter = delay * cfg.jitterFactor * (Math.random() * 2 - 1);
        delay = Math.max(0, delay + jitter);
      }

      cfg.onRetry(lastError, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

// =============================================================================
// Delay Utilities
// =============================================================================

/**
 * Sleep for a specified duration.
 *
 * @param ms Duration to sleep in milliseconds
 * @returns Promise that resolves after the duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a deferred promise with external resolve/reject controls.
 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Create a deferred promise.
 *
 * @returns Deferred object with promise and resolve/reject functions
 */
export function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

// =============================================================================
// Concurrency Utilities
// =============================================================================

/**
 * P1-2 FIX: Thread-safe index generator using closure
 * Ensures each index is returned exactly once, avoiding race conditions.
 *
 * FIX 5.2: IMPORTANT - Single-Threaded Invariant
 * This function relies on JavaScript's single-threaded event loop model.
 * The check-and-increment operation is atomic because:
 * 1. JavaScript execution is single-threaded within an event loop tick
 * 2. The `currentIndex++` happens synchronously before any `await` yields control
 * 3. No other code can interleave between the check and increment
 *
 * ⚠️ DO NOT USE WITH Worker Threads sharing this state:
 * - Node.js Worker Threads have separate event loops
 * - SharedArrayBuffer access requires Atomics for thread safety
 * - This pattern would have TOCTOU races if called from multiple workers
 *
 * For multi-worker scenarios, use Atomics.add() on a SharedArrayBuffer integer.
 */
function createIndexGenerator(length: number): () => number | null {
  let currentIndex = 0;

  return (): number | null => {
    // INVARIANT: Safe only in single-threaded context (main thread or single worker)
    // The if-check and increment are in the same synchronous block with no await
    if (currentIndex >= length) {
      return null;
    }
    return currentIndex++;
  };
}

/**
 * Execute promises with concurrency limit.
 * P1-2 FIX: Uses atomic index generator to prevent race conditions.
 *
 * @param items Items to process
 * @param fn Async function to apply to each item
 * @param concurrency Maximum concurrent operations
 * @returns Array of results
 */
export async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);

  // P1-2 FIX: Use atomic index generator instead of shared mutable state
  const getNextIndex = createIndexGenerator(items.length);

  async function worker(): Promise<void> {
    // P1-2 FIX: Get index atomically before any async operation
    let index: number | null;
    while ((index = getNextIndex()) !== null) {
      // At this point, we have exclusive ownership of this index
      results[index] = await fn(items[index], index);
    }
  }

  // Create workers up to concurrency limit
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, items.length);
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

/**
 * Execute promises sequentially with optional delay between each.
 *
 * @param items Items to process
 * @param fn Async function to apply to each item
 * @param delayMs Optional delay between each operation
 * @returns Array of results
 */
export async function mapSequential<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  delayMs: number = 0
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i++) {
    if (i > 0 && delayMs > 0) {
      await sleep(delayMs);
    }
    results.push(await fn(items[i], i));
  }

  return results;
}

// =============================================================================
// Debounce & Throttle Utilities
// =============================================================================

/**
 * Create a debounced version of an async function.
 * Only executes after no calls for the specified delay.
 *
 * @param fn Function to debounce
 * @param delayMs Debounce delay in milliseconds
 * @returns Debounced function
 */
export function debounceAsync<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  delayMs: number
): (...args: Parameters<T>) => Promise<ReturnType<T> | undefined> {
  let timeoutId: NodeJS.Timeout | null = null;
  let pendingPromise: Promise<ReturnType<T>> | null = null;
  // P0-FIX: Track the resolve of the previous caller so we can settle it when debounced
  let previousResolve: ((value: ReturnType<T> | undefined) => void) | null = null;

  return async (...args: Parameters<T>): Promise<ReturnType<T> | undefined> => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      // P0-FIX (Bug B): Settle the previously returned promise with undefined
      // so it doesn't hang forever when the call is debounced (timer cleared)
      if (previousResolve) {
        previousResolve(undefined);
        previousResolve = null;
      }
    }

    return new Promise<ReturnType<T> | undefined>((resolve, reject) => {
      previousResolve = resolve;
      timeoutId = setTimeout(async () => {
        timeoutId = null;
        previousResolve = null;
        try {
          pendingPromise = fn(...args);
          const result = await pendingPromise;
          pendingPromise = null;
          resolve(result);
        } catch (error) {
          // P0-FIX (Bug A): Propagate errors to the caller instead of
          // creating unhandled rejections and leaving the promise hanging
          pendingPromise = null;
          reject(error);
        }
      }, delayMs);
    });
  };
}

/**
 * Create a throttled version of an async function.
 * Executes at most once per interval.
 *
 * @param fn Function to throttle
 * @param intervalMs Minimum interval between executions
 * @returns Throttled function
 */
export function throttleAsync<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  intervalMs: number
): (...args: Parameters<T>) => Promise<ReturnType<T> | undefined> {
  let lastCallTime = 0;
  let pendingPromise: Promise<ReturnType<T>> | null = null;

  return async (...args: Parameters<T>): Promise<ReturnType<T> | undefined> => {
    const now = Date.now();

    if (pendingPromise) {
      return pendingPromise;
    }

    if (now - lastCallTime >= intervalMs) {
      lastCallTime = now;
      pendingPromise = fn(...args);
      try {
        return await pendingPromise;
      } finally {
        pendingPromise = null;
      }
    }

    return undefined;
  };
}

// =============================================================================
// Shutdown Utilities
// =============================================================================

/**
 * Gracefully shutdown multiple resources with timeout.
 *
 * @param resources Array of cleanup functions
 * @param timeoutMs Maximum time for each cleanup
 * @param logger Optional logger for errors
 */
export async function gracefulShutdown(
  resources: Array<{ name: string; cleanup: () => Promise<void> }>,
  timeoutMs: number,
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void }
): Promise<void> {
  for (const resource of resources) {
    try {
      await withTimeout(resource.cleanup(), timeoutMs, `${resource.name} cleanup`);
    } catch (error) {
      if (error instanceof TimeoutError) {
        logger?.warn(`${resource.name} cleanup timed out`, { timeoutMs });
      } else {
        logger?.warn(`${resource.name} cleanup failed`, {
          error: (error as Error).message
        });
      }
      // Continue with other cleanups
    }
  }
}

/**
 * Wait for multiple promises with individual timeouts.
 * Returns results for promises that complete in time.
 *
 * @param promises Array of promises with names
 * @param timeoutMs Timeout for each promise
 * @returns Object mapping names to results or errors
 */
export async function waitWithTimeouts<T>(
  promises: Array<{ name: string; promise: Promise<T> }>,
  timeoutMs: number
): Promise<Map<string, { success: boolean; result?: T; error?: Error }>> {
  const results = new Map<string, { success: boolean; result?: T; error?: Error }>();

  await Promise.all(
    promises.map(async ({ name, promise }) => {
      try {
        const result = await withTimeout(promise, timeoutMs, name);
        results.set(name, { success: true, result });
      } catch (error) {
        results.set(name, { success: false, error: error as Error });
      }
    })
  );

  return results;
}
