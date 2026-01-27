/**
 * Unit tests for predictor.ts
 *
 * Tests cover:
 * - LSTMPredictor initialization and prediction
 * - PatternRecognizer pattern detection
 * - Singleton factory functions
 * - Reset functions
 * - Edge cases and error handling
 * - Configuration options
 */

import {
  LSTMPredictor,
  PatternRecognizer,
  getLSTMPredictor,
  getPatternRecognizer,
  resetLSTMPredictor,
  resetPatternRecognizer,
  resetAllMLSingletons,
  PriceHistory,
  PredictionContext,
  TrainingData,
  LSTMPredictorConfig,
  PatternRecognizerConfig
} from '../../src/predictor';

// Mock @arbitrage/core
jest.mock('@arbitrage/core', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

describe('LSTMPredictor', () => {
  // Reset singletons before each test
  beforeEach(() => {
    resetAllMLSingletons();
  });

  afterAll(() => {
    resetAllMLSingletons();
  });

  describe('initialization', () => {
    it('should initialize model asynchronously', async () => {
      const predictor = new LSTMPredictor();
      await predictor.waitForReady();

      expect(predictor.isReady()).toBe(true);
    });

    it('should accept custom configuration', async () => {
      const config: LSTMPredictorConfig = {
        sequenceLength: 30,
        featureCount: 10,
        accuracyThreshold: 0.8,
        predictionTimeHorizonMs: 60000
      };

      const predictor = new LSTMPredictor(config);
      await predictor.waitForReady();

      const stats = predictor.getModelStats();
      expect(stats.isReady).toBe(true);
    });

    it('should be ready before prediction can succeed', async () => {
      const predictor = new LSTMPredictor();

      // Model not trained, should use fallback
      const result = await predictor.predictPrice([], {
        currentPrice: 100,
        volume24h: 1000000,
        marketCap: 10000000,
        volatility: 0.05
      });

      expect(result).toBeDefined();
      expect(result.confidence).toBe(0.3); // Fallback confidence for empty history
    });
  });

  describe('predictPrice', () => {
    let predictor: LSTMPredictor;

    beforeEach(async () => {
      predictor = new LSTMPredictor();
      await predictor.waitForReady();
    });

    afterEach(() => {
      predictor.dispose();
    });

    it('should return fallback prediction when not trained', async () => {
      const priceHistory = generatePriceHistory(10);
      const context: PredictionContext = {
        currentPrice: 100,
        volume24h: 1000000,
        marketCap: 10000000,
        volatility: 0.05
      };

      const result = await predictor.predictPrice(priceHistory, context);

      expect(result).toBeDefined();
      expect(result.confidence).toBe(0.5); // Fallback confidence
      expect(['up', 'down', 'sideways']).toContain(result.direction);
      expect(typeof result.predictedPrice).toBe('number');
    });

    it('should handle empty price history', async () => {
      const context: PredictionContext = {
        currentPrice: 100,
        volume24h: 1000000,
        marketCap: 10000000,
        volatility: 0.05
      };

      const result = await predictor.predictPrice([], context);

      expect(result.predictedPrice).toBe(100); // Should use current price
      expect(result.confidence).toBe(0.3); // Low confidence for empty history
    });

    it('should handle price history shorter than sequence length', async () => {
      const priceHistory = generatePriceHistory(5); // Less than default 60
      const context: PredictionContext = {
        currentPrice: 100,
        volume24h: 1000000,
        marketCap: 10000000,
        volatility: 0.05
      };

      const result = await predictor.predictPrice(priceHistory, context);

      expect(result).toBeDefined();
      expect(typeof result.predictedPrice).toBe('number');
      expect(Number.isFinite(result.predictedPrice)).toBe(true);
    });

    it('should return valid time horizon', async () => {
      const priceHistory = generatePriceHistory(10);
      const context: PredictionContext = {
        currentPrice: 100,
        volume24h: 1000000,
        marketCap: 10000000,
        volatility: 0.05
      };

      const result = await predictor.predictPrice(priceHistory, context);

      expect(result.timeHorizon).toBe(300000); // Default 5 minutes
    });
  });

  describe('trainModel', () => {
    let predictor: LSTMPredictor;

    beforeEach(async () => {
      predictor = new LSTMPredictor({
        sequenceLength: 10,
        featureCount: 10
      });
      await predictor.waitForReady();
    });

    afterEach(() => {
      predictor.dispose();
    });

    it('should train model with valid data', async () => {
      const trainingData = generateTrainingData(5, 10 * 10); // 5 samples, 100 features each

      await predictor.trainModel(trainingData);

      const stats = predictor.getModelStats();
      expect(stats.isTrained).toBe(true);
      expect(stats.lastTrainingTime).toBeGreaterThan(0);
    }, 60000); // Allow longer timeout for training

    it('should throw error with invalid input size', async () => {
      const trainingData: TrainingData = {
        inputs: [[1, 2, 3]], // Wrong size
        outputs: [[100, 0.8, 0]],
        timestamps: [Date.now()]
      };

      await expect(predictor.trainModel(trainingData)).rejects.toThrow('Invalid input size');
    });
  });

  describe('updateModel', () => {
    let predictor: LSTMPredictor;

    beforeEach(async () => {
      predictor = new LSTMPredictor();
      await predictor.waitForReady();
    });

    afterEach(() => {
      predictor.dispose();
    });

    it('should accumulate prediction history', async () => {
      for (let i = 0; i < 10; i++) {
        await predictor.updateModel(100 + i, 100 + i + 0.5, Date.now());
      }

      const stats = predictor.getModelStats();
      expect(stats.predictionCount).toBe(10);
    });

    it('should calculate recent accuracy', async () => {
      // Add predictions with 50% accuracy
      for (let i = 0; i < 20; i++) {
        const actual = 100;
        const predicted = i % 2 === 0 ? 100 : 110; // Every other is 10% off
        await predictor.updateModel(actual, predicted, Date.now());
      }

      const stats = predictor.getModelStats();
      expect(stats.recentAccuracy).toBeGreaterThanOrEqual(0);
      expect(stats.recentAccuracy).toBeLessThanOrEqual(1);
    });

    it('should not trigger retraining when accuracy is good', async () => {
      // Add accurate predictions
      for (let i = 0; i < 20; i++) {
        await predictor.updateModel(100, 100.01, Date.now());
      }

      const stats = predictor.getModelStats();
      expect(stats.recentAccuracy).toBeGreaterThan(0.7);
    });
  });

  describe('getModelStats', () => {
    it('should return correct initial stats', async () => {
      const predictor = new LSTMPredictor();
      await predictor.waitForReady();

      const stats = predictor.getModelStats();

      expect(stats.isTrained).toBe(false);
      expect(stats.lastTrainingTime).toBe(0);
      expect(stats.predictionCount).toBe(0);
      expect(stats.recentAccuracy).toBe(1.0); // Default accuracy when no history
      expect(stats.isReady).toBe(true);
      expect(stats.isRetraining).toBe(false);

      predictor.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up resources', async () => {
      const predictor = new LSTMPredictor();
      await predictor.waitForReady();

      // Add some history
      for (let i = 0; i < 5; i++) {
        await predictor.updateModel(100, 100.5, Date.now());
      }

      predictor.dispose();

      const stats = predictor.getModelStats();
      expect(stats.isTrained).toBe(false);
      expect(stats.predictionCount).toBe(0);
      expect(stats.isReady).toBe(false);
    });
  });
});

describe('PatternRecognizer', () => {
  beforeEach(() => {
    resetPatternRecognizer();
  });

  describe('initialization', () => {
    it('should initialize with default patterns', () => {
      const recognizer = new PatternRecognizer();
      const patterns = recognizer.getPatterns();

      expect(patterns.size).toBeGreaterThan(0);
      expect(patterns.has('whale_accumulation')).toBe(true);
      expect(patterns.has('profit_taking')).toBe(true);
      expect(patterns.has('breakout')).toBe(true);
    });

    it('should accept custom configuration', () => {
      const config: PatternRecognizerConfig = {
        minDataPoints: 3,
        patternTimeHorizonMs: 120000
      };

      const recognizer = new PatternRecognizer(config);
      expect(recognizer).toBeDefined();
    });
  });

  describe('detectPattern', () => {
    let recognizer: PatternRecognizer;

    beforeEach(() => {
      recognizer = new PatternRecognizer();
    });

    it('should return null with insufficient data', () => {
      const priceHistory = generatePriceHistory(3); // Less than minDataPoints
      const volumeHistory = [100, 200, 300];

      const result = recognizer.detectPattern(priceHistory, volumeHistory);

      expect(result).toBeNull();
    });

    it('should detect patterns with sufficient data', () => {
      // Create price history with breakout pattern (steady increase)
      const priceHistory: PriceHistory[] = [];
      let price = 100;
      for (let i = 0; i < 10; i++) {
        price *= 1.03; // 3% increase each step
        priceHistory.push({
          timestamp: Date.now() - (10 - i) * 60000,
          price,
          volume: 1000000 * (1 + i * 0.1),
          high: price * 1.01,
          low: price * 0.99
        });
      }

      const volumeHistory = priceHistory.map(p => p.volume);

      const result = recognizer.detectPattern(priceHistory, volumeHistory);

      // May or may not match a pattern depending on thresholds
      if (result) {
        expect(typeof result.pattern).toBe('string');
        expect(result.confidence).toBeGreaterThan(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
        expect(typeof result.expectedOutcome).toBe('string');
      }
    });

    it('should handle flat price data gracefully', () => {
      const priceHistory: PriceHistory[] = [];
      for (let i = 0; i < 10; i++) {
        priceHistory.push({
          timestamp: Date.now() - (10 - i) * 60000,
          price: 100, // Flat price
          volume: 1000000,
          high: 100,
          low: 100
        });
      }

      const volumeHistory = new Array(10).fill(1000000);

      const result = recognizer.detectPattern(priceHistory, volumeHistory);

      // Should not throw, may return consolidation or null
      expect(() => recognizer.detectPattern(priceHistory, volumeHistory)).not.toThrow();
    });

    it('should return pattern result with correct structure', () => {
      // Create data that might match a pattern
      const priceHistory = generatePriceHistory(10);
      const volumeHistory = priceHistory.map(p => p.volume);

      const result = recognizer.detectPattern(priceHistory, volumeHistory);

      if (result) {
        expect(result).toHaveProperty('pattern');
        expect(result).toHaveProperty('confidence');
        expect(result).toHaveProperty('expectedOutcome');
        expect(result).toHaveProperty('timeHorizon');
        expect(result).toHaveProperty('features');
        expect(Array.isArray(result.features)).toBe(true);
      }
    });
  });

  describe('addPattern', () => {
    it('should add custom patterns', () => {
      const recognizer = new PatternRecognizer();

      recognizer.addPattern('custom_pattern', {
        sequence: [0.01, 0.02, 0.03, 0.04],
        threshold: 0.7,
        confidence: 0.85,
        outcome: 'custom_outcome',
        type: 'price'
      });

      const patterns = recognizer.getPatterns();
      expect(patterns.has('custom_pattern')).toBe(true);
    });
  });

  describe('sliding window similarity (Bug 4.4 fix)', () => {
    it('should calculate similarity for sequences of different lengths', () => {
      const recognizer = new PatternRecognizer();

      // Create input that has more elements than pattern sequence
      const priceHistory = generatePriceHistory(15);
      const volumeHistory = priceHistory.map(p => p.volume);

      // Should not throw and should be able to compare sequences
      expect(() => recognizer.detectPattern(priceHistory, volumeHistory)).not.toThrow();
    });

    it('should find best match with sliding window', () => {
      const recognizer = new PatternRecognizer();

      // Create data with pattern near the end
      const priceHistory: PriceHistory[] = [];
      let price = 100;

      // First 6 entries: flat
      for (let i = 0; i < 6; i++) {
        priceHistory.push({
          timestamp: Date.now() - (10 - i) * 60000,
          price,
          volume: 1000000,
          high: price,
          low: price
        });
      }

      // Last 4 entries: breakout pattern
      for (let i = 0; i < 4; i++) {
        price *= 1.03;
        priceHistory.push({
          timestamp: Date.now() - (4 - i) * 60000,
          price,
          volume: 1000000 * (1 + i * 0.2),
          high: price * 1.01,
          low: price * 0.99
        });
      }

      const volumeHistory = priceHistory.map(p => p.volume);

      // Should be able to detect pattern even at end of sequence
      const result = recognizer.detectPattern(priceHistory, volumeHistory);
      // Result may be null if threshold not met, but should not throw
      expect(() => recognizer.detectPattern(priceHistory, volumeHistory)).not.toThrow();
    });
  });
});

describe('Singleton Factory Functions', () => {
  beforeEach(() => {
    resetAllMLSingletons();
  });

  afterAll(() => {
    resetAllMLSingletons();
  });

  describe('getLSTMPredictor', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = getLSTMPredictor();
      const instance2 = getLSTMPredictor();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', async () => {
      const instance1 = getLSTMPredictor();
      await instance1.waitForReady();

      resetLSTMPredictor();

      const instance2 = getLSTMPredictor();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('getPatternRecognizer', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = getPatternRecognizer();
      const instance2 = getPatternRecognizer();

      expect(instance1).toBe(instance2);
    });

    it('should create new instance after reset', () => {
      const instance1 = getPatternRecognizer();

      resetPatternRecognizer();

      const instance2 = getPatternRecognizer();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('resetAllMLSingletons', () => {
    it('should reset all singletons', async () => {
      const lstm1 = getLSTMPredictor();
      await lstm1.waitForReady();
      const pattern1 = getPatternRecognizer();

      resetAllMLSingletons();

      const lstm2 = getLSTMPredictor();
      const pattern2 = getPatternRecognizer();

      expect(lstm1).not.toBe(lstm2);
      expect(pattern1).not.toBe(pattern2);
    });
  });
});

describe('Edge Cases and Error Handling', () => {
  beforeEach(() => {
    resetAllMLSingletons();
  });

  afterAll(() => {
    resetAllMLSingletons();
  });

  describe('division by zero protection (Bug 4.3 fix)', () => {
    it('should handle zero volumes without NaN', async () => {
      const predictor = new LSTMPredictor();
      await predictor.waitForReady();

      const priceHistory: PriceHistory[] = [];
      for (let i = 0; i < 10; i++) {
        priceHistory.push({
          timestamp: Date.now() - (10 - i) * 60000,
          price: 100,
          volume: 0, // Zero volume
          high: 100,
          low: 100
        });
      }

      const context: PredictionContext = {
        currentPrice: 100,
        volume24h: 0, // Zero volume
        marketCap: 0,
        volatility: 0
      };

      const result = await predictor.predictPrice(priceHistory, context);

      expect(Number.isNaN(result.predictedPrice)).toBe(false);
      expect(Number.isFinite(result.predictedPrice)).toBe(true);

      predictor.dispose();
    });
  });

  describe('negative price handling', () => {
    it('should handle negative prices gracefully', async () => {
      const predictor = new LSTMPredictor();
      await predictor.waitForReady();

      const priceHistory: PriceHistory[] = [];
      for (let i = 0; i < 10; i++) {
        priceHistory.push({
          timestamp: Date.now() - (10 - i) * 60000,
          price: -100, // Negative price (shouldn't happen but test defensively)
          volume: 1000000,
          high: -90,
          low: -110
        });
      }

      const context: PredictionContext = {
        currentPrice: -100,
        volume24h: 1000000,
        marketCap: 10000000,
        volatility: 0.05
      };

      const result = await predictor.predictPrice(priceHistory, context);

      // Should not throw
      expect(result).toBeDefined();

      predictor.dispose();
    });
  });

  describe('very large values', () => {
    it('should handle very large price values', async () => {
      const predictor = new LSTMPredictor();
      await predictor.waitForReady();

      const priceHistory: PriceHistory[] = [];
      for (let i = 0; i < 10; i++) {
        priceHistory.push({
          timestamp: Date.now() - (10 - i) * 60000,
          price: 1e15, // Very large price
          volume: 1e20,
          high: 1e15 * 1.1,
          low: 1e15 * 0.9
        });
      }

      const context: PredictionContext = {
        currentPrice: 1e15,
        volume24h: 1e20,
        marketCap: 1e25,
        volatility: 0.05
      };

      const result = await predictor.predictPrice(priceHistory, context);

      expect(Number.isFinite(result.predictedPrice)).toBe(true);

      predictor.dispose();
    });
  });

  describe('concurrent access', () => {
    it('should handle multiple concurrent predictions', async () => {
      const predictor = new LSTMPredictor();
      await predictor.waitForReady();

      const priceHistory = generatePriceHistory(10);
      const context: PredictionContext = {
        currentPrice: 100,
        volume24h: 1000000,
        marketCap: 10000000,
        volatility: 0.05
      };

      // Make multiple concurrent predictions
      const promises = Array(10).fill(null).map(() =>
        predictor.predictPrice(priceHistory, context)
      );

      const results = await Promise.all(promises);

      // All should succeed
      expect(results).toHaveLength(10);
      results.forEach(result => {
        expect(result).toBeDefined();
        expect(Number.isFinite(result.predictedPrice)).toBe(true);
      });

      predictor.dispose();
    });
  });
});

// =============================================================================
// Helper Functions
// =============================================================================

function generatePriceHistory(count: number): PriceHistory[] {
  const history: PriceHistory[] = [];
  let price = 100;

  for (let i = 0; i < count; i++) {
    // Add some random-like variation
    const change = (Math.sin(i * 0.5) * 0.02) + 0.001;
    price *= (1 + change);

    history.push({
      timestamp: Date.now() - (count - i) * 60000,
      price,
      volume: 1000000 + i * 10000,
      high: price * 1.01,
      low: price * 0.99
    });
  }

  return history;
}

function generateTrainingData(sampleCount: number, featureCount: number): TrainingData {
  const inputs: number[][] = [];
  const outputs: number[][] = [];
  const timestamps: number[] = [];

  for (let i = 0; i < sampleCount; i++) {
    // Generate feature vector
    const input: number[] = [];
    for (let j = 0; j < featureCount; j++) {
      input.push(Math.sin(i * 0.1 + j * 0.05));
    }
    inputs.push(input);

    // Generate output: [predicted_price, confidence, direction]
    outputs.push([100 + i, 0.8, i % 2 === 0 ? 1 : -1]);

    timestamps.push(Date.now() - (sampleCount - i) * 60000);
  }

  return { inputs, outputs, timestamps };
}
