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
