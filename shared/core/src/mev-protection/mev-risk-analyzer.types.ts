/**
 * MEV Risk Analyzer Types and Defaults
 *
 * Type definitions and configuration defaults for MEV risk analysis.
 * Extracted from mev-risk-analyzer.ts for focused module organization.
 *
 * @module mev-protection/mev-risk-analyzer.types
 * @see mev-risk-analyzer.ts for the analyzer implementation
 */

import type { MevStrategy } from './types';

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
