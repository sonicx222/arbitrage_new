/**
 * Cross-Chain Detector Exports
 *
 * This file contains all exports for the @arbitrage/cross-chain-detector package.
 * Separated from index.ts to prevent auto-execution when the module is imported.
 *
 * @see index.ts for the service entry point (auto-runs main())
 */

// =============================================================================
// Module Exports (ADR-014: Modular Detector Components)
//
// Exports are organized into sections by domain. The PUBLIC API section contains
// the main service class intended for external consumers. All other sections are
// marked @internal and expose implementation details for use within this service
// or by tightly-coupled test code. Internal exports are preserved for backward
// compatibility but should not be depended upon by other services.
//
// Sections:
//   1. PUBLIC API          - CrossChainDetectorService (the main entry point)
//   2. Types               - Shared type definitions and token pair utilities
//   3. Stream Processing   - Redis Streams consumption (StreamConsumer)
//   4. Price Data          - Price data management and snapshots
//   5. Opportunity         - Opportunity publishing and deduplication
//   6. Bridge              - Bridge latency prediction and cost estimation
//   7. ML                  - ML prediction management
//   8. Confidence          - Confidence score calculation
// =============================================================================

// =============================================================================
// 1. PUBLIC API
// =============================================================================

/** The main cross-chain detector service class. This is the primary public export. */
export { CrossChainDetectorService } from './detector';

// =============================================================================
// 2. @internal - Types (re-exported for consumers and internal modules)
//
// Shared type definitions used across all cross-chain detector modules.
// Includes token pair format constants and conversion utilities.
//
// @see ADR-014: Modular Detector Components
// @see TYPE-CONSOLIDATION: Consolidated from duplicate definitions
// @internal
// =============================================================================

/** @internal */
export {
  ModuleLogger,
  Logger,
  PriceData,
  CrossChainOpportunity,
  IndexedSnapshot,
  PricePoint,
  DetectorConfig,
  WhaleAnalysisConfig,
  MLPredictionConfig,
  // Token pair format utilities (INC-2 FIX: Standardized format handling)
  TOKEN_PAIR_INTERNAL_SEPARATOR,
  TOKEN_PAIR_DISPLAY_SEPARATOR,
  toDisplayTokenPair,
  toInternalTokenPair,
  normalizeToInternalFormat,
  // Phase 3: Pre-validation types
  PreValidationConfig,
  PreValidationSimulationCallback,
  PreValidationSimulationRequest,
  PreValidationSimulationResult,
} from './types';

// =============================================================================
// 3. @internal - Stream Processing
//
// Redis Streams consumption module. Custom multi-stream consumer that reads
// from price-updates, whale-alerts, and pending-opportunities streams in
// parallel. Uses EventEmitter for loose coupling with downstream handlers.
//
// @see ADR-002: Redis Streams over Pub/Sub
// @see ADR-014: Modular Detector Components
// @internal
// =============================================================================

/** @internal */
export {
  createStreamConsumer,
  StreamConsumer,
  StreamConsumerConfig,
  StreamConsumerEvents,
} from './stream-consumer';

// =============================================================================
// 4. @internal - Price Data Management
//
// Manages hierarchical price data storage (chain/dex/pair), cleanup of stale
// data, and creation of indexed snapshots for O(1) token pair lookups during
// detection cycles.
//
// @see ADR-014: Modular Detector Components
// @internal
// =============================================================================

/** @internal */
export {
  createPriceDataManager,
  PriceDataManager,
  PriceDataManagerConfig,
} from './price-data-manager';

// =============================================================================
// 5. @internal - Opportunity Publishing
//
// Publishes cross-chain arbitrage opportunities to Redis Streams with
// deduplication, cache management, and conversion to ArbitrageOpportunity
// format for the execution engine.
//
// @see ADR-002: Redis Streams over Pub/Sub
// @see ADR-014: Modular Detector Components
// @internal
// =============================================================================

/** @internal */
export {
  createOpportunityPublisher,
  OpportunityPublisher,
  OpportunityPublisherConfig,
} from './opportunity-publisher';

// =============================================================================
// 6. @internal - Bridge Latency Prediction & Cost Estimation
//
// BridgeLatencyPredictor: ML-based prediction of cross-chain bridge latency
// and costs using historical data and statistical models.
//
// BridgeCostEstimator: Estimates bridge costs for arbitrage profit calculations.
// Uses BridgeLatencyPredictor for ML-based predictions and falls back to
// configured costs when predictions are unavailable.
//
// @see ADR-014: Modular Detector Components
// @internal
// =============================================================================

/** @internal */
export { BridgeLatencyPredictor, BridgePrediction, BridgeMetrics } from './bridge-predictor';

/** @internal */
export {
  createBridgeCostEstimator,
  BridgeCostEstimator,
  BridgeCostEstimatorConfig,
  BridgeCostEstimate,
} from './bridge-cost-estimator';

// =============================================================================
// 7. @internal - ML Prediction Management
//
// Manages ML predictions for cross-chain arbitrage detection. Handles price
// history tracking, prediction caching with single-flight pattern, and
// confidence calculation via TensorFlow.js LSTM models.
//
// @see ADR-014: Modular Detector Components
// @internal
// =============================================================================

/** @internal */
export {
  createMLPredictionManager,
  MLPredictionManager,
  MLPredictionManagerConfig,
} from './ml-prediction-manager';

// =============================================================================
// 8. @internal - Confidence Calculation
//
// Calculates composite confidence scores for cross-chain opportunities by
// combining price differential, data freshness, ML predictions, and whale
// activity signals. Stateless and shareable across detection cycles.
//
// @see P2-2: ConfidenceCalculator extraction
// @see ADR-014: Cross-Chain Detector Modularization
// @internal
// =============================================================================

/** @internal */
export {
  createConfidenceCalculator,
  ConfidenceCalculator,
  type ConfidenceCalculatorConfig,
  type ConfidenceCalculatorLogger,
  type WhaleActivitySummary,
  type MLPredictionPair,
  type PriceData as ConfidencePriceData,
  type MLConfidenceConfig,
  type WhaleConfidenceConfig,
  DEFAULT_CONFIDENCE_CONFIG,
} from './confidence-calculator';
