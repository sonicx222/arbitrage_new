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
/**
 * Timeout error thrown when an operation exceeds the allowed time.
 */
export declare class TimeoutError extends Error {
    readonly timeoutMs: number;
    readonly operation?: string | undefined;
    constructor(message: string, timeoutMs: number, operation?: string | undefined);
}
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
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName?: string): Promise<T>;
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
export declare function withTimeoutDefault<T>(promise: Promise<T>, timeoutMs: number, defaultValue: T, onTimeout?: () => void): Promise<T>;
/**
 * Execute a function with a timeout, swallowing both errors and timeouts.
 * Useful for non-critical operations during shutdown.
 *
 * @param fn Async function to execute
 * @param timeoutMs Maximum time to wait in milliseconds
 * @param onError Optional callback for errors (including timeout)
 */
export declare function withTimeoutSafe(fn: () => Promise<void>, timeoutMs: number, onError?: (error: Error) => void): Promise<void>;
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
 * Execute an async function with retry logic.
 *
 * @param fn Async function to execute
 * @param config Retry configuration
 * @returns The resolved value of the function
 * @throws The last error if all retries fail
 */
export declare function withRetry<T>(fn: () => Promise<T>, config?: Partial<RetryConfig>): Promise<T>;
/**
 * Sleep for a specified duration.
 *
 * @param ms Duration to sleep in milliseconds
 * @returns Promise that resolves after the duration
 */
export declare function sleep(ms: number): Promise<void>;
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
export declare function createDeferred<T = void>(): Deferred<T>;
/**
 * Execute promises with concurrency limit.
 *
 * @param items Items to process
 * @param fn Async function to apply to each item
 * @param concurrency Maximum concurrent operations
 * @returns Array of results
 */
export declare function mapConcurrent<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, concurrency: number): Promise<R[]>;
/**
 * Execute promises sequentially with optional delay between each.
 *
 * @param items Items to process
 * @param fn Async function to apply to each item
 * @param delayMs Optional delay between each operation
 * @returns Array of results
 */
export declare function mapSequential<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, delayMs?: number): Promise<R[]>;
/**
 * Create a debounced version of an async function.
 * Only executes after no calls for the specified delay.
 *
 * @param fn Function to debounce
 * @param delayMs Debounce delay in milliseconds
 * @returns Debounced function
 */
export declare function debounceAsync<T extends (...args: any[]) => Promise<any>>(fn: T, delayMs: number): (...args: Parameters<T>) => Promise<ReturnType<T> | undefined>;
/**
 * Create a throttled version of an async function.
 * Executes at most once per interval.
 *
 * @param fn Function to throttle
 * @param intervalMs Minimum interval between executions
 * @returns Throttled function
 */
export declare function throttleAsync<T extends (...args: any[]) => Promise<any>>(fn: T, intervalMs: number): (...args: Parameters<T>) => Promise<ReturnType<T> | undefined>;
/**
 * Gracefully shutdown multiple resources with timeout.
 *
 * @param resources Array of cleanup functions
 * @param timeoutMs Maximum time for each cleanup
 * @param logger Optional logger for errors
 */
export declare function gracefulShutdown(resources: Array<{
    name: string;
    cleanup: () => Promise<void>;
}>, timeoutMs: number, logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
}): Promise<void>;
/**
 * Wait for multiple promises with individual timeouts.
 * Returns results for promises that complete in time.
 *
 * @param promises Array of promises with names
 * @param timeoutMs Timeout for each promise
 * @returns Object mapping names to results or errors
 */
export declare function waitWithTimeouts<T>(promises: Array<{
    name: string;
    promise: Promise<T>;
}>, timeoutMs: number): Promise<Map<string, {
    success: boolean;
    result?: T;
    error?: Error;
}>>;
//# sourceMappingURL=async-utils.d.ts.map