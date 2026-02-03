/**
 * P4 Optimization: Ensemble Prediction Combiner
 *
 * Combines LSTM price predictions with Orderflow predictions for improved accuracy.
 * Uses weighted combination with direction alignment bonus/penalty.
 *
 * Design rationale:
 * - LSTM captures price patterns and temporal dependencies
 * - Orderflow captures market sentiment and whale activity
 * - Combining reduces variance (standard ensemble technique)
 * - Direction agreement increases confidence
 *
 * Performance:
 * - Expected 15-25% improvement in prediction accuracy
 * - Adds ~2ms latency for combination (within <50ms hot path budget)
 *
 * @see docs/reports/RPC_PREDICTION_OPTIMIZATION_RESEARCH.md - Optimization P4
 */

import { createLogger } from '@arbitrage/core';
import type { PredictionResult } from './predictor';
import type { OrderflowPrediction } from './orderflow-predictor';

const logger = createLogger('ensemble-combiner');

// =============================================================================
// Types
// =============================================================================

/**
 * Combined prediction from ensemble model.
 */
export interface CombinedPrediction {
  /** Combined direction (resolved from both predictors) */
  direction: 'up' | 'down' | 'sideways';
  /** Combined confidence score (0-1) */
  confidence: number;
  /** Price target from LSTM prediction */
  priceTarget: number;
  /** Volatility adjustment from orderflow */
  volatilityAdjustment: number;
  /** Whether LSTM and orderflow directions aligned */
  directionsAligned: boolean;
  /** Contribution breakdown for debugging */
  contributions: {
    lstmConfidence: number;
    orderflowConfidence: number;
    alignmentBonus: number;
  };
  /** Timestamp of combination */
  timestamp: number;
}

/**
 * Configuration for ensemble combiner.
 */
export interface EnsembleCombinerConfig {
  /** Weight for LSTM prediction (default: 0.6) */
  lstmWeight?: number;
  /** Weight for orderflow prediction (default: 0.4) */
  orderflowWeight?: number;
  /** Bonus when directions align (default: 0.1) */
  alignmentBonus?: number;
  /** Penalty when directions oppose (default: 0.05) */
  alignmentPenalty?: number;
  /** Minimum confidence threshold for LSTM (default: 0.3) */
  minLstmConfidence?: number;
  /** Minimum confidence threshold for orderflow (default: 0.3) */
  minOrderflowConfidence?: number;
}

/**
 * Statistics for ensemble combiner.
 */
export interface EnsembleCombinerStats {
  totalCombinations: number;
  directionsAlignedCount: number;
  directionsOpposedCount: number;
  avgCombinedConfidence: number;
  avgAlignmentBonus: number;
  lstmOnlyCount: number;
  orderflowOnlyCount: number;
  bothPresentCount: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: Required<EnsembleCombinerConfig> = {
  lstmWeight: 0.6,
  orderflowWeight: 0.4,
  alignmentBonus: 0.1,
  alignmentPenalty: 0.05,
  minLstmConfidence: 0.3,
  minOrderflowConfidence: 0.3,
};

// =============================================================================
// Ensemble Prediction Combiner
// =============================================================================

/**
 * Combines LSTM and Orderflow predictions into a single enhanced prediction.
 */
export class EnsemblePredictionCombiner {
  private readonly config: Required<EnsembleCombinerConfig>;
  private stats = {
    totalCombinations: 0,
    directionsAlignedCount: 0,
    directionsOpposedCount: 0,
    totalCombinedConfidence: 0,
    totalAlignmentBonus: 0,
    lstmOnlyCount: 0,
    orderflowOnlyCount: 0,
    bothPresentCount: 0,
  };

  constructor(config: EnsembleCombinerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Validate weights sum approximately to 1
    const totalWeight = this.config.lstmWeight + this.config.orderflowWeight;
    if (Math.abs(totalWeight - 1) > 0.01) {
      logger.warn('LSTM and orderflow weights do not sum to 1, normalizing', {
        lstmWeight: this.config.lstmWeight,
        orderflowWeight: this.config.orderflowWeight,
      });
      this.config.lstmWeight /= totalWeight;
      this.config.orderflowWeight /= totalWeight;
    }
  }

  /**
   * Combine LSTM and orderflow predictions.
   *
   * @param lstmPrediction - LSTM price prediction (can be null)
   * @param orderflowPrediction - Orderflow prediction (can be null)
   * @returns Combined prediction
   */
  combine(
    lstmPrediction: PredictionResult | null,
    orderflowPrediction: OrderflowPrediction | null
  ): CombinedPrediction {
    this.stats.totalCombinations++;

    // Handle cases where one or both predictions are missing
    if (!lstmPrediction && !orderflowPrediction) {
      return this.createDefaultPrediction();
    }

    if (!lstmPrediction) {
      this.stats.orderflowOnlyCount++;
      return this.fromOrderflowOnly(orderflowPrediction!);
    }

    if (!orderflowPrediction) {
      this.stats.lstmOnlyCount++;
      return this.fromLstmOnly(lstmPrediction);
    }

    // Both predictions available
    this.stats.bothPresentCount++;

    // Check confidence thresholds
    const lstmValid = lstmPrediction.confidence >= this.config.minLstmConfidence;
    const orderflowValid = orderflowPrediction.confidence >= this.config.minOrderflowConfidence;

    if (!lstmValid && !orderflowValid) {
      return this.createDefaultPrediction();
    }

    if (!lstmValid) {
      return this.fromOrderflowOnly(orderflowPrediction);
    }

    if (!orderflowValid) {
      return this.fromLstmOnly(lstmPrediction);
    }

    // Both valid - combine them
    return this.combineBothPredictions(lstmPrediction, orderflowPrediction);
  }

  /**
   * Get combiner statistics.
   */
  getStats(): EnsembleCombinerStats {
    const count = this.stats.totalCombinations || 1;
    return {
      totalCombinations: this.stats.totalCombinations,
      directionsAlignedCount: this.stats.directionsAlignedCount,
      directionsOpposedCount: this.stats.directionsOpposedCount,
      avgCombinedConfidence: this.stats.totalCombinedConfidence / count,
      avgAlignmentBonus: this.stats.totalAlignmentBonus / count,
      lstmOnlyCount: this.stats.lstmOnlyCount,
      orderflowOnlyCount: this.stats.orderflowOnlyCount,
      bothPresentCount: this.stats.bothPresentCount,
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalCombinations: 0,
      directionsAlignedCount: 0,
      directionsOpposedCount: 0,
      totalCombinedConfidence: 0,
      totalAlignmentBonus: 0,
      lstmOnlyCount: 0,
      orderflowOnlyCount: 0,
      bothPresentCount: 0,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Create a default prediction when no valid input is available.
   */
  private createDefaultPrediction(): CombinedPrediction {
    return {
      direction: 'sideways',
      confidence: 0,
      priceTarget: 0,
      volatilityAdjustment: 0,
      directionsAligned: true,
      contributions: {
        lstmConfidence: 0,
        orderflowConfidence: 0,
        alignmentBonus: 0,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Create prediction from LSTM only (when orderflow is unavailable).
   */
  private fromLstmOnly(lstm: PredictionResult): CombinedPrediction {
    return {
      direction: lstm.direction,
      confidence: lstm.confidence,
      priceTarget: lstm.predictedPrice,
      volatilityAdjustment: 0,
      directionsAligned: true,
      contributions: {
        lstmConfidence: lstm.confidence,
        orderflowConfidence: 0,
        alignmentBonus: 0,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Create prediction from orderflow only (when LSTM is unavailable).
   */
  private fromOrderflowOnly(orderflow: OrderflowPrediction): CombinedPrediction {
    // Map orderflow direction to price direction
    const direction = this.mapOrderflowDirection(orderflow.direction);

    return {
      direction,
      confidence: orderflow.confidence,
      priceTarget: 0, // No price target from orderflow
      volatilityAdjustment: orderflow.expectedVolatility,
      directionsAligned: true,
      contributions: {
        lstmConfidence: 0,
        orderflowConfidence: orderflow.confidence,
        alignmentBonus: 0,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Combine both predictions using weighted ensemble.
   */
  private combineBothPredictions(
    lstm: PredictionResult,
    orderflow: OrderflowPrediction
  ): CombinedPrediction {
    // Map orderflow direction to price direction for comparison
    const orderflowPriceDirection = this.mapOrderflowDirection(orderflow.direction);

    // Check direction alignment
    const directionsAligned = this.checkDirectionAlignment(
      lstm.direction,
      orderflowPriceDirection
    );

    if (directionsAligned) {
      this.stats.directionsAlignedCount++;
    } else if (lstm.direction !== 'sideways' && orderflowPriceDirection !== 'sideways') {
      this.stats.directionsOpposedCount++;
    }

    // Calculate weighted confidence
    let combinedConfidence =
      this.config.lstmWeight * lstm.confidence +
      this.config.orderflowWeight * orderflow.confidence;

    // Apply alignment bonus/penalty
    let alignmentBonus = 0;
    if (directionsAligned && lstm.direction !== 'sideways') {
      // Both pointing same direction - boost confidence
      alignmentBonus = this.config.alignmentBonus;
      combinedConfidence += alignmentBonus;
    } else if (!directionsAligned && lstm.direction !== 'sideways' && orderflowPriceDirection !== 'sideways') {
      // Opposing directions - reduce confidence
      alignmentBonus = -this.config.alignmentPenalty;
      combinedConfidence += alignmentBonus;
    }

    // Clamp confidence to [0, 1]
    combinedConfidence = Math.max(0, Math.min(1, combinedConfidence));

    // Resolve final direction
    const direction = this.resolveDirection(lstm, orderflow, orderflowPriceDirection);

    // Track stats
    this.stats.totalCombinedConfidence += combinedConfidence;
    this.stats.totalAlignmentBonus += Math.max(0, alignmentBonus);

    return {
      direction,
      confidence: combinedConfidence,
      priceTarget: lstm.predictedPrice,
      volatilityAdjustment: orderflow.expectedVolatility,
      directionsAligned,
      contributions: {
        lstmConfidence: lstm.confidence * this.config.lstmWeight,
        orderflowConfidence: orderflow.confidence * this.config.orderflowWeight,
        alignmentBonus,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Map orderflow direction to price direction.
   */
  private mapOrderflowDirection(
    orderflowDirection: 'bullish' | 'bearish' | 'neutral'
  ): 'up' | 'down' | 'sideways' {
    switch (orderflowDirection) {
      case 'bullish':
        return 'up';
      case 'bearish':
        return 'down';
      case 'neutral':
        return 'sideways';
    }
  }

  /**
   * Check if directions are aligned.
   */
  private checkDirectionAlignment(
    lstmDirection: 'up' | 'down' | 'sideways',
    orderflowDirection: 'up' | 'down' | 'sideways'
  ): boolean {
    // Sideways aligns with anything
    if (lstmDirection === 'sideways' || orderflowDirection === 'sideways') {
      return true;
    }
    return lstmDirection === orderflowDirection;
  }

  /**
   * Resolve final direction from both predictions.
   *
   * Priority:
   * 1. If aligned, use the shared direction
   * 2. If opposed, use the higher confidence prediction
   * 3. If one is sideways, use the other
   */
  private resolveDirection(
    lstm: PredictionResult,
    orderflow: OrderflowPrediction,
    orderflowPriceDirection: 'up' | 'down' | 'sideways'
  ): 'up' | 'down' | 'sideways' {
    // Both sideways
    if (lstm.direction === 'sideways' && orderflowPriceDirection === 'sideways') {
      return 'sideways';
    }

    // LSTM sideways, use orderflow
    if (lstm.direction === 'sideways') {
      return orderflowPriceDirection;
    }

    // Orderflow sideways, use LSTM
    if (orderflowPriceDirection === 'sideways') {
      return lstm.direction;
    }

    // Both have direction - use higher weighted confidence
    const lstmWeightedConf = lstm.confidence * this.config.lstmWeight;
    const orderflowWeightedConf = orderflow.confidence * this.config.orderflowWeight;

    return lstmWeightedConf >= orderflowWeightedConf
      ? lstm.direction
      : orderflowPriceDirection;
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let combinerInstance: EnsemblePredictionCombiner | null = null;

/**
 * Get the singleton EnsemblePredictionCombiner instance.
 *
 * Note: Config is only used on first call. Subsequent calls with config
 * will log a warning and return the existing instance.
 */
export function getEnsemblePredictionCombiner(
  config?: EnsembleCombinerConfig
): EnsemblePredictionCombiner {
  if (!combinerInstance) {
    combinerInstance = new EnsemblePredictionCombiner(config);
  } else if (config !== undefined) {
    // FIX P3-003: Warn when config is provided but will be ignored
    // This helps developers catch cases where they expect config to be applied
    logger.warn('EnsemblePredictionCombiner already initialized, ignoring config', {
      note: 'Use resetEnsemblePredictionCombiner() first if you need to reconfigure',
    });
  }
  return combinerInstance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetEnsemblePredictionCombiner(): void {
  if (combinerInstance) {
    combinerInstance.resetStats();
  }
  combinerInstance = null;
}
