/**
 * Simulation Mode Types
 *
 * All type definitions for the simulation sub-system.
 *
 * @module simulation
 */

// =============================================================================
// Price Simulator Types
// =============================================================================

export interface SimulatedPriceUpdate {
  chain: string;
  dex: string;
  pairKey: string;
  token0: string;
  token1: string;
  price: number;
  price0: number;
  price1: number;
  liquidity: number;
  volume24h: number;
  timestamp: number;
  blockNumber: number;
  isSimulated: true;
}

export interface SimulationConfig {
  /** Base volatility (percentage per update) */
  volatility: number;
  /** Update interval in milliseconds */
  updateIntervalMs: number;
  /** Probability of creating an arbitrage opportunity (0-1) */
  arbitrageChance: number;
  /** Size of arbitrage spread when created */
  arbitrageSpread: number;
  /** Chains to simulate */
  chains: string[];
  /** Token pairs to simulate */
  pairs: string[][];
  /** DEXes per chain */
  dexesPerChain: number;
}

// =============================================================================
// Chain Simulator Types
// =============================================================================

/**
 * Simulated Sync event that mimics real blockchain Sync events.
 * This is the format detectors expect from WebSocket subscriptions.
 */
export interface SimulatedSyncEvent {
  address: string;
  data: string;  // ABI-encoded reserve0, reserve1
  topics: string[];
  blockNumber: string;  // Hex string
  transactionHash: string;
  logIndex: string;
}

/**
 * Opportunity type for strategy routing.
 * Matches StrategyType in execution-engine for proper routing tests.
 */
export type SimulatedOpportunityType =
  | 'intra-chain'
  | 'cross-chain'
  | 'flash-loan'
  | 'triangular'
  | 'quadrilateral';

/**
 * Bridge protocol for cross-chain opportunities.
 */
export type SimulatedBridgeProtocol = 'stargate' | 'across' | 'native';

/**
 * Simulated arbitrage opportunity.
 *
 * Enhanced to support all execution strategy types:
 * - intra-chain: Same chain, different DEXes
 * - cross-chain: Different chains, bridge required
 * - flash-loan: Uses flash loan for capital-free execution
 * - triangular: 3-hop arbitrage (A -> B -> C -> A)
 * - quadrilateral: 4-hop arbitrage (A -> B -> C -> D -> A)
 *
 * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md
 */
export interface SimulatedOpportunity {
  id: string;

  // =========================================================================
  // Strategy Routing Fields
  // =========================================================================

  /** Opportunity type for strategy routing */
  type: SimulatedOpportunityType;

  /** Source chain (buyChain) - for cross-chain, same as chain for intra-chain */
  buyChain: string;

  /** Destination chain (sellChain) - for cross-chain, same as chain for intra-chain */
  sellChain: string;

  /** Whether to use flash loan for execution */
  useFlashLoan: boolean;

  /** Bridge protocol for cross-chain opportunities */
  bridgeProtocol?: SimulatedBridgeProtocol;

  // =========================================================================
  // Multi-Hop Fields (for triangular/quadrilateral)
  // =========================================================================

  /** Number of hops for multi-hop arbitrage (3 for triangular, 4 for quadrilateral) */
  hops?: number;

  /** Token path for multi-hop (e.g., ['WETH', 'USDC', 'WBTC', 'WETH']) */
  path?: string[];

  /** Intermediate tokens (tokens between start and end) */
  intermediateTokens?: string[];

  // =========================================================================
  // Original Fields (preserved for backward compatibility)
  // =========================================================================

  /** Primary chain (for intra-chain, same as buyChain/sellChain) */
  chain: string;

  buyDex: string;
  sellDex: string;
  tokenPair: string;
  buyPrice: number;
  sellPrice: number;
  profitPercentage: number;
  estimatedProfitUsd: number;
  confidence: number;
  timestamp: number;
  expiresAt: number;
  isSimulated: true;

  // =========================================================================
  // Execution Hints (optional, for realistic testing)
  // =========================================================================

  /** Expected gas cost in USD */
  expectedGasCost?: number;

  /** Expected profit after gas (for validation) */
  expectedProfit?: number;

  /** Flash loan fee percentage (for flash-loan type) */
  flashLoanFee?: number;

  /** Bridge fee in USD (for cross-chain type) */
  bridgeFee?: number;
}

/**
 * Configuration for chain-specific simulation
 */
export interface ChainSimulatorConfig {
  chainId: string;
  /** Update interval in milliseconds */
  updateIntervalMs: number;
  /** Base volatility (percentage per update) */
  volatility: number;
  /** Probability of creating an arbitrage opportunity (0-1) */
  arbitrageChance: number;
  /** Minimum spread for arbitrage (percentage) */
  minArbitrageSpread: number;
  /** Maximum spread for arbitrage (percentage) */
  maxArbitrageSpread: number;
  /** Pairs to simulate as [address, token0Symbol, token1Symbol, dex, fee][] */
  pairs: SimulatedPairConfig[];
  /** Minimum position size in USD (default: 1000) */
  minPositionSize?: number;
  /** Maximum position size in USD (default: 50000) */
  maxPositionSize?: number;
}

export interface SimulatedPairConfig {
  address: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  dex: string;
  fee: number;  // As percentage (0.003 = 0.3%)
}

// =============================================================================
// Cross-Chain Simulator Types
// =============================================================================

/**
 * Bridge cost configuration for cross-chain opportunities.
 * Costs are in USD and include protocol fees + typical gas.
 */
export interface BridgeCostConfig {
  /** Fixed cost in USD */
  fixedCost: number;
  /** Percentage fee (0.001 = 0.1%) */
  percentageFee: number;
  /** Estimated bridge time in seconds */
  estimatedTimeSeconds: number;
}

/**
 * Configuration for CrossChainSimulator
 */
export interface CrossChainSimulatorConfig {
  /** Chains to simulate cross-chain opportunities between */
  chains: string[];
  /** Update interval in milliseconds */
  updateIntervalMs: number;
  /** Base volatility (percentage per update) */
  volatility: number;
  /** Minimum profit threshold after bridge costs (percentage) */
  minProfitThreshold: number;
  /** Tokens to track across chains */
  tokens: string[];
  /** Custom bridge costs (optional) */
  bridgeCosts?: Record<string, BridgeCostConfig>;
}
