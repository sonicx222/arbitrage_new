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
 */

import { CHAIN_MEV_STRATEGIES, MevStrategy } from './types';

// =============================================================================
// Types
// =============================================================================

/**
 * Sandwich attack risk levels
 */
export enum SandwichRiskLevel {
  /** Low risk - small transaction, high liquidity */
  LOW = 'low',
  /** Medium risk - moderate transaction size */
  MEDIUM = 'medium',
  /** High risk - large transaction or low liquidity */
  HIGH = 'high',
  /** Critical risk - very large or low liquidity, high slippage */
  CRITICAL = 'critical',
}

/**
 * Mempool recommendation
 */
export enum MempoolRecommendation {
  /** Use public mempool - low risk */
  PUBLIC = 'public',
  /** Use private mempool - high risk */
  PRIVATE = 'private',
  /** Conditional - depends on other factors */
  CONDITIONAL = 'conditional',
}

/**
 * Transaction context for risk analysis
 */
export interface TransactionContext {
  /** Chain identifier (e.g., 'ethereum', 'arbitrum') */
  chain: string;
  /** Transaction value in USD */
  valueUsd: number;
  /** Token symbol being traded (optional) */
  tokenSymbol?: string;
  /** DEX protocol (e.g., 'uniswap_v2', 'sushiswap') */
  dexProtocol?: string;
  /** Slippage tolerance in basis points (e.g., 50 = 0.5%) */
  slippageBps: number;
  /** Pool liquidity in USD (optional) */
  poolLiquidityUsd?: number;
  /** Whether trading a stable pair (e.g., USDC-USDT) */
  isStablePair?: boolean;
  /** Current gas price in wei (optional) */
  gasPrice?: bigint;
  /** Expected profit in USD (optional, for arbitrage) */
  expectedProfitUsd?: number;
}

/**
 * MEV risk assessment result
 */
export interface MevRiskAssessment {
  /** Sandwich attack risk level */
  sandwichRisk: SandwichRiskLevel;
  /** Sandwich risk score (0-100) */
  sandwichRiskScore: number;
  /** Recommended priority fee in gwei (0 for Solana) */
  recommendedPriorityFeeGwei: number;
  /** Recommended tip in lamports (for Solana only) */
  recommendedTipLamports?: number;
  /** Mempool recommendation */
  mempoolRecommendation: MempoolRecommendation;
  /** Recommended MEV strategy for the chain */
  recommendedStrategy: MevStrategy;
  /** List of identified risk factors */
  riskFactors: string[];
  /** Estimated MEV exposure in USD */
  estimatedMevExposureUsd: number;
}

/**
 * MEV Risk Analyzer configuration
 */
export interface MevRiskAnalyzerConfig {
  /** USD threshold for high-value transactions (default: 10000) */
  highValueThresholdUsd?: number;
  /** Slippage threshold for high sandwich risk in bps (default: 100 = 1%) */
  sandwichRiskThresholdBps?: number;
  /** Minimum liquidity ratio for safety (default: 0.01 = 1%) */
  minLiquidityRatioForSafety?: number;
  /** Base priority fee for Ethereum in gwei (default: 2) */
  basePriorityFeeEthereumGwei?: number;
  /** Base tip for Solana in lamports (default: 1000000 = 0.001 SOL) */
  baseTipSolanaLamports?: number;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Default configuration values for MEV risk analysis
 */
export const MEV_RISK_DEFAULTS = {
  /** USD threshold for high-value transactions */
  highValueThresholdUsd: 10000,
  /** Slippage threshold for high sandwich risk in bps (1%) */
  sandwichRiskThresholdBps: 100,
  /** Minimum liquidity ratio for safety (1% of pool) */
  minLiquidityRatioForSafety: 0.01,
  /** Base priority fee for Ethereum in gwei */
  basePriorityFeeEthereumGwei: 2,
  /** Base tip for Solana in lamports (0.001 SOL) */
  baseTipSolanaLamports: 1_000_000,
  /** Risk score thresholds */
  riskScoreThresholds: {
    low: 30,
    medium: 70,
    high: 90,
  },
  /**
   * Chain-specific base priority fees in gwei
   *
   * NOTE: These values are synchronized with MEV_CONFIG in shared/config.
   * If you update these, also update shared/config/src/mev-config.ts
   */
  chainBasePriorityFees: {
    ethereum: 2,
    bsc: 3,
    polygon: 30,
    arbitrum: 0.01,
    optimism: 0.01,
    base: 0.01,
    zksync: 0.01,
    linea: 0.01,
    avalanche: 25,  // Higher due to network congestion patterns
    fantom: 100,    // Higher due to network characteristics
    solana: 0,      // Solana uses lamports for tips, not gwei (use recommendedTipLamports)
  } as Record<string, number>,
  /** L2 chains with sequencer-based MEV protection */
  l2ChainsWithSequencer: ['arbitrum', 'optimism', 'base', 'zksync', 'linea'],
};

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

  constructor(config?: MevRiskAnalyzerConfig) {
    this.config = {
      highValueThresholdUsd: config?.highValueThresholdUsd ?? MEV_RISK_DEFAULTS.highValueThresholdUsd,
      sandwichRiskThresholdBps: config?.sandwichRiskThresholdBps ?? MEV_RISK_DEFAULTS.sandwichRiskThresholdBps,
      minLiquidityRatioForSafety: config?.minLiquidityRatioForSafety ?? MEV_RISK_DEFAULTS.minLiquidityRatioForSafety,
      basePriorityFeeEthereumGwei: config?.basePriorityFeeEthereumGwei ?? MEV_RISK_DEFAULTS.basePriorityFeeEthereumGwei,
      baseTipSolanaLamports: config?.baseTipSolanaLamports ?? MEV_RISK_DEFAULTS.baseTipSolanaLamports,
    };
  }

  /**
   * Assess MEV risk for a transaction
   *
   * @param context - Transaction context for analysis
   * @returns MEV risk assessment with recommendations
   */
  assessRisk(context: TransactionContext): MevRiskAssessment {
    // Handle edge case of zero value
    if (context.valueUsd === 0) {
      return this.createLowRiskAssessment(context);
    }

    // Calculate risk factors
    const riskFactors: string[] = [];
    let riskScore = 0;

    // 1. Value-to-liquidity ratio factor
    const liquidityRatio = this.calculateLiquidityRatio(context);
    const liquidityRiskScore = this.scoreLiquidityRatio(liquidityRatio, riskFactors);
    riskScore += liquidityRiskScore;

    // 2. Slippage tolerance factor
    const slippageRiskScore = this.scoreSlippage(context.slippageBps, riskFactors);
    riskScore += slippageRiskScore;

    // 3. Absolute value factor
    const valueRiskScore = this.scoreAbsoluteValue(context.valueUsd, riskFactors);
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
   */
  private scoreSlippage(slippageBps: number, riskFactors: string[]): number {
    // High threshold from config (default 100 bps = 1%)
    const highThreshold = this.config.sandwichRiskThresholdBps;
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
   */
  private scoreAbsoluteValue(valueUsd: number, riskFactors: string[]): number {
    if (valueUsd >= 100_000) {
      riskFactors.push('very_high_value');
      return 25;
    } else if (valueUsd >= this.config.highValueThresholdUsd) {
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
 * Create a MEV risk analyzer with optional configuration
 */
export function createMevRiskAnalyzer(config?: MevRiskAnalyzerConfig): MevRiskAnalyzer {
  return new MevRiskAnalyzer(config);
}

// =============================================================================
// Config Synchronization Validation
// =============================================================================

/**
 * Validation result for config synchronization
 */
export interface ConfigSyncValidationResult {
  /** Whether configs are synchronized */
  valid: boolean;
  /** List of mismatches found */
  mismatches: ConfigMismatch[];
}

/**
 * Details of a config mismatch
 */
export interface ConfigMismatch {
  chain: string;
  field: string;
  riskAnalyzerValue: number | string;
  externalConfigValue?: number | string;
  message: string;
}

/**
 * Validate that MEV_RISK_DEFAULTS is synchronized with external config
 *
 * This function should be called during application startup or in tests
 * to ensure configuration consistency.
 *
 * @param externalChainConfig - Chain configuration from MEV_CONFIG or similar
 * @returns Validation result with any mismatches found
 *
 * @example
 * ```typescript
 * import { validateConfigSync, MEV_RISK_DEFAULTS } from './mev-risk-analyzer';
 * import { MEV_CONFIG } from '@arbitrage/config';
 *
 * // Convert MEV_CONFIG to the expected format
 * const chainConfigs = Object.entries(MEV_CONFIG.chainSettings).map(([chain, settings]) => ({
 *   chain,
 *   priorityFeeGwei: settings.priorityFeeGwei,
 * }));
 *
 * const result = validateConfigSync(chainConfigs);
 * if (!result.valid) {
 *   console.warn('Config mismatch detected:', result.mismatches);
 * }
 * ```
 */
export function validateConfigSync(
  externalChainConfig: Array<{ chain: string; priorityFeeGwei: number }>
): ConfigSyncValidationResult {
  const mismatches: ConfigMismatch[] = [];

  for (const { chain, priorityFeeGwei } of externalChainConfig) {
    const localValue = MEV_RISK_DEFAULTS.chainBasePriorityFees[chain];

    // Skip if chain is not in local config (external config may have more chains)
    if (localValue === undefined) {
      continue;
    }

    // Check for mismatch (allow small floating point differences)
    if (Math.abs(localValue - priorityFeeGwei) > 0.001) {
      mismatches.push({
        chain,
        field: 'priorityFeeGwei',
        riskAnalyzerValue: localValue,
        externalConfigValue: priorityFeeGwei,
        message: `Chain "${chain}": MEV_RISK_DEFAULTS.chainBasePriorityFees[${chain}] = ${localValue}, but external config has ${priorityFeeGwei}`,
      });
    }
  }

  // Also check for chains in local config that aren't in external config
  for (const chain of Object.keys(MEV_RISK_DEFAULTS.chainBasePriorityFees)) {
    const externalEntry = externalChainConfig.find((c) => c.chain === chain);
    if (!externalEntry) {
      mismatches.push({
        chain,
        field: 'chain',
        riskAnalyzerValue: MEV_RISK_DEFAULTS.chainBasePriorityFees[chain],
        message: `Chain "${chain}" is in MEV_RISK_DEFAULTS but not in external config`,
      });
    }
  }

  return {
    valid: mismatches.length === 0,
    mismatches,
  };
}

/**
 * Get all chains with their local priority fee defaults
 *
 * Useful for debugging or displaying config state.
 */
export function getLocalChainPriorityFees(): Record<string, number> {
  return { ...MEV_RISK_DEFAULTS.chainBasePriorityFees };
}
