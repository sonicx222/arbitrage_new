/**
 * P2-8: FlashLoanFeeCalculator - Extracted from flash-loan.strategy.ts
 *
 * Calculates flash loan fees and analyzes profitability for arbitrage opportunities.
 * This class encapsulates the fee calculation logic that was previously embedded
 * in FlashLoanStrategy, making it reusable and testable.
 *
 * Features:
 * - Flash loan fee calculation with chain-specific overrides
 * - Profitability analysis comparing flash loan vs direct execution
 * - Support for custom fee configurations
 *
 * @see docs/research/REFACTORING_IMPLEMENTATION_PLAN.md P2-8
 * @see ADR-020: Flash Loan Strategy
 */

import { ethers } from 'ethers';
import {
  FLASH_LOAN_PROVIDERS,
  getAaveV3FeeBpsBigInt,
  getBpsDenominatorBigInt,
} from '@arbitrage/config';

// =============================================================================
// Types
// =============================================================================

/**
 * Parameters for profitability analysis
 */
export interface ProfitabilityParams {
  expectedProfitUsd: number;
  flashLoanAmountWei: bigint;
  estimatedGasUnits: bigint;
  gasPriceWei: bigint;
  chain: string;
  ethPriceUsd: number;
  userCapitalWei?: bigint;
}

/**
 * Result of profitability analysis
 */
export interface ProfitabilityAnalysis {
  isProfitable: boolean;
  netProfitUsd: number;
  flashLoanFeeUsd: number;
  gasCostUsd: number;
  flashLoanNetProfit: number;
  directExecutionNetProfit: number;
  recommendation: 'flash-loan' | 'direct' | 'skip';
  breakdown: {
    expectedProfit: number;
    flashLoanFee: number;
    gasCost: number;
    totalCosts: number;
  };
}

/**
 * Configuration for FlashLoanFeeCalculator
 */
export interface FlashLoanFeeCalculatorConfig {
  /** Custom flash loan fee overrides per chain (basis points) */
  feeOverrides?: Record<string, number>;
}

// =============================================================================
// FlashLoanFeeCalculator Class
// =============================================================================

/**
 * P2-8: FlashLoanFeeCalculator - Calculates flash loan fees and profitability.
 *
 * This class provides:
 * 1. Chain-specific flash loan fee calculation
 * 2. Profitability analysis comparing flash loan vs direct execution
 * 3. Configurable fee overrides for testing or custom protocols
 *
 * @example
 * ```typescript
 * const calculator = new FlashLoanFeeCalculator();
 *
 * // Calculate fee for 1 ETH flash loan
 * const fee = calculator.calculateFlashLoanFee(parseEther('1'), 'ethereum');
 *
 * // Analyze profitability
 * const analysis = calculator.analyzeProfitability({
 *   expectedProfitUsd: 100,
 *   flashLoanAmountWei: parseEther('10'),
 *   estimatedGasUnits: 500000n,
 *   gasPriceWei: parseGwei('30'),
 *   chain: 'ethereum',
 *   ethPriceUsd: 2000,
 * });
 * ```
 */
export class FlashLoanFeeCalculator {
  private readonly config: FlashLoanFeeCalculatorConfig;

  // Cache BigInt values at instantiation for hot-path performance
  private readonly BPS_DENOMINATOR_BIGINT = getBpsDenominatorBigInt();
  private readonly AAVE_V3_FEE_BPS_BIGINT = getAaveV3FeeBpsBigInt();

  constructor(config: FlashLoanFeeCalculatorConfig = {}) {
    this.config = config;
  }

  /**
   * Calculate flash loan fee for a given amount.
   *
   * Fee calculation priority:
   * 1. Custom fee override from config (if set for chain)
   * 2. Chain-specific fee from FLASH_LOAN_PROVIDERS config
   * 3. Default Aave V3 fee (0.09% = 9 bps)
   *
   * @param amount - Flash loan amount in wei
   * @param chain - Chain identifier
   * @returns Fee amount in wei
   */
  calculateFlashLoanFee(amount: bigint, chain: string): bigint {
    // Check for custom fee override
    const feeOverride = this.config.feeOverrides?.[chain];
    if (feeOverride !== undefined) {
      return (amount * BigInt(feeOverride)) / this.BPS_DENOMINATOR_BIGINT;
    }

    // Use chain-specific fee from FLASH_LOAN_PROVIDERS config
    const flashLoanConfig = FLASH_LOAN_PROVIDERS[chain];
    if (flashLoanConfig) {
      return (amount * BigInt(flashLoanConfig.fee)) / this.BPS_DENOMINATOR_BIGINT;
    }

    // Default to Aave V3 fee (0.09%)
    return (amount * this.AAVE_V3_FEE_BPS_BIGINT) / this.BPS_DENOMINATOR_BIGINT;
  }

  /**
   * Analyze profitability of flash loan vs direct execution.
   *
   * Compares the net profit of:
   * - Flash loan execution: profit - flash loan fee - gas cost
   * - Direct execution: profit - gas cost (assumes user has capital)
   *
   * Recommendations:
   * - 'skip': Not profitable even with flash loan
   * - 'direct': User has capital and direct is more profitable
   * - 'flash-loan': Flash loan is needed or more profitable
   *
   * @param params - Profitability parameters
   * @returns Profitability analysis result
   */
  analyzeProfitability(params: ProfitabilityParams): ProfitabilityAnalysis {
    const {
      expectedProfitUsd,
      flashLoanAmountWei,
      estimatedGasUnits,
      gasPriceWei,
      chain,
      ethPriceUsd,
      userCapitalWei,
    } = params;

    // Calculate flash loan fee in wei, then USD
    const flashLoanFeeWei = this.calculateFlashLoanFee(flashLoanAmountWei, chain);
    const flashLoanFeeEth = parseFloat(ethers.formatEther(flashLoanFeeWei));
    const flashLoanFeeUsd = flashLoanFeeEth * ethPriceUsd;

    // Calculate gas cost in USD
    const gasCostWei = estimatedGasUnits * gasPriceWei;
    const gasCostEth = parseFloat(ethers.formatEther(gasCostWei));
    const gasCostUsd = gasCostEth * ethPriceUsd;

    // Total costs for flash loan execution
    const totalCosts = flashLoanFeeUsd + gasCostUsd;

    // Net profit calculations
    const flashLoanNetProfit = expectedProfitUsd - totalCosts;
    const directExecutionNetProfit = expectedProfitUsd - gasCostUsd;

    // Determine profitability
    const isProfitable = flashLoanNetProfit > 0;
    const netProfitUsd = flashLoanNetProfit;

    // Determine recommendation
    let recommendation: 'flash-loan' | 'direct' | 'skip';

    if (!isProfitable) {
      recommendation = 'skip';
    } else if (userCapitalWei !== undefined && userCapitalWei >= flashLoanAmountWei) {
      // User has capital for direct execution
      if (directExecutionNetProfit > flashLoanNetProfit) {
        recommendation = 'direct';
      } else {
        recommendation = 'flash-loan';
      }
    } else {
      // User doesn't have capital, must use flash loan
      recommendation = 'flash-loan';
    }

    return {
      isProfitable,
      netProfitUsd,
      flashLoanFeeUsd,
      gasCostUsd,
      flashLoanNetProfit,
      directExecutionNetProfit,
      recommendation,
      breakdown: {
        expectedProfit: expectedProfitUsd,
        flashLoanFee: flashLoanFeeUsd,
        gasCost: gasCostUsd,
        totalCosts,
      },
    };
  }

  /**
   * Get current configuration.
   */
  getConfig(): FlashLoanFeeCalculatorConfig {
    return { ...this.config };
  }
}

/**
 * Factory function to create a FlashLoanFeeCalculator.
 */
export function createFlashLoanFeeCalculator(
  config: FlashLoanFeeCalculatorConfig = {}
): FlashLoanFeeCalculator {
  return new FlashLoanFeeCalculator(config);
}
