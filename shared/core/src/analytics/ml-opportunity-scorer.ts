/**
 * T2.8: ML Opportunity Scorer
 *
 * Integrates ML predictor output with opportunity scoring to enhance
 * arbitrage decision-making with price predictions.
 *
 * Features:
 * - Combines ML predictions with base confidence scores
 * - Direction alignment bonus/penalty
 * - Price impact magnitude scoring
 * - Integration with momentum signals
 * - Batch processing for efficiency
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding 4.1
 */

import { createLogger } from '../logger';
import type { MomentumSignal } from './price-momentum';

const logger = createLogger('ml-opportunity-scorer');

// =============================================================================
// Types
// =============================================================================

/**
 * ML prediction result (matches LSTMPredictor output)
 */
export interface MLPrediction {
  predictedPrice: number;
  confidence: number;
  direction: 'up' | 'down' | 'sideways';
  timeHorizon: number;
  features: number[];
}

/**
 * Configuration for MLOpportunityScorer
 */
export interface MLScorerConfig {
  /** Weight for ML contribution (0-1, default 0.3) */
  mlWeight: number;
  /** Weight for base confidence (0-1, default 0.7) */
  baseWeight: number;
  /** Minimum ML confidence to consider (default 0.5) */
  minMLConfidence: number;
  /** Bonus for aligned direction (default 0.1) */
  directionBonus: number;
  /** Penalty for opposing direction (default 0.15) */
  directionPenalty: number;
  /** Weight for momentum signals (default 0.2) */
  momentumWeight?: number;
}

/**
 * Input for opportunity scoring
 */
export interface OpportunityScoreInput {
  /** Base confidence from traditional calculation */
  baseConfidence: number;
  /** ML prediction result (optional) */
  mlPrediction: MLPrediction | null;
  /** Direction of the opportunity */
  opportunityDirection: 'buy' | 'sell';
  /** Current market price */
  currentPrice: number;
  /** Optional ID for tracking */
  id?: string;
}

/**
 * Input for scoring with momentum
 */
export interface OpportunityWithMomentum extends OpportunityScoreInput {
  /** Momentum signal from PriceMomentumTracker */
  momentumSignal: MomentumSignal | null;
}

/**
 * Enhanced score result
 */
export interface EnhancedScore {
  /** Original base confidence */
  baseConfidence: number;
  /** Final enhanced confidence */
  enhancedConfidence: number;
  /** Whether ML was applied */
  mlApplied: boolean;
  /** ML contribution to score */
  mlContribution: number;
  /** Whether direction aligned */
  directionAligned: boolean;
  /** Score from price impact magnitude */
  priceImpactScore: number;
  /** Optional ID */
  id?: string;
  /** Momentum contribution (when using enhanceWithMomentum) */
  momentumContribution?: number;
}

/**
 * Scorer statistics
 */
export interface ScorerStats {
  scoredOpportunities: number;
  mlEnhancedCount: number;
  avgMLContribution: number;
  avgEnhancement: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: MLScorerConfig = {
  mlWeight: 0.3,
  baseWeight: 0.7,
  minMLConfidence: 0.5,
  directionBonus: 0.1,
  directionPenalty: 0.15,
  momentumWeight: 0.2
};

// =============================================================================
// ML Opportunity Scorer
// =============================================================================

/**
 * T2.8: ML Opportunity Scorer
 *
 * Enhances opportunity scoring by integrating ML predictions
 * with traditional confidence calculations.
 */
export class MLOpportunityScorer {
  private config: MLScorerConfig;
  private stats: {
    scoredOpportunities: number;
    mlEnhancedCount: number;
    totalMLContribution: number;
    totalEnhancement: number;
  };

  constructor(config: Partial<MLScorerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = {
      scoredOpportunities: 0,
      mlEnhancedCount: 0,
      totalMLContribution: 0,
      totalEnhancement: 0
    };

    // Validate weights sum to 1
    const totalWeight = this.config.mlWeight + this.config.baseWeight;
    if (Math.abs(totalWeight - 1) > 0.01) {
      logger.warn('ML and base weights do not sum to 1, normalizing', {
        mlWeight: this.config.mlWeight,
        baseWeight: this.config.baseWeight
      });
      this.config.mlWeight /= totalWeight;
      this.config.baseWeight /= totalWeight;
    }

    logger.info('MLOpportunityScorer initialized', {
      mlWeight: this.config.mlWeight,
      baseWeight: this.config.baseWeight,
      minMLConfidence: this.config.minMLConfidence
    });
  }

  /**
   * Enhance a single opportunity's score with ML prediction.
   */
  async enhanceOpportunityScore(input: OpportunityScoreInput): Promise<EnhancedScore> {
    this.stats.scoredOpportunities++;

    const { baseConfidence, mlPrediction, opportunityDirection, currentPrice, id } = input;

    // Default result (no ML enhancement)
    const defaultResult: EnhancedScore = {
      baseConfidence,
      enhancedConfidence: baseConfidence,
      mlApplied: false,
      mlContribution: 0,
      directionAligned: true,
      priceImpactScore: 0,
      id
    };

    // Skip if no ML prediction or invalid
    if (!mlPrediction || !this.isValidPrediction(mlPrediction)) {
      return defaultResult;
    }

    // Skip if ML confidence below threshold
    if (mlPrediction.confidence < this.config.minMLConfidence) {
      return defaultResult;
    }

    this.stats.mlEnhancedCount++;

    // Calculate direction alignment
    const directionAligned = this.checkDirectionAlignment(
      mlPrediction.direction,
      opportunityDirection
    );

    // Calculate price impact score (magnitude of predicted move)
    const priceImpactScore = this.calculatePriceImpactScore(
      currentPrice,
      mlPrediction.predictedPrice
    );

    // Calculate ML contribution
    // Start with ML confidence and add price impact influence
    let mlScore = mlPrediction.confidence + priceImpactScore * 0.1;

    // Clamp ML score to valid range before weighting
    mlScore = Math.max(0, Math.min(1, mlScore));

    // Calculate weighted combination
    const mlContribution = mlScore * this.config.mlWeight;
    const baseContribution = baseConfidence * this.config.baseWeight;
    let enhancedConfidence = mlContribution + baseContribution;

    // Apply direction bonus/penalty ONCE to the final score
    // BUG FIX: Previously this was applied twice (once to mlScore, once to enhancedConfidence)
    if (mlPrediction.direction !== 'sideways') {
      if (directionAligned) {
        enhancedConfidence += this.config.directionBonus * mlPrediction.confidence;
      } else {
        enhancedConfidence -= this.config.directionPenalty * mlPrediction.confidence;
      }
    }

    // Clamp final confidence
    enhancedConfidence = Math.max(0, Math.min(1, enhancedConfidence));

    // Track stats
    this.stats.totalMLContribution += mlContribution;
    this.stats.totalEnhancement += enhancedConfidence - baseConfidence;

    return {
      baseConfidence,
      enhancedConfidence,
      mlApplied: true,
      mlContribution,
      directionAligned,
      priceImpactScore,
      id
    };
  }

  /**
   * Enhance opportunity with both ML and momentum signals.
   *
   * Weighting model:
   * - mlWeight + baseWeight = 1 (validated in constructor)
   * - momentumWeight is applied as a separate overlay:
   *   - enhancedConfidence is scaled by (1 - momentumWeight)
   *   - momentumContribution is added based on signal confidence
   * - Bonuses/penalties are scaled proportionally to momentumWeight
   */
  async enhanceWithMomentum(input: OpportunityWithMomentum): Promise<EnhancedScore> {
    // First get ML-enhanced score
    const mlResult = await this.enhanceOpportunityScore(input);

    // If no momentum signal, return ML result
    if (!input.momentumSignal) {
      return mlResult;
    }

    const { momentumSignal } = input;
    const momentumWeight = this.config.momentumWeight ?? 0.2;

    // Calculate base momentum contribution
    let momentumContribution = momentumSignal.confidence * momentumWeight;

    // Check direction alignment
    const momentumAligned = this.checkMomentumAlignment(
      momentumSignal.trend,
      input.opportunityDirection
    );

    // BUG FIX: Scale bonuses proportionally to momentumWeight for consistency
    // This ensures bonuses don't dominate when momentumWeight is small
    const bonusScale = momentumWeight * 0.25; // 25% of momentum weight as bonus/penalty

    // Apply alignment bonus/penalty
    if (momentumAligned) {
      momentumContribution += bonusScale;
    } else if (momentumSignal.trend !== 'neutral') {
      momentumContribution -= bonusScale;
    }

    // Apply volume confirmation bonus
    if (momentumSignal.volumeSpike && momentumAligned) {
      momentumContribution += bonusScale;
    }

    // Combine with ML-enhanced score
    // adjustedWeight ensures total weight allocation is consistent
    const adjustedWeight = 1 - momentumWeight;
    const finalConfidence = Math.max(0, Math.min(1,
      mlResult.enhancedConfidence * adjustedWeight + momentumContribution
    ));

    return {
      ...mlResult,
      enhancedConfidence: finalConfidence,
      momentumContribution
    };
  }

  /**
   * Enhance multiple opportunities in batch.
   */
  async enhanceBatch(inputs: OpportunityScoreInput[]): Promise<EnhancedScore[]> {
    // Process in parallel for efficiency
    return Promise.all(inputs.map(input => this.enhanceOpportunityScore(input)));
  }

  /**
   * Rank opportunities by enhanced score.
   */
  async rankOpportunities(inputs: (OpportunityScoreInput & { id: string })[]): Promise<EnhancedScore[]> {
    const enhanced = await this.enhanceBatch(inputs);

    // Sort by enhanced confidence descending
    return enhanced.sort((a, b) => b.enhancedConfidence - a.enhancedConfidence);
  }

  /**
   * Get scorer statistics.
   */
  getStats(): ScorerStats {
    const count = this.stats.scoredOpportunities || 1;
    const mlCount = this.stats.mlEnhancedCount || 1;

    return {
      scoredOpportunities: this.stats.scoredOpportunities,
      mlEnhancedCount: this.stats.mlEnhancedCount,
      avgMLContribution: this.stats.totalMLContribution / mlCount,
      avgEnhancement: this.stats.totalEnhancement / count
    };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      scoredOpportunities: 0,
      mlEnhancedCount: 0,
      totalMLContribution: 0,
      totalEnhancement: 0
    };
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Validate ML prediction is usable.
   */
  private isValidPrediction(prediction: MLPrediction): boolean {
    if (!prediction) return false;
    if (typeof prediction.predictedPrice !== 'number' || isNaN(prediction.predictedPrice)) return false;
    if (typeof prediction.confidence !== 'number' || prediction.confidence < 0) return false;
    if (!['up', 'down', 'sideways'].includes(prediction.direction)) return false;
    return true;
  }

  /**
   * Check if ML direction aligns with opportunity direction.
   * Buy opportunities benefit from "up" predictions.
   * Sell opportunities benefit from "down" predictions.
   */
  private checkDirectionAlignment(
    mlDirection: 'up' | 'down' | 'sideways',
    oppDirection: 'buy' | 'sell'
  ): boolean {
    if (mlDirection === 'sideways') return true; // Neutral alignment
    if (oppDirection === 'buy') return mlDirection === 'up';
    if (oppDirection === 'sell') return mlDirection === 'down';
    return false;
  }

  /**
   * Check if momentum trend aligns with opportunity direction.
   */
  private checkMomentumAlignment(
    trend: 'bullish' | 'bearish' | 'neutral',
    oppDirection: 'buy' | 'sell'
  ): boolean {
    if (trend === 'neutral') return true;
    if (oppDirection === 'buy') return trend === 'bullish';
    if (oppDirection === 'sell') return trend === 'bearish';
    return false;
  }

  /**
   * Calculate score based on predicted price change magnitude.
   * Larger expected moves indicate stronger signals.
   */
  private calculatePriceImpactScore(currentPrice: number, predictedPrice: number): number {
    if (currentPrice <= 0 || predictedPrice <= 0) return 0;

    const changePercent = Math.abs((predictedPrice - currentPrice) / currentPrice);

    // Score based on magnitude: 1% = 0.1, 5% = 0.5, 10% = 1.0
    return Math.min(1, changePercent * 10);
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

/**
 * Singleton Pattern Note:
 * This uses a configurable singleton pattern rather than `createSingleton` from async-singleton.ts
 * because it requires configuration parameters on first initialization. The standard createSingleton
 * pattern uses a fixed factory function which doesn't support runtime configuration.
 *
 * Thread safety: JavaScript is single-threaded for synchronous code, so this pattern
 * is safe. The check-and-set is atomic in the JS event loop.
 */
let scorerInstance: MLOpportunityScorer | null = null;

/**
 * Get the singleton MLOpportunityScorer instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton MLOpportunityScorer instance
 */
export function getMLOpportunityScorer(config?: Partial<MLScorerConfig>): MLOpportunityScorer {
  if (!scorerInstance) {
    scorerInstance = new MLOpportunityScorer(config);
  }
  return scorerInstance;
}

/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export function resetMLOpportunityScorer(): void {
  if (scorerInstance) {
    scorerInstance.resetStats();
  }
  scorerInstance = null;
}
