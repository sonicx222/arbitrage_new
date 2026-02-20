/**
 * Risk Management Orchestrator
 *
 * Extracted from engine.ts executeOpportunity() method (P2-SERVICE).
 * Centralizes runtime risk assessment logic:
 * - Drawdown circuit breaker checks
 * - Expected value (EV) calculation
 * - Kelly-based position sizing
 *
 * NOT part of hot path - called once per opportunity before execution.
 *
 * @see docs/refactoring-roadmap.md P2-SERVICE #9
 * @see ADR-021: Capital Risk Management
 */

import type {
  DrawdownCircuitBreaker,
  EVCalculator,
  KellyPositionSizer,
  ExecutionProbabilityTracker,
  TradingAllowedResult,
  EVCalculation,
  PositionSize,
} from '@arbitrage/core';
import { RISK_CONFIG } from '@arbitrage/config';
import type { Logger, ExecutionStats } from '../types';

/**
 * Input parameters for risk assessment.
 */
export interface RiskAssessmentInput {
  /** Chain identifier */
  chain: string;
  /** DEX identifier */
  dex: string;
  /** Token path length (number of hops) */
  pathLength: number;
  /** Expected profit in ETH/native units */
  expectedProfit?: number;
  /** Gas estimate in wei */
  gasEstimate?: number;
}

/**
 * Result of risk assessment.
 *
 * Contains either:
 * - allowed: true with optional position sizing info
 * - allowed: false with rejection reason
 */
export interface RiskDecision {
  /** Whether the trade should proceed */
  allowed: boolean;
  /** Rejection reason if not allowed */
  rejectionReason?: string;
  /** Rejection code for stats tracking */
  rejectionCode?: 'DRAWDOWN_HALT' | 'LOW_EV' | 'POSITION_SIZE';
  /** Drawdown check result (for state tracking) */
  drawdownCheck?: TradingAllowedResult;
  /** EV calculation result */
  evCalculation?: EVCalculation;
  /** Position size result */
  positionSize?: PositionSize;
  /** Final recommended position size (after applying drawdown multiplier) */
  recommendedSize?: bigint;
}

/**
 * Dependencies for RiskManagementOrchestrator.
 */
export interface RiskOrchestratorDeps {
  drawdownBreaker: DrawdownCircuitBreaker | null;
  evCalculator: EVCalculator | null;
  positionSizer: KellyPositionSizer | null;
  probabilityTracker: ExecutionProbabilityTracker | null;
  logger: Logger;
  stats: ExecutionStats;
  /** FIX P2-11: Max concurrent in-flight trades to mitigate TOCTOU gap (default: 3) */
  maxInFlightTrades?: number;
}

/**
 * Risk Management Orchestrator
 *
 * Coordinates all risk checks before trade execution:
 * 1. Drawdown circuit breaker (capital protection)
 * 2. Expected value calculation (profitability filter)
 * 3. Position sizing using Kelly Criterion
 *
 * Each check can independently reject a trade.
 * Position sizing is adjusted based on drawdown state (CAUTION/RECOVERY).
 *
 * FIX P2-11: Tracks in-flight trades to mitigate TOCTOU gap between
 * risk assessment and trade execution completion.
 */
export class RiskManagementOrchestrator {
  private readonly drawdownBreaker: DrawdownCircuitBreaker | null;
  private readonly evCalculator: EVCalculator | null;
  private readonly positionSizer: KellyPositionSizer | null;
  private readonly probabilityTracker: ExecutionProbabilityTracker | null;
  private readonly logger: Logger;
  private readonly stats: ExecutionStats;

  // FIX P2-11: In-flight trade tracking to mitigate TOCTOU gap.
  // Between assess() returning "allowed" and recordOutcome() being called,
  // multiple trades can be in-flight simultaneously, potentially exceeding
  // drawdown limits before the breaker sees any results.
  private inFlightCount = 0;
  private readonly maxInFlightTrades: number;

  constructor(deps: RiskOrchestratorDeps) {
    this.drawdownBreaker = deps.drawdownBreaker;
    this.evCalculator = deps.evCalculator;
    this.positionSizer = deps.positionSizer;
    this.probabilityTracker = deps.probabilityTracker;
    this.logger = deps.logger;
    this.stats = deps.stats;
    this.maxInFlightTrades = deps.maxInFlightTrades ?? 3;
  }

  /**
   * Assess risk for a trading opportunity.
   *
   * Performs all risk checks in sequence:
   * 1. Drawdown circuit breaker - blocks in HALT state
   * 2. EV calculation - rejects if expected value too low
   * 3. Position sizing - rejects if size below minimum
   *
   * @param input - Opportunity parameters for risk assessment
   * @returns Decision with rejection reason or position sizing info
   */
  assess(input: RiskAssessmentInput): RiskDecision {
    // FIX P2-11: Check in-flight trade limit to mitigate TOCTOU gap
    if (this.inFlightCount >= this.maxInFlightTrades) {
      return {
        allowed: false,
        rejectionReason: `Max in-flight trades (${this.maxInFlightTrades}) reached — wait for pending trades to complete`,
        rejectionCode: 'DRAWDOWN_HALT',
      };
    }

    // Step 1: Check drawdown circuit breaker
    const drawdownResult = this.checkDrawdown();
    if (!drawdownResult.allowed) {
      return drawdownResult;
    }

    // Step 2: Calculate Expected Value
    const evResult = this.calculateEV(input, drawdownResult.drawdownCheck);
    if (!evResult.allowed) {
      return evResult;
    }

    // Step 3: Size position using Kelly Criterion
    const positionResult = this.calculatePosition(
      evResult.evCalculation!,
      drawdownResult.drawdownCheck
    );

    // FIX P2-11: Track in-flight trade when approved
    if (positionResult.allowed) {
      this.inFlightCount++;
    }

    return positionResult;
  }

  /**
   * Check drawdown circuit breaker state.
   */
  private checkDrawdown(): RiskDecision {
    if (!this.drawdownBreaker) {
      return { allowed: true };
    }

    const drawdownCheck = this.drawdownBreaker.isTradingAllowed();

    if (!drawdownCheck.allowed) {
      this.stats.riskDrawdownBlocks++;
      return {
        allowed: false,
        rejectionReason: drawdownCheck.reason,
        rejectionCode: 'DRAWDOWN_HALT',
        drawdownCheck,
      };
    }

    // Track trades executed with reduced position sizing
    if (drawdownCheck.state === 'CAUTION') {
      this.stats.riskCautionCount++;
    }

    return {
      allowed: true,
      drawdownCheck,
    };
  }

  /**
   * Calculate expected value for the opportunity.
   */
  private calculateEV(
    input: RiskAssessmentInput,
    drawdownCheck?: TradingAllowedResult
  ): RiskDecision {
    if (!this.evCalculator || !RISK_CONFIG.ev.enabled) {
      return {
        allowed: true,
        drawdownCheck,
      };
    }

    const evCalc = this.evCalculator.calculate({
      chain: input.chain,
      dex: input.dex,
      pathLength: input.pathLength,
      estimatedProfit: input.expectedProfit
        ? BigInt(Math.floor(input.expectedProfit * 1e18))
        : undefined,
      estimatedGas: input.gasEstimate ? BigInt(input.gasEstimate) : undefined,
    });

    if (!evCalc.shouldExecute) {
      this.stats.riskEVRejections++;
      return {
        allowed: false,
        rejectionReason: evCalc.reason,
        rejectionCode: 'LOW_EV',
        drawdownCheck,
        evCalculation: evCalc,
      };
    }

    return {
      allowed: true,
      drawdownCheck,
      evCalculation: evCalc,
    };
  }

  /**
   * Calculate position size using Kelly Criterion.
   */
  private calculatePosition(
    evCalc: EVCalculation,
    drawdownCheck?: TradingAllowedResult
  ): RiskDecision {
    if (!this.positionSizer || !RISK_CONFIG.positionSizing.enabled) {
      return {
        allowed: true,
        drawdownCheck,
        evCalculation: evCalc,
      };
    }

    let positionSize = this.positionSizer.calculateSize({
      winProbability: evCalc.winProbability,
      expectedProfit: evCalc.rawProfitEstimate,
      expectedLoss: evCalc.rawGasCost,
    });

    // Apply drawdown state multiplier to position size
    if (drawdownCheck && positionSize.recommendedSize > 0n) {
      const multiplier = BigInt(Math.floor(drawdownCheck.sizeMultiplier * 10000));
      positionSize = {
        ...positionSize,
        recommendedSize: (positionSize.recommendedSize * multiplier) / 10000n,
      };
    }

    if (!positionSize.shouldTrade || positionSize.recommendedSize === 0n) {
      this.stats.riskPositionSizeRejections++;
      return {
        allowed: false,
        rejectionReason: positionSize.reason,
        rejectionCode: 'POSITION_SIZE',
        drawdownCheck,
        evCalculation: evCalc,
        positionSize,
      };
    }

    return {
      allowed: true,
      drawdownCheck,
      evCalculation: evCalc,
      positionSize,
      recommendedSize: positionSize.recommendedSize,
    };
  }

  /**
   * Record trade outcome for learning.
   *
   * Updates probability tracker and drawdown breaker with trade result.
   *
   * @param outcome - Trade outcome data
   */
  /**
   * Get current in-flight trade count (for monitoring/testing).
   */
  getInFlightCount(): number {
    return this.inFlightCount;
  }

  recordOutcome(outcome: {
    chain: string;
    dex: string;
    pathLength: number;
    success: boolean;
    actualProfit?: number;
    gasCost?: number;
    gasPrice?: bigint;
  }): void {
    // FIX P1-6: Decrement in-flight counter in finally block to prevent leaks.
    // Previously, if probabilityTracker.recordOutcome() or drawdownBreaker.recordTradeResult()
    // threw, inFlightCount would never decrement, eventually blocking all trades.
    // @see docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md P1 #6
    try {
      // FIX 2.1: Record to probability tracker for win rate learning
      // Uses properly injected probabilityTracker instead of unsafe `as any` cast
      if (this.probabilityTracker) {
        this.probabilityTracker.recordOutcome({
          chain: outcome.chain,
          dex: outcome.dex,
          pathLength: outcome.pathLength,
          hourOfDay: new Date().getUTCHours(),
          gasPrice: outcome.gasPrice ?? 0n,
          success: outcome.success,
          profit: outcome.actualProfit
            ? BigInt(Math.floor(outcome.actualProfit * 1e18))
            : undefined,
          // FIX P0-2: gasCost is in ETH units (fractional) — convert to wei before BigInt
          // @see FIX P0-2 in docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md
          gasCost: outcome.gasCost ? BigInt(Math.floor(outcome.gasCost * 1e18)) : 0n,
          timestamp: Date.now(),
        });
      }

      // Update drawdown breaker with trade result
      if (this.drawdownBreaker) {
        // FIX P0-2: gasCost is in ETH units (fractional) — convert to wei before BigInt
        // @see FIX P0-2 in docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md
        const pnl =
          outcome.success && outcome.actualProfit
            ? BigInt(Math.floor(outcome.actualProfit * 1e18))
            : outcome.gasCost
              ? -BigInt(Math.floor(outcome.gasCost * 1e18))
              : 0n;

        this.drawdownBreaker.recordTradeResult({
          success: outcome.success,
          pnl,
          timestamp: Date.now(),
        });
      }
    } finally {
      // FIX P1-6: Always decrement in-flight counter, even if recording throws
      if (this.inFlightCount > 0) {
        this.inFlightCount--;
      }
    }
  }
}

/**
 * Create a RiskManagementOrchestrator instance.
 *
 * Factory function for clean dependency injection.
 */
export function createRiskOrchestrator(
  deps: RiskOrchestratorDeps
): RiskManagementOrchestrator {
  return new RiskManagementOrchestrator(deps);
}
