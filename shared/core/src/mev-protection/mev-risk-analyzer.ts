/**
 * MEV Risk Analyzer
 *
 * Task 1.2.3: MEV Risk Scoring
 *
 * Analyzes transactions for MEV vulnerability and provides recommendations:
 * - Sandwich attack vulnerability assessment
 * - Optimal tip/priority fee calculation
 * - Private vs public mempool recommendation
 *
 * @module mev-protection/mev-risk-analyzer
 * @see mev-risk-analyzer.types.ts for type definitions and defaults
 * @see config-validator.ts for config synchronization utilities
 */

import { CHAIN_MEV_STRATEGIES } from './types';
import type { MevStrategy } from './types';
import type { AdaptiveThresholdService } from './adaptive-threshold.service';
import { createAdaptiveThresholdService } from './adaptive-threshold.service';
import {
  SandwichRiskLevel,
  MempoolRecommendation,
  MEV_RISK_DEFAULTS,
} from './mev-risk-analyzer.types';
import type {
  TransactionContext,
  MevRiskAssessment,
  MevRiskAnalyzerConfig,
} from './mev-risk-analyzer.types';

// Re-export types and defaults for backward compatibility with existing consumers
// that import directly from this module (e.g., test files)
export {
  SandwichRiskLevel,
  MempoolRecommendation,
  MEV_RISK_DEFAULTS,
} from './mev-risk-analyzer.types';
export type {
  TransactionContext,
  MevRiskAssessment,
  MevRiskAnalyzerConfig,
} from './mev-risk-analyzer.types';
export {
  validateConfigSync,
  getLocalChainPriorityFees,
} from './config-validator';
export type {
  ConfigSyncValidationResult,
  ConfigMismatch,
} from './config-validator';

// =============================================================================
// MEV Risk Analyzer
// =============================================================================

/**
 * Analyzes transactions for MEV risk and provides recommendations
 *
 * Usage:
 * ```typescript
 * const analyzer = new MevRiskAnalyzer();
 *
 * const assessment = analyzer.assessRisk({
 *   chain: 'ethereum',
 *   valueUsd: 10000,
 *   slippageBps: 50,
 *   poolLiquidityUsd: 1_000_000,
 * });
 *
 * if (assessment.mempoolRecommendation === MempoolRecommendation.PRIVATE) {
 *   // Use Flashbots or similar private submission
 * }
 * ```
 */
export class MevRiskAnalyzer {
  private readonly config: Required<MevRiskAnalyzerConfig>;
  private readonly adaptiveService?: AdaptiveThresholdService;

  constructor(
    config?: MevRiskAnalyzerConfig,
    adaptiveService?: AdaptiveThresholdService
  ) {
    this.config = {
      highValueThresholdUsd: config?.highValueThresholdUsd ?? MEV_RISK_DEFAULTS.highValueThresholdUsd,
      sandwichRiskThresholdBps: config?.sandwichRiskThresholdBps ?? MEV_RISK_DEFAULTS.sandwichRiskThresholdBps,
      minLiquidityRatioForSafety: config?.minLiquidityRatioForSafety ?? MEV_RISK_DEFAULTS.minLiquidityRatioForSafety,
      basePriorityFeeEthereumGwei: config?.basePriorityFeeEthereumGwei ?? MEV_RISK_DEFAULTS.basePriorityFeeEthereumGwei,
      baseTipSolanaLamports: config?.baseTipSolanaLamports ?? MEV_RISK_DEFAULTS.baseTipSolanaLamports,
    };
    this.adaptiveService = adaptiveService;
  }

  /**
   * Assess MEV risk for a transaction
   *
   * Task 3.2: Now supports adaptive threshold adjustments based on historical attacks
   *
   * @param context - Transaction context for analysis
   * @returns MEV risk assessment with recommendations
   */
  async assessRisk(context: TransactionContext): Promise<MevRiskAssessment> {
    // Handle edge case of zero value
    if (context.valueUsd === 0) {
      return this.createLowRiskAssessment(context);
    }

    // Task 3.2: Get adaptive adjustments if enabled
    let adjustment;
    if (this.adaptiveService && context.dexProtocol) {
      adjustment = await this.adaptiveService.getAdjustment(context.chain, context.dexProtocol);
    }

    // Apply adaptive multipliers to thresholds
    const effectiveSlippageThreshold = adjustment
      ? this.config.sandwichRiskThresholdBps * adjustment.slippageMultiplier
      : this.config.sandwichRiskThresholdBps;

    const effectiveHighValueThreshold = adjustment
      ? this.config.highValueThresholdUsd * adjustment.profitMultiplier
      : this.config.highValueThresholdUsd;

    // Calculate risk factors
    const riskFactors: string[] = [];
    let riskScore = 0;

    // 1. Value-to-liquidity ratio factor
    const liquidityRatio = this.calculateLiquidityRatio(context);
    const liquidityRiskScore = this.scoreLiquidityRatio(liquidityRatio, riskFactors);
    riskScore += liquidityRiskScore;

    // 2. Slippage tolerance factor (with adaptive threshold)
    const slippageRiskScore = this.scoreSlippage(
      context.slippageBps,
      riskFactors,
      effectiveSlippageThreshold
    );
    riskScore += slippageRiskScore;

    // 3. Absolute value factor (with adaptive threshold)
    const valueRiskScore = this.scoreAbsoluteValue(
      context.valueUsd,
      riskFactors,
      effectiveHighValueThreshold
    );
    riskScore += valueRiskScore;

    // 4. Stable pair discount
    if (context.isStablePair) {
      riskScore *= 0.7; // 30% discount for stable pairs
      riskFactors.push('stable_pair_discount');
    }

    // 5. Chain-specific adjustments
    const chainAdjustment = this.getChainRiskAdjustment(context.chain);
    riskScore *= chainAdjustment;

    // Clamp risk score to 0-100
    riskScore = Math.max(0, Math.min(100, riskScore));

    // Determine risk level
    const sandwichRisk = this.scoreToRiskLevel(riskScore);

    // Calculate recommendations
    const recommendedPriorityFeeGwei = this.calculatePriorityFee(context, riskScore);
    const recommendedTipLamports = context.chain === 'solana'
      ? this.calculateSolanaTip(context, riskScore)
      : undefined;

    const mempoolRecommendation = this.recommendMempool(context, riskScore);
    const recommendedStrategy = this.getRecommendedStrategy(context.chain);
    const estimatedMevExposureUsd = this.estimateMevExposure(context, riskScore);

    return {
      sandwichRisk,
      sandwichRiskScore: Math.round(riskScore),
      recommendedPriorityFeeGwei,
      recommendedTipLamports,
      mempoolRecommendation,
      recommendedStrategy,
      riskFactors,
      estimatedMevExposureUsd,
    };
  }

  /**
   * Record a sandwich attack event for adaptive threshold learning
   *
   * Task 3.2: Public API for recording confirmed sandwich attacks.
   * This data is used by the adaptive threshold service to dynamically
   * adjust risk thresholds based on historical attack patterns.
   *
   * @param event - Sandwich attack details
   * @throws {Error} If adaptive service is not configured
   *
   * @example
   * ```typescript
   * await analyzer.recordSandwichAttack({
   *   chain: 'ethereum',
   *   dex: 'uniswap_v2',
   *   ourTxHash: '0xabc...',
   *   frontRunTxHash: '0xdef...',
   *   backRunTxHash: '0x123...',
   *   mevExtractedUsd: 150
   * });
   * ```
   */
  async recordSandwichAttack(event: {
    chain: string;
    dex: string;
    ourTxHash: string;
    frontRunTxHash: string;
    backRunTxHash: string;
    mevExtractedUsd: number;
  }): Promise<void> {
    if (!this.adaptiveService) {
      throw new Error('Adaptive threshold service not configured');
    }

    await this.adaptiveService.recordAttack(event);
  }

  // ===========================================================================
  // Risk Factor Scoring
  // ===========================================================================

  /**
   * Calculate value-to-liquidity ratio
   */
  private calculateLiquidityRatio(context: TransactionContext): number {
    if (!context.poolLiquidityUsd || context.poolLiquidityUsd === 0) {
      // If liquidity unknown, assume moderate ratio
      return 0.05;
    }
    return context.valueUsd / context.poolLiquidityUsd;
  }

  /**
   * Score liquidity ratio factor (0-40 points)
   *
   * Assesses impact of trade size relative to pool liquidity.
   * Higher ratio = more price impact = more MEV opportunity for attackers.
   */
  private scoreLiquidityRatio(ratio: number, riskFactors: string[]): number {
    if (ratio >= 0.1) {
      // 10%+ of pool = critical (trade dominates pool)
      riskFactors.push('critical_value_to_liquidity_ratio');
      return 40;
    } else if (ratio >= 0.05) {
      // 5-10% = high (significant price impact)
      riskFactors.push('high_value_to_liquidity_ratio');
      return 30;
    } else if (ratio >= this.config.minLiquidityRatioForSafety) {
      // 1-5% = medium (noticeable price impact)
      riskFactors.push('moderate_value_to_liquidity_ratio');
      return 15;
    }
    // < minLiquidityRatioForSafety (default 1%) = low
    return 5;
  }

  /**
   * Score slippage tolerance factor (0-35 points)
   *
   * Uses configurable threshold (sandwichRiskThresholdBps) to determine
   * what constitutes "high" slippage. Default threshold is 100 bps (1%).
   *
   * Task 3.2: Accepts effective threshold parameter for adaptive adjustments
   *
   * @param slippageBps - Slippage tolerance in basis points
   * @param riskFactors - Array to append risk factors to
   * @param effectiveThreshold - Effective threshold after adaptive adjustments (optional)
   */
  private scoreSlippage(
    slippageBps: number,
    riskFactors: string[],
    effectiveThreshold?: number
  ): number {
    // High threshold (adaptive or default)
    const highThreshold = effectiveThreshold ?? this.config.sandwichRiskThresholdBps;
    // Critical threshold is 2x high threshold
    const criticalThreshold = highThreshold * 2;

    if (slippageBps >= criticalThreshold) {
      // 2x threshold (default 2%+) = critical slippage risk
      riskFactors.push('critical_slippage_tolerance');
      return 35;
    } else if (slippageBps >= highThreshold) {
      // At or above threshold = high slippage risk
      riskFactors.push('high_slippage_tolerance');
      return 25;
    } else if (slippageBps >= highThreshold / 2) {
      // Half threshold to threshold = moderate slippage
      riskFactors.push('moderate_slippage_tolerance');
      return 10;
    }
    // Below half threshold = low slippage risk
    return 5;
  }

  /**
   * Score absolute value factor (0-25 points)
   *
   * Task 3.2: Accepts effective threshold parameter for adaptive adjustments
   *
   * @param valueUsd - Transaction value in USD
   * @param riskFactors - Array to append risk factors to
   * @param effectiveThreshold - Effective high value threshold after adaptive adjustments (optional)
   */
  private scoreAbsoluteValue(
    valueUsd: number,
    riskFactors: string[],
    effectiveThreshold?: number
  ): number {
    const highValueThreshold = effectiveThreshold ?? this.config.highValueThresholdUsd;

    if (valueUsd >= 100_000) {
      riskFactors.push('very_high_value');
      return 25;
    } else if (valueUsd >= highValueThreshold) {
      riskFactors.push('high_value');
      return 15;
    } else if (valueUsd >= 1000) {
      return 5;
    }
    return 0;
  }

  /**
   * Get chain-specific risk adjustment multiplier
   *
   * L2 chains with sequencer protection have lower MEV risk.
   * Uses CHAIN_MEV_STRATEGIES as single source of truth for chain strategy.
   */
  private getChainRiskAdjustment(chain: string): number {
    const strategy = CHAIN_MEV_STRATEGIES[chain];

    // L2s with sequencer have inherent protection (FCFS ordering, no public mempool)
    if (strategy === 'sequencer') {
      return 0.5; // 50% risk reduction
    }

    // Solana with Jito has some protection (private bundles, tip auctions)
    if (strategy === 'jito') {
      return 0.7; // 30% risk reduction
    }

    // Ethereum (flashbots), BSC (bloxroute), Polygon (fastlane) - full MEV risk
    // Standard chains also have full risk
    return 1.0;
  }

  /**
   * Convert risk score to risk level
   */
  private scoreToRiskLevel(score: number): SandwichRiskLevel {
    if (score >= MEV_RISK_DEFAULTS.riskScoreThresholds.high) {
      return SandwichRiskLevel.CRITICAL;
    } else if (score >= MEV_RISK_DEFAULTS.riskScoreThresholds.medium) {
      return SandwichRiskLevel.HIGH;
    } else if (score >= MEV_RISK_DEFAULTS.riskScoreThresholds.low) {
      return SandwichRiskLevel.MEDIUM;
    }
    return SandwichRiskLevel.LOW;
  }

  // ===========================================================================
  // Recommendations
  // ===========================================================================

  /**
   * Calculate recommended priority fee in gwei
   */
  private calculatePriorityFee(context: TransactionContext, riskScore: number): number {
    // Solana uses lamports, not gwei
    if (context.chain === 'solana') {
      return 0;
    }

    // Get base fee for chain
    const baseFee = MEV_RISK_DEFAULTS.chainBasePriorityFees[context.chain]
      ?? this.config.basePriorityFeeEthereumGwei;

    // Scale by risk score
    // Low risk (0-30): 1x base
    // Medium risk (30-70): 1.5x base
    // High risk (70-90): 2x base
    // Critical (90+): 3x base
    let multiplier = 1;
    if (riskScore >= 90) {
      multiplier = 3;
    } else if (riskScore >= 70) {
      multiplier = 2;
    } else if (riskScore >= 30) {
      multiplier = 1.5;
    }

    // If expected profit is known, cap fee at reasonable fraction
    if (context.expectedProfitUsd && context.expectedProfitUsd > 0) {
      // Don't recommend fee > 10% of expected profit
      // Rough conversion: 1 gwei ~= $0.000001 at typical gas/prices
      const maxFee = context.expectedProfitUsd * 0.1 * 1000; // Very rough
      return Math.min(baseFee * multiplier, maxFee);
    }

    return baseFee * multiplier;
  }

  /**
   * Calculate recommended tip for Solana in lamports
   */
  private calculateSolanaTip(context: TransactionContext, riskScore: number): number {
    const baseTip = this.config.baseTipSolanaLamports;

    // Scale by risk score
    let multiplier = 1;
    if (riskScore >= 90) {
      multiplier = 5;
    } else if (riskScore >= 70) {
      multiplier = 3;
    } else if (riskScore >= 30) {
      multiplier = 2;
    }

    return Math.round(baseTip * multiplier);
  }

  /**
   * Recommend private vs public mempool
   *
   * Uses CHAIN_MEV_STRATEGIES as single source of truth for chain strategy.
   */
  private recommendMempool(
    context: TransactionContext,
    riskScore: number
  ): MempoolRecommendation {
    const strategy = CHAIN_MEV_STRATEGIES[context.chain];

    // L2s with sequencer have inherent protection - public is usually fine
    if (strategy === 'sequencer') {
      return riskScore >= 90
        ? MempoolRecommendation.CONDITIONAL
        : MempoolRecommendation.PUBLIC;
    }

    // Solana with Jito - always use private (Jito bundles)
    if (strategy === 'jito') {
      return riskScore >= 30
        ? MempoolRecommendation.PRIVATE
        : MempoolRecommendation.CONDITIONAL;
    }

    // High risk = private
    if (riskScore >= 70) {
      return MempoolRecommendation.PRIVATE;
    }

    // Medium risk with high value = conditional/private
    if (riskScore >= 30 && context.valueUsd >= this.config.highValueThresholdUsd) {
      return MempoolRecommendation.CONDITIONAL;
    }

    // Low risk = public
    return MempoolRecommendation.PUBLIC;
  }

  /**
   * Get recommended MEV strategy for chain
   */
  private getRecommendedStrategy(chain: string): MevStrategy {
    return CHAIN_MEV_STRATEGIES[chain] || 'standard';
  }

  /**
   * Estimate potential MEV exposure in USD
   *
   * This is a rough estimate based on slippage and value.
   * Actual MEV exposure depends on many factors including:
   * - Block space competition
   * - Current gas prices
   * - Attacker sophistication
   */
  private estimateMevExposure(context: TransactionContext, riskScore: number): number {
    // Base exposure = slippage tolerance * value
    const baseExposure = (context.slippageBps / 10000) * context.valueUsd;

    // Adjust by risk score (higher risk = more likely to be exploited)
    const exploitProbability = riskScore / 100;

    return baseExposure * exploitProbability;
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Create a low-risk assessment for edge cases
   */
  private createLowRiskAssessment(context: TransactionContext): MevRiskAssessment {
    return {
      sandwichRisk: SandwichRiskLevel.LOW,
      sandwichRiskScore: 0,
      recommendedPriorityFeeGwei: context.chain === 'solana' ? 0 :
        (MEV_RISK_DEFAULTS.chainBasePriorityFees[context.chain] ??
         this.config.basePriorityFeeEthereumGwei),
      recommendedTipLamports: context.chain === 'solana'
        ? this.config.baseTipSolanaLamports
        : undefined,
      mempoolRecommendation: MempoolRecommendation.PUBLIC,
      recommendedStrategy: this.getRecommendedStrategy(context.chain),
      riskFactors: [],
      estimatedMevExposureUsd: 0,
    };
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create MEV Risk Analyzer with optional adaptive threshold service
 *
 * Task 3.2: Automatically creates AdaptiveThresholdService if feature flag enabled.
 * Imports MEV_CONFIG from @arbitrage/config to avoid configuration duplication.
 *
 * Uses require() for synchronous config loading. The project compiles to CommonJS
 * ("module": "commonjs" in tsconfig.json), so require() works correctly at runtime.
 *
 * @param config - Optional MEV risk analyzer configuration
 * @returns Configured MevRiskAnalyzer instance
 */
export function createMevRiskAnalyzer(config?: MevRiskAnalyzerConfig): MevRiskAnalyzer {
  // Task 3.2: Import MEV_CONFIG to get centralized configuration
  let adaptiveService: AdaptiveThresholdService | undefined;

  try {
    // require() is intentional — synchronous loading for CommonJS target.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MEV_CONFIG } = require('@arbitrage/config');

    if (MEV_CONFIG.adaptiveRiskScoring.enabled) {
      // Convert config from MEV_CONFIG format to AdaptiveThresholdConfig format
      adaptiveService = createAdaptiveThresholdService({
        enabled: true,
        attackThreshold: MEV_CONFIG.adaptiveRiskScoring.attackThreshold,
        activeWindowMs: MEV_CONFIG.adaptiveRiskScoring.activeWindowHours * 60 * 60 * 1000,
        reductionPercent: MEV_CONFIG.adaptiveRiskScoring.reductionPercent,
        decayRatePerDay: MEV_CONFIG.adaptiveRiskScoring.decayRatePerDay,
        maxEvents: MEV_CONFIG.adaptiveRiskScoring.maxEvents,
        retentionMs: MEV_CONFIG.adaptiveRiskScoring.retentionDays * 24 * 60 * 60 * 1000,
      });
    }
  } catch {
    // Config not available (test environment) - fallback to env vars
    const adaptiveEnabled = process.env.FEATURE_ADAPTIVE_RISK_SCORING === 'true';
    if (adaptiveEnabled) {
      adaptiveService = createAdaptiveThresholdService({ enabled: true });
    }
  }

  return new MevRiskAnalyzer(config, adaptiveService);
}
