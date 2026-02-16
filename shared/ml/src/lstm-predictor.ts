/**
 * LSTM-based Price Predictor
 *
 * Advanced price forecasting for arbitrage trading using TensorFlow.js.
 * Uses a 2-layer LSTM network (128->64 units) with Huber loss.
 *
 * Extracted from predictor.ts (P3-1 refactoring) for single-responsibility.
 *
 * Bug fixes and optimizations:
 * - Fix 5.1: Atomic training mutex using AsyncMutex
 * - Fix 7.1: Enhanced retrain error handling with retry logic
 * - Fix 7.3: Integrated volume features into feature extraction
 * - Perf 10.2: Pre-allocated feature arrays to reduce allocations
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4
 */

import * as tf from '@tensorflow/tfjs';
import { createLogger, AsyncMutex } from '@arbitrage/core';
import { getModelPersistence, type ModelMetadata } from './model-persistence';
import {
  calculateSMA,
  calculateMean,
  calculateMomentum,
  calculateVolatility,
  calculateTrend,
} from './feature-math';
import type {
  PriceHistory,
  PredictionResult,
  PredictionContext,
  TrainingData,
  PredictionHistoryEntry,
} from './predictor-types';

const logger = createLogger('ml-predictor');

// Fix 7.1: Retry configuration for retraining
const RETRAIN_MAX_ATTEMPTS = 3;
const RETRAIN_BACKOFF_MS = 5000;

// =============================================================================
// Configuration
// =============================================================================

/**
 * Configuration for LSTMPredictor
 */
export interface LSTMPredictorConfig {
  /** Number of time steps in sequence (default: 60 = 1 hour at 1-min intervals) */
  sequenceLength?: number;
  /** Number of features per time step (default: 20) */
  featureCount?: number;
  /** Accuracy threshold to trigger retraining (default: 0.7) */
  accuracyThreshold?: number;
  /** Minimum time between retraining sessions in ms (default: 3600000 = 1 hour) */
  retrainCooldownMs?: number;
  /** Maximum prediction history size (default: 1000) */
  maxHistorySize?: number;
  /** Error threshold for accuracy calculation (default: 0.05 = 5%) */
  errorThreshold?: number;
  /** Time horizon for predictions in ms (default: 300000 = 5 minutes) */
  predictionTimeHorizonMs?: number;
  /**
   * P1 Optimization: Enable model persistence to save/load trained models.
   * Eliminates 100-200s cold start time by loading pre-trained models.
   * @default true
   * @see docs/reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md - Optimization P1
   */
  enablePersistence?: boolean;
  /**
   * P1 Optimization: Model ID for persistence storage.
   * @default 'lstm-predictor'
   */
  modelId?: string;
  /**
   * P1 Optimization: Maximum model age in ms before forcing retrain.
   * Models older than this are considered stale and will be retrained.
   * @default 86400000 (24 hours)
   */
  maxModelAgeMs?: number;
}

/**
 * Default configuration values
 */
const DEFAULT_LSTM_CONFIG: Required<LSTMPredictorConfig> = {
  sequenceLength: 60,
  featureCount: 20,
  accuracyThreshold: 0.7,
  retrainCooldownMs: 3600000, // 1 hour
  maxHistorySize: 1000,
  errorThreshold: 0.05, // 5%
  predictionTimeHorizonMs: 300000, // 5 minutes
  // P1 Optimization: Model persistence defaults
  enablePersistence: true,
  modelId: 'lstm-predictor',
  maxModelAgeMs: 86400000, // 24 hours
};

// =============================================================================
// LSTMPredictor Class
// =============================================================================

/**
 * LSTM-based price predictor with online learning capabilities.
 *
 * Features:
 * - Async initialization with ready promise pattern
 * - Automatic retraining when accuracy degrades
 * - Graceful fallback to simple moving average
 * - Tensor memory management for hot-path efficiency
 *
 * P2-8 note: Stats tracking uses plain predictionHistory array, unlike
 * OrderflowPredictor which uses SynchronizedStats. Consider migrating
 * to SynchronizedStats for consistency when refactoring this class.
 */
export class LSTMPredictor {
  private model: tf.LayersModel | null = null;
  private isTrained = false;
  private lastTrainingTime = 0;
  private predictionHistory: PredictionHistoryEntry[] = [];
  private readonly config: Required<LSTMPredictorConfig>;

  // Fix 5.1: Atomic mutex for concurrent retrain prevention
  private readonly retrainingMutex: AsyncMutex;

  // Fix 7.1: Track retrain attempts for retry logic
  private retrainAttempts = 0;
  private lastRetrainError: Error | null = null;

  // Pre-allocated buffer for feature vectors (performance optimization 10.1)
  private featureBuffer: Float64Array;

  // Perf 10.2: Pre-allocated feature array to reduce allocations in hot path
  private preallocatedFeatures: number[];

  // Ready promise for async initialization (fix for Bug 4.1)
  private readonly modelReady: Promise<void>;
  private modelInitError: Error | null = null;

  // P1 Optimization: Model persistence tracking
  private modelVersion = 0;
  private loadedFromPersistence = false;

  constructor(config: LSTMPredictorConfig = {}) {
    this.config = { ...DEFAULT_LSTM_CONFIG, ...config };
    const totalFeatures = this.config.sequenceLength * this.config.featureCount;
    this.featureBuffer = new Float64Array(totalFeatures);

    // Perf 10.2: Pre-allocate feature array once
    this.preallocatedFeatures = new Array(totalFeatures).fill(0);

    // Fix 5.1: Initialize atomic mutex
    this.retrainingMutex = new AsyncMutex();

    // Initialize model asynchronously with ready promise pattern
    this.modelReady = this.initializeModel().catch(err => {
      this.modelInitError = err instanceof Error ? err : new Error(String(err));
      logger.error('Model initialization failed:', this.modelInitError);
    });
  }

  /**
   * Wait for model to be ready. Call this before using the model.
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
      // P1 Optimization: Try to load persisted model first to skip cold start
      // @see docs/reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md - Optimization P1
      if (this.config.enablePersistence) {
        const loadedSuccessfully = await this.tryLoadPersistedModel();
        if (loadedSuccessfully) {
          logger.info('LSTM model loaded from persistence (skipped cold start)', {
            modelId: this.config.modelId,
            version: this.modelVersion,
          });
          return;
        }
      }

      // Fresh model creation (cold start path)
      logger.info('Creating fresh LSTM model (no persisted model found or persistence disabled)');
      const model = tf.sequential();

      // Input LSTM layer
      model.add(tf.layers.lstm({
        units: 128,
        inputShape: [this.config.sequenceLength, this.config.featureCount],
        returnSequences: true,
        dropout: 0.2,
        recurrentDropout: 0.2
      }));

      // Second LSTM layer
      model.add(tf.layers.lstm({
        units: 64,
        dropout: 0.2,
        recurrentDropout: 0.2
      }));

      // Dense layer for feature transformation
      model.add(tf.layers.dense({ units: 32, activation: 'relu' }));

      // Output layer: [predicted_price, confidence, direction]
      model.add(tf.layers.dense({ units: 3, activation: 'linear' }));

      // Compile with Huber loss (robust to outliers)
      model.compile({
        optimizer: tf.train.adam(0.001),
        loss: (yTrue: tf.Tensor, yPred: tf.Tensor) => tf.losses.huberLoss(yTrue, yPred),
        metrics: ['mae', 'mse']
      });

      this.model = model;

      // Warm up model to trigger JIT compilation (performance optimization 10.2)
      await this.warmupModel();

      logger.info('LSTM model initialized and warmed up successfully');
    } catch (error) {
      logger.error('Failed to initialize LSTM model:', error);
      throw error;
    }
  }

  /**
   * Warm up model with a dummy prediction to trigger JIT compilation.
   */
  private async warmupModel(): Promise<void> {
    if (!this.model) return;

    const warmupTensor = tf.zeros([1, this.config.sequenceLength, this.config.featureCount]);
    try {
      const prediction = this.model.predict(warmupTensor) as tf.Tensor;
      await prediction.data(); // Force synchronous execution
      prediction.dispose();
    } finally {
      warmupTensor.dispose();
    }
  }

  /**
   * P1 Optimization: Try to load a persisted model from disk.
   * Returns true if model was successfully loaded and is not stale.
   * @see docs/reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md - Optimization P1
   */
  private async tryLoadPersistedModel(): Promise<boolean> {
    try {
      const persistence = getModelPersistence();

      // Check if model exists
      if (!(await persistence.modelExists(this.config.modelId))) {
        logger.debug('No persisted model found', { modelId: this.config.modelId });
        return false;
      }

      // Load metadata first to check staleness (faster than full load)
      const metadata = await persistence.loadMetadata(this.config.modelId);
      if (!metadata) {
        logger.debug('No metadata found for persisted model', { modelId: this.config.modelId });
        return false;
      }

      // Check model staleness
      const modelAge = Date.now() - metadata.lastTrainingTime;
      if (modelAge > this.config.maxModelAgeMs) {
        logger.info('Persisted model is stale, will create fresh model', {
          modelId: this.config.modelId,
          modelAgeHours: Math.round(modelAge / 3600000),
          maxAgeHours: Math.round(this.config.maxModelAgeMs / 3600000),
        });
        return false;
      }

      // Load the full model
      const loadResult = await persistence.loadModel(this.config.modelId);
      if (!loadResult.success || !loadResult.model) {
        logger.warn('Failed to load persisted model', {
          modelId: this.config.modelId,
          error: loadResult.error?.message,
        });
        return false;
      }

      // Assign loaded model
      this.model = loadResult.model;
      this.isTrained = metadata.isTrained;
      this.lastTrainingTime = metadata.lastTrainingTime;
      this.modelVersion = metadata.version;
      this.loadedFromPersistence = true;

      // Warm up the loaded model
      await this.warmupModel();

      return true;
    } catch (error) {
      logger.warn('Error loading persisted model, will create fresh model', {
        modelId: this.config.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * P1 Optimization: Save model to persistence after training.
   * @see docs/reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md - Optimization P1
   */
  private async saveModelToPersistence(): Promise<void> {
    if (!this.config.enablePersistence || !this.model) return;

    try {
      const persistence = getModelPersistence();

      this.modelVersion++;
      const metadata: ModelMetadata = {
        modelId: this.config.modelId,
        modelType: 'lstm',
        version: this.modelVersion,
        lastTrainingTime: this.lastTrainingTime,
        trainingSamplesCount: this.predictionHistory.length,
        accuracy: this.calculateRecentAccuracy(),
        isTrained: this.isTrained,
        savedAt: Date.now(),
      };

      const saveResult = await persistence.saveModel(this.model, metadata);
      if (saveResult.success) {
        logger.info('LSTM model saved to persistence', {
          modelId: this.config.modelId,
          version: this.modelVersion,
          accuracy: metadata.accuracy,
        });
      } else {
        logger.warn('Failed to save LSTM model to persistence', {
          modelId: this.config.modelId,
          error: saveResult.error?.message,
        });
      }
    } catch (error) {
      logger.warn('Error saving model to persistence', {
        modelId: this.config.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async predictPrice(
    priceHistory: PriceHistory[],
    context: PredictionContext
  ): Promise<PredictionResult> {
    // Ensure model is ready (fix for Bug 4.1)
    await this.modelReady;

    if (!this.model || this.modelInitError || !this.isTrained) {
      return this.fallbackPrediction(priceHistory, context);
    }

    try {
      // Extract features with proper sizing (fix for Bug 4.2)
      const features = this.extractFeatures(priceHistory, context);

      // Validate feature count
      if (features.length !== this.config.sequenceLength * this.config.featureCount) {
        logger.warn('Feature count mismatch, using fallback', {
          expected: this.config.sequenceLength * this.config.featureCount,
          actual: features.length
        });
        return this.fallbackPrediction(priceHistory, context);
      }

      // Use pre-allocated buffer for tensor creation (performance optimization 10.1)
      this.featureBuffer.set(features);
      const inputTensor = tf.tensor(
        this.featureBuffer,
        [1, this.config.sequenceLength, this.config.featureCount]
      ) as tf.Tensor3D;

      try {
        const prediction = this.model.predict(inputTensor) as tf.Tensor;
        const result = await prediction.data();
        prediction.dispose();

        const rawPredictedPrice = result[0];
        const confidence = Math.min(Math.max(result[1], 0), 1);
        const directionValue = result[2];

        // P1-6 fix: Validate predictedPrice from model output.
        // Raw LSTM output can be NaN, Infinity, or extreme values.
        // Fall back to current price if invalid (same guard as fallbackPrediction).
        const predictedPrice = Number.isFinite(rawPredictedPrice)
          ? rawPredictedPrice
          : context.currentPrice;

        let direction: 'up' | 'down' | 'sideways';
        if (directionValue > 0.1) direction = 'up';
        else if (directionValue < -0.1) direction = 'down';
        else direction = 'sideways';

        return {
          predictedPrice,
          confidence,
          direction,
          timeHorizon: this.config.predictionTimeHorizonMs,
          features
        };
      } finally {
        inputTensor.dispose();
      }
    } catch (error) {
      logger.error('Price prediction failed, using fallback:', error);
      return this.fallbackPrediction(priceHistory, context);
    }
  }

  async trainModel(trainingData: TrainingData): Promise<void> {
    await this.modelReady;

    if (!this.model) {
      throw new Error('Model not initialized');
    }

    if (this.modelInitError) {
      throw this.modelInitError;
    }

    try {
      logger.info(`Training LSTM model with ${trainingData.inputs.length} samples`);

      // Validate input dimensions
      const expectedInputSize = this.config.sequenceLength * this.config.featureCount;
      for (const input of trainingData.inputs) {
        if (input.length !== expectedInputSize) {
          throw new Error(`Invalid input size: expected ${expectedInputSize}, got ${input.length}`);
        }
      }

      const numSamples = trainingData.inputs.length;
      const flatInputs = trainingData.inputs.flat();
      const inputs = tf.tensor(flatInputs, [numSamples, this.config.sequenceLength, this.config.featureCount]) as tf.Tensor3D;
      const outputs = tf.tensor2d(trainingData.outputs);

      try {
        await this.model.fit(inputs, outputs, {
          epochs: 50,
          batchSize: 32,
          validationSplit: 0.2,
          callbacks: {
            onEpochEnd: (epoch: number, logs?: tf.Logs) => {
              if (epoch % 10 === 0 && logs) {
                logger.debug(`Training epoch ${epoch}: loss=${logs.loss?.toFixed(4)}`);
              }
            }
          }
        });

        this.isTrained = true;
        this.lastTrainingTime = Date.now();
        logger.info('LSTM model training completed successfully');

        // P1 Optimization: Save model to persistence after training
        await this.saveModelToPersistence();
      } finally {
        inputs.dispose();
        outputs.dispose();
      }
    } catch (error) {
      logger.error('Model training failed:', error);
      throw error;
    }
  }

  async updateModel(actualPrice: number, predictedPrice: number, timestamp: number): Promise<void> {
    // Store prediction result for online learning
    const entry: PredictionHistoryEntry = {
      timestamp,
      actual: actualPrice,
      predicted: predictedPrice,
      error: actualPrice !== 0 ? Math.abs(actualPrice - predictedPrice) / actualPrice : 0
    };
    this.predictionHistory.push(entry);

    // Keep only last N predictions
    if (this.predictionHistory.length > this.config.maxHistorySize) {
      this.predictionHistory.shift();
    }

    // Check if retraining is needed
    const recentAccuracy = this.calculateRecentAccuracy();
    const timeSinceLastTrain = Date.now() - this.lastTrainingTime;

    // Fix 5.1: Use atomic mutex check instead of boolean flag
    if (
      recentAccuracy < this.config.accuracyThreshold &&
      timeSinceLastTrain > this.config.retrainCooldownMs &&
      !this.retrainingMutex.isLocked() // Atomic mutex check
    ) {
      logger.info('Model accuracy degrading, triggering retraining', {
        accuracy: recentAccuracy,
        threshold: this.config.accuracyThreshold
      });
      // Fix 7.1: Run retraining with retry logic in background
      this.retrainWithRetry().catch(err => {
        logger.error('Background retraining failed after all retries:', err);
      });
    }
  }

  /**
   * Fix 7.1: Retrain with exponential backoff retry logic.
   * Prevents loss of learning opportunity due to transient failures.
   */
  private async retrainWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < RETRAIN_MAX_ATTEMPTS; attempt++) {
      try {
        await this.retrainOnRecentData();
        // Success - reset attempt counter
        this.retrainAttempts = 0;
        this.lastRetrainError = null;
        return;
      } catch (error) {
        this.retrainAttempts++;
        this.lastRetrainError = error instanceof Error ? error : new Error(String(error));

        if (attempt < RETRAIN_MAX_ATTEMPTS - 1) {
          const backoffMs = RETRAIN_BACKOFF_MS * Math.pow(2, attempt);
          logger.warn(`Retrain attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`, {
            error: this.lastRetrainError.message
          });
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw this.lastRetrainError || new Error('Retraining failed after all attempts');
  }

  /**
   * Fix 5.1: Uses AsyncMutex for atomic training lock.
   * Previous boolean flag had TOCTOU vulnerability.
   */
  private async retrainOnRecentData(): Promise<void> {
    if (this.predictionHistory.length < 100) return;

    // Fix 5.1: Use atomic mutex - tryAcquire returns release fn or null if locked
    const releaseFn = this.retrainingMutex.tryAcquire();
    if (!releaseFn) {
      logger.debug('Retraining already in progress, skipping');
      return;
    }

    try {
      const trainingData = this.createTrainingDataFromHistory();

      if (trainingData.inputs.length === 0) {
        logger.warn('No valid training data from history');
        return;
      }

      const numSamples = trainingData.inputs.length;
      const flatInputs = trainingData.inputs.flat();
      const inputs = tf.tensor(flatInputs, [numSamples, this.config.sequenceLength, this.config.featureCount]) as tf.Tensor3D;
      const outputs = tf.tensor2d(trainingData.outputs);

      try {
        await this.model!.fit(inputs, outputs, {
          epochs: 10,
          batchSize: 16,
          validationSplit: 0.1
        });

        this.lastTrainingTime = Date.now();
        logger.info('Model retrained on recent data');

        // P1 Optimization: Save model to persistence after retraining
        await this.saveModelToPersistence();
      } finally {
        inputs.dispose();
        outputs.dispose();
      }
    } catch (error) {
      logger.error('Retraining failed:', error);
      throw error; // Re-throw for retry handling
    } finally {
      // Fix 5.1: Release by calling the release function
      releaseFn();
    }
  }

  private createTrainingDataFromHistory(): TrainingData {
    const inputs: number[][] = [];
    const outputs: number[][] = [];
    const timestamps: number[] = [];

    const requiredLength = this.config.sequenceLength * this.config.featureCount;

    for (let i = this.config.sequenceLength; i < this.predictionHistory.length; i++) {
      const sequence = this.predictionHistory.slice(i - this.config.sequenceLength, i);
      const features = this.extractFeaturesFromHistory(sequence);

      // Only add if feature vector has correct size
      if (features.length === requiredLength) {
        inputs.push(features);
        outputs.push([
          this.predictionHistory[i].actual,
          0.8,
          0
        ]);
        timestamps.push(this.predictionHistory[i].timestamp);
      }
    }

    return { inputs, outputs, timestamps };
  }

  /**
   * Extract features with proper sizing (fix for Bug 4.2).
   * Always returns exactly sequenceLength * featureCount values.
   *
   * Perf 10.2: Uses pre-allocated feature array to reduce allocations.
   * Fix 7.3: Integrated volume features using calculateVolumeFeatures.
   */
  private extractFeatures(priceHistory: PriceHistory[], context: PredictionContext): number[] {
    const totalFeatures = this.config.sequenceLength * this.config.featureCount;

    // Perf 10.2: Reset pre-allocated array instead of creating new one
    const features = this.preallocatedFeatures;
    for (let i = 0; i < totalFeatures; i++) {
      features[i] = 0;
    }

    if (priceHistory.length === 0) {
      // Add context features at the end
      const contextStart = totalFeatures - 4;
      features[contextStart] = context.currentPrice;
      features[contextStart + 1] = context.volume24h;
      features[contextStart + 2] = context.volatility;
      features[contextStart + 3] = context.marketCap;
      // Return a copy to prevent shared buffer aliasing (P0-1 fix)
      return features.slice();
    }

    // Use available price history, padding if necessary
    const dataLength = Math.min(priceHistory.length, this.config.sequenceLength);
    const startIdx = this.config.sequenceLength - dataLength;

    // Fix 7.3: Pre-calculate volume features for the window
    const volumes = priceHistory.slice(-dataLength).map(p => p.volume);
    const [avgVolume, volumeRatio] = this.calculateVolumeFeatures(volumes);

    for (let i = 0; i < dataLength; i++) {
      const historyIdx = priceHistory.length - dataLength + i;
      const featureIdx = (startIdx + i) * this.config.featureCount;
      const entry = priceHistory[historyIdx];

      // Per-timestep features (20 features per timestep)
      features[featureIdx] = entry.price;
      features[featureIdx + 1] = entry.volume;
      features[featureIdx + 2] = entry.high;
      features[featureIdx + 3] = entry.low;
      features[featureIdx + 4] = entry.high - entry.low; // Range
      features[featureIdx + 5] = (entry.price - entry.low) / Math.max(entry.high - entry.low, 1e-10); // Position in range

      // Calculate returns if we have previous data
      if (historyIdx > 0) {
        const prevPrice = priceHistory[historyIdx - 1].price;
        features[featureIdx + 6] = prevPrice !== 0 ? (entry.price - prevPrice) / prevPrice : 0;
        features[featureIdx + 7] = Math.log(entry.price / Math.max(prevPrice, 1e-10));
      }

      // Fix 7.3: Use calculateVolumeFeatures for volume ratio calculation
      if (historyIdx > 0) {
        const prevVolume = priceHistory[historyIdx - 1].volume;
        features[featureIdx + 8] = prevVolume !== 0 ? entry.volume / prevVolume : 1;
      }

      // Additional computed features
      const prices = priceHistory.slice(Math.max(0, historyIdx - 10), historyIdx + 1).map(p => p.price);
      features[featureIdx + 9] = calculateVolatility(prices);
      features[featureIdx + 10] = calculateTrend(prices);
      features[featureIdx + 11] = calculateMomentum(prices);

      // SMA features
      const sma5 = calculateSMA(prices.slice(-5));
      const sma10 = calculateSMA(prices);
      features[featureIdx + 12] = sma5;
      features[featureIdx + 13] = sma10;
      features[featureIdx + 14] = sma5 !== 0 ? entry.price / sma5 - 1 : 0;
      features[featureIdx + 15] = sma10 !== 0 ? entry.price / sma10 - 1 : 0;

      // Context features (replicated per timestep for consistency)
      features[featureIdx + 16] = context.currentPrice;
      features[featureIdx + 17] = context.volume24h;
      features[featureIdx + 18] = context.volatility;
      // Fix 7.3: Add volume features from calculateVolumeFeatures
      features[featureIdx + 19] = avgVolume > 0 ? entry.volume / avgVolume : volumeRatio;
    }

    // Return a copy to prevent shared buffer aliasing (P0-1 fix)
    // The pre-allocated array is reused across calls, so callers must
    // not hold references to it. Returning a copy ensures PredictionResult.features
    // remains stable after subsequent predictPrice() calls.
    return features.slice();
  }

  private extractFeaturesFromHistory(history: PredictionHistoryEntry[]): number[] {
    const totalFeatures = this.config.sequenceLength * this.config.featureCount;
    const features: number[] = new Array(totalFeatures).fill(0);

    for (let i = 0; i < history.length && i < this.config.sequenceLength; i++) {
      const featureIdx = i * this.config.featureCount;
      const entry = history[i];

      features[featureIdx] = entry.actual;
      features[featureIdx + 1] = entry.predicted;
      features[featureIdx + 2] = entry.error;
      features[featureIdx + 3] = entry.timestamp;

      // Derived features
      if (i > 0) {
        const prevActual = history[i - 1].actual;
        features[featureIdx + 4] = prevActual !== 0 ? (entry.actual - prevActual) / prevActual : 0;
        features[featureIdx + 5] = entry.error - history[i - 1].error;
      }

      // Calculate rolling statistics
      const recentErrors = history.slice(Math.max(0, i - 10), i + 1).map(h => h.error);
      const recentActuals = history.slice(Math.max(0, i - 10), i + 1).map(h => h.actual);

      features[featureIdx + 6] = calculateMean(recentErrors);
      features[featureIdx + 7] = Math.max(...recentErrors, 0);
      features[featureIdx + 8] = calculateVolatility(recentActuals);
      features[featureIdx + 9] = calculateTrend(recentActuals);
    }

    return features;
  }

  /**
   * Calculate volume features with division-by-zero protection (fix for Bug 4.3).
   */
  private calculateVolumeFeatures(volumes: number[]): number[] {
    if (volumes.length === 0) return [0, 1]; // Default ratio of 1 (no change)

    const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;

    // Fix for Bug 4.3: Prevent division by zero
    const ratio = mean !== 0 ? volumes[volumes.length - 1] / mean : 1;

    return [mean, Number.isFinite(ratio) ? ratio : 1];
  }

  private calculateRecentAccuracy(): number {
    if (this.predictionHistory.length < 10) return 1.0;

    const recent = this.predictionHistory.slice(-50);
    const accurate = recent.filter(h => h.error < this.config.errorThreshold).length;

    return accurate / recent.length;
  }

  private fallbackPrediction(priceHistory: PriceHistory[], context: PredictionContext): PredictionResult {
    if (priceHistory.length === 0) {
      return {
        predictedPrice: context.currentPrice,
        confidence: 0.3,
        direction: 'sideways',
        timeHorizon: this.config.predictionTimeHorizonMs,
        features: []
      };
    }

    const prices = priceHistory.map(p => p.price);
    const recentPrices = prices.slice(-10);
    const avgPrice = recentPrices.length > 0
      ? recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length
      : context.currentPrice;

    const trend = calculateTrend(recentPrices.slice(-5));
    const predictedPrice = avgPrice * (1 + trend * 0.01);

    return {
      predictedPrice: Number.isFinite(predictedPrice) ? predictedPrice : avgPrice,
      confidence: 0.5,
      direction: trend > 0 ? 'up' : trend < 0 ? 'down' : 'sideways',
      timeHorizon: this.config.predictionTimeHorizonMs,
      features: []
    };
  }

  getModelStats(): {
    isTrained: boolean;
    lastTrainingTime: number;
    predictionCount: number;
    recentAccuracy: number;
    isReady: boolean;
    isRetraining: boolean;
    retrainAttempts: number;
    lastRetrainError: string | null;
    // P1 Optimization: Model persistence stats
    persistenceEnabled: boolean;
    loadedFromPersistence: boolean;
    modelVersion: number;
  } {
    return {
      isTrained: this.isTrained,
      lastTrainingTime: this.lastTrainingTime,
      predictionCount: this.predictionHistory.length,
      recentAccuracy: this.calculateRecentAccuracy(),
      isReady: this.isReady(),
      // Fix 5.1: Use mutex isLocked() instead of boolean flag
      isRetraining: this.retrainingMutex.isLocked(),
      // Fix 7.1: Expose retry stats for monitoring
      retrainAttempts: this.retrainAttempts,
      lastRetrainError: this.lastRetrainError?.message ?? null,
      // P1 Optimization: Model persistence stats
      persistenceEnabled: this.config.enablePersistence,
      loadedFromPersistence: this.loadedFromPersistence,
      modelVersion: this.modelVersion,
    };
  }

  /**
   * Dispose of model resources.
   */
  dispose(): void {
    if (this.model) {
      this.model.dispose();
      this.model = null;
    }
    this.predictionHistory = [];
    this.isTrained = false;
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let lstmPredictor: LSTMPredictor | null = null;

/**
 * Get the singleton LSTMPredictor instance.
 */
export function getLSTMPredictor(config?: LSTMPredictorConfig): LSTMPredictor {
  if (!lstmPredictor) {
    lstmPredictor = new LSTMPredictor(config);
  }
  return lstmPredictor;
}

/**
 * Reset the LSTMPredictor singleton.
 * Use for testing or when reconfiguration is needed.
 */
export function resetLSTMPredictor(): void {
  if (lstmPredictor) {
    lstmPredictor.dispose();
    lstmPredictor = null;
  }
}
