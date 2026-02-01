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
// DEPRECATED ARBITRAGE CALCULATOR EXPORTS
// These have been replaced by components/arbitrage-detector and components/price-calculator
// =============================================================================

/**
 * @deprecated Since v1.0.0. Use detectArbitrage from components/arbitrage-detector instead.
 * Will be removed in v2.0.0.
 */
export { calculateIntraChainArbitrage } from '../arbitrage-calculator';

/**
 * @deprecated Since v1.0.0. Use isValidPairSnapshot from components/arbitrage-detector instead.
 * Will be removed in v2.0.0.
 */
export { validatePairSnapshot } from '../arbitrage-calculator';

/**
 * @deprecated Since v1.0.0. Use PairRepository.createSnapshot() from components/pair-repository instead.
 * Will be removed in v2.0.0.
 */
export { createPairSnapshot } from '../arbitrage-calculator';

/**
 * @deprecated Since v1.0.0. These types will be removed in v2.0.0.
 * Migration guide:
 * - PairSnapshot → ComponentPairSnapshot from components/pair-repository
 * - ChainPriceData → components/arbitrage-detector
 * - CrossChainOpportunityResult → components/arbitrage-detector
 */
export type {
  PairSnapshot as ArbitragePairSnapshot,
  PriceComparisonResult,
  ArbitrageCalcConfig,
} from '../arbitrage-calculator';

// =============================================================================
// DEPRECATED DOMAIN MODELS
// DomainArbitrageError is replaced by ArbitrageError from @arbitrage/types
// =============================================================================

/**
 * @deprecated Since v1.0.0. Use ArbitrageError from '@arbitrage/types' instead.
 * The DomainArbitrageError class uses an older error pattern.
 * Migration: new ArbitrageError(msg, code, service) from '@arbitrage/types'
 */
export { ArbitrageError as DomainArbitrageError } from '../domain-models';

// =============================================================================
// DEPRECATED ASYNC UTILITIES
// withRetry renamed to withRetryAsync for clarity
// =============================================================================

/**
 * @deprecated Since v1.0.0. Use withRetryAsync from '@arbitrage/core' instead.
 * The name was changed for clarity (async vs sync retry).
 */
export { withRetry } from '../async/async-utils';
