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
