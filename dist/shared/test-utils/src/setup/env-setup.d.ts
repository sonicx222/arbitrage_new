/**
 * Test Environment Setup
 *
 * Provides isolated environment variable management for tests.
 * Prevents environment leakage between test files.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */
/**
 * Test environment configuration
 */
export interface TestEnvironment {
    REDIS_URL: string;
    REDIS_HOST: string;
    REDIS_PORT: string;
    NODE_ENV: string;
    LOG_LEVEL: string;
    ETHEREUM_RPC_URL: string;
    ETHEREUM_WS_URL: string;
    ARBITRUM_RPC_URL: string;
    ARBITRUM_WS_URL: string;
    OPTIMISM_RPC_URL: string;
    OPTIMISM_WS_URL: string;
    BASE_RPC_URL: string;
    BASE_WS_URL: string;
    BSC_RPC_URL: string;
    BSC_WS_URL: string;
    POLYGON_RPC_URL: string;
    POLYGON_WS_URL: string;
    AVALANCHE_RPC_URL: string;
    AVALANCHE_WS_URL: string;
    [key: string]: string;
}
/**
 * Setup test environment with default values and optional overrides
 */
export declare function setupTestEnv(overrides?: Partial<TestEnvironment>): void;
/**
 * Restore original environment (call in afterAll)
 */
export declare function restoreEnv(): void;
/**
 * Get a test environment variable
 */
export declare function getTestEnv(key: keyof TestEnvironment): string;
/**
 * Execute a function with temporary environment changes
 */
export declare function withEnv<T>(envOverrides: Partial<TestEnvironment>, fn: () => T | Promise<T>): Promise<T>;
/**
 * Update Redis connection from config file (used by global setup)
 */
export declare function updateRedisEnvFromConfig(config: {
    host: string;
    port: number;
    url: string;
}): void;
/**
 * Check if running in CI environment
 */
export declare function isCI(): boolean;
/**
 * Check if debug mode is enabled
 */
export declare function isDebugMode(): boolean;
//# sourceMappingURL=env-setup.d.ts.map