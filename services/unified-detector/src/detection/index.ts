/**
 * Detection Module
 *
 * Exports for arbitrage detection services.
 * Extracted from chain-instance.ts for single-responsibility principle.
 *
 * @see R3 - Chain Instance Detection Strategies
 * @see REFACTORING_ROADMAP.md
 */

// =============================================================================
// Simple Arbitrage Detector
// =============================================================================

export {
  SimpleArbitrageDetector,
  createSimpleArbitrageDetector,
} from './simple-arbitrage-detector';

export type {
  PairSnapshot,
  SimpleArbitrageConfig,
} from './simple-arbitrage-detector';

// =============================================================================
// Snapshot Manager
// =============================================================================

export {
  SnapshotManager,
  createSnapshotManager,
} from './snapshot-manager';

export type {
  ExtendedPair,
  SnapshotManagerConfig,
} from './snapshot-manager';
