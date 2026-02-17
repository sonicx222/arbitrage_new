/**
 * Simulation Mode Module (Re-export Barrel)
 *
 * This file preserves the original import path (`./simulation-mode`) for backward
 * compatibility. All implementation has been split into focused sub-modules under
 * `./simulation/`:
 *
 * - types.ts: All type definitions (~200 lines)
 * - constants.ts: Token prices, DEX mappings, chain pairs, bridge costs (~250 lines)
 * - mode-utils.ts: Environment-based mode detection (~70 lines)
 * - price-simulator.ts: Global price feed simulator (~190 lines)
 * - chain-simulator.ts: Per-chain detector integration simulator (~360 lines)
 * - cross-chain-simulator.ts: Cross-chain opportunity simulator (~300 lines)
 *
 * @module simulation
 * @see ADR-003: Partitioned Chain Detectors
 */

// Re-export everything from the simulation sub-module
export {
  // Types (re-exported as types)
  type SimulatedPriceUpdate,
  type SimulationConfig,
  type SimulatedSyncEvent,
  type SimulatedOpportunityType,
  type SimulatedBridgeProtocol,
  type SimulatedOpportunity,
  type ChainSimulatorConfig,
  type SimulatedPairConfig,
  type BridgeCostConfig,
  type CrossChainSimulatorConfig,

  // Constants
  CHAIN_SPECIFIC_PAIRS,
  DEFAULT_BRIDGE_COSTS,

  // Mode utilities
  isSimulationMode,
  isExecutionSimulationMode,
  isHybridExecutionMode,
  getSimulationModeSummary,

  // Price simulator
  PriceSimulator,
  getSimulator,
  resetSimulatorInstance,

  // Chain simulator
  ChainSimulator,
  getChainSimulator,
  stopChainSimulator,
  stopAllChainSimulators,

  // Cross-chain simulator
  CrossChainSimulator,
  getCrossChainSimulator,
  stopCrossChainSimulator,
} from './simulation/index';

// Named re-export for backward compatibility
export { DEFAULT_CONFIG as SIMULATION_CONFIG } from './simulation/constants';
