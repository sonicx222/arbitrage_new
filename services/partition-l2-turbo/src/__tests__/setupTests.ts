/**
 * Jest Setup for P2 L2-Turbo Partition Service Tests
 *
 * Configures test environment, mocks, and cleanup handlers.
 *
 * BUG-FIX: Added listener leak detection to catch potential memory leaks
 * without aggressively removing handlers (which can break Jest).
 */

// Set test environment flag to prevent auto-start
process.env.JEST_WORKER_ID = 'test';

// Increase timeout for integration tests
jest.setTimeout(10000);

// Mock console methods to reduce noise in test output
// Uncomment to silence logs during tests:
// global.console = {
//   ...console,
//   log: jest.fn(),
//   debug: jest.fn(),
//   info: jest.fn(),
//   warn: jest.fn(),
// };

// =============================================================================
// Listener Leak Detection
// =============================================================================

// Track initial listener counts to detect leaks
// Note: We track but do NOT remove - removeAllListeners() can break Jest's
// internal handlers for uncaughtException and unhandledRejection
const TRACKED_EVENTS = ['SIGTERM', 'SIGINT'] as const;

interface ListenerCounts {
  SIGTERM: number;
  SIGINT: number;
}

let initialListenerCounts: ListenerCounts | null = null;

beforeAll(() => {
  // Capture initial listener counts before any tests run
  initialListenerCounts = {
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGINT: process.listenerCount('SIGINT'),
  };
});

// Clean up after all tests
afterAll(async () => {
  // Allow pending timers/promises to resolve before test teardown
  // Jest's global timeout (10000ms) provides safety against hanging
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
  } catch {
    // Ignore any unexpected errors during teardown
  }

  // BUG-FIX: Detect listener leaks and warn (but don't forcefully remove)
  // This helps identify cleanup issues without breaking Jest's handlers
  if (initialListenerCounts) {
    const leaks: string[] = [];
    for (const event of TRACKED_EVENTS) {
      const currentCount = process.listenerCount(event);
      const initialCount = initialListenerCounts[event];
      if (currentCount > initialCount) {
        leaks.push(`${event}: ${initialCount} -> ${currentCount} (+${currentCount - initialCount})`);
      }
    }
    if (leaks.length > 0) {
      console.warn(
        '[setupTests] Potential listener leak detected. ' +
        'Ensure cleanupProcessHandlers() is called in afterEach:',
        leaks
      );
    }
  }
});
