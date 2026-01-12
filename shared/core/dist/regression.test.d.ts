/**
 * Regression Tests for Phase 4 Fixes
 *
 * These tests verify that race conditions, memory leaks, and other issues
 * identified during code analysis remain fixed.
 *
 * Issues covered:
 * - Singleton initialization race conditions (distributed-lock, price-oracle)
 * - Event emission safety (service-state)
 * - Subscription memory leak (redis)
 * - Stop promise race (base-detector)
 * - Health monitoring shutdown race (base-detector)
 * - Promise.allSettled cleanup (base-detector)
 */
export {};
//# sourceMappingURL=regression.test.d.ts.map