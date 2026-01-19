/**
 * Simulation Module
 *
 * Re-exports simulation components for chain simulation in dev/test mode.
 *
 * NOTE: This module is currently a standalone reference implementation.
 * chain-instance.ts still uses its inline simulation code due to tight
 * coupling with internal pair state management. Future refactoring can
 * integrate this module by providing the onSyncEvent callback.
 *
 * @see chain-instance.ts (parent)
 */

export { ChainSimulationHandler } from './chain.simulator';
export type {
  SimulationConfig,
  NonEvmSimulationConfig,
  SimulationCallbacks,
  PairForSimulation
} from './chain.simulator';
