/**
 * Test Support Types
 *
 * Types and interfaces used by production code to support test isolation patterns.
 * These types enable the beforeAll + resetState optimization pattern for tests.
 */

/**
 * Interface for classes that support state reset for test isolation.
 *
 * Classes implementing this interface can be used with the beforeAll + resetState
 * pattern, which creates instances once and resets state between tests instead of
 * recreating instances for each test.
 *
 * @see shared/test-utils/src/helpers/test-state-management.ts for helper functions
 */
export interface Resettable {
  /**
   * Reset internal state for test isolation.
   *
   * This method should:
   * - Clear cached data (maps, arrays, sets)
   * - Reset counters and statistics
   * - Clear any accumulated state from previous tests
   *
   * This method should NOT:
   * - Recreate connections or expensive resources
   * - Change configuration
   * - Reset shared external state (use singleton resets for that)
   */
  resetState(): void;
}
