/**
 * Statistical Arbitrage Strategy
 *
 * Extends BaseExecutionStrategy for EVM-based statistical arbitrage execution.
 * Translates stat arb signals into flash loan swap paths.
 *
 * The stat arb execution is atomic within one transaction:
 * 1. Flash loan the overvalued token from Aave/Balancer
 * 2. Swap overvalued -> undervalued on the DEX where overvalued is expensive
 * 3. Swap undervalued -> overvalued on the DEX where overvalued is cheap
 * 4. Repay flash loan + fee
 * 5. Profit = spread * position size - flash loan fee - gas
 *
 * This is essentially a flash loan arbitrage where the two DEXs are chosen
 * based on the spread signal rather than instantaneous price detection.
 *
 * The opportunity.hops[] already define the swap path from the detector.
 * This strategy validates the stat arb signal is still valid before execution.
 *
 * @see shared/core/src/detector/statistical-arbitrage-detector.ts - Opportunity source
 * @see services/execution-engine/src/strategies/flash-loan.strategy.ts - Flash loan pattern
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import {
  createErrorResult,
  createSkippedResult,
} from '../types';
import { BaseExecutionStrategy } from './base.strategy';
import type { StrategyContext, ExecutionResult, Logger } from '../types';
import { generateTraceId } from '@arbitrage/core/tracing/trace-context';
import { getErrorMessage } from '@arbitrage/core';

// =============================================================================
// Types
// =============================================================================

export interface StatisticalArbitrageConfig {
  /** Minimum confidence score to proceed with execution (default: 0.5) */
  minConfidence: number;
  /** Maximum age of opportunity in ms before stale (default: 30000 = 30s) */
  maxOpportunityAgeMs: number;
  /** Minimum expected profit in USD to justify gas costs (default: 5) */
  minExpectedProfitUsd: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: StatisticalArbitrageConfig = {
  minConfidence: 0.5,
  maxOpportunityAgeMs: 30_000,
  minExpectedProfitUsd: 5,
};

// =============================================================================
// Statistical Arbitrage Strategy
// =============================================================================

/**
 * Executes statistical arbitrage opportunities via flash loan infrastructure.
 *
 * Validates the opportunity's statistical signals are still valid, then
 * delegates to the flash loan execution path for atomic on-chain execution.
 */
export class StatisticalArbitrageStrategy extends BaseExecutionStrategy {
  private readonly config: StatisticalArbitrageConfig;
  private readonly flashLoanStrategy: { execute: (opp: ArbitrageOpportunity, ctx: StrategyContext) => Promise<ExecutionResult> } | null;

  constructor(
    logger: Logger,
    config?: Partial<StatisticalArbitrageConfig>,
    flashLoanStrategy?: { execute: (opp: ArbitrageOpportunity, ctx: StrategyContext) => Promise<ExecutionResult> },
  ) {
    super(logger);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.flashLoanStrategy = flashLoanStrategy ?? null;

    this.logger.info('StatisticalArbitrageStrategy initialized', {
      minConfidence: this.config.minConfidence,
      maxOpportunityAgeMs: this.config.maxOpportunityAgeMs,
      minExpectedProfitUsd: this.config.minExpectedProfitUsd,
    });
  }

  /**
   * Execute a statistical arbitrage opportunity.
   *
   * Validates the opportunity, then delegates to flash loan infrastructure
   * for atomic on-chain execution.
   */
  async execute(
    opportunity: ArbitrageOpportunity,
    ctx: StrategyContext,
  ): Promise<ExecutionResult> {
    const chain = opportunity.chain ?? 'unknown';
    const dex = opportunity.buyDex ?? opportunity.sellDex ?? 'stat-arb';
    const oppId = opportunity.id ?? 'unknown';
    // C3: Trace context for cross-service correlation
    const traceId = generateTraceId();

    // ===========================================================================
    // Pre-execution Validation
    // ===========================================================================

    // Check opportunity age
    const age = Date.now() - opportunity.timestamp;
    if (age > this.config.maxOpportunityAgeMs) {
      this.logger.warn('Statistical arb opportunity is stale', {
        traceId,
        opportunityId: oppId,
        ageMs: age,
        maxAgeMs: this.config.maxOpportunityAgeMs,
      });
      return createSkippedResult(
        oppId,
        `[ERR_STALE] Opportunity age ${age}ms exceeds max ${this.config.maxOpportunityAgeMs}ms`,
        chain,
        dex,
      );
    }

    // Check minimum confidence
    if (opportunity.confidence < this.config.minConfidence) {
      this.logger.warn('Statistical arb confidence too low', {
        traceId,
        opportunityId: oppId,
        confidence: opportunity.confidence,
        minConfidence: this.config.minConfidence,
      });
      return createSkippedResult(
        oppId,
        `[ERR_LOW_CONFIDENCE] Confidence ${opportunity.confidence} below threshold ${this.config.minConfidence}`,
        chain,
        dex,
      );
    }

    // Check minimum expected profit
    const expectedProfit = opportunity.expectedProfit ?? 0;
    if (expectedProfit < this.config.minExpectedProfitUsd) {
      this.logger.warn('Statistical arb expected profit too low', {
        opportunityId: oppId,
        expectedProfit,
        minExpectedProfitUsd: this.config.minExpectedProfitUsd,
      });
      return createSkippedResult(
        oppId,
        `[ERR_LOW_PROFIT] Expected profit $${expectedProfit} below threshold $${this.config.minExpectedProfitUsd}`,
        chain,
        dex,
      );
    }

    // Check required fields
    if (!opportunity.tokenIn || !opportunity.tokenOut) {
      return createErrorResult(
        oppId,
        '[ERR_INVALID_OPPORTUNITY] Missing tokenIn/tokenOut for statistical arbitrage',
        chain,
        dex,
      );
    }

    // ===========================================================================
    // Delegate to Flash Loan Strategy
    // ===========================================================================

    if (this.flashLoanStrategy) {
      this.logger.info('Delegating stat arb to flash loan strategy', {
        traceId,
        opportunityId: oppId,
        chain,
        tokenIn: opportunity.tokenIn,
        tokenOut: opportunity.tokenOut,
        expectedProfit,
      });

      // Ensure the opportunity is marked for flash loan execution
      const flashLoanOpp: ArbitrageOpportunity = {
        ...opportunity,
        useFlashLoan: true,
      };

      try {
        return await this.flashLoanStrategy.execute(flashLoanOpp, ctx);
      } catch (error) {
        const errorMsg = getErrorMessage(error);
        this.logger.error('Flash loan execution failed for stat arb', {
          traceId,
          opportunityId: oppId,
          error: errorMsg,
        });
        return createErrorResult(
          oppId,
          `[ERR_FLASH_LOAN_FAILED] ${errorMsg}`,
          chain,
          dex,
        );
      }
    }

    // No flash loan strategy available — report error instead of faking success.
    // Fake success would corrupt P&L tracking with phantom profits.
    this.logger.error('No flash loan strategy available for stat arb execution', {
      traceId,
      opportunityId: oppId,
      chain,
    });

    return createErrorResult(
      oppId,
      '[ERR_NO_FLASH_LOAN_STRATEGY] Statistical arbitrage requires a flash loan strategy for execution',
      chain,
      dex,
    );
  }
}
