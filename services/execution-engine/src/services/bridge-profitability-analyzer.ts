/**
 * Bridge Profitability Analyzer
 *
 * Analyzes bridge fees to determine if cross-chain arbitrage opportunities
 * remain profitable after accounting for bridging costs.
 *
 * Extracted from base.strategy.ts as part of R4 refactoring.
 *
 * Features:
 * - Bridge fee to profit ratio calculation
 * - Configurable fee thresholds
 * - Detailed profitability breakdown
 *
 * @see base.strategy.ts (consumer)
 * @see cross-chain.strategy.ts (primary consumer)
 * @see REFACTORING_ROADMAP.md R4
 */

import { ethers } from 'ethers';
import type { Logger } from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * Options for bridge profitability analysis.
 */
export interface BridgeProfitabilityOptions {
  /** Maximum percentage of profit that bridge fees can consume (default: 50%) */
  maxFeePercentage?: number;
  /** Chain name for logging */
  chain?: string;
}

/**
 * Result of bridge profitability analysis.
 */
export interface BridgeProfitabilityResult {
  /** Whether the opportunity remains profitable after bridge fees */
  isProfitable: boolean;
  /** Bridge fee in USD */
  bridgeFeeUsd: number;
  /** Bridge fee in ETH (or native token) */
  bridgeFeeEth: number;
  /** Expected profit after subtracting bridge fees */
  profitAfterFees: number;
  /** Bridge fee as a percentage of expected profit */
  feePercentageOfProfit: number;
  /** Human-readable reason if not profitable */
  reason?: string;
}

/**
 * Configuration for the BridgeProfitabilityAnalyzer.
 */
export interface BridgeProfitabilityAnalyzerConfig {
  /** Default maximum fee percentage (default: 50%) */
  defaultMaxFeePercentage?: number;
}

// =============================================================================
// BridgeProfitabilityAnalyzer Class
// =============================================================================

/**
 * BridgeProfitabilityAnalyzer - Analyzes bridge fees for cross-chain arbitrage profitability.
 *
 * This class encapsulates bridge fee analysis logic previously in BaseExecutionStrategy.
 * It provides clear profitability decisions with detailed breakdowns.
 *
 * Usage:
 * ```typescript
 * const analyzer = new BridgeProfitabilityAnalyzer(logger);
 * const result = analyzer.analyze(bridgeFeeWei, expectedProfitUsd, ethPriceUsd, { chain: 'ethereum' });
 * if (!result.isProfitable) {
 *   logger.warn('Bridge fees too high', { reason: result.reason });
 * }
 * ```
 */
export class BridgeProfitabilityAnalyzer {
  private readonly logger: Logger;
  private readonly defaultMaxFeePercentage: number;

  constructor(logger: Logger, config?: BridgeProfitabilityAnalyzerConfig) {
    this.logger = logger;
    this.defaultMaxFeePercentage = config?.defaultMaxFeePercentage ?? 50;
  }

  /**
   * Check if bridge fees make the opportunity unprofitable.
   *
   * This analysis helps prevent executing trades where bridge fees would
   * consume too much of the expected profit, potentially resulting in a loss
   * after all costs are accounted for.
   *
   * @param bridgeFeeWei - Bridge fee in wei (from bridge quote)
   * @param expectedProfitUsd - Expected profit in USD
   * @param nativeTokenPriceUsd - Price of native token in USD (ETH price for Ethereum)
   * @param options - Configuration options
   * @returns Object with profitability status and details
   */
  analyze(
    bridgeFeeWei: bigint,
    expectedProfitUsd: number,
    nativeTokenPriceUsd: number,
    options: BridgeProfitabilityOptions = {}
  ): BridgeProfitabilityResult {
    const maxFeePercentage = options.maxFeePercentage ?? this.defaultMaxFeePercentage;

    // Convert bridge fee from wei to ETH, then to USD
    const bridgeFeeEth = parseFloat(ethers.formatEther(bridgeFeeWei));
    const bridgeFeeUsd = bridgeFeeEth * nativeTokenPriceUsd;

    // Calculate what percentage of profit the fee represents
    const feePercentageOfProfit = expectedProfitUsd > 0
      ? (bridgeFeeUsd / expectedProfitUsd) * 100
      : 100;

    const profitAfterFees = expectedProfitUsd - bridgeFeeUsd;
    const isProfitable = feePercentageOfProfit < maxFeePercentage;

    if (!isProfitable) {
      this.logger.debug('Bridge fee profitability check failed', {
        bridgeFeeEth,
        bridgeFeeUsd,
        expectedProfitUsd,
        feePercentageOfProfit: feePercentageOfProfit.toFixed(2),
        maxFeePercentage,
        chain: options.chain,
      });
    }

    return {
      isProfitable,
      bridgeFeeUsd,
      bridgeFeeEth,
      profitAfterFees,
      feePercentageOfProfit,
      reason: isProfitable
        ? undefined
        : `Bridge fees ($${bridgeFeeUsd.toFixed(2)}) exceed ${maxFeePercentage}% of expected profit ($${expectedProfitUsd.toFixed(2)})`,
    };
  }

  /**
   * Calculate the minimum profit required for a given bridge fee.
   *
   * This is useful for determining if an opportunity is worth pursuing
   * before getting a detailed quote.
   *
   * @param bridgeFeeWei - Bridge fee in wei
   * @param nativeTokenPriceUsd - Price of native token in USD
   * @param maxFeePercentage - Maximum fee percentage (default: uses instance default)
   * @returns Minimum profit in USD required to remain profitable
   */
  getMinimumProfitRequired(
    bridgeFeeWei: bigint,
    nativeTokenPriceUsd: number,
    maxFeePercentage?: number
  ): number {
    const feePercentage = maxFeePercentage ?? this.defaultMaxFeePercentage;
    const bridgeFeeEth = parseFloat(ethers.formatEther(bridgeFeeWei));
    const bridgeFeeUsd = bridgeFeeEth * nativeTokenPriceUsd;

    // If fee is X% of profit, then profit = fee / (X/100)
    return bridgeFeeUsd / (feePercentage / 100);
  }

  /**
   * Get the default maximum fee percentage.
   */
  getDefaultMaxFeePercentage(): number {
    return this.defaultMaxFeePercentage;
  }
}

// =============================================================================
// Standalone Function (for backward compatibility)
// =============================================================================

/**
 * Check if bridge fees make the opportunity unprofitable.
 *
 * @param bridgeFeeWei - Bridge fee in wei (from bridge quote)
 * @param expectedProfitUsd - Expected profit in USD
 * @param nativeTokenPriceUsd - Price of native token in USD
 * @param logger - Logger instance
 * @param options - Configuration options
 * @returns Object with profitability status and details
 *
 * @deprecated Use BridgeProfitabilityAnalyzer.analyze() instead
 */
export function checkBridgeProfitability(
  bridgeFeeWei: bigint,
  expectedProfitUsd: number,
  nativeTokenPriceUsd: number,
  logger: Logger,
  options: BridgeProfitabilityOptions = {}
): BridgeProfitabilityResult {
  const analyzer = new BridgeProfitabilityAnalyzer(logger);
  return analyzer.analyze(bridgeFeeWei, expectedProfitUsd, nativeTokenPriceUsd, options);
}
