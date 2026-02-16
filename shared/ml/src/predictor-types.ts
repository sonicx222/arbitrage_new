/**
 * Shared types for the ML prediction engine.
 *
 * Extracted from predictor.ts (P3-1 refactoring) to allow LSTMPredictor
 * and PatternRecognizer to live in separate files while sharing types.
 */

export interface PriceHistory {
  timestamp: number;
  price: number;
  volume: number;
  high: number;
  low: number;
}

export interface PredictionResult {
  predictedPrice: number;
  confidence: number;
  direction: 'up' | 'down' | 'sideways';
  timeHorizon: number;
  features: number[];
}

export interface PatternResult {
  pattern: string;
  confidence: number;
  expectedOutcome: string;
  timeHorizon: number;
  features: number[];
}

export interface TrainingData {
  inputs: number[][];
  outputs: number[][];
  timestamps: number[];
}

export interface PredictionContext {
  currentPrice: number;
  volume24h: number;
  marketCap: number;
  volatility: number;
}

/**
 * Internal type for tracking prediction accuracy over time.
 */
export interface PredictionHistoryEntry {
  timestamp: number;
  actual: number;
  predicted: number;
  error: number;
}
