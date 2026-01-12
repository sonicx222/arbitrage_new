/**
 * Async Singleton Pattern Utility
 * P1-3-FIX: Standardized singleton pattern for thread-safe lazy initialization
 *
 * This utility prevents race conditions in singleton creation by:
 * 1. Caching the factory promise (not the result) immediately
 * 2. Allowing multiple callers to await the same promise
 * 3. Preventing duplicate initialization attempts
 *
 * @example
 * const getRedisClient = createAsyncSingleton(
 *   async () => new Redis(config),
 *   async (client) => client.disconnect()
 * );
 *
 * // Usage
 * const client = await getRedisClient();
 */
/**
 * Creates a thread-safe async singleton factory.
 *
 * @param factory - Async function that creates the singleton instance
 * @param cleanup - Optional async function to cleanup the instance on reset
 * @param name - Optional name for logging purposes
 * @returns Object with get() and reset() methods
 */
export declare function createAsyncSingleton<T>(factory: () => Promise<T>, cleanup?: (instance: T) => Promise<void>, name?: string): {
    get: () => Promise<T>;
    reset: () => Promise<void>;
    isInitialized: () => boolean;
};
/**
 * Creates a simple (synchronous) singleton factory.
 * Use this for singletons that don't require async initialization.
 *
 * @param factory - Function that creates the singleton instance
 * @param cleanup - Optional function to cleanup the instance on reset
 * @param name - Optional name for logging purposes
 */
export declare function createSingleton<T>(factory: () => T, cleanup?: (instance: T) => void, name?: string): {
    get: () => T;
    reset: () => void;
    isInitialized: () => boolean;
};
/**
 * Decorator for creating singleton methods in classes.
 * The first call initializes, subsequent calls return the cached instance.
 */
export declare function singleton<T>(): MethodDecorator;
//# sourceMappingURL=async-singleton.d.ts.map