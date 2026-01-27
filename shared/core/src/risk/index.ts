/**
 * Risk Management Module
 *
 * Phase 3: Capital & Risk Controls (P0)
 *
 * This module provides risk management components for arbitrage trading:
 *
 * IMPLEMENTED:
 * - Execution Probability Tracker (Task 3.4.1) ✓
 *   Tracks historical execution outcomes by (chain, DEX, pathLength)
 *   Provides win probability queries for EV calculations
 *
 * - EV Calculator (Task 3.4.2) ✓
 *   Calculates expected value: EV = (winProb × profit) - (lossProb × gasCost)
 *   Makes data-driven execution decisions
 *
 * - Position Sizer (Task 3.4.3) ✓
 *   Calculates optimal position sizes based on Kelly Criterion
 *   Uses fractional Kelly (0.5x default) for reduced variance
 *
 * - Drawdown Circuit Breaker (Task 3.4.4) ✓
 *   Halts trading when drawdown exceeds threshold
 *   State machine: NORMAL -> CAUTION -> HALT -> RECOVERY -> NORMAL
 *
 * @see docs/reports/implementation_plan_v3.md Section 3.4
 */

// =============================================================================
// Execution Probability Tracker (Task 3.4.1)
// =============================================================================

export {
  ExecutionProbabilityTracker,
  getExecutionProbabilityTracker,
  resetExecutionProbabilityTracker,
} from './execution-probability-tracker';

// =============================================================================
// EV Calculator (Task 3.4.2)
// =============================================================================

export {
  EVCalculator,
  getEVCalculator,
  resetEVCalculator,
} from './ev-calculator';

// =============================================================================
// Position Sizer (Task 3.4.3)
// =============================================================================

export {
  KellyPositionSizer,
  getKellyPositionSizer,
  resetKellyPositionSizer,
} from './position-sizer';

// =============================================================================
// Drawdown Circuit Breaker (Task 3.4.4)
// =============================================================================

export {
  DrawdownCircuitBreaker,
  getDrawdownCircuitBreaker,
  resetDrawdownCircuitBreaker,
} from './drawdown-circuit-breaker';

// =============================================================================
// Types
// =============================================================================

export type {
  // Execution Probability Tracker (Task 3.4.1)
  ExecutionProbabilityConfig,
  ExecutionOutcome,
  SerializedOutcome,
  ProbabilityQueryParams,
  ProfitQueryParams,
  GasCostQueryParams,
  ProbabilityResult,
  ProfitResult,
  GasCostResult,
  ExecutionTrackerStats,
  HourlyStats,

  // EV Calculator (Task 3.4.2)
  EVConfig,
  EVInput,
  EVCalculation,
  EVCalculatorStats,

  // Position Sizer (Task 3.4.3)
  PositionSizerConfig,
  PositionSize,
  PositionSizeInput,
  PositionSizerStats,

  // Drawdown Circuit Breaker (Task 3.4.4)
  DrawdownConfig,
  DrawdownState,
  DrawdownStateType,
  DrawdownStats,
  TradingAllowedResult,
  TradeResult,
} from './types';
