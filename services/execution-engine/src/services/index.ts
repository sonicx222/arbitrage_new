/**
 * Services Module
 *
 * Re-exports all execution engine services.
 *
 * @see engine.ts (parent service)
 */

export { ProviderServiceImpl } from './provider.service';
export type { ProviderServiceConfig } from './provider.service';

export { QueueServiceImpl } from './queue.service';
export type { QueueServiceConfig } from './queue.service';

// Circuit breaker module (Phase 1.3)
export {
  createCircuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitBreakerEvent,
  type CircuitBreakerMetrics,
  type CircuitBreakerStatus,
  type CircuitBreakerState,
  type ResolvedCircuitBreakerConfig,
} from './circuit-breaker';

// Simulation module (Phase 1.1)
export {
  // Types
  type SimulationProviderType,
  type SimulationResult,
  type StateChange,
  type SimulationLog,
  type SimulationRequest,
  type StateOverride,
  type SimulationProviderConfig,
  type SimulationProviderHealth,
  type SimulationMetrics,
  type ISimulationProvider,
  type SimulationServiceConfig,
  type ISimulationService,
  type SimulationServiceOptions,
  // Constants
  CHAIN_IDS,
  SIMULATION_DEFAULTS,
  TENDERLY_CONFIG,
  ALCHEMY_CONFIG,
  // Providers
  TenderlyProvider,
  createTenderlyProvider,
  AlchemySimulationProvider,
  createAlchemyProvider,
  // Service
  SimulationService,
  createSimulationService,
} from './simulation';

// =============================================================================
// R4 Extracted Services (from base.strategy.ts)
// =============================================================================

// Gas price optimization service
export {
  GasPriceOptimizer,
  validateGasPriceConfiguration,
  validateGasPrice,
  getFallbackGasPrice,
  // Constants
  GAS_SPIKE_MULTIPLIER_BIGINT,
  WEI_PER_GWEI,
  MIN_GAS_PRICE_GWEI,
  MAX_GAS_PRICE_GWEI,
  DEFAULT_GAS_PRICES_GWEI,
  FALLBACK_GAS_PRICES_WEI,
  // Types
  type GasConfigValidationResult,
  type GasBaselineEntry,
  type GasPriceOptimizerConfig,
} from './gas-price-optimizer';

// Nonce allocation manager
export {
  NonceAllocationManager,
  getDefaultNonceAllocationManager,
  resetDefaultNonceAllocationManager,
  // Types
  type NonceAllocationManagerConfig,
} from './nonce-allocation-manager';

// MEV protection service
export {
  MevProtectionService,
  // Types
  type MevEligibilityResult,
  type MevProtectionServiceConfig,
} from './mev-protection-service';

// Bridge profitability analyzer
export {
  BridgeProfitabilityAnalyzer,
  // Types
  type BridgeProfitabilityOptions,
  type BridgeProfitabilityResult,
  type BridgeProfitabilityAnalyzerConfig,
} from './bridge-profitability-analyzer';

// =============================================================================
// P1 FIX: Lock Conflict Tracker (extracted from engine.ts)
// =============================================================================

// Lock conflict tracker for crash recovery
export {
  LockConflictTracker,
  getLockConflictTracker,
  resetLockConflictTracker,
  // Types
  type ConflictInfo,
  type LockConflictTrackerConfig,
} from './lock-conflict-tracker';

// =============================================================================
// P0 Refactoring: Health Monitoring Manager (extracted from engine.ts)
// =============================================================================

// Health monitoring manager for interval-based operations
export {
  HealthMonitoringManager,
  createHealthMonitoringManager,
  // Types
  type HealthMonitoringDependencies,
} from './health-monitoring-manager';

// =============================================================================
// Finding #7: Circuit Breaker Manager (extracted from engine.ts)
// =============================================================================

export {
  CircuitBreakerManager,
  createCircuitBreakerManager,
  type CircuitBreakerManagerDeps,
} from './circuit-breaker-manager';

// =============================================================================
// Finding #7: Pending State Manager (extracted from engine.ts)
// =============================================================================

export {
  PendingStateManager,
  createPendingStateManager,
  type PendingStateManagerDeps,
  type PendingStateProviderSource,
} from './pending-state-manager';

// =============================================================================
// Finding #7: TX Simulation Initializer (extracted from engine.ts)
// =============================================================================

export {
  initializeTxSimulationService,
  type SimulationProviderSource,
} from './tx-simulation-initializer';

// =============================================================================
// S6: Standby Manager (extracted from engine.ts)
// =============================================================================

export {
  StandbyManager,
  createStandbyManager,
  type StandbyManagerDeps,
} from './standby-manager';
