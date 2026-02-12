/**
 * Pre-Validation Orchestrator
 *
 * Manages sample-based pre-validation of arbitrage opportunities.
 * Uses simulation callbacks to filter out opportunities that would fail on-chain.
 *
 * ## Purpose
 *
 * Pre-validation simulates the buy leg of an arbitrage opportunity before
 * publishing. This filters out opportunities that would fail due to:
 * - Insufficient liquidity
 * - Price slippage beyond threshold
 * - Contract reverts
 *
 * ## Budget Management
 *
 * Pre-validation uses a monthly budget to control simulation costs:
 * - Default budget: 2500 simulations/month (10% of Tenderly's 25K/month)
 * - Budget auto-resets on the first of each month
 * - When budget exhausted, opportunities pass through unvalidated (fail-open)
 *
 * ## Sample-Based Selection
 *
 * Not all opportunities are pre-validated to conserve budget:
 * - Sample rate (default 10%) randomly selects opportunities
 * - Profit threshold ensures only valuable opportunities are validated
 *
 * ## P0-7 Refactor
 *
 * Extracted from CrossChainDetectorService to improve SRP.
 * The detector no longer manages pre-validation state directly.
 *
 * @see ADR-023: Detector Pre-validation
 * @see REFACTORING_IMPLEMENTATION_PLAN.md P0-7
 */

import {
  PreValidationConfig,
  PreValidationSimulationRequest,
  PreValidationSimulationResult,
  PreValidationSimulationCallback,
  CrossChainOpportunity,
} from './types';

/**
 * Logger interface for dependency injection.
 */
export interface PreValidationLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Pre-validation metrics for monitoring.
 */
export interface PreValidationMetrics {
  /** Number of simulations used this month */
  budgetUsed: number;
  /** Remaining simulations this month */
  budgetRemaining: number;
  /** Successful validations count */
  successCount: number;
  /** Failed validations count */
  failCount: number;
  /** Success rate (0-1) */
  successRate: number;
}

/**
 * Result of pre-validation check.
 */
export interface PreValidationResult {
  /** Whether to allow the opportunity (true = publish, false = filter) */
  allowed: boolean;
  /** Reason for decision */
  reason: 'not_enabled' | 'not_sampled' | 'validated_pass' | 'validated_fail' | 'skipped' | 'timeout' | 'error';
}

/**
 * Pre-Validation Orchestrator
 *
 * Manages sample-based pre-validation of arbitrage opportunities.
 */
export class PreValidationOrchestrator {
  // State tracking
  private budgetUsed = 0;
  private budgetResetTime = 0;
  private successCount = 0;
  private failCount = 0;
  private simulationCallback: PreValidationSimulationCallback | null = null;

  constructor(
    private readonly config: PreValidationConfig,
    private readonly logger: PreValidationLogger,
    private readonly defaultTradeSizeUsd: number = 1000
  ) {}

  /**
   * Pre-validate an opportunity and decide whether to allow it.
   *
   * This is the main entry point. Call this before publishing an opportunity.
   * Returns whether the opportunity should be published.
   *
   * @param opportunity - The opportunity to validate
   * @returns Result indicating whether to allow the opportunity
   */
  async validateOpportunity(opportunity: CrossChainOpportunity): Promise<PreValidationResult> {
    // If pre-validation is disabled, allow all opportunities
    if (!this.config.enabled) {
      return { allowed: true, reason: 'not_enabled' };
    }

    // Check if this opportunity should be pre-validated (sampling)
    const shouldValidate = this.shouldPreValidate(opportunity);
    if (!shouldValidate) {
      return { allowed: true, reason: 'not_sampled' };
    }

    // Perform pre-validation
    const isValid = await this.executePreValidation(opportunity);

    if (isValid) {
      this.successCount++;
      return { allowed: true, reason: 'validated_pass' };
    } else {
      this.failCount++;
      this.logger.debug('Opportunity failed pre-validation, filtering', {
        token: opportunity.token,
        sourceChain: opportunity.sourceChain,
        targetChain: opportunity.targetChain,
        netProfit: opportunity.netProfit,
      });
      return { allowed: false, reason: 'validated_fail' };
    }
  }

  /**
   * Determine if an opportunity should be pre-validated.
   *
   * Selection criteria:
   * 1. Budget not exhausted
   * 2. Profit above minimum threshold
   * 3. Random sample rate check
   *
   * @param opportunity - The opportunity to check
   * @returns True if opportunity should be pre-validated
   */
  private shouldPreValidate(opportunity: CrossChainOpportunity): boolean {
    // Check monthly budget reset
    this.checkBudgetReset();

    // Check budget exhaustion
    if (this.budgetUsed >= this.config.monthlyBudget) {
      return false;
    }

    // Check profit threshold
    if (opportunity.netProfit < this.config.minProfitForValidation) {
      return false;
    }

    // Sample rate check (random selection)
    if (Math.random() >= this.config.sampleRate) {
      return false;
    }

    return true;
  }

  /**
   * Check and reset monthly budget if new month.
   */
  private checkBudgetReset(): void {
    const now = Date.now();
    const monthStart = new Date(now);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const monthStartMs = monthStart.getTime();

    if (this.budgetResetTime < monthStartMs) {
      // New month - reset budget
      this.budgetUsed = 0;
      this.budgetResetTime = now;
      this.logger.info('Pre-validation budget reset for new month', {
        budget: this.config.monthlyBudget,
      });
    }
  }

  /**
   * Execute pre-validation simulation for an opportunity.
   *
   * @param opportunity - The opportunity to validate
   * @returns True if opportunity passes validation (or validation skipped)
   */
  private async executePreValidation(opportunity: CrossChainOpportunity): Promise<boolean> {
    const startTime = Date.now();

    try {
      // If no simulation callback is configured, pass through (fail-open)
      if (!this.simulationCallback) {
        this.logger.debug('Pre-validation skipped: no simulation callback configured', {
          token: opportunity.token,
          sourceChain: opportunity.sourceChain,
          netProfit: opportunity.netProfit,
        });
        return true;
      }

      // Build simulation request
      const simRequest: PreValidationSimulationRequest = {
        chain: opportunity.sourceChain,
        tokenPair: opportunity.token,
        dex: opportunity.sourceDex,
        tradeSizeUsd: opportunity.tradeSizeUsd ?? this.defaultTradeSizeUsd,
        expectedPrice: opportunity.sourcePrice,
      };

      // Increment budget usage only when simulation actually runs
      this.budgetUsed++;

      // Execute simulation with timeout
      const simResult = await Promise.race([
        this.simulationCallback(simRequest),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), this.config.maxLatencyMs)
        ),
      ]);

      const latencyMs = Date.now() - startTime;

      // Timeout - fail-open
      if (simResult === null) {
        this.logger.debug('Pre-validation timed out, allowing opportunity', {
          token: opportunity.token,
          latencyMs,
          maxLatencyMs: this.config.maxLatencyMs,
        });
        return true;
      }

      // Log simulation result
      this.logger.debug('Pre-validation completed', {
        token: opportunity.token,
        sourceChain: opportunity.sourceChain,
        success: simResult.success,
        wouldRevert: simResult.wouldRevert,
        latencyMs: simResult.latencyMs,
      });

      // Determine result
      if (simResult.success && !simResult.wouldRevert) {
        return true;
      } else {
        this.logger.info('Pre-validation rejected opportunity', {
          token: opportunity.token,
          sourceChain: opportunity.sourceChain,
          reason: simResult.wouldRevert ? 'would_revert' : 'simulation_failed',
          error: simResult.error,
        });
        return false;
      }
    } catch (error) {
      this.logger.warn('Pre-validation failed with error, allowing opportunity', {
        error: (error as Error).message,
        token: opportunity.token,
      });
      // On error, allow the opportunity (fail-open to avoid blocking valid opportunities)
      return true;
    }
  }

  /**
   * Get pre-validation metrics.
   */
  getMetrics(): PreValidationMetrics {
    const total = this.successCount + this.failCount;

    return {
      budgetUsed: this.budgetUsed,
      budgetRemaining: Math.max(0, this.config.monthlyBudget - this.budgetUsed),
      successCount: this.successCount,
      failCount: this.failCount,
      successRate: total > 0 ? this.successCount / total : 0,
    };
  }

  /**
   * Set simulation callback for pre-validation.
   *
   * Allows runtime injection of simulation capability after initialization.
   * The orchestrator can call this once SimulationService is ready.
   *
   * @param callback - The simulation callback or null to disable
   */
  setSimulationCallback(callback: PreValidationSimulationCallback | null): void {
    this.simulationCallback = callback;
    this.logger.info('Pre-validation simulation callback updated', {
      hasCallback: !!callback,
      preValidationEnabled: this.config.enabled,
    });
  }

  /**
   * Check if pre-validation is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Reset state (mainly for testing).
   */
  reset(): void {
    this.budgetUsed = 0;
    this.budgetResetTime = 0;
    this.successCount = 0;
    this.failCount = 0;
    this.simulationCallback = null;
  }
}
