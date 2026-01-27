/**
 * Unified Detector Exports
 *
 * This file contains all exports for the @arbitrage/unified-detector package.
 * Separated from index.ts to prevent auto-execution when the module is imported.
 *
 * @see index.ts for the service entry point (auto-runs main())
 */

// =============================================================================
// Main Exports
// =============================================================================

export { UnifiedChainDetector } from './unified-detector';
export { ChainDetectorInstance } from './chain-instance';
export type { UnifiedDetectorConfig, UnifiedDetectorStats, ChainStats } from './unified-detector';

// =============================================================================
// Modular Components (ARCH-REFACTOR)
// =============================================================================

export {
  createChainInstanceManager,
  type ChainInstanceManager,
  type ChainInstanceManagerConfig,
  type ChainInstanceFactory,
  type StartResult,
} from './chain-instance-manager';

export {
  createHealthReporter,
  type HealthReporter,
  type HealthReporterConfig,
  type GetHealthDataFn,
} from './health-reporter';

export {
  createMetricsCollector,
  type MetricsCollector,
  type MetricsCollectorConfig,
  type GetStatsFn,
} from './metrics-collector';

// =============================================================================
// Shared Types
// =============================================================================

export {
  type Logger,
  type FeeBasisPoints,
  type FeeDecimal,
  asLogger,
  basisPointsToDecimal,
  decimalToBasisPoints,
} from './types';

// =============================================================================
// Constants
// =============================================================================

export {
  DEFAULT_HEALTH_CHECK_PORT,
  DEFAULT_METRICS_INTERVAL_MS,
  DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  CHAIN_STOP_TIMEOUT_MS,
  STATE_TRANSITION_TIMEOUT_MS,
  SNAPSHOT_CACHE_TTL_MS,
  DEX_POOL_CACHE_TTL_MS,
  TRIANGULAR_CHECK_INTERVAL_MS,
  MULTI_LEG_CHECK_INTERVAL_MS,
  DEFAULT_OPPORTUNITY_EXPIRY_MS,
  DEFAULT_SIMULATION_UPDATE_INTERVAL_MS,
  DEFAULT_SIMULATION_VOLATILITY,
  STABLECOIN_SYMBOLS,
  DEFAULT_TOKEN_DECIMALS,
} from './constants';
