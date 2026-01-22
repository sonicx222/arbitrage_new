/**
 * Simulation Module
 *
 * Re-exports simulation components for chain simulation in dev/test mode.
 *
 * REFACTORED: This module is now fully integrated into chain-instance.ts
 * via the onSyncEvent callback. The ChainSimulationHandler encapsulates
 * both EVM and non-EVM simulation logic, with callbacks bridging to the
 * parent's state management.
 *
 * @see chain-instance.ts (parent)
 * @see ADR-003: Partitioned Chain Detectors
 */

export { ChainSimulationHandler } from './chain.simulator';
export type {
  SimulationConfig,
  NonEvmSimulationConfig,
  SimulationCallbacks,
  PairForSimulation
} from './chain.simulator';
