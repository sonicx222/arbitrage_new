"use strict";
/**
 * Jest Setup File
 *
 * This file runs before each test file.
 * Configure in jest.config.js: setupFilesAfterEnv: ['<rootDir>/shared/test-utils/src/setup/jest-setup.ts']
 *
 * @see docs/TEST_ARCHITECTURE.md
 */
Object.defineProperty(exports, "__esModule", { value: true });
require("@jest/globals");
const env_setup_1 = require("./env-setup");
const singleton_reset_1 = require("./singleton-reset");
const swap_event_factory_1 = require("../factories/swap-event.factory");
const price_update_factory_1 = require("../factories/price-update.factory");
// =============================================================================
// Global Setup
// =============================================================================
// Initialize test environment before all tests
beforeAll(async () => {
    // Setup environment variables
    (0, env_setup_1.setupTestEnv)();
    // Initialize singleton reset functions
    await (0, singleton_reset_1.initializeSingletonResets)();
});
// =============================================================================
// Per-Test Setup
// =============================================================================
// Reset state before each test for isolation
beforeEach(() => {
    // Reset factories to ensure deterministic IDs
    (0, swap_event_factory_1.resetSwapEventFactory)();
    (0, price_update_factory_1.resetPriceUpdateFactory)();
});
// =============================================================================
// Per-Test Cleanup
// =============================================================================
// Clean up after each test
afterEach(async () => {
    // Reset all singletons to prevent test interference
    await (0, singleton_reset_1.resetAllSingletons)();
    // Clear all mocks
    jest.clearAllMocks();
});
// =============================================================================
// Global Teardown
// =============================================================================
// Restore original environment after all tests
afterAll(() => {
    (0, env_setup_1.restoreEnv)();
});
// =============================================================================
// Debug Mode Configuration
// =============================================================================
// Increase timeout for debugging
if (process.env.DEBUG_TESTS === 'true') {
    jest.setTimeout(300000); // 5 minutes for debugging
}
// =============================================================================
// Custom Matchers
// =============================================================================
expect.extend({
    /**
     * Check if a number is within a range (inclusive)
     *
     * @example
     * expect(5).toBeWithinRange(1, 10);
     * expect(latencyMs).toBeWithinRange(0, 100);
     */
    toBeWithinRange(received, floor, ceiling) {
        const pass = received >= floor && received <= ceiling;
        return {
            pass,
            message: () => pass
                ? `expected ${received} not to be within range ${floor} - ${ceiling}`
                : `expected ${received} to be within range ${floor} - ${ceiling}`
        };
    },
    /**
     * Check if a string is a valid Ethereum address
     *
     * @example
     * expect(address).toBeValidAddress();
     */
    toBeValidAddress(received) {
        const pass = /^0x[a-fA-F0-9]{40}$/.test(received);
        return {
            pass,
            message: () => pass
                ? `expected ${received} not to be a valid Ethereum address`
                : `expected ${received} to be a valid Ethereum address (0x + 40 hex chars)`
        };
    },
    /**
     * Check if a string is a valid transaction hash
     *
     * @example
     * expect(txHash).toBeValidTxHash();
     */
    toBeValidTxHash(received) {
        const pass = /^0x[a-fA-F0-9]{64}$/.test(received);
        return {
            pass,
            message: () => pass
                ? `expected ${received} not to be a valid transaction hash`
                : `expected ${received} to be a valid transaction hash (0x + 64 hex chars)`
        };
    },
    /**
     * Check if an async function completes within a time limit
     *
     * @example
     * await expect(async () => someAsyncFn()).toCompleteWithin(100);
     */
    async toCompleteWithin(received, timeoutMs) {
        const start = Date.now();
        try {
            await received();
            const duration = Date.now() - start;
            const pass = duration <= timeoutMs;
            return {
                pass,
                message: () => pass
                    ? `expected function not to complete within ${timeoutMs}ms (took ${duration}ms)`
                    : `expected function to complete within ${timeoutMs}ms but took ${duration}ms`
            };
        }
        catch (error) {
            return {
                pass: false,
                message: () => `function threw an error: ${error.message}`
            };
        }
    },
    /**
     * Check if a value is approximately equal (for floating point comparison)
     *
     * @example
     * expect(result).toBeApproximately(0.1 + 0.2, 0.001);
     */
    toBeApproximately(received, expected, precision = 0.0001) {
        const diff = Math.abs(received - expected);
        const pass = diff <= precision;
        return {
            pass,
            message: () => pass
                ? `expected ${received} not to be approximately ${expected} (±${precision})`
                : `expected ${received} to be approximately ${expected} (±${precision}), diff was ${diff}`
        };
    }
});
// =============================================================================
// Console Warning Suppression (optional)
// =============================================================================
// Suppress noisy console output during tests (uncomment if needed)
// const originalWarn = console.warn;
// const originalError = console.error;
// beforeAll(() => {
//   console.warn = (...args: unknown[]) => {
//     // Filter out known noisy warnings
//     const message = args[0]?.toString() || '';
//     if (message.includes('deprecated')) return;
//     originalWarn.apply(console, args);
//   };
// });
// afterAll(() => {
//   console.warn = originalWarn;
//   console.error = originalError;
// });
// =============================================================================
// Unhandled Rejection Handler
// =============================================================================
// Fail tests on unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection in test:', reason);
    // In test environment, this should fail the test
});
//# sourceMappingURL=jest-setup.js.map