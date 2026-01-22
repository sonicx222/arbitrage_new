/**
 * Jest Setup for P2 L2-Turbo Partition Service Tests
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
  // Allow pending timers/promises to resolve
  await new Promise(resolve => setTimeout(resolve, 100));
});
