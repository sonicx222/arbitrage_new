/**
 * @arbitrage/ml - Machine Learning Engine
 *
 * ML-based price prediction and pattern recognition for arbitrage trading.
 *
 * Modules:
 * - lstm-predictor.ts: LSTM price predictor (P3-1 split from predictor.ts)
 * - pattern-recognizer.ts: Pattern recognizer (P3-1 split from predictor.ts)
 * - predictor-types.ts: Shared prediction types (P3-1 split from predictor.ts)
 * - predictor.ts: Re-export hub for backward compatibility
 * - orderflow-features.ts: Feature engineering for orderflow signals (T4.3.1)
 * - orderflow-predictor.ts: Orderflow pattern predictor (T4.3.2)
 * - direction-types.ts: Unified direction type system (Fix 6.1/9.1)
 * - feature-math.ts: Shared mathematical utilities (Refactor 9.2)
 * - synchronized-stats.ts: Thread-safe statistics tracking (Refactor 9.3)
 * - model-persistence.ts: Model save/load utilities (Fix 7.2)
 * - tf-backend.ts: TensorFlow backend selection (Fix 3.2)
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4
 */

// =============================================================================
// TensorFlow Backend (Fix 3.2)
// Must be imported before any TensorFlow operations
// =============================================================================

export {
  initializeTensorFlow,
  getTensorFlowBackend,
  isTensorFlowInitialized,
  isNativeBackend,
  getTensorFlowMemory,
  getTensorFlowInfo,
  disposeAllTensors,
  withTensorCleanup,
  // P2-2: Renamed for clarity (these monitor but don't clean up)
  withTensorMonitorAsync,
  withTrackedTensorMonitor,
  // P2-2: Deprecated aliases for backwards compatibility
  withTensorCleanupAsync,
  withTrackedTensorCleanup,
  resetTensorFlowBackend
} from './tf-backend';

export type {
  TFBackend,
  BackendInitResult,
  BackendConfig
} from './tf-backend';

// =============================================================================
// Direction Types (Fix 6.1/9.1: Unified Direction System)
// =============================================================================

export {
  DirectionMapper,
  getDirectionMapper,
  priceToMarketDirection,
  marketToPriceDirection,
  isPriceDirectionAligned,
  isMarketDirectionAligned
} from './direction-types';

export type {
  PriceDirection,
  MarketDirection,
  OpportunityDirection,
  UnifiedDirection
} from './direction-types';

// =============================================================================
// Feature Math Utilities (Refactor 9.2)
// =============================================================================

export {
  // Statistical functions
  calculateSMA,
  calculateMean,
  calculateVariance,
  calculateStdDev,
  calculateVolatility,
  calculateMomentum,
  calculateMomentumPercent,
  // Trend analysis
  calculateTrend,
  calculateTrendStrength,
  // Return calculations
  calculateReturns,
  calculateLogReturns,
  // Volume analysis
  calculateVolumeFeatures,
  calculateVolumeChanges,
  // Normalization
  normalize,
  normalizeSymmetric,
  normalizeSequence,
  // Similarity
  cosineSimilarity,
  cosineSimilarityNormalized,
  trendSimilarity,
  // Safe math
  safeDivide,
  clamp,
  isFiniteNumber,
  finiteOrDefault
} from './feature-math';

// =============================================================================
// Synchronized Statistics (Refactor 9.3)
// =============================================================================

export {
  SynchronizedStats,
  createSynchronizedStats
} from './synchronized-stats';

export type {
  SynchronizedStatsConfig,
  StatsSnapshot
} from './synchronized-stats';

// =============================================================================
// Model Persistence (Fix 7.2)
// =============================================================================

export {
  ModelPersistence,
  getModelPersistence,
  resetModelPersistence
} from './model-persistence';

export type {
  ModelMetadata,
  PersistenceConfig,
  SaveResult,
  LoadResult
} from './model-persistence';

// =============================================================================
// Prediction Types (P3-1 split)
// =============================================================================

export type {
  PriceHistory,
  PredictionResult,
  PatternResult,
  TrainingData,
  PredictionContext,
  PredictionHistoryEntry,
} from './predictor-types';

// =============================================================================
// LSTM Price Predictor (P3-1 split)
// =============================================================================

export {
  LSTMPredictor,
  getLSTMPredictor,
  resetLSTMPredictor,
} from './lstm-predictor';

export type { LSTMPredictorConfig } from './lstm-predictor';

// =============================================================================
// Pattern Recognizer (P3-1 split)
// =============================================================================

export {
  PatternRecognizer,
  getPatternRecognizer,
  resetPatternRecognizer,
} from './pattern-recognizer';

export type { PatternRecognizerConfig } from './pattern-recognizer';

// Aggregated reset (imports both singletons)
export { resetAllMLSingletons } from './predictor';

// =============================================================================
// Orderflow Feature Engineering (T4.3.1)
// =============================================================================

export {
  // Class
  OrderflowFeatureExtractor,
  // Singleton factory
  getOrderflowFeatureExtractor,
  // Reset function
  resetOrderflowFeatureExtractor,
  // Constants
  ORDERFLOW_FEATURE_COUNT
} from './orderflow-features';

export type {
  // Feature types
  OrderflowFeatures,
  NormalizedOrderflowFeatures,
  OrderflowFeatureInput,
  // Configuration
  OrderflowExtractorConfig,
  // Supporting types
  WhaleNetDirection,
  RecentSwap,
  LiquidationData,
  PoolReserves
} from './orderflow-features';

// =============================================================================
// Orderflow Predictor (T4.3.2)
// =============================================================================

export {
  // Class
  OrderflowPredictor,
  // Singleton factory
  getOrderflowPredictor,
  // Reset function
  resetOrderflowPredictor,
  // Fix 1.1: Conversion helper co-located with predictor
  toOrderflowSignal
} from './orderflow-predictor';

export type {
  // Prediction result
  OrderflowPrediction,
  // Fix 1.1: Signal type for MLOpportunityScorer integration
  OrderflowSignal,
  // Training types
  OrderflowTrainingSample,
  OrderflowTrainingBatch,
  // Configuration
  OrderflowPredictorConfig,
  // Statistics
  OrderflowModelStats
} from './orderflow-predictor';

// =============================================================================
// Ensemble Prediction Combiner (P4 Optimization)
// =============================================================================

export {
  // Class
  EnsemblePredictionCombiner,
  // Singleton factory
  getEnsemblePredictionCombiner,
  // Reset function
  resetEnsemblePredictionCombiner,
} from './ensemble-combiner';

export type {
  // Combined prediction result
  CombinedPrediction,
  // Configuration
  EnsembleCombinerConfig,
  // Statistics
  EnsembleCombinerStats,
} from './ensemble-combiner';
