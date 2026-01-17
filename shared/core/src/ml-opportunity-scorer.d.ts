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
import type { MomentumSignal } from './price-momentum';
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
/**
 * T2.8: ML Opportunity Scorer
 *
 * Enhances opportunity scoring by integrating ML predictions
 * with traditional confidence calculations.
 */
export declare class MLOpportunityScorer {
    private config;
    private stats;
    constructor(config?: Partial<MLScorerConfig>);
    /**
     * Enhance a single opportunity's score with ML prediction.
     */
    enhanceOpportunityScore(input: OpportunityScoreInput): Promise<EnhancedScore>;
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
    enhanceWithMomentum(input: OpportunityWithMomentum): Promise<EnhancedScore>;
    /**
     * Enhance multiple opportunities in batch.
     */
    enhanceBatch(inputs: OpportunityScoreInput[]): Promise<EnhancedScore[]>;
    /**
     * Rank opportunities by enhanced score.
     */
    rankOpportunities(inputs: (OpportunityScoreInput & {
        id: string;
    })[]): Promise<EnhancedScore[]>;
    /**
     * Get scorer statistics.
     */
    getStats(): ScorerStats;
    /**
     * Reset statistics.
     */
    resetStats(): void;
    /**
     * Validate ML prediction is usable.
     */
    private isValidPrediction;
    /**
     * Check if ML direction aligns with opportunity direction.
     * Buy opportunities benefit from "up" predictions.
     * Sell opportunities benefit from "down" predictions.
     */
    private checkDirectionAlignment;
    /**
     * Check if momentum trend aligns with opportunity direction.
     */
    private checkMomentumAlignment;
    /**
     * Calculate score based on predicted price change magnitude.
     * Larger expected moves indicate stronger signals.
     */
    private calculatePriceImpactScore;
}
/**
 * Get the singleton MLOpportunityScorer instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton MLOpportunityScorer instance
 */
export declare function getMLOpportunityScorer(config?: Partial<MLScorerConfig>): MLOpportunityScorer;
/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export declare function resetMLOpportunityScorer(): void;
//# sourceMappingURL=ml-opportunity-scorer.d.ts.map