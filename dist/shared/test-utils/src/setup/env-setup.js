"use strict";
/**
 * Test Environment Setup
 *
 * Provides isolated environment variable management for tests.
 * Prevents environment leakage between test files.
 *
 * @see docs/TEST_ARCHITECTURE.md
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupTestEnv = setupTestEnv;
exports.restoreEnv = restoreEnv;
exports.getTestEnv = getTestEnv;
exports.withEnv = withEnv;
exports.updateRedisEnvFromConfig = updateRedisEnvFromConfig;
exports.isCI = isCI;
exports.isDebugMode = isDebugMode;
// Store original environment
const originalEnv = { ...process.env };
/**
 * Default test environment values
 */
const defaultTestEnv = {
    // Redis - uses memory server by default
    REDIS_URL: 'redis://localhost:6379',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    // Node
    NODE_ENV: 'test',
    LOG_LEVEL: 'error', // Minimize logging in tests
    // Ethereum ecosystem (use test URLs)
    ETHEREUM_RPC_URL: 'https://eth-mainnet.test/v3/test',
    ETHEREUM_WS_URL: 'wss://eth-mainnet.test/ws/v3/test',
    ARBITRUM_RPC_URL: 'https://arb-mainnet.test/rpc',
    ARBITRUM_WS_URL: 'wss://arb-mainnet.test/feed',
    OPTIMISM_RPC_URL: 'https://optimism-mainnet.test/rpc',
    OPTIMISM_WS_URL: 'wss://optimism-mainnet.test/feed',
    BASE_RPC_URL: 'https://base-mainnet.test/rpc',
    BASE_WS_URL: 'wss://base-mainnet.test/feed',
    // Other chains
    BSC_RPC_URL: 'https://bsc-dataseed.test',
    BSC_WS_URL: 'wss://bsc-ws.test',
    POLYGON_RPC_URL: 'https://polygon-rpc.test',
    POLYGON_WS_URL: 'wss://polygon-ws.test',
    AVALANCHE_RPC_URL: 'https://avalanche-c.test/rpc',
    AVALANCHE_WS_URL: 'wss://avalanche-c.test/ws'
};
/**
 * Setup test environment with default values and optional overrides
 */
function setupTestEnv(overrides = {}) {
    const env = { ...defaultTestEnv, ...overrides };
    for (const [key, value] of Object.entries(env)) {
        process.env[key] = value;
    }
}
/**
 * Restore original environment (call in afterAll)
 */
function restoreEnv() {
    // Clear test env vars
    for (const key of Object.keys(defaultTestEnv)) {
        delete process.env[key];
    }
    // Restore original values
    Object.assign(process.env, originalEnv);
}
/**
 * Get a test environment variable
 */
function getTestEnv(key) {
    return process.env[key] ?? defaultTestEnv[key] ?? '';
}
/**
 * Execute a function with temporary environment changes
 */
async function withEnv(envOverrides, fn) {
    const backup = {};
    // Backup current values
    for (const key of Object.keys(envOverrides)) {
        backup[key] = process.env[key];
    }
    // Apply overrides
    for (const [key, value] of Object.entries(envOverrides)) {
        process.env[key] = value;
    }
    try {
        const result = fn();
        return result instanceof Promise ? await result : result;
    }
    finally {
        // Restore backup
        for (const [key, value] of Object.entries(backup)) {
            if (value === undefined) {
                delete process.env[key];
            }
            else {
                process.env[key] = value;
            }
        }
    }
}
/**
 * Update Redis connection from config file (used by global setup)
 */
function updateRedisEnvFromConfig(config) {
    process.env.REDIS_HOST = config.host;
    process.env.REDIS_PORT = String(config.port);
    process.env.REDIS_URL = config.url;
}
/**
 * Check if running in CI environment
 */
function isCI() {
    return process.env.CI === 'true' || !!process.env.GITHUB_ACTIONS;
}
/**
 * Check if debug mode is enabled
 */
function isDebugMode() {
    return process.env.DEBUG_TESTS === 'true';
}
//# sourceMappingURL=env-setup.js.map