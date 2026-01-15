/**
 * Singleton Reset Manager
 *
 * Centralized management of singleton reset functions.
 * Automatically resets all registered singletons between tests
 * to ensure proper test isolation.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */
type ResetFunction = () => void | Promise<void>;
/**
 * Register a singleton reset function
 *
 * @param name - Unique name for the singleton (for logging)
 * @param resetFn - Function to reset the singleton
 * @param priority - Reset order (default 50, lower = earlier)
 */
export declare function registerSingletonReset(name: string, resetFn: ResetFunction, priority?: number): void;
/**
 * Unregister a singleton reset function
 */
export declare function unregisterSingletonReset(name: string): void;
/**
 * Reset all registered singletons
 *
 * Call this in afterEach() to ensure test isolation
 */
export declare function resetAllSingletons(): Promise<void>;
/**
 * Get list of registered singleton names (for debugging)
 */
export declare function getRegisteredSingletons(): string[];
/**
 * Clear all registered singletons (for testing the test utils)
 */
export declare function clearRegisteredSingletons(): void;
/**
 * Initialize all known singleton reset functions
 *
 * This function should be called once during test setup.
 * It dynamically imports @arbitrage/core to avoid circular dependencies.
 */
export declare function initializeSingletonResets(): Promise<void>;
/**
 * Create a reset function for a specific singleton
 *
 * Useful when you need to reset a singleton explicitly in a test
 */
export declare function createSingletonResetter(name: string): () => Promise<void>;
export {};
//# sourceMappingURL=singleton-reset.d.ts.map