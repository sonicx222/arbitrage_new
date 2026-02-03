/**
 * A/B Testing Framework
 *
 * Provides infrastructure for comparing execution strategies
 * with statistical significance analysis.
 *
 * @module ab-testing
 * @see FINAL_IMPLEMENTATION_PLAN.md Task 3: A/B Testing Framework
 */

// Types
export type {
  Experiment,
  ExperimentStatus,
  VariantAssignment,
  ExperimentMetrics,
  ComputedMetrics,
  ABTestExecutionResult,
  SignificanceResult,
  SignificanceRecommendation,
  ExperimentSummary,
  ABTestingConfig,
  StrategyId,
} from './types';

export {
  DEFAULT_AB_TESTING_CONFIG,
  STRATEGY_IDS,
} from './types';

// Framework
export {
  ABTestingFramework,
  createABTestingFramework,
} from './framework';

// Metrics
export {
  MetricsCollector,
  createMetricsCollector,
} from './metrics-collector';

// Statistical Analysis
export {
  calculateSignificance,
  calculateRequiredSampleSize,
  estimateTimeToSignificance,
  shouldStopEarly,
} from './statistical-analysis';
