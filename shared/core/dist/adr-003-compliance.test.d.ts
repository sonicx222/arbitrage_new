/**
 * ADR-003 Compliance Tests: Partitioned Chain Detectors
 *
 * These tests verify that the system adheres to ADR-003:
 * - Single-chain detectors are deprecated
 * - Unified-detector handles multiple chains via partitions
 * - Chain configuration is centralized
 *
 * Per ADR-003:
 * - 3-4 partitions for 15+ chains (not 1 service per chain)
 * - Fits within free hosting limits (Fly.io 3 apps)
 * - Shared overhead across chains
 *
 * TDD Approach: Tests written BEFORE full implementation.
 *
 * @see docs/architecture/adr/ADR-003-partitioned-detectors.md
 */
export {};
//# sourceMappingURL=adr-003-compliance.test.d.ts.map