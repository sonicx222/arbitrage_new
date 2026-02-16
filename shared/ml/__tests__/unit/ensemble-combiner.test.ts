/**
 * Unit tests for EnsemblePredictionCombiner
 *
 * Tests the ensemble combiner that merges LSTM price predictions
 * with orderflow predictions using weighted combination.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('@arbitrage/core', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import {
  EnsemblePredictionCombiner,
  getEnsemblePredictionCombiner,
  resetEnsemblePredictionCombiner,
} from '../../src/ensemble-combiner';
import type { PredictionResult } from '../../src/predictor-types';
import type { OrderflowPrediction } from '../../src/orderflow-predictor';

// =============================================================================
// Mock Helpers
// =============================================================================

function createMockLstmPrediction(overrides: Partial<PredictionResult> = {}): PredictionResult {
  return {
    direction: 'up',
    confidence: 0.8,
    predictedPrice: 100,
    timeHorizon: 300000,
    features: [],
    ...overrides,
  };
}

function createMockOrderflowPrediction(overrides: Partial<OrderflowPrediction> = {}): OrderflowPrediction {
  return {
    direction: 'bullish',
    confidence: 0.7,
    orderflowPressure: 0.5,
    expectedVolatility: 0.05,
    whaleImpact: 0.3,
    timeHorizonMs: 60000,
    features: {} as OrderflowPrediction['features'],
    timestamp: Date.now(),
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('EnsemblePredictionCombiner', () => {
  beforeEach(() => {
    resetEnsemblePredictionCombiner();
  });

  // ===========================================================================
  // Constructor
  // ===========================================================================

  describe('constructor', () => {
    it('should create with default config', () => {
      const combiner = new EnsemblePredictionCombiner();
      const stats = combiner.getStats();
      expect(stats.totalCombinations).toBe(0);
    });

    it('should create with custom config', () => {
      const combiner = new EnsemblePredictionCombiner({
        lstmWeight: 0.7,
        orderflowWeight: 0.3,
        alignmentBonus: 0.15,
      });
      // Verify it works by combining - custom weights should affect results
      const lstm = createMockLstmPrediction({ confidence: 0.8 });
      const orderflow = createMockOrderflowPrediction({ confidence: 0.8 });
      const result = combiner.combine(lstm, orderflow);
      // With 0.7/0.3 weights and alignment bonus of 0.15:
      // 0.7*0.8 + 0.3*0.8 + 0.15 = 0.56 + 0.24 + 0.15 = 0.95
      expect(result.contributions.lstmConfidence).toBeCloseTo(0.56, 2);
      expect(result.contributions.orderflowConfidence).toBeCloseTo(0.24, 2);
    });

    it('should normalize weights that do not sum to 1', () => {
      const combiner = new EnsemblePredictionCombiner({
        lstmWeight: 3,
        orderflowWeight: 2,
      });
      // Weights should be normalized: 3/5=0.6, 2/5=0.4
      const lstm = createMockLstmPrediction({ confidence: 1.0 });
      const orderflow = createMockOrderflowPrediction({ confidence: 1.0 });
      const result = combiner.combine(lstm, orderflow);
      // After normalization: 0.6*1.0 + 0.4*1.0 = 1.0, plus alignment bonus
      expect(result.contributions.lstmConfidence).toBeCloseTo(0.6, 1);
      expect(result.contributions.orderflowConfidence).toBeCloseTo(0.4, 1);
    });
  });

  // ===========================================================================
  // combine() - missing predictions
  // ===========================================================================

  describe('combine() - missing predictions', () => {
    let combiner: EnsemblePredictionCombiner;

    beforeEach(() => {
      combiner = new EnsemblePredictionCombiner();
    });

    it('should return default prediction when both are null', () => {
      const result = combiner.combine(null, null);
      expect(result.direction).toBe('sideways');
      expect(result.confidence).toBe(0);
      expect(result.directionsAligned).toBe(true);
    });

    it('should return LSTM-based prediction when only LSTM is provided', () => {
      const lstm = createMockLstmPrediction({ direction: 'up', confidence: 0.85 });
      const result = combiner.combine(lstm, null);
      expect(result.direction).toBe('up');
      expect(result.confidence).toBe(0.85);
      expect(result.priceTarget).toBe(100);
      expect(result.contributions.lstmConfidence).toBe(0.85);
      expect(result.contributions.orderflowConfidence).toBe(0);
    });

    it('should return orderflow-based prediction when only orderflow is provided', () => {
      const orderflow = createMockOrderflowPrediction({
        direction: 'bearish',
        confidence: 0.75,
        expectedVolatility: 0.1,
      });
      const result = combiner.combine(null, orderflow);
      expect(result.direction).toBe('down');
      expect(result.confidence).toBe(0.75);
      expect(result.priceTarget).toBe(0);
      expect(result.volatilityAdjustment).toBe(0.1);
      expect(result.contributions.orderflowConfidence).toBe(0.75);
      expect(result.contributions.lstmConfidence).toBe(0);
    });
  });

  // ===========================================================================
  // combine() - direction alignment
  // ===========================================================================

  describe('combine() - direction alignment', () => {
    let combiner: EnsemblePredictionCombiner;

    beforeEach(() => {
      combiner = new EnsemblePredictionCombiner();
    });

    it('should detect alignment when both predict up/bullish', () => {
      const lstm = createMockLstmPrediction({ direction: 'up' });
      const orderflow = createMockOrderflowPrediction({ direction: 'bullish' });
      const result = combiner.combine(lstm, orderflow);
      expect(result.directionsAligned).toBe(true);
      expect(result.contributions.alignmentBonus).toBeGreaterThan(0);
    });

    it('should detect alignment when both predict down/bearish', () => {
      const lstm = createMockLstmPrediction({ direction: 'down' });
      const orderflow = createMockOrderflowPrediction({ direction: 'bearish' });
      const result = combiner.combine(lstm, orderflow);
      expect(result.directionsAligned).toBe(true);
      expect(result.contributions.alignmentBonus).toBeGreaterThan(0);
    });

    it('should detect opposition when LSTM is up and orderflow is bearish', () => {
      const lstm = createMockLstmPrediction({ direction: 'up' });
      const orderflow = createMockOrderflowPrediction({ direction: 'bearish' });
      const result = combiner.combine(lstm, orderflow);
      expect(result.directionsAligned).toBe(false);
      expect(result.contributions.alignmentBonus).toBeLessThan(0);
    });

    it('should detect alignment when LSTM is sideways (sideways aligns with anything)', () => {
      const lstm = createMockLstmPrediction({ direction: 'sideways' });
      const orderflow = createMockOrderflowPrediction({ direction: 'bullish' });
      const result = combiner.combine(lstm, orderflow);
      expect(result.directionsAligned).toBe(true);
    });
  });

  // ===========================================================================
  // combine() - confidence calculation
  // ===========================================================================

  describe('combine() - confidence calculation', () => {
    let combiner: EnsemblePredictionCombiner;

    beforeEach(() => {
      combiner = new EnsemblePredictionCombiner();
    });

    it('should calculate combined confidence as weighted sum plus bonus', () => {
      const lstm = createMockLstmPrediction({ direction: 'up', confidence: 0.8 });
      const orderflow = createMockOrderflowPrediction({ direction: 'bullish', confidence: 0.7 });
      const result = combiner.combine(lstm, orderflow);
      // Default weights: lstm=0.6, orderflow=0.4, alignmentBonus=0.1
      // 0.6*0.8 + 0.4*0.7 + 0.1 = 0.48 + 0.28 + 0.1 = 0.86
      expect(result.confidence).toBeCloseTo(0.86, 2);
    });

    it('should clamp confidence to [0, 1]', () => {
      const lstm = createMockLstmPrediction({ direction: 'up', confidence: 1.0 });
      const orderflow = createMockOrderflowPrediction({ direction: 'bullish', confidence: 1.0 });
      const result = combiner.combine(lstm, orderflow);
      // 0.6*1.0 + 0.4*1.0 + 0.1 = 1.1 -> clamped to 1.0
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should fall back to orderflow only when LSTM confidence is below threshold', () => {
      const lstm = createMockLstmPrediction({ direction: 'up', confidence: 0.1 }); // below 0.3 default
      const orderflow = createMockOrderflowPrediction({ direction: 'bullish', confidence: 0.7 });
      const result = combiner.combine(lstm, orderflow);
      // Should use orderflow-only path
      expect(result.confidence).toBe(0.7);
      expect(result.contributions.lstmConfidence).toBe(0);
      expect(result.contributions.orderflowConfidence).toBe(0.7);
    });

    it('should fall back to LSTM only when orderflow confidence is below threshold', () => {
      const lstm = createMockLstmPrediction({ direction: 'up', confidence: 0.8 });
      const orderflow = createMockOrderflowPrediction({ direction: 'bullish', confidence: 0.1 }); // below 0.3
      const result = combiner.combine(lstm, orderflow);
      // Should use lstm-only path
      expect(result.confidence).toBe(0.8);
      expect(result.contributions.lstmConfidence).toBe(0.8);
      expect(result.contributions.orderflowConfidence).toBe(0);
    });

    it('should return default when both are below confidence thresholds', () => {
      const lstm = createMockLstmPrediction({ direction: 'up', confidence: 0.1 });
      const orderflow = createMockOrderflowPrediction({ direction: 'bullish', confidence: 0.1 });
      const result = combiner.combine(lstm, orderflow);
      expect(result.direction).toBe('sideways');
      expect(result.confidence).toBe(0);
    });
  });

  // ===========================================================================
  // combine() - direction resolution
  // ===========================================================================

  describe('combine() - direction resolution', () => {
    let combiner: EnsemblePredictionCombiner;

    beforeEach(() => {
      combiner = new EnsemblePredictionCombiner();
    });

    it('should use higher weighted confidence direction when opposed', () => {
      // LSTM weight=0.6, confidence=0.9 -> weighted=0.54
      // Orderflow weight=0.4, confidence=0.5 -> weighted=0.20
      // LSTM wins
      const lstm = createMockLstmPrediction({ direction: 'up', confidence: 0.9 });
      const orderflow = createMockOrderflowPrediction({ direction: 'bearish', confidence: 0.5 });
      const result = combiner.combine(lstm, orderflow);
      expect(result.direction).toBe('up');
    });

    it('should use non-sideways direction when one is sideways', () => {
      const lstm = createMockLstmPrediction({ direction: 'sideways', confidence: 0.8 });
      const orderflow = createMockOrderflowPrediction({ direction: 'bullish', confidence: 0.7 });
      const result = combiner.combine(lstm, orderflow);
      expect(result.direction).toBe('up');
    });

    it('should return sideways when both are sideways', () => {
      const lstm = createMockLstmPrediction({ direction: 'sideways', confidence: 0.8 });
      const orderflow = createMockOrderflowPrediction({ direction: 'neutral', confidence: 0.7 });
      const result = combiner.combine(lstm, orderflow);
      expect(result.direction).toBe('sideways');
    });
  });

  // ===========================================================================
  // getStats()
  // ===========================================================================

  describe('getStats()', () => {
    let combiner: EnsemblePredictionCombiner;

    beforeEach(() => {
      combiner = new EnsemblePredictionCombiner();
    });

    it('should track totalCombinations', () => {
      const lstm = createMockLstmPrediction();
      const orderflow = createMockOrderflowPrediction();
      combiner.combine(lstm, orderflow);
      combiner.combine(lstm, orderflow);
      combiner.combine(lstm, orderflow);
      expect(combiner.getStats().totalCombinations).toBe(3);
    });

    it('should track directionsAlignedCount', () => {
      const lstm = createMockLstmPrediction({ direction: 'up' });
      const orderflowAligned = createMockOrderflowPrediction({ direction: 'bullish' });
      const orderflowOpposed = createMockOrderflowPrediction({ direction: 'bearish' });
      combiner.combine(lstm, orderflowAligned);
      combiner.combine(lstm, orderflowOpposed);
      combiner.combine(lstm, orderflowAligned);
      expect(combiner.getStats().directionsAlignedCount).toBe(2);
    });

    it('should track lstmOnlyCount, orderflowOnlyCount, bothPresentCount', () => {
      const lstm = createMockLstmPrediction();
      const orderflow = createMockOrderflowPrediction();
      combiner.combine(lstm, null); // lstmOnly
      combiner.combine(null, orderflow); // orderflowOnly
      combiner.combine(lstm, orderflow); // bothPresent
      const stats = combiner.getStats();
      expect(stats.lstmOnlyCount).toBe(1);
      expect(stats.orderflowOnlyCount).toBe(1);
      expect(stats.bothPresentCount).toBe(1);
    });

    it('should calculate averages correctly', () => {
      const lstm = createMockLstmPrediction({ direction: 'up', confidence: 0.8 });
      const orderflow = createMockOrderflowPrediction({ direction: 'bullish', confidence: 0.7 });
      combiner.combine(lstm, orderflow);
      const stats = combiner.getStats();
      expect(stats.avgCombinedConfidence).toBeGreaterThan(0);
      expect(stats.avgAlignmentBonus).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // resetStats()
  // ===========================================================================

  describe('resetStats()', () => {
    it('should reset all counters to 0', () => {
      const combiner = new EnsemblePredictionCombiner();
      const lstm = createMockLstmPrediction();
      const orderflow = createMockOrderflowPrediction();
      combiner.combine(lstm, orderflow);
      combiner.combine(lstm, null);
      combiner.combine(null, orderflow);

      combiner.resetStats();
      const stats = combiner.getStats();
      expect(stats.totalCombinations).toBe(0);
      expect(stats.directionsAlignedCount).toBe(0);
      expect(stats.directionsOpposedCount).toBe(0);
      expect(stats.lstmOnlyCount).toBe(0);
      expect(stats.orderflowOnlyCount).toBe(0);
      expect(stats.bothPresentCount).toBe(0);
      expect(stats.avgCombinedConfidence).toBe(0);
      expect(stats.avgAlignmentBonus).toBe(0);
    });
  });

  // ===========================================================================
  // Singleton
  // ===========================================================================

  describe('singleton', () => {
    it('should return the same instance from getEnsemblePredictionCombiner', () => {
      const instance1 = getEnsemblePredictionCombiner();
      const instance2 = getEnsemblePredictionCombiner();
      expect(instance1).toBe(instance2);
    });

    it('should clear instance with resetEnsemblePredictionCombiner', () => {
      const instance1 = getEnsemblePredictionCombiner();
      resetEnsemblePredictionCombiner();
      const instance2 = getEnsemblePredictionCombiner();
      expect(instance1).not.toBe(instance2);
    });
  });
});
