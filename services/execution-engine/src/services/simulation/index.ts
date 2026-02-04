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
  // Fix: Export BaseMetrics for consistent metrics interfaces across services
  BaseMetrics,
} from './types';

export {
  CHAIN_IDS,
  WETH_ADDRESSES,
  SIMULATION_DEFAULTS,
  TENDERLY_CONFIG,
  ALCHEMY_CONFIG,
  HELIUS_CONFIG,
  CircularBuffer,
  // Fix 1.1: Export shared utilities that were defined but not exported
  getWethAddress,
  isWethAddress,
  getSimulationErrorMessage,
  createCancellableTimeout,
  updateRollingAverage,
  // Fix 9.4: Export shared revert reason extraction utility
  extractRevertReason,
  // Chain type utilities for routing
  isSolanaChain,
  isEvmChain,
} from './types';

// Base Provider (for extension)
export { BaseSimulationProvider } from './base-simulation-provider';

/**
 * Simulation Providers
 *
 * Provider hierarchy (from ADR-016 + Phase 2 amendments):
 *
 * ## EVM Chains (Ethereum, Arbitrum, Base, etc.)
 *
 * 1. TenderlyProvider (Primary) - Full-featured simulation with state changes and logs
 *    - Best accuracy, detailed execution traces
 *    - 25,000 free simulations/month
 *    - Recommended for production
 *
 * 2. AlchemyProvider (Secondary/Fallback) - eth_call based simulation
 *    - Good for basic revert detection
 *    - Practically unlimited (300M compute units/month free tier)
 *    - Used when Tenderly quota exhausted or unavailable
 *
 * 3. LocalSimulationProvider (Tertiary/Fallback) - Lightweight eth_call simulation
 *    - Uses existing RPC provider (no additional API keys)
 *    - No rate limits, no external dependencies
 *    - Limited accuracy: no state changes, no detailed logs
 *    - Fix 1.1/1.2: Added as third-tier fallback for resilience
 *    - Useful when external simulation providers are unavailable
 *
 * ## Solana Chain
 *
 * 4. HeliusSimulationProvider - Solana-specific simulation via Helius API
 *    - Uses Solana's native simulateTransaction RPC method
 *    - 100,000 credits/month free tier
 *    - Falls back to native Solana RPC when Helius unavailable
 *    - Automatically routed when chain is 'solana'
 *
 * Configure EVM provider priority in SimulationServiceConfig.providerPriority
 * Default: ['tenderly', 'alchemy', 'local']
 * Solana routing is automatic (no priority configuration needed)
 */
export { TenderlyProvider, createTenderlyProvider } from './tenderly-provider';
export { AlchemySimulationProvider, createAlchemyProvider } from './alchemy-provider';
export { LocalSimulationProvider, createLocalProvider } from './local-provider';
export {
  HeliusSimulationProvider,
  createHeliusProvider,
  type SolanaSimulationRequest,
  type SolanaSimulationResult,
  type SolanaAccountChange,
  type SolanaInnerInstruction,
  type HeliusProviderConfig,
} from './helius-provider';

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

// Batch Quoter Service (Performance Optimization - Task P1)
// Uses MultiPathQuoter contract to batch getAmountsOut() calls
// @see contracts/src/MultiPathQuoter.sol
export {
  BatchQuoterService,
  createBatchQuoterService,
  type QuoteRequest,
  type QuoteResult,
  type ArbitrageSimulationResult,
  type BatchQuoterConfig,
  type BatchQuoterMetrics,
} from './batch-quoter.service';
