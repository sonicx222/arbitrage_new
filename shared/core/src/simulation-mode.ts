/**
 * Simulation Mode Module
 *
 * Generates simulated price feeds and arbitrage opportunities for local testing
 * without requiring real blockchain connections.
 *
 * Usage:
 *   Set SIMULATION_MODE=true in environment variables
 *
 * Features:
 *   - Simulated price feeds with realistic volatility
 *   - Artificial arbitrage opportunities for testing
 *   - Reserve-based pair simulation (mimics real DEX Sync events)
 *   - Chain-specific simulators for detector integration
 *   - No external dependencies required
 *
 * Implementation split into sub-modules under ./simulation/ for maintainability.
 * This file re-exports everything for backward compatibility.
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @module simulation
 */

// Re-export all types
export type {
  SimulatedPriceUpdate,
  SimulationConfig,
  SimulatedSyncEvent,
  SimulatedOpportunityType,
  SimulatedBridgeProtocol,
  SimulatedOpportunity,
  ChainSimulatorConfig,
  SimulatedPairConfig,
  BridgeCostConfig,
  CrossChainSimulatorConfig,
} from './simulation/index';

// Re-export constants
export {
  DEFAULT_CONFIG,
  BASE_PRICES,
  getTokenPrice,
  CHAIN_SPECIFIC_PAIRS,
  DEXES,
  DEFAULT_BRIDGE_COSTS,
} from './simulation/index';

// Backward-compatible alias used by core/src/index.ts
export { DEFAULT_CONFIG as SIMULATION_CONFIG } from './simulation/constants';

// Re-export mode utilities
export {
  isSimulationMode,
  isExecutionSimulationMode,
  isHybridExecutionMode,
  getSimulationModeSummary,
} from './simulation/index';

// Re-export price simulator
export {
  PriceSimulator,
  getSimulator,
  resetSimulatorInstance,
} from './simulation/index';

// Re-export chain simulator
export {
  ChainSimulator,
  getChainSimulator,
  stopChainSimulator,
  stopAllChainSimulators,
} from './simulation/index';

// Re-export cross-chain simulator
export {
  CrossChainSimulator,
  getCrossChainSimulator,
  stopCrossChainSimulator,
} from './simulation/index';
