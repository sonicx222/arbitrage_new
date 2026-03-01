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
 * Aligned with ArbitrageOpportunity.type in shared/types/src/index.ts:181
 * and StrategyType in execution-engine for proper routing.
 *
 * @see shared/types/src/index.ts:181 — ArbitrageOpportunity.type
 * @see services/execution-engine/src/strategies/strategy-factory.ts:79 — StrategyType
 */
export type SimulatedOpportunityType =
  | 'simple'
  | 'cross-dex'
  | 'intra-dex'
  | 'cross-chain'
  | 'flash-loan'
  | 'triangular'
  | 'quadrilateral'
  | 'multi-leg'
  | 'backrun'
  | 'uniswapx'
  | 'statistical'
  | 'predictive'
  | 'solana';

/**
 * Bridge protocol for cross-chain opportunities.
 */
export type SimulatedBridgeProtocol = 'stargate' | 'across' | 'native';

/**
 * Simulated arbitrage opportunity.
 *
 * Supports all 13 execution strategy types:
 * - simple: Two-pool on same DEX (price lag between V2/V3 pools)
 * - cross-dex: Same tokens, different DEXes on same chain
 * - intra-dex: Same DEX, different pool types
 * - cross-chain: Different chains, bridge required
 * - flash-loan: Uses flash loan for capital-free execution
 * - triangular: 3-hop arbitrage (A -> B -> C -> A)
 * - quadrilateral: 4-hop arbitrage (A -> B -> C -> D -> A)
 * - multi-leg: N-hop swap paths
 * - backrun: MEV-Share backrun opportunities
 * - uniswapx: Dutch auction filler opportunities
 * - statistical: Mean-reversion / cointegration-based
 * - predictive: ML-based price prediction
 * - solana: Solana-native DEX arbitrage
 *
 * @see docs/reports/SIMULATION_REWORK_RESEARCH_2026-03-01.md
 */
export interface SimulatedOpportunity {
  id: string;

  // =========================================================================
  // Strategy Routing Fields
  // =========================================================================

  /** Opportunity type for strategy routing */
  type: SimulatedOpportunityType;

  /** Source chain — for cross-chain differs from sellChain, same for single-chain types */
  buyChain: string;

  /** Destination chain — for cross-chain differs from buyChain, same for single-chain types */
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

  /** Primary chain (same as buyChain/sellChain for single-chain types) */
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
// Market Regime Types
// =============================================================================

/**
 * Market regime for realistic simulation tick behavior.
 * Regimes transition via Markov chain each tick.
 *
 * @see docs/reports/SIMULATION_REWORK_RESEARCH_2026-03-01.md — Section 8.5
 */
export type MarketRegime = 'quiet' | 'normal' | 'burst';

export interface RegimeConfig {
  /** Multiplier for pair activity probability (0.3 = 30% of base) */
  pairActivityMultiplier: number;
  /** Multiplier for price volatility */
  volatilityMultiplier: number;
  /** Multiplier for arbitrage chance */
  arbChanceMultiplier: number;
}

/**
 * Simulation realism levels:
 * - 'low': Legacy behavior (flat 1000ms, all pairs every tick, 5 types)
 * - 'medium': Block-time aligned + activity tiers + all 13 types (default)
 * - 'high': Full regime model on top of medium
 */
export type SimulationRealismLevel = 'low' | 'medium' | 'high';

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
