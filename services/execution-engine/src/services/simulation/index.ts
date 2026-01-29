/**
 * Simulation Module
 *
 * Provides transaction simulation capabilities for pre-flight validation.
 *
 * @see Phase 1.1: Transaction Simulation Integration in implementation plan
 */

// Types
export type {
  SimulationProviderType,
  SimulationResult,
  StateChange,
  SimulationLog,
  SimulationRequest,
  StateOverride,
  SimulationProviderConfig,
  SimulationProviderHealth,
  SimulationMetrics,
  ISimulationProvider,
  SimulationServiceConfig,
  ISimulationService,
} from './types';

export {
  CHAIN_IDS,
  WETH_ADDRESSES,
  SIMULATION_DEFAULTS,
  TENDERLY_CONFIG,
  ALCHEMY_CONFIG,
  CircularBuffer,
  // Fix 1.1: Export shared utilities that were defined but not exported
  getWethAddress,
  isWethAddress,
  getSimulationErrorMessage,
  createCancellableTimeout,
  updateRollingAverage,
} from './types';

// Base Provider (for extension)
export { BaseSimulationProvider } from './base-simulation-provider';

// Providers
export { TenderlyProvider, createTenderlyProvider } from './tenderly-provider';
export { AlchemySimulationProvider, createAlchemyProvider } from './alchemy-provider';
export { LocalSimulationProvider, createLocalProvider } from './local-provider';

// Service
export {
  SimulationService,
  createSimulationService,
  type SimulationServiceOptions,
} from './simulation.service';

// Metrics Collector (Phase 1.1.3)
export {
  createSimulationMetricsCollector,
  type SimulationMetricsCollector,
  type SimulationMetricsCollectorConfig,
  type SimulationMetricsSnapshot,
} from './simulation-metrics-collector';

// Anvil Fork Manager (Phase 2: Pending-State Simulation - Task 2.3.1)
export {
  AnvilForkManager,
  createAnvilForkManager,
  type AnvilForkConfig,
  type AnvilForkState,
  type AnvilForkInfo,
  type AnvilForkHealth,
  type AnvilForkMetrics,
  type PendingTxSimulationResult,
} from './anvil-manager';

// Pending State Simulator (Phase 2: Pending-State Simulation - Task 2.3.1)
export {
  PendingStateSimulator,
  createPendingStateSimulator,
  type PendingStateSimulatorConfig,
  type PendingSwapSimulationResult,
  type PendingSwapIntent,
  type BatchSimulationOptions,
  type PoolInfo,
  type SimulatorMetrics,
} from './pending-state-simulator';

// Hot Fork Synchronizer (Phase 2: Pending-State Simulation - Task 2.3.2)
// Fix 6.2: SynchronizerLogger removed - use Logger from types.ts instead
export {
  HotForkSynchronizer,
  createHotForkSynchronizer,
  type HotForkSynchronizerConfig,
  type SynchronizerState,
  type SynchronizerMetrics,
} from './hot-fork-synchronizer';
