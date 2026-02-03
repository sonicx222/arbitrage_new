/**
 * A/B Testing Framework Types
 *
 * Types and interfaces for the A/B testing system that compares
 * execution strategies (flash loan vs direct, MEV protection methods, etc.)
 *
 * @see FINAL_IMPLEMENTATION_PLAN.md Task 3: A/B Testing Framework
 */

import type { ExecutionResult } from '../types';

// =============================================================================
// Experiment Types
// =============================================================================

/**
 * Experiment definition for A/B testing.
 *
 * Each experiment compares a control strategy against a variant.
 * Traffic is split deterministically based on opportunity hash.
 */
export interface Experiment {
  /** Unique experiment identifier */
  id: string;
  /** Human-readable experiment name */
  name: string;
  /** Control strategy ID (baseline) */
  control: string;
  /** Variant strategy ID (test) */
  variant: string;
  /** Traffic split for variant (0.0-1.0, e.g., 0.1 = 10% variant) */
  trafficSplit: number;
  /** Experiment start date */
  startDate: Date;
  /** Experiment end date (optional - runs indefinitely if not set) */
  endDate?: Date;
  /** Minimum sample size before significance can be calculated */
  minSampleSize: number;
  /** Experiment status */
  status: ExperimentStatus;
  /** Optional description */
  description?: string;
  /** Chain filter (if set, only applies to opportunities on this chain) */
  chainFilter?: string;
  /** DEX filter (if set, only applies to opportunities on this DEX) */
  dexFilter?: string;
}

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';

/**
 * Variant assignment result.
 */
export type VariantAssignment = 'control' | 'variant';

// =============================================================================
// Metrics Types
// =============================================================================

/**
 * Metrics collected per variant during an experiment.
 */
export interface ExperimentMetrics {
  /** Experiment ID */
  experimentId: string;
  /** Which variant these metrics are for */
  variant: VariantAssignment;
  /** Number of successful executions */
  successCount: number;
  /** Number of failed executions */
  failureCount: number;
  /** Total profit in wei (bigint serialized as string) */
  totalProfitWei: string;
  /** Total gas cost in wei (bigint serialized as string) */
  totalGasCostWei: string;
  /** Sum of latencies (for average calculation) */
  totalLatencyMs: number;
  /** Number of MEV frontrun events detected */
  mevFrontrunCount: number;
  /** Timestamp of first execution */
  firstExecutionAt?: number;
  /** Timestamp of last execution */
  lastExecutionAt?: number;
}

/**
 * Computed metrics with calculated fields.
 */
export interface ComputedMetrics extends ExperimentMetrics {
  /** Success rate (0.0-1.0) */
  successRate: number;
  /** Average profit per execution in wei */
  avgProfitWei: string;
  /** Average gas cost per execution in wei */
  avgGasCostWei: string;
  /** Average latency per execution in ms */
  avgLatencyMs: number;
  /** MEV frontrun rate (0.0-1.0) */
  mevFrontrunRate: number;
  /** Total sample size */
  sampleSize: number;
}

/**
 * Execution result extended with A/B testing metadata.
 */
export interface ABTestExecutionResult {
  /** Original execution result */
  result: ExecutionResult;
  /** Experiment ID this execution was part of */
  experimentId: string;
  /** Variant assigned for this execution */
  variant: VariantAssignment;
  /** Execution timestamp */
  timestamp: number;
  /** Execution latency in ms */
  latencyMs: number;
  /** Whether MEV frontrun was detected */
  mevFrontrunDetected: boolean;
}

// =============================================================================
// Statistical Analysis Types
// =============================================================================

/**
 * Result of statistical significance calculation.
 */
export interface SignificanceResult {
  /** P-value from Z-test */
  pValue: number;
  /** Whether result is statistically significant (p < 0.05) */
  significant: boolean;
  /** Z-score */
  zScore: number;
  /** 95% confidence interval for difference */
  confidenceInterval: {
    lower: number;
    upper: number;
  };
  /** Effect size (difference in success rates) */
  effectSize: number;
  /** Recommendation based on analysis */
  recommendation: SignificanceRecommendation;
  /** Warning if sample size is too small */
  sampleSizeWarning?: string;
}

export type SignificanceRecommendation =
  | 'adopt_variant'      // Variant significantly better
  | 'keep_control'       // Control significantly better or no difference
  | 'continue_testing'   // Not enough data yet
  | 'inconclusive';      // Enough data but no significant difference

/**
 * Experiment summary with metrics and significance.
 */
export interface ExperimentSummary {
  experiment: Experiment;
  controlMetrics: ComputedMetrics;
  variantMetrics: ComputedMetrics;
  significance: SignificanceResult;
  /** Runtime in hours */
  runtimeHours: number;
  /** Whether experiment is ready for conclusion */
  readyForConclusion: boolean;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * A/B testing framework configuration.
 */
export interface ABTestingConfig {
  /** Enable/disable A/B testing */
  enabled: boolean;
  /** Default traffic split for new experiments */
  defaultTrafficSplit: number;
  /** Default minimum sample size */
  defaultMinSampleSize: number;
  /** P-value threshold for significance (default: 0.05) */
  significanceThreshold: number;
  /** Redis key prefix for metrics storage */
  redisKeyPrefix: string;
  /** Metrics TTL in seconds (default: 30 days) */
  metricsTtlSeconds: number;
}

export const DEFAULT_AB_TESTING_CONFIG: ABTestingConfig = {
  enabled: false,
  defaultTrafficSplit: 0.1, // 10% variant
  defaultMinSampleSize: 100,
  significanceThreshold: 0.05,
  redisKeyPrefix: 'ab-test:',
  metricsTtlSeconds: 30 * 24 * 60 * 60, // 30 days
};

// =============================================================================
// Strategy Types
// =============================================================================

/**
 * Strategy IDs for A/B testing.
 * These correspond to execution strategies in the engine.
 */
export const STRATEGY_IDS = {
  // Execution strategies
  DIRECT_EXECUTION: 'direct',
  FLASH_LOAN_EXECUTION: 'flash-loan',
  SIMULATION_ONLY: 'simulation',

  // MEV protection strategies
  MEV_FLASHBOTS: 'mev-flashbots',
  MEV_JITO: 'mev-jito',
  MEV_NONE: 'mev-none',

  // Gas strategies
  GAS_AGGRESSIVE: 'gas-aggressive',
  GAS_CONSERVATIVE: 'gas-conservative',
  GAS_DYNAMIC: 'gas-dynamic',
} as const;

export type StrategyId = typeof STRATEGY_IDS[keyof typeof STRATEGY_IDS];
