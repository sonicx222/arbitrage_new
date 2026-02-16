/**
 * ML Prediction Engine - Re-export Hub
 *
 * P3-1 refactoring: This file was split into focused modules:
 * - predictor-types.ts: Shared data types (PriceHistory, PredictionResult, etc.)
 * - lstm-predictor.ts: LSTMPredictor class with LSTM-based price forecasting
 * - pattern-recognizer.ts: PatternRecognizer class with sliding window pattern detection
 *
 * This file re-exports everything for backward compatibility. New code should
 * import directly from the specific module files.
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4
 */

// Types
export type {
  PriceHistory,
  PredictionResult,
  PatternResult,
  TrainingData,
  PredictionContext,
  PredictionHistoryEntry,
} from './predictor-types';

// LSTMPredictor
import {
  LSTMPredictor,
  getLSTMPredictor,
  resetLSTMPredictor,
} from './lstm-predictor';
export { LSTMPredictor, getLSTMPredictor, resetLSTMPredictor };
export type { LSTMPredictorConfig } from './lstm-predictor';

// PatternRecognizer
import {
  PatternRecognizer,
  getPatternRecognizer,
  resetPatternRecognizer,
} from './pattern-recognizer';
export { PatternRecognizer, getPatternRecognizer, resetPatternRecognizer };
export type { PatternRecognizerConfig } from './pattern-recognizer';

/**
 * Reset all ML singletons.
 */
export function resetAllMLSingletons(): void {
  resetLSTMPredictor();
  resetPatternRecognizer();
}
