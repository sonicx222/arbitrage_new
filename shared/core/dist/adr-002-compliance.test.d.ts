/**
 * ADR-002 Compliance Tests: Redis Streams Required (No Pub/Sub Fallback)
 *
 * These tests verify that the system adheres to ADR-002:
 * - Redis Streams is the ONLY messaging mechanism
 * - No Pub/Sub fallback code exists
 * - Services fail fast if Streams is unavailable
 *
 * Uses static code analysis to verify compliance without needing
 * to import actual modules (avoids dependency issues in tests).
 *
 * TDD Approach: These tests are written BEFORE implementation.
 * They should FAIL with current code that has Pub/Sub fallback.
 *
 * @see docs/architecture/adr/ADR-002-redis-streams.md
 */
export {};
//# sourceMappingURL=adr-002-compliance.test.d.ts.map