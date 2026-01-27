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
 * @see docs/reports/implementation_plan_v3.md - Phase 4, Task 4.3.2
 */

import * as tf from '@tensorflow/tfjs';
import { createLogger } from '@arbitrage/core';
import {
  OrderflowFeatureExtractor,
  OrderflowFeatures,
  OrderflowFeatureInput,
  getOrderflowFeatureExtractor,
  ORDERFLOW_FEATURE_COUNT
} from './orderflow-features';

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
  timestamps: number[];
}

/**
 * Model statistics
 */
export interface OrderflowModelStats {
  isReady: boolean;
  isTrained: boolean;
  trainingHistorySize: number;
  lastTrainingTime: number;
  totalPredictions: number;
  accuracy: number;
}

// =============================================================================
// OrderflowPredictor Class
// =============================================================================

/**
 * T4.3.2: Orderflow Predictor
 *
 * Neural network for orderflow pattern prediction.
 * Uses features from OrderflowFeatureExtractor to predict short-term market behavior.
 */
export class OrderflowPredictor {
  private model: tf.LayersModel | null = null;
  private readonly config: Required<OrderflowPredictorConfig>;
  private readonly featureExtractor: OrderflowFeatureExtractor;

  // Training history for online learning
  private trainingHistory: OrderflowTrainingSample[] = [];
  private lastTrainingTime = 0;
  private totalPredictions = 0;
  private correctPredictions = 0;

  // Ready promise for async initialization
  private readonly modelReady: Promise<void>;
  private modelInitError: Error | null = null;
  private isTrained = false;

  // Pre-allocated buffer for predictions
  private readonly inputBuffer: Float64Array;

  constructor(
    config: OrderflowPredictorConfig = {},
    featureExtractor?: OrderflowFeatureExtractor
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.featureExtractor = featureExtractor ?? getOrderflowFeatureExtractor();
    this.inputBuffer = new Float64Array(ORDERFLOW_FEATURE_COUNT);

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
   * @param input - Orderflow feature input
   * @returns Prediction result
   */
  async predict(input: OrderflowFeatureInput): Promise<OrderflowPrediction> {
    await this.modelReady;

    // Extract features
    const features = this.featureExtractor.extractFeatures(input);
    const normalizedFeatures = this.featureExtractor.normalizeFeatures(features);

    // Check if model is ready and trained
    if (!this.model || this.modelInitError || !this.isTrained) {
      return this.fallbackPrediction(features);
    }

    try {
      // Prepare input tensor
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

      const inputTensor = tf.tensor2d([Array.from(this.inputBuffer)]);

      try {
        const output = this.model.predict(inputTensor) as tf.Tensor;
        const result = await output.data();
        output.dispose();

        this.totalPredictions++;

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

        return {
          direction,
          confidence,
          orderflowPressure,
          expectedVolatility,
          whaleImpact,
          timeHorizonMs: this.config.predictionTimeHorizonMs,
          features,
          timestamp: Date.now()
        };
      } finally {
        inputTensor.dispose();
      }
    } catch (error) {
      logger.error('Orderflow prediction failed, using fallback:', error);
      return this.fallbackPrediction(features);
    }
  }

  /**
   * Train the model with a batch of samples.
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

    try {
      logger.info(`Training orderflow model with ${samples.length} samples`);

      const batch = this.prepareBatch(samples);
      const inputs = tf.tensor2d(batch.inputs);
      const outputs = tf.tensor2d(
        batch.directionLabels.map((dir, i) => [
          ...dir,
          batch.pressureLabels[i],
          batch.volatilityLabels[i],
          0 // whale impact placeholder
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
    }
  }

  /**
   * Add a training sample for online learning.
   */
  addTrainingSample(sample: OrderflowTrainingSample): void {
    this.trainingHistory.push(sample);

    // Track accuracy if we have predictions
    if (this.totalPredictions > 0) {
      // Simple accuracy tracking based on direction
      // In production, this would compare against actual prediction
    }

    // Keep history bounded
    if (this.trainingHistory.length > this.config.maxHistorySize) {
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
   */
  getStats(): OrderflowModelStats {
    return {
      isReady: this.isReady(),
      isTrained: this.isTrained,
      trainingHistorySize: this.trainingHistory.length,
      lastTrainingTime: this.lastTrainingTime,
      totalPredictions: this.totalPredictions,
      accuracy: this.totalPredictions > 0
        ? this.correctPredictions / this.totalPredictions
        : 0
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
    this.isTrained = false;
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

      timestamps.push(sample.timestamp);
    }

    return { inputs, directionLabels, pressureLabels, volatilityLabels, timestamps };
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
