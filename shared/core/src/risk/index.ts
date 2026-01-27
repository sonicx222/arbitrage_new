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
 * PLANNED (not yet implemented):
 * - Position Sizer (Task 3.4.3) - DEFERRED
 *   Will calculate optimal position sizes based on Kelly Criterion
 *   Target: Implement after EV Calculator is battle-tested in production
 *
 * - Drawdown Circuit Breaker (Task 3.4.4) - DEFERRED
 *   Will halt trading when drawdown exceeds threshold
 *   Target: Implement with Position Sizer
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
} from './types';
