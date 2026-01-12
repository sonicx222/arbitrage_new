/**
 * Regression Tests for P0/P1/P2 Bug Fixes
 *
 * These tests verify that the identified bugs have been fixed and prevent regression.
 *
 * P0 Fixes covered:
 * - P0-1: Non-atomic pair updates in base-detector.ts
 * - P0-5: Singleton error cache in price-oracle.ts
 * - P0-6: Whale alert silent failure in base-detector.ts
 *
 * P1 Fixes covered:
 * - P1-2: Backpressure race in execution-engine
 * - P1-3: Stream MAXLEN support in redis-streams.ts
 * - P1-5: Latency calculation in coordinator
 *
 * P2 Fixes covered:
 * - P2-1: EventBatcher TOCTOU race condition in processQueue
 * - P2-2: CacheCoherencyManager non-atomic operations and unbounded array
 * - P2-3: SelfHealingManager health state TOCTOU
 * - P2-4: WebSocketManager timer cleanup edge cases
 *
 * @see architecture-alignment-plan.md
 */
export {};
//# sourceMappingURL=fixes-regression.test.d.ts.map