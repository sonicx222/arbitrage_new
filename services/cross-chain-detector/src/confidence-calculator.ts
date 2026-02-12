/**
 * P2-2: ConfidenceCalculator - Extracted from detector.ts
 *
 * Calculates confidence scores for cross-chain arbitrage opportunities.
 * Combines multiple signals: price differential, data freshness, ML predictions,
 * and whale activity into a unified confidence score.
 *
 * @see docs/research/REFACTORING_IMPLEMENTATION_PLAN.md P2-2
 * @see ADR-014: Cross-Chain Detector Modularization
 */

import type { PriceUpdate } from '@arbitrage/types';
// Import PredictionResult from @arbitrage/ml to match detector.ts usage
import type { PredictionResult } from '@arbitrage/ml';

// =============================================================================
// Types
// =============================================================================

/**
 * Whale activity summary data used for confidence adjustment.
 */
export interface WhaleActivitySummary {
  /** Dominant direction of whale activity: 'bullish', 'bearish', or 'neutral' */
  dominantDirection: 'bullish' | 'bearish' | 'neutral';
  /** Net USD flow (positive = inflow, negative = outflow) */
  netFlowUsd: number;
  /** Number of super whale transactions (>$1M) */
  superWhaleCount: number;
}

/**
 * ML prediction pair for source and target chains.
 */
export interface MLPredictionPair {
  source?: PredictionResult | null;
  target?: PredictionResult | null;
}

/**
 * Price data for confidence calculation.
 */
export interface PriceData {
  update: PriceUpdate;
  price: number;
}

/**
 * Configuration for ML prediction confidence adjustments.
 */
export interface MLConfidenceConfig {
  /** Whether ML predictions are enabled */
  enabled: boolean;
  /** Minimum prediction confidence to apply adjustments */
  minConfidence: number;
  /** Boost multiplier when prediction aligns with opportunity */
  alignedBoost: number;
  /** Penalty multiplier when prediction opposes opportunity */
  opposedPenalty: number;
}

/**
 * Configuration for whale activity confidence adjustments.
 */
export interface WhaleConfidenceConfig {
  /** Boost multiplier for bullish whale activity */
  whaleBullishBoost: number;
  /** Penalty multiplier for bearish whale activity */
  whaleBearishPenalty: number;
  /** Boost multiplier for super whale presence */
  superWhaleBoost: number;
  /** USD threshold for significant flow */
  significantFlowThresholdUsd: number;
}

/**
 * Logger interface for confidence calculator.
 */
export interface ConfidenceCalculatorLogger {
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Full configuration for ConfidenceCalculator.
 */
export interface ConfidenceCalculatorConfig {
  ml: MLConfidenceConfig;
  whale: WhaleConfidenceConfig;
  /** Maximum confidence value (cap) */
  maxConfidence?: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

// FIX #2: Aligned defaults with detector.ts DEFAULT_WHALE_CONFIG and DEFAULT_ML_CONFIG
// so standalone CC tests use production-consistent values.
export const DEFAULT_CONFIDENCE_CONFIG: ConfidenceCalculatorConfig = {
  ml: {
    enabled: false,
    minConfidence: 0.6,
    alignedBoost: 1.15,
    opposedPenalty: 0.9,
  },
  whale: {
    whaleBullishBoost: 1.15,
    whaleBearishPenalty: 0.85,
    superWhaleBoost: 1.25,
    significantFlowThresholdUsd: 100000,
  },
  maxConfidence: 0.95,
};

// =============================================================================
// ConfidenceCalculator Class
// =============================================================================

/**
 * P2-2: ConfidenceCalculator - Composite confidence calculator with pluggable signals.
 *
 * Calculates confidence scores for cross-chain arbitrage opportunities by combining:
 * 1. Base confidence from price differential
 * 2. Age penalty for stale data
 * 3. ML prediction adjustments (optional)
 * 4. Whale activity adjustments (optional)
 *
 * This class is stateless and can be shared across detection cycles.
 */
export class ConfidenceCalculator {
  private readonly config: ConfidenceCalculatorConfig;
  private readonly logger: ConfidenceCalculatorLogger;

  constructor(
    config: Partial<ConfidenceCalculatorConfig> = {},
    logger: ConfidenceCalculatorLogger
  ) {
    this.config = {
      ...DEFAULT_CONFIDENCE_CONFIG,
      ...config,
      ml: { ...DEFAULT_CONFIDENCE_CONFIG.ml, ...config.ml },
      whale: { ...DEFAULT_CONFIDENCE_CONFIG.whale, ...config.whale },
    };
    this.logger = logger;
  }

  /**
   * Calculate composite confidence score for a cross-chain opportunity.
   *
   * @param lowPrice - Price data from the lower-priced chain (buy side)
   * @param highPrice - Price on the higher-priced chain (sell side)
   * @param whaleData - Optional whale activity summary for adjustment
   * @param mlPrediction - Optional ML predictions for source/target chains
   * @returns Confidence score between 0 and maxConfidence
   */
  calculate(
    lowPrice: PriceData,
    highPrice: { price: number },
    whaleData?: WhaleActivitySummary,
    mlPrediction?: MLPredictionPair
  ): number {
    // Step 1: Validate input prices
    if (!this.validatePrices(lowPrice.price, highPrice.price)) {
      return 0;
    }

    // Step 2: Calculate base confidence from price differential
    let confidence = this.calculateBaseConfidence(lowPrice.price, highPrice.price);

    // Step 3: Apply age penalty for stale data
    confidence = this.applyAgePenalty(confidence, lowPrice.update.timestamp);

    // Capture pre-boost confidence for FIX #10 multiplier cap
    const preBoostConfidence = confidence;

    // Step 4: Apply ML prediction adjustments (if enabled and available)
    const { mlConfidence, mlSupported } = this.applyMLAdjustment(confidence, mlPrediction);
    confidence = mlConfidence;

    // Step 5: Apply whale activity adjustments (if available)
    confidence = this.applyWhaleAdjustment(confidence, whaleData);

    // Step 6: Cap combined boost multiplier at 1.5x (FIX #10)
    // Prevents stacked whale + ML boosters from inflating confidence beyond 1.5x
    if (preBoostConfidence > 0) {
      const effectiveMultiplier = confidence / preBoostConfidence;
      if (effectiveMultiplier > 1.5) {
        confidence = preBoostConfidence * 1.5;
      }
    }

    // Step 7: Cap confidence at maximum
    const maxConfidence = this.config.maxConfidence ?? 0.95;
    confidence = Math.min(confidence, maxConfidence);

    return confidence;
  }

  /**
   * Validate that prices are finite positive numbers.
   */
  private validatePrices(lowPrice: number, highPrice: number): boolean {
    if (lowPrice <= 0 || highPrice <= 0 ||
        !Number.isFinite(lowPrice) || !Number.isFinite(highPrice)) {
      this.logger.warn('Invalid prices in confidence calculation', {
        lowPrice,
        highPrice,
      });
      return false;
    }
    return true;
  }

  /**
   * Calculate base confidence from price differential.
   * Maps price difference to 0-1 scale (50% difference = 1.0 confidence).
   */
  private calculateBaseConfidence(lowPrice: number, highPrice: number): number {
    // Scale: 50% price difference maps to 1.0 confidence
    const rawConfidence = Math.min(highPrice / lowPrice - 1, 0.5) * 2;

    // Validate result
    if (!Number.isFinite(rawConfidence) || rawConfidence < 0) {
      return 0;
    }

    return rawConfidence;
  }

  /**
   * Apply age penalty for stale data.
   * 1 minute of staleness = 10% penalty (down to 10% floor).
   */
  private applyAgePenalty(confidence: number, timestamp: number): number {
    const ageMinutes = Math.max(0, (Date.now() - timestamp) / 60000);
    const ageFactor = Math.max(0.1, 1 - ageMinutes * 0.1);
    return confidence * ageFactor;
  }

  /**
   * Apply ML prediction adjustments.
   *
   * For cross-chain arbitrage: buy on source (low price), sell on target (high price)
   * - Favorable: source price going up (buy now) OR target stable/up
   * - Unfavorable: source going down (wait) OR target going down
   */
  private applyMLAdjustment(
    confidence: number,
    mlPrediction?: MLPredictionPair
  ): { mlConfidence: number; mlSupported: boolean } {
    if (!this.config.ml.enabled || !mlPrediction) {
      return { mlConfidence: confidence, mlSupported: false };
    }

    const { source, target } = mlPrediction;
    let mlConfidenceBoost = 1.0;
    let mlSupported = false;

    // Check source chain prediction
    if (source && source.confidence >= this.config.ml.minConfidence) {
      if (source.direction === 'up') {
        // Source price predicted to go up - good to buy now
        mlConfidenceBoost *= this.config.ml.alignedBoost;
        mlSupported = true;
      } else if (source.direction === 'down') {
        // Source price predicted to go down - maybe wait
        mlConfidenceBoost *= this.config.ml.opposedPenalty;
      }
    }

    // Check target chain prediction
    if (target && target.confidence >= this.config.ml.minConfidence) {
      if (target.direction === 'up' || target.direction === 'sideways') {
        // Target price stable or going up - opportunity will persist
        mlConfidenceBoost *= mlSupported ? 1.05 : this.config.ml.alignedBoost;
        mlSupported = true;
      } else if (target.direction === 'down') {
        // Target price predicted to drop - opportunity may vanish
        mlConfidenceBoost *= this.config.ml.opposedPenalty;
        mlSupported = false;
      }
    }

    const adjustedConfidence = confidence * mlConfidenceBoost;

    this.logger.debug('ML prediction applied to confidence', {
      sourceDirection: source?.direction,
      sourceConfidence: source?.confidence,
      targetDirection: target?.direction,
      targetConfidence: target?.confidence,
      mlConfidenceBoost,
      mlSupported,
    });

    return { mlConfidence: adjustedConfidence, mlSupported };
  }

  /**
   * Apply whale activity adjustments.
   */
  private applyWhaleAdjustment(
    confidence: number,
    whaleData?: WhaleActivitySummary
  ): number {
    if (!whaleData) {
      return confidence;
    }

    const { dominantDirection, netFlowUsd, superWhaleCount } = whaleData;
    let adjustedConfidence = confidence;

    // Direction adjustment
    if (dominantDirection === 'bullish') {
      adjustedConfidence *= this.config.whale.whaleBullishBoost;
    } else if (dominantDirection === 'bearish') {
      adjustedConfidence *= this.config.whale.whaleBearishPenalty;
    }

    // Super whale presence boost
    if (superWhaleCount > 0) {
      adjustedConfidence *= this.config.whale.superWhaleBoost;
    }

    // Large net flow boost
    if (Math.abs(netFlowUsd) > this.config.whale.significantFlowThresholdUsd) {
      adjustedConfidence *= 1.1; // Additional 10% boost
    }

    return adjustedConfidence;
  }

  /**
   * Get current configuration (for testing/debugging).
   */
  getConfig(): ConfidenceCalculatorConfig {
    return { ...this.config };
  }
}

/**
 * Factory function to create a ConfidenceCalculator with the given config.
 */
export function createConfidenceCalculator(
  config: Partial<ConfidenceCalculatorConfig> = {},
  logger: ConfidenceCalculatorLogger
): ConfidenceCalculator {
  return new ConfidenceCalculator(config, logger);
}
