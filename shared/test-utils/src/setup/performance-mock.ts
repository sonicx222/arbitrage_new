/**
 * Global performance mock for Jest test environments.
 *
 * Provides a deterministic `performance.now()` mock that returns 1000ms.
 * This prevents tests from depending on real system timing.
 *
 * Usage:
 *   - Imported by `jest-setup.ts` for root-level test runs
 *   - Imported by each service's `setupTests.ts` for service-level test runs
 *
 * Tests that need real timing (e.g., performance benchmarks) should override
 * this mock in their own `beforeEach` block.
 *
 * @see shared/test-utils/src/setup/jest-setup.ts
 */
(global as any).performance = {
  now: jest.fn().mockReturnValue(1000),
};
