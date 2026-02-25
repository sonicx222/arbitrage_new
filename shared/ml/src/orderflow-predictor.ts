/**
 * T4.3.2: Orderflow Predictor Model
 *
 * Neural network model for predicting orderflow patterns and market direction
 * based on extracted orderflow features.
 *
 * This model complements the LSTMPredictor with orderflow-specific predictions:
 * - Short-term price direction (1-5 minutes)
 * - Orderflow pressure (buying vs selling)
 * - Volatility expectations
 * - Whale activity impact prediction
 *
 * Architecture:
 * - 3-layer dense network with dropout for regularization
 * - Batch normalization for training stability
 * - Multi-output heads for different prediction targets
 *
 * Bug fixes and optimizations:
 * - Fix 4.1: Accurate accuracy calculation using validated predictions count
 * - Fix 4.2: Bounds check for feature buffer access
 * - Fix 4.4: Improved stale prediction handling with sorted Map
 * - Fix 5.1: Atomic training mutex using Promise-based lock
 * - Perf 10.1: Direct Float64Array usage without Array.from()
 * - Perf 10.3: Optimized pending prediction cleanup
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4, Task 4.3.2
 */

import * as tf from '@tensorflow/tfjs';
import { AsyncMutex } from '@arbitrage/core/async';
import { createLogger } from '@arbitrage/core';
import {
  OrderflowFeatureExtractor,
  OrderflowFeatures,
  OrderflowFeatureInput,
  getOrderflowFeatureExtractor,
  ORDERFLOW_FEATURE_COUNT
} from './orderflow-features';
import { MarketDirection } from './direction-types';
import { SynchronizedStats } from './synchronized-stats';

const logger = createLogger('orderflow-predictor');

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for OrderflowPredictor
 */
export interface OrderflowPredictorConfig {
  /** Number of hidden units in first dense layer (default: 64) */
  hiddenUnits1?: number;
  /** Number of hidden units in second dense layer (default: 32) */
  hiddenUnits2?: number;
  /** Dropout rate for regularization (default: 0.3) */
  dropoutRate?: number;
  /** Learning rate for optimizer (default: 0.001) */
  learningRate?: number;
  /** Confidence threshold for predictions (default: 0.6) */
  confidenceThreshold?: number;
  /** Time horizon for predictions in ms (default: 60000 = 1 minute) */
  predictionTimeHorizonMs?: number;
  /** Number of output classes for direction (default: 3 = up/down/neutral) */
  directionClasses?: number;
  /** Minimum samples for training (default: 100) */
  minTrainingSamples?: number;
  /** Maximum history size for online learning (default: 5000) */
  maxHistorySize?: number;
}

const DEFAULT_CONFIG: Required<OrderflowPredictorConfig> = {
  hiddenUnits1: 64,
  hiddenUnits2: 32,
  dropoutRate: 0.3,
  learningRate: 0.001,
  confidenceThreshold: 0.6,
  predictionTimeHorizonMs: 60000, // 1 minute
  directionClasses: 3,
  minTrainingSamples: 100,
  maxHistorySize: 5000
};

// =============================================================================
// Types
// =============================================================================

/**
 * Orderflow prediction result
 */
export interface OrderflowPrediction {
  /** Predicted price direction */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** Confidence score (0-1) */
  confidence: number;
  /** Predicted orderflow pressure (-1 to 1, positive = buying) */
  orderflowPressure: number;
  /** Predicted volatility (normalized 0-1) */
  expectedVolatility: number;
  /** Whale impact score (0-1, how much whale activity will affect price) */
  whaleImpact: number;
  /** Time horizon for prediction in ms */
  timeHorizonMs: number;
  /** Input features used for prediction */
  features: OrderflowFeatures;
  /** Timestamp of prediction */
  timestamp: number;
}

/**
 * Training sample for the model
 */
export interface OrderflowTrainingSample {
  /** Input features */
  features: OrderflowFeatures;
  /** Actual outcome */
  outcome: {
    /** Actual price direction that occurred */
    direction: 'bullish' | 'bearish' | 'neutral';
    /** Actual price change percentage */
    priceChangePercent: number;
    /** Actual volatility observed */
    volatility: number;
  };
  /** Timestamp when sample was created */
  timestamp: number;
}

/**
 * Training data batch
 */
export interface OrderflowTrainingBatch {
  inputs: number[][];
  directionLabels: number[][];
  pressureLabels: number[];
  volatilityLabels: number[];
  whaleImpactLabels: number[];
  timestamps: number[];
}

/**
 * Model statistics
 *
 * Fix 4.1: Added validatedPredictions for accurate accuracy calculation.
 */
export interface OrderflowModelStats {
  isReady: boolean;
  isTrained: boolean;
  isTraining: boolean;
  trainingHistorySize: number;
  lastTrainingTime: number;
  totalPredictions: number;
  /** Number of predictions that have been validated against actual outcomes */
  validatedPredictions: number;
  /** Number of correct predictions (direction matched) */
  correctPredictions: number;
  /** Accuracy = correctPredictions / validatedPredictions (0 if no validations) */
  accuracy: number;
  pendingValidations: number;
}

// =============================================================================
// OrderflowSignal Type (Fix 1.1: Co-located with OrderflowPrediction)
// =============================================================================

/**
 * Orderflow signal for integration with MLOpportunityScorer.
 * This is the interface used by the core module to receive orderflow predictions.
 *
 * Fix 1.1: Moved from @arbitrage/core to @arbitrage/ml for better colocation
 * with the OrderflowPredictor that produces these signals.
 */
export interface OrderflowSignal {
  /** Market direction prediction */
  direction: MarketDirection;
  /** Confidence score (0-1) */
  confidence: number;
  /** Orderflow pressure (-1 to 1, positive = net buying) */
  pressure: number;
  /** Expected volatility (0-1) */
  expectedVolatility: number;
  /** Whale activity impact (0-1) */
  whaleImpact: number;
  /** Prediction timestamp */
  timestamp: number;
  /** Time horizon in milliseconds */
  timeHorizonMs: number;
}

/**
 * Convert an OrderflowPrediction to an OrderflowSignal for use with MLOpportunityScorer.
 *
 * Fix 1.1: Moved from @arbitrage/core to @arbitrage/ml for better colocation.
 *
 * @param prediction - OrderflowPrediction from OrderflowPredictor
 * @returns OrderflowSignal for MLOpportunityScorer
 */
export function toOrderflowSignal(prediction: OrderflowPrediction): OrderflowSignal {
  return {
    direction: prediction.direction,
    confidence: prediction.confidence,
    pressure: prediction.orderflowPressure,
    expectedVolatility: prediction.expectedVolatility,
    whaleImpact: prediction.whaleImpact,
    timestamp: prediction.timestamp,
    timeHorizonMs: prediction.timeHorizonMs
  };
}

// =============================================================================
// OrderflowPredictor Class
// =============================================================================

/**
 * T4.3.2: Orderflow Predictor
 *
 * Neural network for orderflow pattern prediction.
 * Uses features from OrderflowFeatureExtractor to predict short-term market behavior.
 *
 * Thread-safety and performance optimizations:
 * - Uses AsyncMutex for training to prevent concurrent execution (Fix 5.1)
 * - Uses SynchronizedStats for accurate metrics tracking (Fix 4.1, 5.2)
 * - Pre-allocated Float64Array with bounds validation (Fix 4.2, Perf 10.1)
 * - Optimized pending prediction tracking (Fix 4.4, Perf 10.3)
 *
 * P2-3 note: Model persistence is not yet implemented for OrderflowPredictor.
 * ADR-025 specifies an `orderflow-predictor/` model directory, but this class
 * does not currently save/load model weights. LSTMPredictor has persistence.
 * Implementing persistence here would follow the same pattern as predictor.ts.
 */
export class OrderflowPredictor {
  private model: tf.LayersModel | null = null;
  private readonly config: Required<OrderflowPredictorConfig>;
  private readonly featureExtractor: OrderflowFeatureExtractor;

  // Training history for online learning
  private trainingHistory: OrderflowTrainingSample[] = [];
  private lastTrainingTime = 0;

  // Fix 4.1/5.2: Thread-safe statistics tracking
  private readonly stats: SynchronizedStats;

  // Ready promise for async initialization
  private readonly modelReady: Promise<void>;
  private modelInitError: Error | null = null;
  private isTrained = false;

  // Fix 5.1: Atomic mutex for concurrent training protection
  private readonly trainingMutex: AsyncMutex;

  // Fix 4.4/Perf 10.3: Sorted pending predictions for efficient cleanup
  // Key is timestamp, value is prediction. Map maintains insertion order.
  private pendingPredictions: Map<number, OrderflowPrediction> = new Map();
  // Track timestamps separately for O(1) oldest lookup
  private oldestPendingTimestamp: number = Infinity;

  // Perf 10.1: Pre-allocated buffer for predictions with bounds validation
  private readonly inputBuffer: Float64Array;
  private readonly INPUT_BUFFER_SIZE = ORDERFLOW_FEATURE_COUNT;

  // P0-2 fix: Monotonic counter for unique pending prediction keys in batch mode
  private pendingPredictionCounter = 0;

  constructor(
    config: OrderflowPredictorConfig = {},
    featureExtractor?: OrderflowFeatureExtractor
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.featureExtractor = featureExtractor ?? getOrderflowFeatureExtractor();

    // Fix 4.2: Validate buffer size matches expected feature count
    if (ORDERFLOW_FEATURE_COUNT !== 10) {
      logger.warn('ORDERFLOW_FEATURE_COUNT changed from expected 10', {
        expected: 10,
        actual: ORDERFLOW_FEATURE_COUNT
      });
    }
    this.inputBuffer = new Float64Array(this.INPUT_BUFFER_SIZE);

    // Fix 5.1: Initialize async mutex for training
    this.trainingMutex = new AsyncMutex();

    // Fix 4.1/5.2: Initialize synchronized stats
    this.stats = new SynchronizedStats({
      initialCounters: {
        totalPredictions: 0,
        validatedPredictions: 0,
        correctPredictions: 0,
        highConfidencePredictions: 0
      },
      initialAccumulators: {}
    });

    this.modelReady = this.initializeModel().catch(err => {
      this.modelInitError = err instanceof Error ? err : new Error(String(err));
      logger.error('Orderflow model initialization failed:', this.modelInitError);
    });
  }

  /**
   * Wait for model to be ready.
   */
  async waitForReady(): Promise<void> {
    await this.modelReady;
    if (this.modelInitError) {
      throw this.modelInitError;
    }
  }

  /**
   * Check if model is ready for predictions.
   */
  isReady(): boolean {
    return this.model !== null && !this.modelInitError;
  }

  private async initializeModel(): Promise<void> {
    try {
      const model = tf.sequential();

      // Input layer with batch normalization
      model.add(tf.layers.dense({
        units: this.config.hiddenUnits1,
        inputShape: [ORDERFLOW_FEATURE_COUNT],
        activation: 'relu',
        kernelInitializer: 'heNormal'
      }));
      model.add(tf.layers.batchNormalization());
      model.add(tf.layers.dropout({ rate: this.config.dropoutRate }));

      // Hidden layer
      model.add(tf.layers.dense({
        units: this.config.hiddenUnits2,
        activation: 'relu',
        kernelInitializer: 'heNormal'
      }));
      model.add(tf.layers.batchNormalization());
      model.add(tf.layers.dropout({ rate: this.config.dropoutRate }));

      // Output layer: [direction(3), pressure(1), volatility(1), whaleImpact(1)]
      // Total: 6 outputs
      model.add(tf.layers.dense({
        units: this.config.directionClasses + 3,
        activation: 'linear'
      }));

      model.compile({
        optimizer: tf.train.adam(this.config.learningRate),
        loss: 'meanSquaredError',
        metrics: ['mae']
      });

      this.model = model;

      // Warm up with dummy prediction
      await this.warmupModel();

      logger.info('Orderflow predictor model initialized');
    } catch (error) {
      logger.error('Failed to initialize orderflow model:', error);
      throw error;
    }
  }

  private async warmupModel(): Promise<void> {
    if (!this.model) return;

    const warmupTensor = tf.zeros([1, ORDERFLOW_FEATURE_COUNT]);
    try {
      const prediction = this.model.predict(warmupTensor) as tf.Tensor;
      await prediction.data();
      prediction.dispose();
    } finally {
      warmupTensor.dispose();
    }
  }

  /**
   * Predict orderflow patterns from market data.
   *
   * Performance optimizations (Perf 10.1):
   * - Uses pre-allocated Float64Array directly without Array.from()
   * - Reuses input buffer across predictions
   *
   * @param input - Orderflow feature input
   * @returns Prediction result
   */
  async predict(input: OrderflowFeatureInput): Promise<OrderflowPrediction> {
    await this.modelReady;

    // Extract features
    const features = this.featureExtractor.extractFeatures(input);
    const normalizedFeatures = this.featureExtractor.normalizeFeatures(features);

    // Fix 4.1: Track all predictions atomically
    this.stats.increment('totalPredictions');

    // Check if model is ready and trained
    if (!this.model || this.modelInitError || !this.isTrained) {
      return this.fallbackPrediction(features);
    }

    try {
      // Fix 4.2: Prepare input with bounds checking
      this.fillInputBuffer(normalizedFeatures);

      // P2-6 fix: Pass Float64Array directly to tf.tensor instead of
      // allocating a new array with Array.from(), preserving pre-allocation benefit.
      const inputTensor = tf.tensor(this.inputBuffer, [1, this.INPUT_BUFFER_SIZE]);

      try {
        const output = this.model.predict(inputTensor) as tf.Tensor;
        const result = await output.data();
        output.dispose();

        // Parse output: [bullish, neutral, bearish, pressure, volatility, whaleImpact]
        const directionScores = [result[0], result[1], result[2]];
        const maxScore = Math.max(...directionScores);
        const maxIdx = directionScores.indexOf(maxScore);

        const directions: Array<'bullish' | 'neutral' | 'bearish'> = ['bullish', 'neutral', 'bearish'];
        const direction = directions[maxIdx];

        // Apply softmax-like normalization for confidence
        const expScores = directionScores.map(s => Math.exp(s));
        const sumExp = expScores.reduce((a, b) => a + b, 0);
        const confidence = sumExp > 0 ? expScores[maxIdx] / sumExp : 0.33;

        const orderflowPressure = Math.max(-1, Math.min(1, result[3]));
        const expectedVolatility = Math.max(0, Math.min(1, result[4]));
        const whaleImpact = Math.max(0, Math.min(1, result[5]));

        const prediction: OrderflowPrediction = {
          direction,
          confidence,
          orderflowPressure,
          expectedVolatility,
          whaleImpact,
          timeHorizonMs: this.config.predictionTimeHorizonMs,
          features,
          timestamp: Date.now()
        };

        // Store prediction for accuracy tracking if confidence is above threshold
        if (confidence >= this.config.confidenceThreshold) {
          this.stats.increment('highConfidencePredictions');
          this.addPendingPrediction(prediction);
        }

        return prediction;
      } finally {
        inputTensor.dispose();
      }
    } catch (error) {
      logger.error('Orderflow prediction failed, using fallback:', error);
      return this.fallbackPrediction(features);
    }
  }

  /**
   * Fix 4.2: Fill input buffer with bounds checking.
   * Validates that all indices are within buffer bounds.
   */
  private fillInputBuffer(normalizedFeatures: ReturnType<OrderflowFeatureExtractor['normalizeFeatures']>): void {
    // Validate buffer size
    if (this.inputBuffer.length < 10) {
      throw new Error(`Input buffer too small: ${this.inputBuffer.length} < 10`);
    }

    this.inputBuffer[0] = normalizedFeatures.whaleSwapCount1h;
    this.inputBuffer[1] = normalizedFeatures.whaleNetDirection;
    this.inputBuffer[2] = normalizedFeatures.hourOfDay;
    this.inputBuffer[3] = normalizedFeatures.dayOfWeek;
    this.inputBuffer[4] = normalizedFeatures.isUsMarketOpen;
    this.inputBuffer[5] = normalizedFeatures.isAsiaMarketOpen;
    this.inputBuffer[6] = normalizedFeatures.reserveImbalanceRatio;
    this.inputBuffer[7] = normalizedFeatures.recentSwapMomentum;
    this.inputBuffer[8] = normalizedFeatures.nearestLiquidationLevel;
    this.inputBuffer[9] = normalizedFeatures.openInterestChange24h;
  }

  /**
   * Fix 4.4/Perf 10.3: Add pending prediction with optimized tracking.
   */
  private addPendingPrediction(prediction: OrderflowPrediction): void {
    this.pendingPredictions.set(prediction.timestamp, prediction);

    // Track oldest timestamp for O(1) cleanup
    if (prediction.timestamp < this.oldestPendingTimestamp) {
      this.oldestPendingTimestamp = prediction.timestamp;
    }

    // Bound pending predictions to prevent memory leak
    if (this.pendingPredictions.size > 1000) {
      this.cleanupOldestPendingPredictions(100);
    }
  }

  /**
   * Fix 4.4/Perf 10.3: Remove oldest pending predictions efficiently.
   */
  private cleanupOldestPendingPredictions(count: number): void {
    let removed = 0;
    for (const key of this.pendingPredictions.keys()) {
      if (removed >= count) break;
      this.pendingPredictions.delete(key);
      removed++;
    }

    // Update oldest timestamp
    if (this.pendingPredictions.size > 0) {
      this.oldestPendingTimestamp = this.pendingPredictions.keys().next().value ?? Infinity;
    } else {
      this.oldestPendingTimestamp = Infinity;
    }
  }

  /**
   * Train the model with a batch of samples.
   *
   * Fix 5.1: Uses AsyncMutex for atomic training to prevent race conditions.
   * Previous implementation used a boolean flag which was not atomic.
   */
  async train(samples: OrderflowTrainingSample[]): Promise<void> {
    await this.modelReady;

    if (!this.model) {
      throw new Error('Model not initialized');
    }

    if (samples.length < this.config.minTrainingSamples) {
      logger.warn('Insufficient training samples', {
        provided: samples.length,
        required: this.config.minTrainingSamples
      });
      return;
    }

    // Fix 5.1: Use atomic mutex - tryAcquire returns release fn or null if locked
    const releaseFn = this.trainingMutex.tryAcquire();
    if (!releaseFn) {
      logger.warn('Training already in progress, skipping');
      return;
    }

    try {
      logger.info(`Training orderflow model with ${samples.length} samples`);

      const batch = this.prepareBatch(samples);
      const inputs = tf.tensor2d(batch.inputs);
      const outputs = tf.tensor2d(
        batch.directionLabels.map((dir, i) => [
          ...dir,
          batch.pressureLabels[i],
          batch.volatilityLabels[i],
          batch.whaleImpactLabels[i]
        ])
      );

      try {
        await this.model.fit(inputs, outputs, {
          epochs: 30,
          batchSize: Math.min(32, samples.length),
          validationSplit: 0.2,
          callbacks: {
            onEpochEnd: (epoch, logs) => {
              if (epoch % 10 === 0 && logs) {
                logger.debug(`Orderflow training epoch ${epoch}: loss=${logs.loss?.toFixed(4)}`);
              }
            }
          }
        });

        this.isTrained = true;
        this.lastTrainingTime = Date.now();
        logger.info('Orderflow model training completed');
      } finally {
        inputs.dispose();
        outputs.dispose();
      }
    } catch (error) {
      logger.error('Orderflow training failed:', error);
      throw error;
    } finally {
      // Fix 5.1: Release by calling the release function
      releaseFn();
    }
  }

  /**
   * Check if training is currently in progress.
   */
  isTrainingInProgress(): boolean {
    return this.trainingMutex.isLocked();
  }

  /**
   * Add a training sample for online learning.
   * Also validates pending predictions against actual outcomes for accuracy tracking.
   *
   * Fix 4.1: Properly tracks validated vs total predictions for accurate accuracy.
   * Fix 4.4: Improved stale prediction handling.
   * Perf 10.3: Optimized Map iteration - only iterates when necessary.
   */
  addTrainingSample(sample: OrderflowTrainingSample): void {
    this.trainingHistory.push(sample);

    // Track accuracy by validating pending predictions against actual outcome
    const predictionWindow = this.config.predictionTimeHorizonMs;
    const sampleTime = sample.timestamp;

    // Perf 10.3: Early exit if no pending predictions or sample is too old
    if (this.pendingPredictions.size === 0) {
      this.maintainHistoryBounds();
      return;
    }

    // Perf 10.3: Quick check if this sample could possibly match any prediction
    // If sample is older than newest pending - oldest, skip iteration
    if (sampleTime < this.oldestPendingTimestamp) {
      this.maintainHistoryBounds();
      return;
    }

    // Collect keys to delete after iteration (avoid modifying during iteration)
    const keysToDelete: number[] = [];
    const staleThreshold = sampleTime - predictionWindow * 2;

    for (const [predictionTime, prediction] of this.pendingPredictions) {
      const timeDiff = sampleTime - predictionTime;

      if (timeDiff > 0 && timeDiff <= predictionWindow * 1.5) {
        // Fix 4.1: Track validated predictions separately
        this.stats.increment('validatedPredictions');

        // Validate prediction direction against actual outcome
        if (prediction.direction === sample.outcome.direction) {
          this.stats.increment('correctPredictions');
        }

        keysToDelete.push(predictionTime);
      } else if (predictionTime < staleThreshold) {
        // Fix 4.4: Remove stale predictions (no matching sample received)
        // Count as validated but not correct (timed out)
        this.stats.increment('validatedPredictions');
        keysToDelete.push(predictionTime);
      }
    }

    // Delete collected keys
    for (const key of keysToDelete) {
      this.pendingPredictions.delete(key);
    }

    // Update oldest timestamp if we deleted some
    if (keysToDelete.length > 0 && this.pendingPredictions.size > 0) {
      this.oldestPendingTimestamp = this.pendingPredictions.keys().next().value ?? Infinity;
    } else if (this.pendingPredictions.size === 0) {
      this.oldestPendingTimestamp = Infinity;
    }

    this.maintainHistoryBounds();
  }

  /**
   * Maintain bounded history size.
   */
  private maintainHistoryBounds(): void {
    // Keep history bounded
    while (this.trainingHistory.length > this.config.maxHistorySize) {
      this.trainingHistory.shift();
    }
  }

  /**
   * Retrain model using accumulated history.
   */
  async retrainOnHistory(): Promise<void> {
    if (this.trainingHistory.length < this.config.minTrainingSamples) {
      logger.info('Insufficient history for retraining', {
        available: this.trainingHistory.length,
        required: this.config.minTrainingSamples
      });
      return;
    }

    await this.train(this.trainingHistory);
  }

  /**
   * Get model statistics.
   *
   * Fix 4.1: Uses SynchronizedStats for accurate tracking of validated predictions.
   * Accuracy is now calculated as correctPredictions / validatedPredictions,
   * where validatedPredictions only includes predictions that have been
   * matched against actual outcomes.
   */
  getStats(): OrderflowModelStats {
    const totalPredictions = this.stats.getCounter('totalPredictions');
    const validatedPredictions = this.stats.getCounter('validatedPredictions');
    const correctPredictions = this.stats.getCounter('correctPredictions');

    // Fix 4.1: Calculate accuracy only from validated predictions
    const accuracy = validatedPredictions > 0
      ? correctPredictions / validatedPredictions
      : 0;

    return {
      isReady: this.isReady(),
      isTrained: this.isTrained,
      isTraining: this.trainingMutex.isLocked(),
      trainingHistorySize: this.trainingHistory.length,
      lastTrainingTime: this.lastTrainingTime,
      totalPredictions,
      validatedPredictions,
      correctPredictions,
      accuracy,
      pendingValidations: this.pendingPredictions.size
    };
  }

  /**
   * Dispose model resources.
   */
  dispose(): void {
    if (this.model) {
      this.model.dispose();
      this.model = null;
    }
    this.trainingHistory = [];
    this.pendingPredictions.clear();
    this.oldestPendingTimestamp = Infinity;
    this.pendingPredictionCounter = 0;
    this.isTrained = false;
    this.stats.reset();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private fallbackPrediction(features: OrderflowFeatures): OrderflowPrediction {
    // Heuristic-based prediction when model isn't trained
    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let orderflowPressure = 0;

    // Use whale direction as primary signal
    if (features.whaleNetDirection === 'accumulating') {
      direction = 'bullish';
      orderflowPressure = 0.5;
    } else if (features.whaleNetDirection === 'distributing') {
      direction = 'bearish';
      orderflowPressure = -0.5;
    }

    // Adjust based on momentum
    if (features.recentSwapMomentum > 1000000) {
      direction = 'bullish';
      orderflowPressure = Math.max(orderflowPressure, 0.3);
    } else if (features.recentSwapMomentum < -1000000) {
      direction = 'bearish';
      orderflowPressure = Math.min(orderflowPressure, -0.3);
    }

    // Estimate volatility from whale count
    const expectedVolatility = Math.min(features.whaleSwapCount1h / 20, 1);

    // Whale impact based on swap count
    const whaleImpact = Math.min(features.whaleSwapCount1h / 10, 1);

    return {
      direction,
      confidence: 0.4, // Lower confidence for heuristic
      orderflowPressure,
      expectedVolatility,
      whaleImpact,
      timeHorizonMs: this.config.predictionTimeHorizonMs,
      features,
      timestamp: Date.now()
    };
  }

  private prepareBatch(samples: OrderflowTrainingSample[]): OrderflowTrainingBatch {
    const inputs: number[][] = [];
    const directionLabels: number[][] = [];
    const pressureLabels: number[] = [];
    const volatilityLabels: number[] = [];
    const whaleImpactLabels: number[] = [];
    const timestamps: number[] = [];

    for (const sample of samples) {
      const normalized = this.featureExtractor.normalizeFeatures(sample.features);

      inputs.push([
        normalized.whaleSwapCount1h,
        normalized.whaleNetDirection,
        normalized.hourOfDay,
        normalized.dayOfWeek,
        normalized.isUsMarketOpen,
        normalized.isAsiaMarketOpen,
        normalized.reserveImbalanceRatio,
        normalized.recentSwapMomentum,
        normalized.nearestLiquidationLevel,
        normalized.openInterestChange24h
      ]);

      // One-hot encode direction
      const dirLabel = [0, 0, 0];
      if (sample.outcome.direction === 'bullish') dirLabel[0] = 1;
      else if (sample.outcome.direction === 'neutral') dirLabel[1] = 1;
      else dirLabel[2] = 1;
      directionLabels.push(dirLabel);

      // Normalize pressure from price change
      pressureLabels.push(Math.max(-1, Math.min(1, sample.outcome.priceChangePercent / 5)));

      // Normalize volatility
      volatilityLabels.push(Math.min(sample.outcome.volatility / 0.1, 1));

      // Calculate whale impact from features (normalized 0-1)
      // Impact is based on whale count and volatility correlation
      const whaleImpact = Math.min(1, (sample.features.whaleSwapCount1h / 20) *
        (1 + Math.abs(sample.outcome.priceChangePercent) / 10));
      whaleImpactLabels.push(whaleImpact);

      timestamps.push(sample.timestamp);
    }

    return { inputs, directionLabels, pressureLabels, volatilityLabels, whaleImpactLabels, timestamps };
  }

  // ===========================================================================
  // FIX 10.2: Batch Prediction for Performance
  // ===========================================================================

  /**
   * FIX 10.2: Predict multiple inputs in a single batch for better performance.
   *
   * Batch prediction is significantly faster than individual predictions because:
   * - Single tensor operation vs N operations
   * - Better GPU/WASM utilization
   * - Reduced async overhead
   *
   * @param inputs - Array of feature inputs to predict
   * @returns Array of predictions (same order as inputs)
   */
  async predictBatch(inputs: OrderflowFeatureInput[]): Promise<OrderflowPrediction[]> {
    if (inputs.length === 0) return [];

    // Single input - use regular predict
    if (inputs.length === 1) {
      return [await this.predict(inputs[0])];
    }

    await this.modelReady;

    // Check if model is ready
    if (!this.model || this.modelInitError || !this.isTrained) {
      // Fall back to individual predictions with fallback
      return Promise.all(inputs.map(input => this.predict(input)));
    }

    try {
      // Extract and normalize features for all inputs
      const featurePairs = inputs.map(input => {
        const features = this.featureExtractor.extractFeatures(input);
        const normalized = this.featureExtractor.normalizeFeatures(features);
        return { features, normalized };
      });

      // Build batch tensor from normalized features
      const batchInputs = featurePairs.map(({ normalized }) => [
        normalized.whaleSwapCount1h,
        normalized.whaleNetDirection,
        normalized.hourOfDay,
        normalized.dayOfWeek,
        normalized.isUsMarketOpen,
        normalized.isAsiaMarketOpen,
        normalized.reserveImbalanceRatio,
        normalized.recentSwapMomentum,
        normalized.nearestLiquidationLevel,
        normalized.openInterestChange24h
      ]);

      const inputTensor = tf.tensor2d(batchInputs);

      try {
        const output = this.model.predict(inputTensor) as tf.Tensor;
        const results = await output.array() as number[][];
        output.dispose();

        // Parse batch results
        const predictions: OrderflowPrediction[] = results.map((result, idx) => {
          // Track all predictions atomically
          this.stats.increment('totalPredictions');

          // Parse output: [bullish, neutral, bearish, pressure, volatility, whaleImpact]
          const directionScores = [result[0], result[1], result[2]];
          const maxScore = Math.max(...directionScores);
          const maxIndex = directionScores.indexOf(maxScore);

          const direction: MarketDirection =
            maxIndex === 0 ? 'bullish' :
            maxIndex === 2 ? 'bearish' : 'neutral';

          // P0-2 fix: Apply softmax normalization matching predict() behavior.
          // Previously used raw maxScore which is unbounded; softmax produces [0,1].
          const expScores = directionScores.map(s => Math.exp(s));
          const sumExp = expScores.reduce((a, b) => a + b, 0);
          const confidence = sumExp > 0 ? expScores[maxIndex] / sumExp : 0.33;

          const pressure = Math.max(-1, Math.min(1, result[3]));
          const volatility = Math.max(0, Math.min(1, result[4]));
          const whaleImpact = Math.max(0, Math.min(1, result[5]));

          const prediction: OrderflowPrediction = {
            direction,
            confidence,
            orderflowPressure: pressure,
            expectedVolatility: volatility,
            whaleImpact,
            timestamp: Date.now(),
            timeHorizonMs: this.config.predictionTimeHorizonMs,
            features: featurePairs[idx].features // Use original features, not normalized
          };

          // P0-2 fix: Apply same confidence threshold as predict() before storing
          if (confidence >= this.config.confidenceThreshold) {
            this.stats.increment('highConfidencePredictions');
            // Use monotonic counter to generate unique keys for batch items.
            // addPendingPrediction uses prediction.timestamp as Map key, and
            // batch items share the same Date.now(). Adding a sub-ms counter
            // offset ensures unique keys while preserving approximate time ordering.
            const uniqueKey = prediction.timestamp + (this.pendingPredictionCounter++ * 0.001);
            this.pendingPredictions.set(uniqueKey, prediction);
            if (uniqueKey < this.oldestPendingTimestamp) {
              this.oldestPendingTimestamp = uniqueKey;
            }
            if (this.pendingPredictions.size > 1000) {
              this.cleanupOldestPendingPredictions(100);
            }
          }

          return prediction;
        });

        return predictions;
      } finally {
        inputTensor.dispose();
      }
    } catch (error) {
      logger.error('Batch prediction failed, falling back to individual', { error });
      // Fall back to individual predictions
      return Promise.all(inputs.map(input => this.predict(input)));
    }
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let predictorInstance: OrderflowPredictor | null = null;

/**
 * Get the singleton OrderflowPredictor instance.
 */
export function getOrderflowPredictor(config?: OrderflowPredictorConfig): OrderflowPredictor {
  if (!predictorInstance) {
    predictorInstance = new OrderflowPredictor(config);
  }
  return predictorInstance;
}

/**
 * Reset the singleton instance.
 * Use for testing or reconfiguration.
 */
export function resetOrderflowPredictor(): void {
  if (predictorInstance) {
    predictorInstance.dispose();
    predictorInstance = null;
  }
}
