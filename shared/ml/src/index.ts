/**
 * @arbitrage/ml - Machine Learning Engine
 *
 * ML-based price prediction and pattern recognition for arbitrage trading.
 *
 * Modules:
 * - predictor.ts: LSTM price predictor and pattern recognizer
 * - orderflow-features.ts: Feature engineering for orderflow signals (T4.3.1)
 * - orderflow-predictor.ts: Orderflow pattern predictor (T4.3.2)
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4
 */

// =============================================================================
// Price Prediction Engine (LSTM)
// =============================================================================

export {
  // Classes
  LSTMPredictor,
  PatternRecognizer,
  // Singleton factories
  getLSTMPredictor,
  getPatternRecognizer,
  // Reset functions for testing
  resetLSTMPredictor,
  resetPatternRecognizer,
  resetAllMLSingletons
} from './predictor';

export type {
  // Data types
  PriceHistory,
  PredictionResult,
  PatternResult,
  TrainingData,
  PredictionContext,
  // Configuration types
  LSTMPredictorConfig,
  PatternRecognizerConfig
} from './predictor';

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
  resetOrderflowPredictor
} from './orderflow-predictor';

export type {
  // Prediction result
  OrderflowPrediction,
  // Training types
  OrderflowTrainingSample,
  OrderflowTrainingBatch,
  // Configuration
  OrderflowPredictorConfig,
  // Statistics
  OrderflowModelStats
} from './orderflow-predictor';
