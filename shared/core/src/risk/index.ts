/**
 * Risk Management Module
 *
 * Phase 3: Capital & Risk Controls (P0)
 *
 * This module provides risk management components for arbitrage trading:
 * - Execution Probability Tracker (Task 3.4.1)
 * - EV Calculator (Task 3.4.2) - TODO
 * - Position Sizer (Task 3.4.3) - TODO
 * - Drawdown Circuit Breaker (Task 3.4.4) - TODO
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
// Types
// =============================================================================

export type {
  // Configuration
  ExecutionProbabilityConfig,

  // Outcome tracking
  ExecutionOutcome,
  SerializedOutcome,

  // Query parameters
  ProbabilityQueryParams,
  ProfitQueryParams,
  GasCostQueryParams,

  // Query results
  ProbabilityResult,
  ProfitResult,
  GasCostResult,

  // Statistics
  ExecutionTrackerStats,
  HourlyStats,
} from './types';
