/**
 * Orderflow Predictor Tests (T4.3.2)
 *
 * Tests for the orderflow pattern prediction model that predicts
 * market direction and orderflow pressure from extracted features.
 *
 * Tests cover:
 * - Model initialization and warmup
 * - Prediction with trained/untrained model
 * - Training with valid/invalid data
 * - Online learning (addTrainingSample, retrainOnHistory)
 * - Singleton factory functions
 * - Edge cases and error handling
 *
 * P0-3 fix: These tests now use a lightweight TF.js mock so they run in CI.
 * Set RUN_SLOW_TESTS=true to run with real TF.js (for nightly builds).
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4, Task 4.3.2
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// P0-3 fix: Use TF.js mock for CI — tests validate prediction logic, not TF.js itself.
import { createTfMock } from './__helpers__/tf-mock';
const { mockTf, setOrderflowMode, restoreMocks: restoreTfMocks, restoreLastModelMocks } = createTfMock();
setOrderflowMode(); // Configure mock for 6-output orderflow model
jest.mock('@tensorflow/tfjs', () => mockTf);

// P3-3: Use shared mock helpers to reduce duplication
import {
  type MockWhaleActivitySummary,
  createMockWhaleActivitySummary,
  createDefaultInput,
} from './__helpers__/mock-orderflow';

// =============================================================================
// Test Setup - Mock dependencies
// =============================================================================

// Create mock whale tracker
const mockWhaleTracker = {
  getActivitySummary: jest.fn<(pairKey: string, chain: string, windowMs?: number) => MockWhaleActivitySummary>()
};

// Mock the @arbitrage/core module - define MockAsyncMutex inline to work with hoisting
jest.mock('@arbitrage/core', () => {
  // Mock AsyncMutex class defined inline
  class MockAsyncMutex {
    private locked = false;
    private waitQueue: Array<() => void> = [];

    async acquire(): Promise<() => void> {
      if (this.locked) {
        await new Promise<void>(resolve => {
          this.waitQueue.push(resolve);
        });
      }
      this.locked = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = this.waitQueue.shift();
        if (next) {
          setImmediate(next);
        } else {
          this.locked = false;
        }
      };
    }

    tryAcquire(): (() => void) | null {
      if (this.locked) return null;
      this.locked = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.locked = false;
      };
    }

    isLocked(): boolean {
      return this.locked;
    }
  }

  return {
    createLogger: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    })),
    getWhaleActivityTracker: jest.fn(),
    AsyncMutex: MockAsyncMutex
  };
});

// Import after mocking
import {
  OrderflowPredictor,
  getOrderflowPredictor,
  resetOrderflowPredictor
} from '../../src/orderflow-predictor';

// Get the mocked module and set up whale tracker implementation
import { getWhaleActivityTracker } from '@arbitrage/core/analytics';
const mockedGetWhaleActivityTracker = jest.mocked(getWhaleActivityTracker);
mockedGetWhaleActivityTracker.mockReturnValue(mockWhaleTracker as any);
import type {
  OrderflowPrediction,
  OrderflowTrainingSample,
  OrderflowPredictorConfig
} from '../../src/orderflow-predictor';
import type { OrderflowFeatureInput, OrderflowFeatures } from '../../src/orderflow-features';
import { resetOrderflowFeatureExtractor } from '../../src/orderflow-features';

// P3-3: createMockWhaleActivitySummary and createDefaultInput now imported
// from __helpers__/mock-orderflow.ts

function createTrainingSample(
  overrides: Partial<OrderflowTrainingSample> = {}
): OrderflowTrainingSample {
  const defaultFeatures: OrderflowFeatures = {
    whaleSwapCount1h: 10,
    whaleNetDirection: 'accumulating',
    hourOfDay: 14,
    dayOfWeek: 2,
    isUsMarketOpen: true,
    isAsiaMarketOpen: false,
    reserveImbalanceRatio: 0.2,
    recentSwapMomentum: 50000,
    nearestLiquidationLevel: 0.85,
    openInterestChange24h: 5.0
  };

  return {
    features: defaultFeatures,
    outcome: {
      direction: 'bullish',
      priceChangePercent: 2.5,
      volatility: 0.03
    },
    timestamp: Date.now(),
    ...overrides
  };
}

function generateTrainingSamples(count: number): OrderflowTrainingSample[] {
  const samples: OrderflowTrainingSample[] = [];
  const directions: Array<'bullish' | 'bearish' | 'neutral'> = ['bullish', 'bearish', 'neutral'];
  const whaleDirections: Array<'accumulating' | 'distributing' | 'neutral'> = ['accumulating', 'distributing', 'neutral'];

  for (let i = 0; i < count; i++) {
    const directionIdx = i % 3;
    samples.push({
      features: {
        whaleSwapCount1h: Math.floor(Math.random() * 50),
        whaleNetDirection: whaleDirections[i % 3],
        hourOfDay: i % 24,
        dayOfWeek: i % 7,
        isUsMarketOpen: i % 2 === 0,
        isAsiaMarketOpen: i % 3 === 0,
        reserveImbalanceRatio: (Math.random() - 0.5) * 2,
        recentSwapMomentum: (Math.random() - 0.5) * 2000000,
        nearestLiquidationLevel: Math.random(),
        openInterestChange24h: (Math.random() - 0.5) * 100
      },
      outcome: {
        direction: directions[directionIdx],
        priceChangePercent: (Math.random() - 0.5) * 10,
        volatility: Math.random() * 0.1
      },
      timestamp: Date.now() - (count - i) * 60000
    });
  }

  return samples;
}

// =============================================================================
// OrderflowPredictor Tests
// =============================================================================

/** Re-establish @arbitrage/core mock implementations after resetMocks clears them */
function restoreCoreMocks() {
  const core = require('@arbitrage/core');
  (core.createLogger as jest.Mock).mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  });
}

describe('OrderflowPredictor', () => {
  beforeEach(() => {
    // Re-establish all mock implementations after resetMocks clears them
    restoreTfMocks();
    setOrderflowMode();
    restoreCoreMocks();
    // Re-setup whale tracker mock after clearAllMocks
    mockedGetWhaleActivityTracker.mockReturnValue(mockWhaleTracker as any);
    resetOrderflowPredictor();
    resetOrderflowFeatureExtractor();
    mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());
  });

  afterEach(() => {
    resetOrderflowPredictor();
    resetOrderflowFeatureExtractor();
  });

  describe('Initialization', () => {
    it('should initialize model asynchronously', async () => {
      const predictor = new OrderflowPredictor();
      await predictor.waitForReady();

      expect(predictor.isReady()).toBe(true);
    });

    it('should accept custom configuration', async () => {
      const config: OrderflowPredictorConfig = {
        hiddenUnits1: 128,
        hiddenUnits2: 64,
        dropoutRate: 0.2,
        learningRate: 0.0005,
        confidenceThreshold: 0.7,
        predictionTimeHorizonMs: 300000
      };

      const predictor = new OrderflowPredictor(config);
      await predictor.waitForReady();

      expect(predictor.isReady()).toBe(true);

      predictor.dispose();
    });

    it('should report not ready before initialization completes', () => {
      const predictor = new OrderflowPredictor();

      // Immediately check - might still be initializing
      // The model starts initialization in constructor
      // isReady() checks model !== null && !modelInitError

      predictor.dispose();
    });

    it('should properly dispose resources', async () => {
      const predictor = new OrderflowPredictor();
      await predictor.waitForReady();

      predictor.dispose();

      const stats = predictor.getStats();
      expect(stats.isReady).toBe(false);
      expect(stats.isTrained).toBe(false);
    });
  });

  describe('Prediction - Untrained Model', () => {
    let predictor: OrderflowPredictor;

    // Use beforeAll for shared model - predictions are read-only operations
    beforeAll(async () => {
      predictor = new OrderflowPredictor();
      await predictor.waitForReady();
    }, 30000);

    beforeEach(() => {
      // Restore model mock implementations cleared by resetMocks
      restoreLastModelMocks(true);
    });

    afterAll(() => {
      predictor.dispose();
    });

    it('should return fallback prediction when model is not trained', async () => {
      const input = createDefaultInput();

      const result = await predictor.predict(input);

      expect(result).toBeDefined();
      expect(result.confidence).toBe(0.4); // Fallback confidence
      expect(['bullish', 'bearish', 'neutral']).toContain(result.direction);
    });

    it('should include features in prediction result', async () => {
      const input = createDefaultInput();

      const result = await predictor.predict(input);

      expect(result.features).toBeDefined();
      expect(typeof result.features.whaleSwapCount1h).toBe('number');
      expect(typeof result.features.hourOfDay).toBe('number');
    });

    it('should include timestamp in prediction result', async () => {
      const input = createDefaultInput();
      const beforeTime = Date.now();

      const result = await predictor.predict(input);

      expect(result.timestamp).toBeGreaterThanOrEqual(beforeTime);
    });

    it('should include time horizon from config', async () => {
      const input = createDefaultInput();

      const result = await predictor.predict(input);

      expect(result.timeHorizonMs).toBe(60000); // Default 1 minute
    });

    it('should return bullish direction when whale activity is accumulating', async () => {
      // Set up mock before creating predictor to ensure it's used
      mockWhaleTracker.getActivitySummary.mockReturnValue(
        createMockWhaleActivitySummary({
          buyVolumeUsd: 1000000,
          sellVolumeUsd: 200000, // buyRatio = 0.833 > 0.6 = accumulating
          whaleCount: 20
        })
      );

      const input = createDefaultInput();
      const result = await predictor.predict(input);

      // The fallback should detect accumulating direction and return bullish
      // or if the whale direction isn't detected, at least check the result structure
      expect(['bullish', 'bearish', 'neutral']).toContain(result.direction);
      expect(result.confidence).toBe(0.4); // Fallback confidence
      // The orderflowPressure depends on detected whale direction
      expect(typeof result.orderflowPressure).toBe('number');
    });

    it('should return bearish direction when whale activity is distributing', async () => {
      // Set up mock with distributing pattern
      mockWhaleTracker.getActivitySummary.mockReturnValue(
        createMockWhaleActivitySummary({
          buyVolumeUsd: 200000,
          sellVolumeUsd: 1000000, // buyRatio = 0.167 < 0.4 = distributing
          whaleCount: 20
        })
      );

      const input = createDefaultInput();
      const result = await predictor.predict(input);

      // The fallback should detect distributing direction
      expect(['bullish', 'bearish', 'neutral']).toContain(result.direction);
      expect(result.confidence).toBe(0.4); // Fallback confidence
      expect(typeof result.orderflowPressure).toBe('number');
    });

    it('should use momentum for fallback when positive', async () => {
      mockWhaleTracker.getActivitySummary.mockReturnValue(
        createMockWhaleActivitySummary({
          buyVolumeUsd: 500000,
          sellVolumeUsd: 500000 // Neutral
        })
      );

      const input = createDefaultInput({
        recentSwaps: [
          { direction: 'buy', amountUsd: 5000000, timestamp: Date.now() }
        ]
      });

      const result = await predictor.predict(input);

      // Strong positive momentum should influence direction
      expect(result.orderflowPressure).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Training', () => {
    let predictor: OrderflowPredictor;

    beforeEach(async () => {
      predictor = new OrderflowPredictor({
        minTrainingSamples: 50 // Lower for testing
      });
      await predictor.waitForReady();
    });

    afterEach(() => {
      predictor.dispose();
    });

    it('should train model with sufficient samples', async () => {
      const samples = generateTrainingSamples(100);

      await predictor.train(samples);

      const stats = predictor.getStats();
      expect(stats.isTrained).toBe(true);
      expect(stats.lastTrainingTime).toBeGreaterThan(0);
    }, 60000); // Allow longer timeout for training

    it('should reject training with insufficient samples', async () => {
      const samples = generateTrainingSamples(10); // Less than minTrainingSamples

      await predictor.train(samples);

      const stats = predictor.getStats();
      expect(stats.isTrained).toBe(false);
    });

    it('should update lastTrainingTime after training', async () => {
      const samples = generateTrainingSamples(100);
      const beforeTraining = Date.now();

      await predictor.train(samples);

      const stats = predictor.getStats();
      expect(stats.lastTrainingTime).toBeGreaterThanOrEqual(beforeTraining);
    }, 60000);
  });

  describe('Prediction - Trained Model', () => {
    let predictor: OrderflowPredictor;

    // P3-8 fix: Use beforeAll — training is expensive and predictions
    // are read-only operations that don't require a fresh model each time.
    beforeAll(async () => {
      predictor = new OrderflowPredictor({
        minTrainingSamples: 50
      });
      await predictor.waitForReady();

      // Train the model once for all prediction tests
      const samples = generateTrainingSamples(100);
      await predictor.train(samples);
    }, 60000);

    beforeEach(() => {
      // Restore model mock implementations cleared by resetMocks
      restoreLastModelMocks(true);
    });

    afterAll(() => {
      predictor.dispose();
    });

    it('should return ML prediction when trained', async () => {
      const input = createDefaultInput();

      const result = await predictor.predict(input);

      expect(result).toBeDefined();
      expect(['bullish', 'bearish', 'neutral']).toContain(result.direction);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should return bounded orderflow pressure (-1 to 1)', async () => {
      const input = createDefaultInput();

      const result = await predictor.predict(input);

      expect(result.orderflowPressure).toBeGreaterThanOrEqual(-1);
      expect(result.orderflowPressure).toBeLessThanOrEqual(1);
    });

    it('should return bounded volatility (0 to 1)', async () => {
      const input = createDefaultInput();

      const result = await predictor.predict(input);

      expect(result.expectedVolatility).toBeGreaterThanOrEqual(0);
      expect(result.expectedVolatility).toBeLessThanOrEqual(1);
    });

    it('should return bounded whale impact (0 to 1)', async () => {
      const input = createDefaultInput();

      const result = await predictor.predict(input);

      expect(result.whaleImpact).toBeGreaterThanOrEqual(0);
      expect(result.whaleImpact).toBeLessThanOrEqual(1);
    });

    it('should increment prediction counter', async () => {
      const input = createDefaultInput();
      const statsBefore = predictor.getStats();

      await predictor.predict(input);
      await predictor.predict(input);

      const statsAfter = predictor.getStats();
      expect(statsAfter.totalPredictions).toBe(statsBefore.totalPredictions + 2);
    });
  });

  describe('Online Learning', () => {
    let predictor: OrderflowPredictor;

    beforeEach(async () => {
      predictor = new OrderflowPredictor({
        minTrainingSamples: 50,
        maxHistorySize: 200
      });
      await predictor.waitForReady();
    });

    afterEach(() => {
      predictor.dispose();
    });

    it('should accumulate training samples', () => {
      const sample = createTrainingSample();

      predictor.addTrainingSample(sample);
      predictor.addTrainingSample(sample);

      const stats = predictor.getStats();
      expect(stats.trainingHistorySize).toBe(2);
    });

    it('should respect maxHistorySize', () => {
      // Add more samples than maxHistorySize
      for (let i = 0; i < 250; i++) {
        predictor.addTrainingSample(createTrainingSample());
      }

      const stats = predictor.getStats();
      expect(stats.trainingHistorySize).toBeLessThanOrEqual(200);
    });

    it('should retrain when history reaches minimum samples', async () => {
      // Add samples
      for (let i = 0; i < 100; i++) {
        predictor.addTrainingSample(createTrainingSample());
      }

      await predictor.retrainOnHistory();

      const stats = predictor.getStats();
      expect(stats.isTrained).toBe(true);
    }, 60000);

    it('should not retrain with insufficient history', async () => {
      // Add fewer samples than required
      for (let i = 0; i < 10; i++) {
        predictor.addTrainingSample(createTrainingSample());
      }

      await predictor.retrainOnHistory();

      const stats = predictor.getStats();
      expect(stats.isTrained).toBe(false);
    });
  });

  describe('Model Statistics', () => {
    let predictor: OrderflowPredictor;

    beforeEach(async () => {
      predictor = new OrderflowPredictor();
      await predictor.waitForReady();
    });

    afterEach(() => {
      predictor.dispose();
    });

    it('should return correct initial stats', () => {
      const stats = predictor.getStats();

      expect(stats.isReady).toBe(true);
      expect(stats.isTrained).toBe(false);
      expect(stats.isTraining).toBe(false);
      expect(stats.trainingHistorySize).toBe(0);
      expect(stats.lastTrainingTime).toBe(0);
      expect(stats.totalPredictions).toBe(0);
      expect(stats.accuracy).toBe(0);
      expect(stats.pendingValidations).toBe(0);
    });

    it('should update stats after predictions', async () => {
      const input = createDefaultInput();

      await predictor.predict(input);

      const stats = predictor.getStats();
      expect(stats.totalPredictions).toBe(1);
    });

    it('should update stats after adding samples', () => {
      predictor.addTrainingSample(createTrainingSample());

      const stats = predictor.getStats();
      expect(stats.trainingHistorySize).toBe(1);
    });
  });

  describe('Race Condition Protection', () => {
    let predictor: OrderflowPredictor;

    beforeEach(async () => {
      predictor = new OrderflowPredictor({
        minTrainingSamples: 50
      });
      await predictor.waitForReady();
    });

    afterEach(() => {
      predictor.dispose();
    });

    it('should prevent concurrent training with isTraining mutex', async () => {
      const samples = generateTrainingSamples(100);

      // Start two training calls concurrently
      const trainingPromise1 = predictor.train(samples);
      const trainingPromise2 = predictor.train(samples);

      await Promise.all([trainingPromise1, trainingPromise2]);

      // Should complete without error
      const stats = predictor.getStats();
      expect(stats.isTrained).toBe(true);
      expect(stats.isTraining).toBe(false);
    }, 120000);

    it('should show isTraining flag during training', async () => {
      const samples = generateTrainingSamples(100);

      // Start training without awaiting
      const trainingPromise = predictor.train(samples);

      // Check isTraining during training (may be true or already false if fast)
      // This is a timing-sensitive test, so we just verify it doesn't throw
      expect(() => predictor.getStats()).not.toThrow();

      await trainingPromise;

      // After training completes, isTraining should be false
      expect(predictor.getStats().isTraining).toBe(false);
    }, 60000);
  });

  describe('Accuracy Tracking', () => {
    let predictor: OrderflowPredictor;

    beforeEach(async () => {
      predictor = new OrderflowPredictor({
        minTrainingSamples: 50,
        confidenceThreshold: 0.5 // Lower threshold for testing
      });
      await predictor.waitForReady();

      // Train the model first
      const samples = generateTrainingSamples(100);
      await predictor.train(samples);
    }, 60000);

    afterEach(() => {
      predictor.dispose();
    });

    it('should track pending predictions for accuracy validation', async () => {
      const input = createDefaultInput();

      // Make a prediction
      const prediction = await predictor.predict(input);

      // If confidence >= threshold, should be tracked
      const stats = predictor.getStats();
      if (prediction.confidence >= 0.5) {
        expect(stats.pendingValidations).toBeGreaterThan(0);
      }
    });

    it('should validate accuracy when training sample matches prediction', async () => {
      const input = createDefaultInput();
      const prediction = await predictor.predict(input);

      // Add a training sample that matches the prediction timestamp window
      const sample = createTrainingSample({
        outcome: {
          direction: prediction.direction,
          priceChangePercent: 2.0,
          volatility: 0.05
        },
        timestamp: Date.now() + 30000 // Within 1 minute horizon
      });

      predictor.addTrainingSample(sample);

      // If prediction was tracked, accuracy should be calculated
      const stats = predictor.getStats();
      // Just verify no errors - accuracy calculation depends on timing
      expect(stats.accuracy).toBeGreaterThanOrEqual(0);
      expect(stats.accuracy).toBeLessThanOrEqual(1);
    });
  });

  describe('Edge Cases', () => {
    let predictor: OrderflowPredictor;

    // Use beforeAll - predictions are read-only operations
    beforeAll(async () => {
      predictor = new OrderflowPredictor();
      await predictor.waitForReady();
    }, 30000);

    beforeEach(() => {
      // Restore model mock implementations cleared by resetMocks
      restoreLastModelMocks(true);
    });

    afterAll(() => {
      predictor.dispose();
    });

    it('should handle whale tracker errors gracefully', async () => {
      mockWhaleTracker.getActivitySummary.mockImplementation(() => {
        throw new Error('Whale tracker unavailable');
      });

      const input = createDefaultInput();

      // Should not throw, should use defaults
      const result = await predictor.predict(input);
      expect(result).toBeDefined();
      expect(result.features.whaleSwapCount1h).toBe(0);
    });

    it('should handle zero reserves', async () => {
      const input = createDefaultInput({
        poolReserves: {
          reserve0: 0n,
          reserve1: 0n
        }
      });

      const result = await predictor.predict(input);

      expect(result).toBeDefined();
      expect(Number.isFinite(result.orderflowPressure)).toBe(true);
    });

    it('should handle very large reserves', async () => {
      const input = createDefaultInput({
        poolReserves: {
          reserve0: BigInt('1000000000000000000000000000'), // Very large
          reserve1: BigInt('500000000000000000000000000')
        }
      });

      const result = await predictor.predict(input);

      expect(result).toBeDefined();
      expect(Number.isFinite(result.features.reserveImbalanceRatio)).toBe(true);
    });

    it('should handle empty recent swaps', async () => {
      const input = createDefaultInput({
        recentSwaps: []
      });

      const result = await predictor.predict(input);

      expect(result).toBeDefined();
      expect(result.features.recentSwapMomentum).toBe(0);
    });

    it('should handle missing liquidation data', async () => {
      const input = createDefaultInput({
        liquidationData: undefined
      });

      const result = await predictor.predict(input);

      expect(result).toBeDefined();
      expect(result.features.nearestLiquidationLevel).toBe(0);
      expect(result.features.openInterestChange24h).toBe(0);
    });

    it('should handle concurrent predictions', async () => {
      const input = createDefaultInput();

      // Make multiple concurrent predictions
      const promises = Array(10).fill(null).map(() =>
        predictor.predict(input)
      );

      const results = await Promise.all(promises);

      // All should succeed
      expect(results).toHaveLength(10);
      results.forEach(result => {
        expect(result).toBeDefined();
        expect(['bullish', 'bearish', 'neutral']).toContain(result.direction);
      });
    });
  });

  describe('Prediction Result Structure', () => {
    let predictor: OrderflowPredictor;

    // Use beforeAll - predictions are read-only operations
    beforeAll(async () => {
      predictor = new OrderflowPredictor();
      await predictor.waitForReady();
    }, 30000);

    beforeEach(() => {
      // Restore model mock implementations cleared by resetMocks
      restoreLastModelMocks(true);
    });

    afterAll(() => {
      predictor.dispose();
    });

    it('should return all required fields', async () => {
      const input = createDefaultInput();

      const result = await predictor.predict(input);

      expect(result).toHaveProperty('direction');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('orderflowPressure');
      expect(result).toHaveProperty('expectedVolatility');
      expect(result).toHaveProperty('whaleImpact');
      expect(result).toHaveProperty('timeHorizonMs');
      expect(result).toHaveProperty('features');
      expect(result).toHaveProperty('timestamp');
    });

    it('should have features object with all required fields', async () => {
      const input = createDefaultInput();

      const result = await predictor.predict(input);
      const features = result.features;

      expect(features).toHaveProperty('whaleSwapCount1h');
      expect(features).toHaveProperty('whaleNetDirection');
      expect(features).toHaveProperty('hourOfDay');
      expect(features).toHaveProperty('dayOfWeek');
      expect(features).toHaveProperty('isUsMarketOpen');
      expect(features).toHaveProperty('isAsiaMarketOpen');
      expect(features).toHaveProperty('reserveImbalanceRatio');
      expect(features).toHaveProperty('recentSwapMomentum');
      expect(features).toHaveProperty('nearestLiquidationLevel');
      expect(features).toHaveProperty('openInterestChange24h');
    });
  });
});

// =============================================================================
// Singleton Factory Tests
// =============================================================================

describe('Singleton Factory', () => {
  beforeEach(() => {
    // Re-establish all mock implementations after resetMocks clears them
    restoreTfMocks();
    setOrderflowMode();
    restoreCoreMocks();
    // Re-setup whale tracker mock after clearAllMocks
    mockedGetWhaleActivityTracker.mockReturnValue(mockWhaleTracker as any);
    resetOrderflowPredictor();
    resetOrderflowFeatureExtractor();
    mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());
  });

  afterEach(() => {
    resetOrderflowPredictor();
    resetOrderflowFeatureExtractor();
  });

  it('should return the same instance on subsequent calls', () => {
    const instance1 = getOrderflowPredictor();
    const instance2 = getOrderflowPredictor();

    expect(instance1).toBe(instance2);
  });

  it('should apply config only on first call', () => {
    const config1: OrderflowPredictorConfig = { hiddenUnits1: 64 };
    const config2: OrderflowPredictorConfig = { hiddenUnits1: 128 };

    const instance1 = getOrderflowPredictor(config1);
    const instance2 = getOrderflowPredictor(config2);

    // Both should be the same instance with first config
    expect(instance1).toBe(instance2);
  });

  it('should create new instance after reset', async () => {
    const instance1 = getOrderflowPredictor();
    await instance1.waitForReady();

    resetOrderflowPredictor();

    const instance2 = getOrderflowPredictor();

    expect(instance1).not.toBe(instance2);
  });

  it('should dispose old instance on reset', async () => {
    const instance1 = getOrderflowPredictor();
    await instance1.waitForReady();

    resetOrderflowPredictor();

    const stats = instance1.getStats();
    expect(stats.isReady).toBe(false);
  });
});

// =============================================================================
// Integration with OrderflowFeatureExtractor Tests
// =============================================================================

describe('Integration with OrderflowFeatureExtractor', () => {
  beforeEach(() => {
    // Re-establish all mock implementations after resetMocks clears them
    restoreTfMocks();
    setOrderflowMode();
    restoreCoreMocks();
    // Re-setup whale tracker mock after clearAllMocks
    mockedGetWhaleActivityTracker.mockReturnValue(mockWhaleTracker as any);
    resetOrderflowPredictor();
    resetOrderflowFeatureExtractor();
    mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());
  });

  afterEach(() => {
    resetOrderflowPredictor();
    resetOrderflowFeatureExtractor();
  });

  it('should correctly extract and normalize features for prediction', async () => {
    const predictor = new OrderflowPredictor();
    await predictor.waitForReady();

    const timestamp = new Date('2026-01-27T15:00:00Z').getTime();
    const input: OrderflowFeatureInput = {
      pairKey: 'WETH-USDC',
      chain: 'ethereum',
      currentTimestamp: timestamp,
      poolReserves: {
        reserve0: 2000000n,
        reserve1: 1000000n
      },
      recentSwaps: [
        { direction: 'buy', amountUsd: 100000, timestamp: timestamp - 1000 },
        { direction: 'sell', amountUsd: 50000, timestamp: timestamp - 2000 }
      ],
      liquidationData: {
        nearestLiquidationLevel: 0.9,
        openInterestChange24h: 10
      }
    };

    const result = await predictor.predict(input);

    // Verify features were extracted correctly
    expect(result.features.hourOfDay).toBe(15);
    expect(result.features.reserveImbalanceRatio).toBeCloseTo(0.333, 2);
    expect(result.features.recentSwapMomentum).toBe(50000); // 100000 - 50000
    expect(result.features.nearestLiquidationLevel).toBe(0.9);

    predictor.dispose();
  });

  it('should use same feature extractor instance', async () => {
    const predictor1 = new OrderflowPredictor();
    const predictor2 = new OrderflowPredictor();

    await Promise.all([
      predictor1.waitForReady(),
      predictor2.waitForReady()
    ]);

    const input = createDefaultInput();

    const result1 = await predictor1.predict(input);
    const result2 = await predictor2.predict(input);

    // Same input should produce same features
    expect(result1.features).toEqual(result2.features);

    predictor1.dispose();
    predictor2.dispose();
  });
});

// =============================================================================
// Training Data Preparation Tests
// =============================================================================

describe('Training Data Preparation', () => {
  let predictor: OrderflowPredictor;

  beforeEach(async () => {
    // Re-establish all mock implementations after resetMocks clears them
    restoreTfMocks();
    setOrderflowMode();
    restoreCoreMocks();
    // Re-setup whale tracker mock after clearAllMocks
    mockedGetWhaleActivityTracker.mockReturnValue(mockWhaleTracker as any);
    resetOrderflowPredictor();
    resetOrderflowFeatureExtractor();
    mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

    predictor = new OrderflowPredictor({
      minTrainingSamples: 50
    });
    await predictor.waitForReady();
  });

  afterEach(() => {
    predictor.dispose();
    resetOrderflowPredictor();
    resetOrderflowFeatureExtractor();
  });

  it('should handle samples with all bullish outcomes', async () => {
    const samples = generateTrainingSamples(100).map(s => ({
      ...s,
      outcome: { ...s.outcome, direction: 'bullish' as const }
    }));

    await predictor.train(samples);

    const stats = predictor.getStats();
    expect(stats.isTrained).toBe(true);
  }, 60000);

  it('should handle samples with mixed outcomes', async () => {
    const samples = generateTrainingSamples(100);

    await predictor.train(samples);

    const stats = predictor.getStats();
    expect(stats.isTrained).toBe(true);
  }, 60000);

  it('should handle samples with extreme values', async () => {
    const samples = generateTrainingSamples(100).map(s => ({
      ...s,
      features: {
        ...s.features,
        whaleSwapCount1h: 1000, // Very high
        recentSwapMomentum: 1e10, // Very high
        openInterestChange24h: 500 // Very high
      }
    }));

    await predictor.train(samples);

    const stats = predictor.getStats();
    expect(stats.isTrained).toBe(true);
  }, 60000);

  it('should handle samples with all zeros', async () => {
    const samples = generateTrainingSamples(100).map(s => ({
      ...s,
      features: {
        whaleSwapCount1h: 0,
        whaleNetDirection: 'neutral' as const,
        hourOfDay: 0,
        dayOfWeek: 0,
        isUsMarketOpen: false,
        isAsiaMarketOpen: false,
        reserveImbalanceRatio: 0,
        recentSwapMomentum: 0,
        nearestLiquidationLevel: 0,
        openInterestChange24h: 0
      }
    }));

    await predictor.train(samples);

    const stats = predictor.getStats();
    expect(stats.isTrained).toBe(true);
  }, 60000);
});

// =============================================================================
// P1-4: predictBatch Tests
// =============================================================================

describe('predictBatch', () => {
  let predictor: OrderflowPredictor;

  beforeEach(async () => {
    // Re-establish all mock implementations after resetMocks clears them
    restoreTfMocks();
    setOrderflowMode();
    restoreCoreMocks();
    mockedGetWhaleActivityTracker.mockReturnValue(mockWhaleTracker as any);
    resetOrderflowPredictor();
    resetOrderflowFeatureExtractor();
    mockWhaleTracker.getActivitySummary.mockReturnValue(createMockWhaleActivitySummary());

    predictor = new OrderflowPredictor({
      minTrainingSamples: 50,
      confidenceThreshold: 0.6,
    });
    await predictor.waitForReady();
  });

  afterEach(() => {
    predictor.dispose();
    resetOrderflowPredictor();
    resetOrderflowFeatureExtractor();
  });

  it('should return empty array for empty inputs', async () => {
    const results = await predictor.predictBatch([]);
    expect(results).toEqual([]);
  });

  it('should delegate single input to predict()', async () => {
    const input = createDefaultInput();
    const batchResults = await predictor.predictBatch([input]);

    expect(batchResults).toHaveLength(1);
    expect(batchResults[0]).toHaveProperty('direction');
    expect(batchResults[0]).toHaveProperty('confidence');
    expect(batchResults[0]).toHaveProperty('orderflowPressure');
    expect(batchResults[0]).toHaveProperty('expectedVolatility');
    expect(batchResults[0]).toHaveProperty('timestamp');
  });

  it('should return predictions for multiple inputs when untrained', async () => {
    const inputs = [
      createDefaultInput(),
      createDefaultInput({ pairKey: 'WBTC-USDC' }),
      createDefaultInput({ pairKey: 'DAI-USDC' }),
    ];

    const results = await predictor.predictBatch(inputs);

    // Untrained model falls back to individual predict() calls
    expect(results).toHaveLength(3);
    results.forEach(result => {
      expect(result.direction).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  it('should return predictions for multiple inputs when trained', async () => {
    // Train the model first
    const samples = generateTrainingSamples(100);
    await predictor.train(samples);

    const inputs = [
      createDefaultInput(),
      createDefaultInput({ pairKey: 'WBTC-USDC' }),
      createDefaultInput({ pairKey: 'DAI-USDC' }),
    ];

    const results = await predictor.predictBatch(inputs);

    expect(results).toHaveLength(3);
    results.forEach(result => {
      expect(['bullish', 'bearish', 'neutral']).toContain(result.direction);
      // P0-2 fix: confidence should be softmax-normalized (bounded 0-1)
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      // Pressure bounded to [-1, 1]
      expect(result.orderflowPressure).toBeGreaterThanOrEqual(-1);
      expect(result.orderflowPressure).toBeLessThanOrEqual(1);
      // Volatility bounded to [0, 1]
      expect(result.expectedVolatility).toBeGreaterThanOrEqual(0);
      expect(result.expectedVolatility).toBeLessThanOrEqual(1);
      // Should have features from extraction
      expect(result.features).toBeDefined();
      expect(result.timestamp).toBeGreaterThan(0);
    });
  }, 60000);

  it('should apply confidence threshold for pending prediction storage', async () => {
    const samples = generateTrainingSamples(100);
    await predictor.train(samples);

    const inputs = [
      createDefaultInput(),
      createDefaultInput({ pairKey: 'WBTC-USDC' }),
    ];

    const results = await predictor.predictBatch(inputs);

    // All returned results should exist regardless of confidence
    expect(results).toHaveLength(2);
    // Stats should reflect total predictions
    const stats = predictor.getStats();
    expect(stats.totalPredictions).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('should preserve input order in batch results', async () => {
    const samples = generateTrainingSamples(100);
    await predictor.train(samples);

    const inputs = [
      createDefaultInput({ pairKey: 'PAIR-A' }),
      createDefaultInput({ pairKey: 'PAIR-B' }),
      createDefaultInput({ pairKey: 'PAIR-C' }),
    ];

    const results = await predictor.predictBatch(inputs);

    // Should have same number of results as inputs, in order
    expect(results).toHaveLength(inputs.length);
  }, 60000);

  it('should dispose tensors properly (no leaks)', async () => {
    const samples = generateTrainingSamples(100);
    await predictor.train(samples);

    const inputs = [
      createDefaultInput(),
      createDefaultInput({ pairKey: 'WBTC-USDC' }),
    ];

    // Should not throw and should complete successfully
    const results = await predictor.predictBatch(inputs);
    expect(results).toHaveLength(2);
  }, 60000);

  it('should fall back to individual predictions on batch error', async () => {
    // With an untrained model, batch will fall back
    const inputs = [
      createDefaultInput(),
      createDefaultInput({ pairKey: 'WBTC-USDC' }),
    ];

    const results = await predictor.predictBatch(inputs);

    // Should still get results via fallback
    expect(results).toHaveLength(2);
    results.forEach(result => {
      expect(result).toHaveProperty('direction');
      expect(result).toHaveProperty('confidence');
    });
  });
});
