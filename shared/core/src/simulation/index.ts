/**
 * Simulation Module
 *
 * Generates simulated price feeds and arbitrage opportunities for local testing
 * without requiring real blockchain connections.
 *
 * Sub-modules:
 * - types: All type definitions
 * - constants: Token prices, DEX mappings, chain pairs, bridge costs
 * - mode-utils: Environment-based mode detection
 * - price-simulator: Global price feed simulator
 * - chain-simulator: Per-chain detector integration simulator
 * - cross-chain-simulator: Cross-chain opportunity simulator
 * - math-utils: Statistical utilities (Gaussian, Poisson, weighted selection)
 * - throughput-profiles: Per-chain throughput profiles calibrated to real data
 *
 * @module simulation
 */

// Types
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
  MarketRegime,
  RegimeConfig,
  SimulationRealismLevel,
  ChainThroughputProfile,
  GasModel,
  SampledGasPrice,
} from './types';

// Constants
export {
  DEFAULT_CONFIG,
  BASE_PRICES,
  getTokenPrice,
  CHAIN_SPECIFIC_PAIRS,
  DEXES,
  DEFAULT_BRIDGE_COSTS,
  PAIR_ACTIVITY_TIERS,
  DEFAULT_PAIR_ACTIVITY,
  STRATEGY_WEIGHTS,
  selectWeightedStrategyType,
  REGIME_CONFIGS,
  REGIME_TRANSITIONS,
  transitionRegime,
} from './constants';

// Mode utilities
export {
  isSimulationMode,
  isExecutionSimulationMode,
  isHybridExecutionMode,
  getSimulationModeSummary,
  getSimulationRealismLevel,
} from './mode-utils';

// Price simulator
export {
  PriceSimulator,
  getSimulator,
  resetSimulatorInstance,
} from './price-simulator';

// Chain simulator
export {
  ChainSimulator,
  getChainSimulator,
  stopChainSimulator,
  stopAllChainSimulators,
} from './chain-simulator';

// Cross-chain simulator
export {
  CrossChainSimulator,
  getCrossChainSimulator,
  stopCrossChainSimulator,
} from './cross-chain-simulator';

// Math utilities
export { gaussianRandom, poissonRandom, weightedRandomSelect } from './math-utils';

// Throughput profiles
export {
  CHAIN_THROUGHPUT_PROFILES,
  getNativeTokenPrice,
  selectWeightedDex,
} from './throughput-profiles';
