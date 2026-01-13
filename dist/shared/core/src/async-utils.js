"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimeoutError = void 0;
exports.withTimeout = withTimeout;
exports.withTimeoutDefault = withTimeoutDefault;
exports.withTimeoutSafe = withTimeoutSafe;
exports.withRetry = withRetry;
exports.sleep = sleep;
exports.createDeferred = createDeferred;
exports.mapConcurrent = mapConcurrent;
exports.mapSequential = mapSequential;
exports.debounceAsync = debounceAsync;
exports.throttleAsync = throttleAsync;
exports.gracefulShutdown = gracefulShutdown;
exports.waitWithTimeouts = waitWithTimeouts;
// =============================================================================
// Timeout Utilities
// =============================================================================
/**
 * Timeout error thrown when an operation exceeds the allowed time.
 */
class TimeoutError extends Error {
    constructor(message, timeoutMs, operation) {
        super(message);
        this.timeoutMs = timeoutMs;
        this.operation = operation;
        this.name = 'TimeoutError';
    }
}
exports.TimeoutError = TimeoutError;
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
async function withTimeout(promise, timeoutMs, operationName) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const msg = operationName
                ? `Operation '${operationName}' timed out after ${timeoutMs}ms`
                : `Operation timed out after ${timeoutMs}ms`;
            reject(new TimeoutError(msg, timeoutMs, operationName));
        }, timeoutMs);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId);
        return result;
    }
    catch (error) {
        clearTimeout(timeoutId);
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
async function withTimeoutDefault(promise, timeoutMs, defaultValue, onTimeout) {
    try {
        return await withTimeout(promise, timeoutMs);
    }
    catch (error) {
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
async function withTimeoutSafe(fn, timeoutMs, onError) {
    try {
        await withTimeout(fn(), timeoutMs);
    }
    catch (error) {
        onError?.(error);
        // Swallow error - operation is non-critical
    }
}
/**
 * Default retry configuration.
 */
const DEFAULT_RETRY_CONFIG = {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    exponential: true,
    jitterFactor: 0.1,
    isRetryable: () => true,
    onRetry: () => { }
};
/**
 * Execute an async function with retry logic.
 *
 * @param fn Async function to execute
 * @param config Retry configuration
 * @returns The resolved value of the function
 * @throws The last error if all retries fail
 */
async function withRetry(fn, config = {}) {
    const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
    let lastError;
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
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
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Create a deferred promise.
 *
 * @returns Deferred object with promise and resolve/reject functions
 */
function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
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
 */
function createIndexGenerator(length) {
    let currentIndex = 0;
    return () => {
        // This is safe because JS is single-threaded in the event loop
        // The check and increment happen in the same synchronous block
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
async function mapConcurrent(items, fn, concurrency) {
    const results = new Array(items.length);
    // P1-2 FIX: Use atomic index generator instead of shared mutable state
    const getNextIndex = createIndexGenerator(items.length);
    async function worker() {
        // P1-2 FIX: Get index atomically before any async operation
        let index;
        while ((index = getNextIndex()) !== null) {
            // At this point, we have exclusive ownership of this index
            results[index] = await fn(items[index], index);
        }
    }
    // Create workers up to concurrency limit
    const workers = [];
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
async function mapSequential(items, fn, delayMs = 0) {
    const results = [];
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
function debounceAsync(fn, delayMs) {
    let timeoutId = null;
    let pendingPromise = null;
    return async (...args) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        return new Promise((resolve) => {
            timeoutId = setTimeout(async () => {
                timeoutId = null;
                pendingPromise = fn(...args);
                const result = await pendingPromise;
                pendingPromise = null;
                resolve(result);
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
function throttleAsync(fn, intervalMs) {
    let lastCallTime = 0;
    let pendingPromise = null;
    return async (...args) => {
        const now = Date.now();
        if (pendingPromise) {
            return pendingPromise;
        }
        if (now - lastCallTime >= intervalMs) {
            lastCallTime = now;
            pendingPromise = fn(...args);
            try {
                return await pendingPromise;
            }
            finally {
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
async function gracefulShutdown(resources, timeoutMs, logger) {
    for (const resource of resources) {
        try {
            await withTimeout(resource.cleanup(), timeoutMs, `${resource.name} cleanup`);
        }
        catch (error) {
            if (error instanceof TimeoutError) {
                logger?.warn(`${resource.name} cleanup timed out`, { timeoutMs });
            }
            else {
                logger?.warn(`${resource.name} cleanup failed`, {
                    error: error.message
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
async function waitWithTimeouts(promises, timeoutMs) {
    const results = new Map();
    await Promise.all(promises.map(async ({ name, promise }) => {
        try {
            const result = await withTimeout(promise, timeoutMs, name);
            results.set(name, { success: true, result });
        }
        catch (error) {
            results.set(name, { success: false, error: error });
        }
    }));
    return results;
}
//# sourceMappingURL=async-utils.js.map