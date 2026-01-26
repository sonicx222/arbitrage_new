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
  SIMULATION_DEFAULTS,
  TENDERLY_CONFIG,
  ALCHEMY_CONFIG,
  CircularBuffer,
} from './types';

// Providers
export { TenderlyProvider, createTenderlyProvider } from './tenderly-provider';
export { AlchemySimulationProvider, createAlchemyProvider } from './alchemy-provider';

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
export {
  HotForkSynchronizer,
  createHotForkSynchronizer,
  type HotForkSynchronizerConfig,
  type SynchronizerState,
  type SynchronizerMetrics,
} from './hot-fork-synchronizer';
