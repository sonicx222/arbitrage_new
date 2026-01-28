/**
 * Jest Setup for P1 Asia-Fast Partition Service Tests
 *
 * Configures test environment, mocks, and cleanup handlers.
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

// Clean up after all tests
afterAll(async () => {
  // Allow pending timers/promises to resolve before test teardown
  // Jest's global timeout (10000ms) provides safety against hanging
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
  } catch {
    // Ignore any unexpected errors during teardown
  }
});
