/**
 * Jest Setup File
 *
 * This file runs before each test file.
 * Configure in jest.config.js: setupFilesAfterEnv: ['<rootDir>/shared/test-utils/src/setup/jest-setup.ts']
 *
 * @see docs/TEST_ARCHITECTURE.md
 */

import '@jest/globals';
import { setupTestEnv, restoreEnv } from './env-setup';
import { resetAllSingletons, initializeSingletonResets } from './singleton-reset';
import { resetSwapEventFactory } from '../factories/swap-event.factory';
import { resetPriceUpdateFactory } from '../factories/price-update.factory';

// =============================================================================
// Global Setup
// =============================================================================

// Initialize test environment before all tests
beforeAll(async () => {
  // Setup environment variables
  setupTestEnv();

  // Initialize singleton reset functions
  await initializeSingletonResets();
});

// =============================================================================
// Per-Test Setup
// =============================================================================

// Reset state before each test for isolation
beforeEach(() => {
  // Reset factories to ensure deterministic IDs
  resetSwapEventFactory();
  resetPriceUpdateFactory();
});

// =============================================================================
// Per-Test Cleanup
// =============================================================================

// Clean up after each test
afterEach(async () => {
  // Reset all singletons to prevent test interference
  await resetAllSingletons();

  // Clear all mocks
  jest.clearAllMocks();
});

// =============================================================================
// Global Teardown
// =============================================================================

// Restore original environment after all tests
afterAll(() => {
  restoreEnv();
});

// =============================================================================
// Debug Mode Configuration
// =============================================================================

// Increase timeout for debugging
if (process.env.DEBUG_TESTS === 'true') {
  jest.setTimeout(300000); // 5 minutes for debugging
}

// =============================================================================
// Fake Timers Utilities
// =============================================================================

/**
 * Execute a function with fake timers, automatically cleaning up after.
 *
 * Use this for tests that depend on timing (setTimeout, setInterval, Date.now).
 * This makes tests deterministic and not flaky.
 *
 * @example
 * it('should timeout after 5 seconds', async () => {
 *   await withFakeTimers(async () => {
 *     const promise = operationWithTimeout(5000);
 *     jest.advanceTimersByTime(5000);
 *     await expect(promise).rejects.toThrow('timeout');
 *   });
 * });
 */
export async function withFakeTimers<T>(fn: () => T | Promise<T>): Promise<T> {
  jest.useFakeTimers();
  try {
    const result = fn();
    if (result instanceof Promise) {
      return await result;
    }
    return result;
  } finally {
    jest.useRealTimers();
  }
}

/**
 * Execute a function with fake timers and advance time automatically.
 *
 * @example
 * it('should debounce calls', async () => {
 *   const result = await withAdvancedTimers(
 *     async () => debouncedFn(),
 *     100 // advance 100ms
 *   );
 *   expect(result).toBe('debounced');
 * });
 */
export async function withAdvancedTimers<T>(
  fn: () => T | Promise<T>,
  advanceMs: number
): Promise<T> {
  return withFakeTimers(async () => {
    const promise = fn();
    jest.advanceTimersByTime(advanceMs);
    if (promise instanceof Promise) {
      return await promise;
    }
    return promise;
  });
}

/**
 * Run all pending timers and flush promises.
 *
 * Useful when you need to resolve all pending timeouts and promises
 * in fake timer mode.
 */
export async function flushTimersAndPromises(): Promise<void> {
  jest.runAllTimers();
  // Flush promise queue
  await new Promise(resolve => setImmediate(resolve));
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
  toBeWithinRange(received: number, floor: number, ceiling: number) {
    const pass = received >= floor && received <= ceiling;
    return {
      pass,
      message: () =>
        pass
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
  toBeValidAddress(received: string) {
    const pass = /^0x[a-fA-F0-9]{40}$/.test(received);
    return {
      pass,
      message: () =>
        pass
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
  toBeValidTxHash(received: string) {
    const pass = /^0x[a-fA-F0-9]{64}$/.test(received);
    return {
      pass,
      message: () =>
        pass
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
  async toCompleteWithin(received: unknown, timeoutMs: number) {
    // Type validation
    if (typeof received !== 'function') {
      return {
        pass: false,
        message: () => `expected a function but received ${typeof received}`
      };
    }

    const start = Date.now();
    try {
      await (received as () => Promise<unknown>)();
      const duration = Date.now() - start;
      const pass = duration <= timeoutMs;
      return {
        pass,
        message: () =>
          pass
            ? `expected function not to complete within ${timeoutMs}ms (took ${duration}ms)`
            : `expected function to complete within ${timeoutMs}ms but took ${duration}ms`
      };
    } catch (error) {
      return {
        pass: false,
        message: () => `function threw an error: ${(error as Error).message}`
      };
    }
  },

  /**
   * Check if a value is approximately equal (for floating point comparison)
   *
   * @example
   * expect(result).toBeApproximately(0.1 + 0.2, 0.001);
   */
  toBeApproximately(received: number, expected: number, precision = 0.0001) {
    const diff = Math.abs(received - expected);
    const pass = diff <= precision;
    return {
      pass,
      message: () =>
        pass
          ? `expected ${received} not to be approximately ${expected} (±${precision})`
          : `expected ${received} to be approximately ${expected} (±${precision}), diff was ${diff}`
    };
  }
});

// =============================================================================
// Type Declarations for Custom Matchers
// =============================================================================

declare global {
  namespace jest {
    interface Matchers<R> {
      toBeWithinRange(floor: number, ceiling: number): R;
      toBeValidAddress(): R;
      toBeValidTxHash(): R;
      toCompleteWithin(timeoutMs: number): Promise<R>;
      toBeApproximately(expected: number, precision?: number): R;
    }
  }
}

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
