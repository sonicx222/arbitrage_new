/**
 * Cross-Chain Detector Architecture Alignment Tests
 *
 * These tests verify that CrossChainDetectorService follows the same
 * architectural patterns as other detectors for consistency.
 *
 * Current State:
 * - CrossChainDetectorService does NOT extend BaseDetector
 * - Has different lifecycle management
 * - Has different error handling patterns
 *
 * Options per Architecture Alignment Plan:
 * 1. Make CrossChainDetectorService extend BaseDetector
 * 2. Create new base class hierarchy for multi-chain services
 * 3. Document as intentional exception in ADR
 *
 * TDD Approach: Tests written BEFORE implementation.
 *
 * @see architecture-alignment-plan.md Issue #3
 */
export {};
//# sourceMappingURL=cross-chain-alignment.test.d.ts.map