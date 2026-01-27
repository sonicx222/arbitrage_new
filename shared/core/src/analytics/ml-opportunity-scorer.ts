/**
 * T2.8: ML Opportunity Scorer
 * T4.3.3: Orderflow Integration with Opportunity Scoring
 *
 * Integrates ML predictor output with opportunity scoring to enhance
 * arbitrage decision-making with price predictions.
 *
 * Features:
 * - Combines ML predictions with base confidence scores
 * - Direction alignment bonus/penalty
 * - Price impact magnitude scoring
 * - Integration with momentum signals
 * - Integration with orderflow signals (T4.3.3)
 * - Batch processing for efficiency
 *
 * Bug fixes and optimizations:
 * - Fix 4.3: NaN protection in volatility penalty calculation
 * - Fix 5.2: Atomic stats updates using deferred batching
 * - Perf 10.4: Deferred non-blocking logging in hot paths
 * - Perf 10.5: Concurrent batch processing with proper error handling
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding 4.1
 * @see docs/reports/implementation_plan_v3.md - Phase 4, Task 4.3.3
 */

import { createLogger } from '../logger';
import type { MomentumSignal } from './price-momentum';

const logger = createLogger('ml-opportunity-scorer');

// Perf 10.4: Deferred logging queue for non-blocking hot path
// Logs are batched and flushed periodically to avoid blocking scoring
const deferredLogs: Array<{ level: 'info' | 'warn' | 'debug'; msg: string; data?: object }> = [];
let logFlushScheduled = false;

/**
 * FIX 4.3, 10.1: Periodic flush timer to prevent unbounded memory growth.
 * Flushes logs every 5 seconds even under low throughput.
 */
const LOG_FLUSH_INTERVAL_MS = 5000;
let periodicFlushTimer: ReturnType<typeof setInterval> | null = null;

function ensurePeriodicFlush(): void {
  if (periodicFlushTimer !== null) return;

  periodicFlushTimer = setInterval(() => {
    if (deferredLogs.length > 0) {
      flushDeferredLogs();
    }
  }, LOG_FLUSH_INTERVAL_MS);

  // Ensure timer doesn't prevent process exit
  if (periodicFlushTimer.unref) {
    periodicFlushTimer.unref();
  }
}

function deferLog(level: 'info' | 'warn' | 'debug', msg: string, data?: object): void {
  deferredLogs.push({ level, msg, data });

  // FIX 4.3, 10.1: Start periodic flush timer on first log
  ensurePeriodicFlush();

  // Immediate flush at batch threshold
  if (!logFlushScheduled && deferredLogs.length >= 10) {
    logFlushScheduled = true;
    setImmediate(flushDeferredLogs);
  }
}

function flushDeferredLogs(): void {
  logFlushScheduled = false;
  const logs = deferredLogs.splice(0, deferredLogs.length);
  for (const log of logs) {
    logger[log.level](log.msg, log.data);
  }
}

/**
 * FIX 4.3: Stop the periodic flush timer (for testing/cleanup).
 */
export function stopDeferredLogFlush(): void {
  if (periodicFlushTimer !== null) {
    clearInterval(periodicFlushTimer);
    periodicFlushTimer = null;
  }
  // Flush any remaining logs
  if (deferredLogs.length > 0) {
    flushDeferredLogs();
  }
}

/**
 * Helper to safely get a finite number or default value.
 * Fix 4.3: Protects against NaN/Infinity in calculations.
 */
function finiteOrDefault(value: number, defaultValue: number): number {
  return Number.isFinite(value) ? value : defaultValue;
}

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
 * T4.3.3: Orderflow signal for integration with opportunity scoring.
 *
 * This type adapts OrderflowPrediction from the ML module to work with
 * the MLOpportunityScorer. Direction is mapped:
 * - 'bullish' → aligns with 'buy' opportunities (like ML 'up')
 * - 'bearish' → aligns with 'sell' opportunities (like ML 'down')
 * - 'neutral' → neutral alignment (like ML 'sideways')
 */
export interface OrderflowSignal {
  /** Predicted orderflow direction */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** Confidence score (0-1) */
  confidence: number;
  /** Orderflow pressure (-1 to 1, positive = buying) */
  orderflowPressure: number;
  /** Expected volatility (0-1) */
  expectedVolatility: number;
  /** Whale activity impact score (0-1) */
  whaleImpact: number;
  /** Timestamp of the signal */
  timestamp: number;
}

/**
 * Configuration for MLOpportunityScorer
 *
 * FIX 2.2, 4.2: Weight allocation documentation.
 *
 * Weighting Model:
 * ────────────────
 * The scorer uses a layered weighting approach:
 *
 * Layer 1 - Base Score (mlWeight + baseWeight must sum to 1.0):
 *   - mlWeight (0.3): Weight given to ML prediction confidence
 *   - baseWeight (0.7): Weight given to traditional base confidence
 *   - Constructor auto-normalizes if they don't sum to 1.0
 *
 * Layer 2 - Signal Overlays (applied on top of base score):
 *   - momentumWeight (0.2): Applied when momentum signal present
 *   - orderflowWeight (0.15): Applied when orderflow signal present
 *   - These reduce the base score weight proportionally:
 *     finalScore = baseScore * (1 - signalWeight) + signalContribution
 *
 * Example with all signals:
 *   baseScore = mlPrediction * 0.3 + baseConfidence * 0.7
 *   withMomentum = baseScore * 0.8 + momentumContribution * 0.2
 *   withBoth = baseScore * 0.65 + momentumContribution + orderflowContribution
 */
export interface MLScorerConfig {
  /** Weight for ML contribution (0-1, default 0.3). Must sum with baseWeight to 1.0 */
  mlWeight: number;
  /** Weight for base confidence (0-1, default 0.7). Must sum with mlWeight to 1.0 */
  baseWeight: number;
  /** Minimum ML confidence to consider (default 0.5) */
  minMLConfidence: number;
  /** Bonus for aligned direction (default 0.1) */
  directionBonus: number;
  /** Penalty for opposing direction (default 0.15) */
  directionPenalty: number;
  /** Weight for momentum signals (default 0.2) */
  momentumWeight?: number;
  /** Weight for orderflow signals (default 0.15) - T4.3.3 */
  orderflowWeight?: number;
  /** Minimum orderflow confidence to consider (default 0.4) - T4.3.3 */
  minOrderflowConfidence?: number;
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
 * T4.3.3: Input for scoring with orderflow signal
 */
export interface OpportunityWithOrderflow extends OpportunityScoreInput {
  /** Orderflow signal from OrderflowPredictor */
  orderflowSignal: OrderflowSignal | null;
}

/**
 * T4.3.3: Input for scoring with all signals (ML, momentum, orderflow)
 */
export interface OpportunityWithAllSignals extends OpportunityScoreInput {
  /** Momentum signal from PriceMomentumTracker */
  momentumSignal: MomentumSignal | null;
  /** Orderflow signal from OrderflowPredictor */
  orderflowSignal: OrderflowSignal | null;
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
  /** T4.3.3: Whether orderflow was applied */
  orderflowApplied?: boolean;
  /** T4.3.3: Orderflow contribution to score */
  orderflowContribution?: number;
  /** T4.3.3: Whether orderflow direction aligned with opportunity */
  orderflowDirectionAligned?: boolean;
}

/**
 * T4.3.3: Enhanced score result with orderflow details
 */
export interface EnhancedScoreWithOrderflow extends EnhancedScore {
  /** Whether orderflow was applied */
  orderflowApplied: boolean;
  /** Orderflow contribution to score */
  orderflowContribution: number;
  /** Whether orderflow direction aligned with opportunity */
  orderflowDirectionAligned: boolean;
}

/**
 * Scorer statistics
 */
export interface ScorerStats {
  scoredOpportunities: number;
  mlEnhancedCount: number;
  avgMLContribution: number;
  avgEnhancement: number;
  /** T4.3.3: Number of opportunities enhanced with orderflow */
  orderflowEnhancedCount?: number;
  /** T4.3.3: Average orderflow contribution */
  avgOrderflowContribution?: number;
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
  momentumWeight: 0.2,
  orderflowWeight: 0.15, // T4.3.3: Default orderflow weight
  minOrderflowConfidence: 0.4 // T4.3.3: Lower threshold than ML (orderflow is more volatile)
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
    orderflowEnhancedCount: number;
    totalOrderflowContribution: number;
  };

  constructor(config: Partial<MLScorerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = {
      scoredOpportunities: 0,
      mlEnhancedCount: 0,
      totalMLContribution: 0,
      totalEnhancement: 0,
      orderflowEnhancedCount: 0,
      totalOrderflowContribution: 0
    };

    // Validate weights sum to 1
    const totalWeight = this.config.mlWeight + this.config.baseWeight;
    if (Math.abs(totalWeight - 1) > 0.01) {
      // Perf 10.4: Use deferred logging for non-critical warnings
      deferLog('warn', 'ML and base weights do not sum to 1, normalizing', {
        mlWeight: this.config.mlWeight,
        baseWeight: this.config.baseWeight
      });
      this.config.mlWeight /= totalWeight;
      this.config.baseWeight /= totalWeight;
    }

    // Perf 10.4: Defer initialization logging
    deferLog('info', 'MLOpportunityScorer initialized', {
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
   * T4.3.3: Enhance opportunity with orderflow signal.
   *
   * Integrates orderflow predictions from the OrderflowPredictor model.
   * The orderflow signal provides:
   * - Direction alignment (bullish/bearish/neutral)
   * - Orderflow pressure magnitude
   * - Whale activity impact
   * - Expected volatility (used as a confidence reducer)
   *
   * @param input - Opportunity with optional orderflow signal
   * @returns Enhanced score with orderflow contribution
   */
  async enhanceWithOrderflow(input: OpportunityWithOrderflow): Promise<EnhancedScoreWithOrderflow> {
    // First get ML-enhanced score
    const mlResult = await this.enhanceOpportunityScore(input);

    // Default orderflow result
    const defaultOrderflowResult: EnhancedScoreWithOrderflow = {
      ...mlResult,
      orderflowApplied: false,
      orderflowContribution: 0,
      orderflowDirectionAligned: true
    };

    // If no orderflow signal, return with ML result only
    if (!input.orderflowSignal) {
      return defaultOrderflowResult;
    }

    const { orderflowSignal } = input;

    // Validate orderflow signal
    if (!this.isValidOrderflowSignal(orderflowSignal)) {
      return defaultOrderflowResult;
    }

    // Skip if orderflow confidence below threshold
    const minOrderflowConfidence = this.config.minOrderflowConfidence ?? 0.4;
    if (orderflowSignal.confidence < minOrderflowConfidence) {
      return defaultOrderflowResult;
    }

    const orderflowWeight = this.config.orderflowWeight ?? 0.15;

    // Track orderflow enhancement
    this.stats.orderflowEnhancedCount++;

    // Check direction alignment (bullish → buy, bearish → sell)
    const orderflowDirectionAligned = this.checkOrderflowAlignment(
      orderflowSignal.direction,
      input.opportunityDirection
    );

    // Calculate orderflow contribution based on confidence and pressure
    // Base contribution from orderflow confidence
    let orderflowContribution = finiteOrDefault(orderflowSignal.confidence, 0) * orderflowWeight;

    // Add pressure magnitude bonus (scaled by alignment)
    // Fix 4.3: Use finiteOrDefault to protect against NaN
    const pressureMagnitude = Math.abs(finiteOrDefault(orderflowSignal.orderflowPressure, 0));
    const pressureBonus = pressureMagnitude * orderflowWeight * 0.2;

    // Add whale impact factor (higher whale activity = stronger signal)
    // Fix 4.3: Use finiteOrDefault to protect against NaN
    const whaleBonus = finiteOrDefault(orderflowSignal.whaleImpact, 0) * orderflowWeight * 0.15;

    // Volatility penalty (high volatility = less certainty)
    // Fix 4.3: Use finiteOrDefault to protect against NaN/undefined
    const volatilityPenalty = finiteOrDefault(orderflowSignal.expectedVolatility, 0) * orderflowWeight * 0.3;

    // Apply direction alignment bonus/penalty
    if (orderflowSignal.direction !== 'neutral') {
      if (orderflowDirectionAligned) {
        orderflowContribution += pressureBonus + whaleBonus;
      } else {
        orderflowContribution -= pressureBonus + whaleBonus;
      }
    }

    // Apply volatility penalty regardless of direction
    orderflowContribution -= volatilityPenalty;

    // Note: orderflowContribution already includes confidence weighting from line 432
    // Do NOT multiply by confidence again (Bug fix: removed duplicate multiplication)

    // Combine with ML-enhanced score
    // adjustedWeight ensures total weight allocation is consistent
    const adjustedWeight = 1 - orderflowWeight;
    let finalConfidence = mlResult.enhancedConfidence * adjustedWeight + orderflowContribution;

    // Clamp final confidence
    finalConfidence = Math.max(0, Math.min(1, finalConfidence));

    // Track stats
    this.stats.totalOrderflowContribution += Math.abs(orderflowContribution);

    return {
      ...mlResult,
      enhancedConfidence: finalConfidence,
      orderflowApplied: true,
      orderflowContribution,
      orderflowDirectionAligned
    };
  }

  /**
   * T4.3.3: Enhance opportunity with all available signals (ML, momentum, orderflow).
   *
   * This method combines all three signal types for maximum insight:
   * - ML prediction (price direction and magnitude)
   * - Momentum signal (trend strength and velocity)
   * - Orderflow signal (whale activity and pressure)
   *
   * Weight allocation:
   * - ML-enhanced score (base + ML) is scaled by (1 - totalSignalWeight)
   * - totalSignalWeight = sum of weights for active signals (momentum + orderflow)
   * - Each active signal contributes proportionally to its weight and confidence
   *
   * Note: Orderflow signals below minOrderflowConfidence threshold are ignored.
   *
   * @param input - Opportunity with all optional signals
   * @returns Enhanced score with all contributions
   */
  async enhanceWithAllSignals(input: OpportunityWithAllSignals): Promise<EnhancedScoreWithOrderflow> {
    const { momentumSignal, orderflowSignal, ...baseInput } = input;

    // Start with ML enhancement
    const mlResult = await this.enhanceOpportunityScore(baseInput);

    const momentumWeight = this.config.momentumWeight ?? 0.2;
    const orderflowWeight = this.config.orderflowWeight ?? 0.15;

    let enhancedConfidence = mlResult.enhancedConfidence;
    let momentumContribution = 0;
    let orderflowContribution = 0;
    let orderflowApplied = false;
    let orderflowDirectionAligned = true;

    // Calculate total signal weight to scale properly
    const hasSignals = momentumSignal || orderflowSignal;
    if (!hasSignals) {
      return {
        ...mlResult,
        orderflowApplied: false,
        orderflowContribution: 0,
        orderflowDirectionAligned: true
      };
    }

    // Apply momentum signal if available
    if (momentumSignal) {
      const momentumAligned = this.checkMomentumAlignment(
        momentumSignal.trend,
        input.opportunityDirection
      );

      momentumContribution = momentumSignal.confidence * momentumWeight;
      const bonusScale = momentumWeight * 0.25;

      if (momentumAligned) {
        momentumContribution += bonusScale;
      } else if (momentumSignal.trend !== 'neutral') {
        momentumContribution -= bonusScale;
      }

      if (momentumSignal.volumeSpike && momentumAligned) {
        momentumContribution += bonusScale;
      }
    }

    // Apply orderflow signal if available and valid
    const minOrderflowConfidence = this.config.minOrderflowConfidence ?? 0.4;
    if (orderflowSignal && this.isValidOrderflowSignal(orderflowSignal) &&
        orderflowSignal.confidence >= minOrderflowConfidence) {
      this.stats.orderflowEnhancedCount++;
      orderflowApplied = true;

      orderflowDirectionAligned = this.checkOrderflowAlignment(
        orderflowSignal.direction,
        input.opportunityDirection
      );

      // Fix 4.3: Use finiteOrDefault to protect against NaN in all calculations
      orderflowContribution = finiteOrDefault(orderflowSignal.confidence, 0) * orderflowWeight;
      const pressureMagnitude = Math.abs(finiteOrDefault(orderflowSignal.orderflowPressure, 0));
      const pressureBonus = pressureMagnitude * orderflowWeight * 0.2;
      const whaleBonus = finiteOrDefault(orderflowSignal.whaleImpact, 0) * orderflowWeight * 0.15;
      const volatilityPenalty = finiteOrDefault(orderflowSignal.expectedVolatility, 0) * orderflowWeight * 0.3;

      if (orderflowSignal.direction !== 'neutral') {
        if (orderflowDirectionAligned) {
          orderflowContribution += pressureBonus + whaleBonus;
        } else {
          orderflowContribution -= pressureBonus + whaleBonus;
        }
      }

      orderflowContribution -= volatilityPenalty;
      // Note: orderflowContribution already includes confidence weighting from line 551
      // Do NOT multiply by confidence again (Bug fix: removed duplicate multiplication)

      this.stats.totalOrderflowContribution += Math.abs(orderflowContribution);
    }

    // Calculate total signal weight applied
    const totalSignalWeight = (momentumSignal ? momentumWeight : 0) + (orderflowSignal ? orderflowWeight : 0);
    const baseAdjustedWeight = 1 - totalSignalWeight;

    // Combine all contributions
    enhancedConfidence = mlResult.enhancedConfidence * baseAdjustedWeight +
      momentumContribution + orderflowContribution;

    // Clamp final confidence
    enhancedConfidence = Math.max(0, Math.min(1, enhancedConfidence));

    return {
      ...mlResult,
      enhancedConfidence,
      momentumContribution,
      orderflowApplied,
      orderflowContribution,
      orderflowDirectionAligned
    };
  }

  /**
   * Enhance multiple opportunities in batch.
   *
   * Perf 10.5: Processes inputs concurrently with controlled parallelism.
   * Uses Promise.allSettled for resilient error handling - failures in
   * individual scoring don't affect other opportunities.
   */
  async enhanceBatch(inputs: OpportunityScoreInput[]): Promise<EnhancedScore[]> {
    if (inputs.length === 0) return [];

    // Perf 10.5: Use Promise.allSettled for resilient batch processing
    const results = await Promise.allSettled(
      inputs.map(input => this.enhanceOpportunityScore(input))
    );

    // Process results, using default for failed items
    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }

      // On failure, return unenhanced score
      deferLog('warn', 'Batch scoring failed for opportunity', {
        index,
        id: inputs[index].id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      });

      return {
        baseConfidence: inputs[index].baseConfidence,
        enhancedConfidence: inputs[index].baseConfidence,
        mlApplied: false,
        mlContribution: 0,
        directionAligned: true,
        priceImpactScore: 0,
        id: inputs[index].id
      };
    });
  }

  /**
   * Perf 10.5: Enhance batch with all signals (momentum + orderflow).
   * This is optimized for high-throughput scoring scenarios.
   */
  async enhanceBatchWithAllSignals(
    inputs: OpportunityWithAllSignals[]
  ): Promise<EnhancedScoreWithOrderflow[]> {
    if (inputs.length === 0) return [];

    const results = await Promise.allSettled(
      inputs.map(input => this.enhanceWithAllSignals(input))
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }

      deferLog('warn', 'Batch all-signals scoring failed', {
        index,
        id: inputs[index].id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason)
      });

      return {
        baseConfidence: inputs[index].baseConfidence,
        enhancedConfidence: inputs[index].baseConfidence,
        mlApplied: false,
        mlContribution: 0,
        directionAligned: true,
        priceImpactScore: 0,
        id: inputs[index].id,
        orderflowApplied: false,
        orderflowContribution: 0,
        orderflowDirectionAligned: true
      };
    });
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
    const orderflowCount = this.stats.orderflowEnhancedCount || 1;

    return {
      scoredOpportunities: this.stats.scoredOpportunities,
      mlEnhancedCount: this.stats.mlEnhancedCount,
      avgMLContribution: this.stats.totalMLContribution / mlCount,
      avgEnhancement: this.stats.totalEnhancement / count,
      orderflowEnhancedCount: this.stats.orderflowEnhancedCount,
      avgOrderflowContribution: this.stats.totalOrderflowContribution / orderflowCount
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
      totalEnhancement: 0,
      orderflowEnhancedCount: 0,
      totalOrderflowContribution: 0
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
   * T4.3.3: Validate orderflow signal is usable.
   */
  private isValidOrderflowSignal(signal: OrderflowSignal): boolean {
    if (!signal) return false;
    if (typeof signal.confidence !== 'number' || isNaN(signal.confidence) || signal.confidence < 0) return false;
    if (typeof signal.orderflowPressure !== 'number' || isNaN(signal.orderflowPressure)) return false;
    if (typeof signal.expectedVolatility !== 'number' || isNaN(signal.expectedVolatility)) return false;
    if (typeof signal.whaleImpact !== 'number' || isNaN(signal.whaleImpact)) return false;
    if (!['bullish', 'bearish', 'neutral'].includes(signal.direction)) return false;
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
   * T4.3.3: Check if orderflow direction aligns with opportunity direction.
   * Maps orderflow direction (bullish/bearish/neutral) to opportunity direction (buy/sell):
   * - 'bullish' → aligns with 'buy'
   * - 'bearish' → aligns with 'sell'
   * - 'neutral' → aligns with both (neutral alignment)
   */
  private checkOrderflowAlignment(
    orderflowDirection: 'bullish' | 'bearish' | 'neutral',
    oppDirection: 'buy' | 'sell'
  ): boolean {
    if (orderflowDirection === 'neutral') return true;
    if (oppDirection === 'buy') return orderflowDirection === 'bullish';
    if (oppDirection === 'sell') return orderflowDirection === 'bearish';
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

// =============================================================================
// T4.3.3: Orderflow Signal Conversion Helper
// =============================================================================

/**
 * Input type for orderflow prediction conversion.
 * Matches the OrderflowPrediction interface from @arbitrage/ml module.
 */
export interface OrderflowPredictionInput {
  direction: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  orderflowPressure: number;
  expectedVolatility: number;
  whaleImpact: number;
  timestamp: number;
  // Optional fields from full OrderflowPrediction (not needed for scoring)
  timeHorizonMs?: number;
  features?: unknown;
}

/**
 * T4.3.3: Convert OrderflowPrediction from @arbitrage/ml to OrderflowSignal for scoring.
 *
 * This helper bridges the ML module's prediction output with the scoring module's
 * signal input. The conversion is straightforward since the types are nearly identical,
 * but having an explicit converter ensures type safety and allows for future mapping changes.
 *
 * @example
 * ```typescript
 * import { getOrderflowPredictor } from '@arbitrage/ml';
 * import { toOrderflowSignal, getMLOpportunityScorer } from '@arbitrage/core';
 *
 * const predictor = getOrderflowPredictor();
 * const prediction = await predictor.predict(input);
 * const signal = toOrderflowSignal(prediction);
 *
 * const scorer = getMLOpportunityScorer();
 * const result = await scorer.enhanceWithOrderflow({ ...opportunity, orderflowSignal: signal });
 * ```
 *
 * @param prediction - OrderflowPrediction from the ML module
 * @returns OrderflowSignal for use with MLOpportunityScorer
 */
export function toOrderflowSignal(prediction: OrderflowPredictionInput): OrderflowSignal {
  return {
    direction: prediction.direction,
    confidence: prediction.confidence,
    orderflowPressure: prediction.orderflowPressure,
    expectedVolatility: prediction.expectedVolatility,
    whaleImpact: prediction.whaleImpact,
    timestamp: prediction.timestamp
  };
}
