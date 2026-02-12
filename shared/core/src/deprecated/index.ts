/**
 * Deprecated Exports
 *
 * R8: Public API Surface Reduction
 *
 * This module contains exports that are deprecated and will be removed in v2.0.0.
 * Import from here only for backward compatibility during migration.
 *
 * MIGRATION GUIDE:
 * - calculateIntraChainArbitrage → detectArbitrage from '@arbitrage/core'
 * - validatePairSnapshot → isValidPairSnapshot from '@arbitrage/core'
 * - createPairSnapshot → PairRepository.createSnapshot() from '@arbitrage/core'
 * - ArbitragePairSnapshot → ComponentPairSnapshot from '@arbitrage/core'
 * - DomainArbitrageError → ArbitrageError from '@arbitrage/types'
 *
 * @module deprecated
 * @deprecated All exports in this module will be removed in v2.0.0
 */

// =============================================================================
// REMOVED: Deprecated Arbitrage Calculator Exports
// =============================================================================
// The following exports have been REMOVED as part of v2.0.0 cleanup:
//
// - calculateIntraChainArbitrage
//   → MIGRATION: Use SimpleArbitrageDetector.detectArbitrage() from unified-detector
//
// - validatePairSnapshot
//   → MIGRATION: Use SnapshotManager validation or define local validation
//
// - createPairSnapshot
//   → MIGRATION: Use SnapshotManager.createPairSnapshot() from unified-detector
//
// - PairSnapshot type (ArbitragePairSnapshot)
//   → MIGRATION: Import PairSnapshot from simple-arbitrage-detector
//
// - PriceComparisonResult type
//   → MIGRATION: Use SpreadResult from components/price-calculator
//
// - ArbitrageCalcConfig type
//   → MIGRATION: Use detection config directly in services
// =============================================================================

// =============================================================================
// DEPRECATED DOMAIN MODELS
// DomainArbitrageError is replaced by ArbitrageError from @arbitrage/types
// =============================================================================

// REMOVED: DomainArbitrageError (domain-models.ts dead code, cleaned up)
// Migration: Use ArbitrageError from '@arbitrage/types' instead.

// =============================================================================
// DEPRECATED ASYNC UTILITIES
// withRetry renamed to withRetryAsync for clarity
// =============================================================================

/**
 * @deprecated Since v1.0.0. Use withRetryAsync from '@arbitrage/core' instead.
 * The name was changed for clarity (async vs sync retry).
 */
export { withRetry } from '../async/async-utils';
