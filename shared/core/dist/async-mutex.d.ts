/**
 * P2-2 FIX: Reusable AsyncMutex Utility
 *
 * Provides thread-safe mutual exclusion for async operations in JavaScript.
 * Prevents race conditions when multiple async operations need exclusive access
 * to a shared resource.
 *
 * Use cases in this codebase:
 * - Connection establishment (websocket-manager.ts connectMutex)
 * - Batch flushing (redis-streams.ts flushLock)
 * - Singleton initialization (async-singleton.ts)
 * - Lock acquisition (distributed-lock.ts)
 *
 * @example
 * ```ts
 * const mutex = new AsyncMutex();
 *
 * // Basic usage
 * await mutex.runExclusive(async () => {
 *   // Only one caller can be here at a time
 *   await doSomethingExclusive();
 * });
 *
 * // Manual acquire/release
 * const release = await mutex.acquire();
 * try {
 *   await doSomething();
 * } finally {
 *   release();
 * }
 * ```
 */
export interface MutexStats {
    /** Number of times the mutex was acquired */
    acquireCount: number;
    /** Number of times callers had to wait (contention) */
    contentionCount: number;
    /** Total time spent waiting in milliseconds */
    totalWaitTimeMs: number;
    /** Whether the mutex is currently held */
    isLocked: boolean;
    /** Number of callers currently waiting */
    waitingCount: number;
}
/**
 * Async mutex for mutual exclusion in async operations.
 */
export declare class AsyncMutex {
    private locked;
    private waitQueue;
    private stats;
    /**
     * Acquire the mutex.
     * If the mutex is already held, this will wait until it's released.
     *
     * @returns A release function that MUST be called when done
     */
    acquire(): Promise<() => void>;
    /**
     * Try to acquire the mutex without waiting.
     *
     * @returns Release function if acquired, null if mutex is already held
     */
    tryAcquire(): (() => void) | null;
    /**
     * Run an async function with exclusive access.
     * The mutex is automatically released when the function completes (success or error).
     *
     * @param fn The async function to run exclusively
     * @returns The return value of fn
     */
    runExclusive<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * Run an async function with exclusive access, but return null if the mutex is busy.
     *
     * @param fn The async function to run exclusively
     * @returns The return value of fn, or null if mutex was busy
     */
    tryRunExclusive<T>(fn: () => Promise<T>): Promise<T | null>;
    /**
     * Check if the mutex is currently locked.
     */
    isLocked(): boolean;
    /**
     * Get mutex statistics.
     */
    getStats(): MutexStats;
    /**
     * Reset statistics.
     */
    resetStats(): void;
}
export declare function namedMutex(name: string): AsyncMutex;
/**
 * Clear a named mutex (useful for testing).
 */
export declare function clearNamedMutex(name: string): void;
/**
 * Clear all named mutexes (useful for testing).
 */
export declare function clearAllNamedMutexes(): void;
//# sourceMappingURL=async-mutex.d.ts.map