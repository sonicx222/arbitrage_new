/**
 * Kelly Position Sizer
 *
 * Phase 3: Capital & Risk Controls (P0)
 * Task 3.4.3: Position Sizer (Kelly Criterion)
 *
 * Calculates optimal position sizes using the Kelly Criterion:
 *   f* = (p * b - q) / b
 * Where:
 *   p = win probability
 *   q = loss probability (1 - p)
 *   b = odds (expectedProfit / expectedLoss)
 *
 * Uses fractional Kelly (configurable multiplier, default 0.5) for reduced
 * variance while maintaining most of the growth benefit.
 *
 * @see docs/reports/implementation_plan_v3.md Section 3.4.3
 */

import { createLogger, Logger } from '../logger';
import type {
  PositionSize,
  PositionSizeInput,
  PositionSizerConfig,
  PositionSizerStats,
} from './types';

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: PositionSizerConfig = {
  kellyMultiplier: 0.5, // Half Kelly (safer)
  maxSingleTradeFraction: 0.02, // 2% max per trade
  minTradeFraction: 0.001, // 0.1% minimum
  totalCapital: 0n, // Must be set by caller
  enabled: true,
};

// =============================================================================
// KellyPositionSizer Implementation
// =============================================================================

/**
 * Calculates optimal position sizes using the Kelly Criterion.
 *
 * The Kelly Criterion maximizes long-term capital growth by sizing
 * positions based on edge (win probability and odds). This implementation
 * uses fractional Kelly to reduce variance.
 *
 * Key features:
 * - O(1) position sizing calculation
 * - Configurable Kelly multiplier (fractional Kelly)
 * - Hard caps on min/max position sizes
 * - Statistics tracking for monitoring
 */
export class KellyPositionSizer {
  private config: PositionSizerConfig;
  private logger: Logger;

  // Statistics
  private totalCalculations = 0;
  private tradesApproved = 0;
  private rejectedNegativeKelly = 0;
  private rejectedBelowMinimum = 0;
  private cappedAtMaximum = 0;
  private totalFraction = 0; // Sum of approved fractions for averaging

  constructor(config: Partial<PositionSizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = createLogger('kelly-position-sizer');

    // FIX 3.1: Validate configuration to prevent silent failures
    this.validateConfig();

    this.logger.info('KellyPositionSizer initialized', {
      kellyMultiplier: this.config.kellyMultiplier,
      maxSingleTradeFraction: this.config.maxSingleTradeFraction,
      minTradeFraction: this.config.minTradeFraction,
      totalCapital: this.config.totalCapital.toString(),
      enabled: this.config.enabled,
    });
  }

  /**
   * FIX 3.1: Validates configuration to prevent silent failures.
   * Throws on invalid config, warns on dangerous defaults.
   */
  private validateConfig(): void {
    // Validate numeric ranges
    if (this.config.kellyMultiplier <= 0 || this.config.kellyMultiplier > 1) {
      throw new Error('kellyMultiplier must be between 0 (exclusive) and 1 (inclusive)');
    }
    if (this.config.maxSingleTradeFraction <= 0 || this.config.maxSingleTradeFraction > 1) {
      throw new Error('maxSingleTradeFraction must be between 0 (exclusive) and 1 (inclusive)');
    }
    if (this.config.minTradeFraction < 0 || this.config.minTradeFraction >= this.config.maxSingleTradeFraction) {
      throw new Error('minTradeFraction must be >= 0 and < maxSingleTradeFraction');
    }

    // FIX 3.1: Warn about zero capital - this is a dangerous configuration
    // that will silently approve trades with size 0
    if (this.config.totalCapital === 0n && this.config.enabled) {
      this.logger.warn(
        'CONFIGURATION WARNING: totalCapital is 0 with enabled=true. ' +
        'All trades will be sized to 0. Call updateCapital() before trading.'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Public API: Calculate Position Size
  // ---------------------------------------------------------------------------

  /**
   * Calculates the optimal position size for a trade opportunity.
   *
   * Uses the Kelly Criterion formula: f* = (p * b - q) / b
   * Then applies:
   * 1. Fractional Kelly (multiplier)
   * 2. Max cap (maxSingleTradeFraction)
   * 3. Min threshold (minTradeFraction)
   *
   * @param input - Win probability and expected profit/loss
   * @returns Position sizing result with recommended size and metadata
   */
  calculateSize(input: PositionSizeInput): PositionSize {
    this.totalCalculations++;

    // Handle disabled state (fallback to max size)
    if (!this.config.enabled) {
      return this.createDisabledResult();
    }

    // FIX 3.1: Reject trades when capital is not configured
    // This prevents silent 0-size trade approvals
    if (this.config.totalCapital === 0n) {
      return this.createZeroCapitalResult();
    }

    // Calculate odds (profit/loss ratio)
    const odds = this.calculateOdds(input.expectedProfit, input.expectedLoss);

    // Handle edge case: zero or undefined odds
    if (odds === 0 || !Number.isFinite(odds)) {
      return this.createZeroOddsResult(odds);
    }

    // Calculate raw Kelly fraction: f* = (p * b - q) / b
    const p = input.winProbability;
    const q = 1 - p;
    const b = odds;
    const kellyFraction = (p * b - q) / b;

    // Apply Kelly multiplier (fractional Kelly)
    const adjustedKelly = kellyFraction * this.config.kellyMultiplier;

    // Handle negative Kelly (don't trade)
    if (kellyFraction <= 0 || adjustedKelly <= 0) {
      return this.createNegativeKellyResult(kellyFraction, adjustedKelly);
    }

    // Apply min/max caps
    const { cappedFraction, wasCapped, belowMinimum } = this.applyCaps(adjustedKelly);

    // Handle below minimum threshold
    if (belowMinimum) {
      return this.createBelowMinimumResult(kellyFraction, adjustedKelly, cappedFraction);
    }

    // Track statistics
    if (wasCapped) {
      this.cappedAtMaximum++;
    }
    this.tradesApproved++;
    this.totalFraction += cappedFraction;

    // Calculate actual position size in wei
    const maxAllowed = this.calculateMaxAllowed();
    const recommendedSize = this.calculateSizeFromFraction(cappedFraction);

    const result: PositionSize = {
      recommendedSize,
      fractionOfCapital: cappedFraction,
      kellyFraction,
      adjustedKelly,
      cappedFraction,
      maxAllowed,
      shouldTrade: true,
    };

    this.logger.debug('Position size calculated', {
      winProbability: input.winProbability,
      odds: b.toFixed(4),
      kellyFraction: kellyFraction.toFixed(4),
      adjustedKelly: adjustedKelly.toFixed(4),
      cappedFraction: cappedFraction.toFixed(4),
      recommendedSize: recommendedSize.toString(),
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Public API: Update Capital
  // ---------------------------------------------------------------------------

  /**
   * Updates the total capital available for trading.
   *
   * Call this when capital changes (deposits, withdrawals, P&L).
   *
   * @param newCapital - New total capital in wei
   */
  updateCapital(newCapital: bigint): void {
    this.config.totalCapital = newCapital;

    this.logger.info('Capital updated', {
      newCapital: newCapital.toString(),
    });
  }

  // ---------------------------------------------------------------------------
  // Public API: Statistics
  // ---------------------------------------------------------------------------

  /**
   * Gets aggregated statistics from the sizer.
   *
   * @returns Sizer statistics
   */
  getStats(): PositionSizerStats {
    return {
      totalCalculations: this.totalCalculations,
      tradesApproved: this.tradesApproved,
      rejectedNegativeKelly: this.rejectedNegativeKelly,
      rejectedBelowMinimum: this.rejectedBelowMinimum,
      cappedAtMaximum: this.cappedAtMaximum,
      averageFraction: this.tradesApproved > 0
        ? this.totalFraction / this.tradesApproved
        : 0,
      totalCapitalUsed: this.config.totalCapital,
    };
  }

  // ---------------------------------------------------------------------------
  // Public API: Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Clears statistics without destroying the instance.
   */
  clear(): void {
    this.totalCalculations = 0;
    this.tradesApproved = 0;
    this.rejectedNegativeKelly = 0;
    this.rejectedBelowMinimum = 0;
    this.cappedAtMaximum = 0;
    this.totalFraction = 0;

    this.logger.info('KellyPositionSizer cleared');
  }

  /**
   * Destroys the sizer and releases resources.
   */
  destroy(): void {
    this.clear();
    this.logger.info('KellyPositionSizer destroyed');
  }

  // ---------------------------------------------------------------------------
  // Private: Calculation Helpers
  // ---------------------------------------------------------------------------

  /**
   * Calculates odds (profit/loss ratio) from BigInt values.
   */
  private calculateOdds(expectedProfit: bigint, expectedLoss: bigint): number {
    if (expectedLoss === 0n) {
      // Infinite odds when loss is zero (free money!)
      return Number.POSITIVE_INFINITY;
    }

    if (expectedProfit === 0n) {
      return 0;
    }

    // Convert BigInt to number for floating-point division
    // This is safe because odds is a ratio, not absolute value
    return Number(expectedProfit) / Number(expectedLoss);
  }

  /**
   * Applies min/max caps to the adjusted Kelly fraction.
   */
  private applyCaps(adjustedKelly: number): {
    cappedFraction: number;
    wasCapped: boolean;
    belowMinimum: boolean;
  } {
    let cappedFraction = adjustedKelly;
    let wasCapped = false;
    let belowMinimum = false;

    // Apply maximum cap
    if (cappedFraction > this.config.maxSingleTradeFraction) {
      cappedFraction = this.config.maxSingleTradeFraction;
      wasCapped = true;
    }

    // Check minimum threshold
    if (cappedFraction < this.config.minTradeFraction) {
      belowMinimum = true;
    }

    return { cappedFraction, wasCapped, belowMinimum };
  }

  /**
   * Calculates maximum allowed position size in wei.
   */
  private calculateMaxAllowed(): bigint {
    // Use integer math: (capital * fraction * 10000) / 10000
    const scaleFactor = 10000n;
    const fractionScaled = BigInt(Math.floor(this.config.maxSingleTradeFraction * 10000));

    return (this.config.totalCapital * fractionScaled) / scaleFactor;
  }

  /**
   * Calculates position size in wei from fraction.
   */
  private calculateSizeFromFraction(fraction: number): bigint {
    // Use integer math: (capital * fraction * 10000) / 10000
    const scaleFactor = 10000n;
    const fractionScaled = BigInt(Math.floor(fraction * 10000));

    return (this.config.totalCapital * fractionScaled) / scaleFactor;
  }

  // ---------------------------------------------------------------------------
  // Private: Result Builders
  // ---------------------------------------------------------------------------

  /**
   * Creates result when sizer is disabled.
   */
  private createDisabledResult(): PositionSize {
    const maxAllowed = this.calculateMaxAllowed();

    this.tradesApproved++;
    this.totalFraction += this.config.maxSingleTradeFraction;

    return {
      recommendedSize: maxAllowed,
      fractionOfCapital: this.config.maxSingleTradeFraction,
      kellyFraction: 0,
      adjustedKelly: 0,
      cappedFraction: this.config.maxSingleTradeFraction,
      maxAllowed,
      shouldTrade: true,
    };
  }

  /**
   * Creates result when odds are zero or undefined.
   */
  private createZeroOddsResult(odds: number): PositionSize {
    // Special case: infinite odds (zero loss)
    if (odds === Number.POSITIVE_INFINITY) {
      const maxAllowed = this.calculateMaxAllowed();
      const fraction = this.config.maxSingleTradeFraction;

      this.tradesApproved++;
      this.cappedAtMaximum++;
      this.totalFraction += fraction;

      return {
        recommendedSize: maxAllowed,
        fractionOfCapital: fraction,
        kellyFraction: 1, // Kelly approaches 1 with infinite odds
        adjustedKelly: this.config.kellyMultiplier,
        cappedFraction: fraction,
        maxAllowed,
        shouldTrade: true,
      };
    }

    // Zero odds (zero profit) - don't trade
    this.rejectedNegativeKelly++;

    return {
      recommendedSize: 0n,
      fractionOfCapital: 0,
      kellyFraction: 0,
      adjustedKelly: 0,
      cappedFraction: 0,
      maxAllowed: this.calculateMaxAllowed(),
      shouldTrade: false,
      reason: 'Zero expected profit - no edge',
    };
  }

  /**
   * Creates result for negative Kelly (unfavorable edge).
   */
  private createNegativeKellyResult(kellyFraction: number, adjustedKelly: number): PositionSize {
    this.rejectedNegativeKelly++;

    return {
      recommendedSize: 0n,
      fractionOfCapital: 0,
      kellyFraction,
      adjustedKelly,
      cappedFraction: 0,
      maxAllowed: this.calculateMaxAllowed(),
      shouldTrade: false,
      reason: `Negative Kelly (${kellyFraction.toFixed(4)}) - unfavorable edge`,
    };
  }

  /**
   * Creates result when position size is below minimum threshold.
   */
  private createBelowMinimumResult(
    kellyFraction: number,
    adjustedKelly: number,
    cappedFraction: number
  ): PositionSize {
    this.rejectedBelowMinimum++;

    return {
      recommendedSize: 0n,
      fractionOfCapital: 0,
      kellyFraction,
      adjustedKelly,
      cappedFraction,
      maxAllowed: this.calculateMaxAllowed(),
      shouldTrade: false,
      reason: `Position size (${(cappedFraction * 100).toFixed(2)}%) below minimum (${(this.config.minTradeFraction * 100).toFixed(2)}%)`,
    };
  }

  /**
   * FIX 3.1: Creates result when capital is not configured.
   * This prevents silent 0-size trade approvals.
   */
  private createZeroCapitalResult(): PositionSize {
    // Count this as a rejection for statistics
    this.rejectedBelowMinimum++;

    this.logger.warn('Trade rejected: totalCapital is 0. Call updateCapital() first.');

    return {
      recommendedSize: 0n,
      fractionOfCapital: 0,
      kellyFraction: 0,
      adjustedKelly: 0,
      cappedFraction: 0,
      maxAllowed: 0n,
      shouldTrade: false,
      reason: 'Capital not configured - call updateCapital() before trading',
    };
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

let sizerInstance: KellyPositionSizer | null = null;
let initializingSizer = false;

/**
 * Gets the singleton KellyPositionSizer instance.
 *
 * Creates a new instance on first call. Subsequent calls return the same instance.
 * Note: config is only used on first call. Passing different values on subsequent
 * calls will be ignored (singleton pattern).
 *
 * @param config - Optional configuration (only used on first call)
 * @returns The singleton sizer instance
 * @throws Error if called during initialization (race condition prevention)
 */
export function getKellyPositionSizer(
  config?: Partial<PositionSizerConfig>
): KellyPositionSizer {
  // P0-FIX 5.1: Prevent race condition during initialization
  if (initializingSizer) {
    throw new Error('KellyPositionSizer is being initialized. Avoid concurrent initialization.');
  }

  if (!sizerInstance) {
    initializingSizer = true;
    try {
      sizerInstance = new KellyPositionSizer(config);
    } finally {
      initializingSizer = false;
    }
  }
  return sizerInstance;
}

/**
 * Resets the singleton instance.
 *
 * Destroys the existing instance if present. A new instance will be created
 * on the next call to getKellyPositionSizer().
 *
 * P0-FIX 5.2: Set instance to null BEFORE destroy to prevent race condition
 * where getKellyPositionSizer() could return the destroyed instance.
 */
export function resetKellyPositionSizer(): void {
  if (sizerInstance) {
    // P0-FIX 5.2: Capture reference and null out first to prevent race
    const instanceToDestroy = sizerInstance;
    sizerInstance = null;
    instanceToDestroy.destroy();
  }
}
