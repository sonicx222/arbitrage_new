/**
 * Expected Value (EV) Calculator
 *
 * Phase 3: Capital & Risk Controls (P0)
 * Task 3.4.2: Expected Value Calculator
 *
 * Calculates the expected value of arbitrage opportunities using the formula:
 *   EV = (winProbability × expectedProfit) - (lossProbability × gasCost)
 *
 * Uses ExecutionProbabilityTracker (Task 3.4.1) to obtain historical
 * win probabilities based on (chain, DEX, pathLength) combinations.
 *
 * @see docs/reports/implementation_plan_v3.md Section 3.4.2
 */

import { createLogger, Logger } from '../logger';
import type { ExecutionProbabilityTracker } from './execution-probability-tracker';
import type {
  EVCalculation,
  EVCalculatorStats,
  EVConfig,
  EVInput,
} from './types';

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: EVConfig = {
  minEVThreshold: 5000000000000000n, // 0.005 ETH (~$10 at $2000/ETH)
  minWinProbability: 0.3, // 30% minimum win probability
  maxLossPerTrade: 100000000000000000n, // 0.1 ETH
  useHistoricalGasCost: true,
  defaultGasCost: 10000000000000000n, // 0.01 ETH
  defaultProfitEstimate: 50000000000000000n, // 0.05 ETH
};

// =============================================================================
// EVCalculator Implementation
// =============================================================================

/**
 * Calculates expected value for arbitrage opportunities.
 *
 * The EVCalculator uses historical execution data from ExecutionProbabilityTracker
 * to compute the expected value of potential trades. This enables data-driven
 * decision making for trade execution.
 *
 * Key features:
 * - O(1) EV calculation per opportunity
 * - Configurable thresholds for execution decisions
 * - Flexible input handling (multiple field name formats)
 * - Statistics tracking for monitoring
 */
export class EVCalculator {
  private config: EVConfig;
  private probabilityTracker: ExecutionProbabilityTracker;
  private logger: Logger;

  // Statistics
  private totalCalculations = 0;
  private approvedCount = 0;
  private rejectedLowEV = 0;
  private rejectedLowProbability = 0;
  private rejectedMaxLoss = 0;
  private totalEV = 0n;
  private totalApprovedEV = 0n;

  constructor(
    probabilityTracker: ExecutionProbabilityTracker,
    config: Partial<EVConfig> = {}
  ) {
    this.probabilityTracker = probabilityTracker;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger('ev-calculator');

    this.logger.info('EVCalculator initialized', {
      minEVThreshold: this.config.minEVThreshold.toString(),
      minWinProbability: this.config.minWinProbability,
      useHistoricalGasCost: this.config.useHistoricalGasCost,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API: Calculate EV
  // ---------------------------------------------------------------------------

  /**
   * Calculates the expected value for an arbitrage opportunity.
   *
   * Formula: EV = (winProb × profit) - (lossProb × gasCost)
   *
   * @param input - The opportunity input with chain, dex, and estimates
   * @returns EVCalculation with expected value and execution recommendation
   */
  calculate(input: EVInput): EVCalculation {
    // Extract values from flexible input format
    const chain = input.chain;
    const dex = input.dex;
    const pathLength = this.resolvePathLength(input);
    const profitEstimate = this.resolveProfitEstimate(input);
    const gasCostEstimate = this.resolveGasCost(input, chain);

    // Get win probability from tracker
    const probResult = this.probabilityTracker.getWinProbability({
      chain,
      dex,
      pathLength,
    });

    const winProbability = probResult.winProbability;
    const lossProbability = 1 - winProbability;

    // Calculate expected values
    // Note: Using integer math for BigInt. We scale probability by 10000 for 0.01% precision.
    const scaleFactor = 10000n;
    const winProbScaled = BigInt(Math.floor(winProbability * 10000));
    const lossProbScaled = BigInt(Math.floor(lossProbability * 10000));

    const expectedProfit = (profitEstimate * winProbScaled) / scaleFactor;
    const expectedGasCost = (gasCostEstimate * lossProbScaled) / scaleFactor;
    const expectedValue = expectedProfit - expectedGasCost;

    // Determine if should execute
    const { shouldExecute, reason } = this.evaluateExecution(
      expectedValue,
      winProbability,
      probResult.isDefault,
      gasCostEstimate
    );

    // Update statistics
    this.updateStats(shouldExecute, expectedValue, reason);

    const result: EVCalculation = {
      expectedValue,
      winProbability,
      expectedProfit,
      expectedGasCost,
      shouldExecute,
      reason,
      probabilitySource: probResult.isDefault ? 'default' : 'historical',
      sampleCount: probResult.sampleCount,
      rawProfitEstimate: profitEstimate,
      rawGasCost: gasCostEstimate,
    };

    this.logger.debug('EV calculated', {
      chain,
      dex,
      pathLength,
      expectedValue: expectedValue.toString(),
      winProbability,
      shouldExecute,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Public API: Statistics
  // ---------------------------------------------------------------------------

  /**
   * Gets aggregated statistics from the calculator.
   *
   * @returns Calculator statistics
   */
  getStats(): EVCalculatorStats {
    return {
      totalCalculations: this.totalCalculations,
      approvedCount: this.approvedCount,
      rejectedLowEV: this.rejectedLowEV,
      rejectedLowProbability: this.rejectedLowProbability,
      rejectedMaxLoss: this.rejectedMaxLoss,
      averageApprovedEV: this.approvedCount > 0
        ? this.totalApprovedEV / BigInt(this.approvedCount)
        : 0n,
      averageEV: this.totalCalculations > 0
        ? this.totalEV / BigInt(this.totalCalculations)
        : 0n,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API: Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Clears calculator statistics without destroying the instance.
   */
  clear(): void {
    this.totalCalculations = 0;
    this.approvedCount = 0;
    this.rejectedLowEV = 0;
    this.rejectedLowProbability = 0;
    this.rejectedMaxLoss = 0;
    this.totalEV = 0n;
    this.totalApprovedEV = 0n;

    this.logger.info('EVCalculator cleared');
  }

  /**
   * Destroys the calculator and releases resources.
   */
  destroy(): void {
    this.clear();
    this.logger.info('EVCalculator destroyed');
  }

  // ---------------------------------------------------------------------------
  // Private: Input Resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolves pathLength from various input formats.
   */
  private resolvePathLength(input: EVInput): number {
    // Explicit pathLength takes precedence
    if (input.pathLength !== undefined && input.pathLength !== null) {
      return input.pathLength;
    }

    // Infer from path array (length - 1 = number of swaps)
    if (input.path && input.path.length > 1) {
      return input.path.length - 1;
    }

    // Default to 2 (simple A→B→A arbitrage)
    return 2;
  }

  /**
   * Resolves profit estimate from various input field names.
   */
  private resolveProfitEstimate(input: EVInput): bigint {
    // Check explicit fields in order of preference
    if (input.estimatedProfit !== undefined && input.estimatedProfit !== null) {
      return input.estimatedProfit;
    }

    if (input.expectedProfit !== undefined && input.expectedProfit !== null) {
      return input.expectedProfit;
    }

    // Fall back to default
    return this.config.defaultProfitEstimate;
  }

  /**
   * Resolves gas cost estimate from input or historical data.
   */
  private resolveGasCost(input: EVInput, chain: string): bigint {
    // Check explicit fields first
    if (input.estimatedGas !== undefined && input.estimatedGas !== null) {
      return input.estimatedGas;
    }

    if (input.gasEstimate !== undefined && input.gasEstimate !== null) {
      return input.gasEstimate;
    }

    // Try historical gas cost if enabled
    if (this.config.useHistoricalGasCost) {
      const gasCostResult = this.probabilityTracker.getAverageGasCost({ chain });
      if (gasCostResult.sampleCount > 0) {
        return gasCostResult.averageGasCost;
      }
    }

    // Fall back to default
    return this.config.defaultGasCost;
  }

  // ---------------------------------------------------------------------------
  // Private: Execution Evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluates whether an opportunity should be executed.
   */
  private evaluateExecution(
    expectedValue: bigint,
    winProbability: number,
    isDefaultProbability: boolean,
    potentialLoss: bigint
  ): { shouldExecute: boolean; reason?: string } {
    // Check max loss per trade first (risk cap)
    if (potentialLoss > this.config.maxLossPerTrade) {
      return {
        shouldExecute: false,
        reason: `Potential loss (${potentialLoss.toString()}) exceeds max loss per trade (${this.config.maxLossPerTrade.toString()})`,
      };
    }

    // Check win probability threshold (more important filter)
    if (winProbability < this.config.minWinProbability && !isDefaultProbability) {
      return {
        shouldExecute: false,
        reason: `Win probability (${(winProbability * 100).toFixed(1)}%) below minimum threshold (${(this.config.minWinProbability * 100).toFixed(1)}%)`,
      };
    }

    // Check EV threshold
    if (expectedValue < this.config.minEVThreshold) {
      return {
        shouldExecute: false,
        reason: `EV (${expectedValue.toString()}) below threshold (${this.config.minEVThreshold.toString()})`,
      };
    }

    return { shouldExecute: true };
  }

  // ---------------------------------------------------------------------------
  // Private: Statistics
  // ---------------------------------------------------------------------------

  /**
   * Updates internal statistics after a calculation.
   */
  private updateStats(
    shouldExecute: boolean,
    expectedValue: bigint,
    reason?: string
  ): void {
    this.totalCalculations++;
    this.totalEV += expectedValue;

    if (shouldExecute) {
      this.approvedCount++;
      this.totalApprovedEV += expectedValue;
    } else if (reason) {
      if (reason.includes('max loss') || reason.includes('Potential loss')) {
        this.rejectedMaxLoss++;
      } else if (reason.includes('probability')) {
        this.rejectedLowProbability++;
      } else if (reason.includes('EV') || reason.includes('threshold')) {
        this.rejectedLowEV++;
      }
    }
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let calculatorInstance: EVCalculator | null = null;
let initializingCalculator = false;

/**
 * Gets the singleton EVCalculator instance.
 *
 * Creates a new instance on first call. Subsequent calls return the same instance.
 * Note: probabilityTracker and config are only used on first call. Passing different
 * values on subsequent calls will be ignored (singleton pattern).
 *
 * @param probabilityTracker - The tracker to use for probability lookups (required on first call)
 * @param config - Optional configuration (only used on first call)
 * @returns The singleton calculator instance
 * @throws Error if called during initialization (race condition prevention)
 */
export function getEVCalculator(
  probabilityTracker: ExecutionProbabilityTracker,
  config?: Partial<EVConfig>
): EVCalculator {
  // P0-FIX 5.1: Prevent race condition during initialization
  if (initializingCalculator) {
    throw new Error('EVCalculator is being initialized. Avoid concurrent initialization.');
  }

  if (!calculatorInstance) {
    initializingCalculator = true;
    try {
      calculatorInstance = new EVCalculator(probabilityTracker, config);
    } finally {
      initializingCalculator = false;
    }
  }
  return calculatorInstance;
}

/**
 * Resets the singleton instance.
 *
 * Destroys the existing instance if present. A new instance will be created
 * on the next call to getEVCalculator().
 *
 * P0-FIX 5.2: Set instance to null BEFORE destroy to prevent race condition
 * where getEVCalculator() could return the destroyed instance.
 */
export function resetEVCalculator(): void {
  if (calculatorInstance) {
    // P0-FIX 5.2: Capture reference and null out first to prevent race
    const instanceToDestroy = calculatorInstance;
    calculatorInstance = null;
    instanceToDestroy.destroy();
  }
}
