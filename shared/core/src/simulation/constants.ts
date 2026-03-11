/**
 * Simulation Mode Constants
 *
 * Token prices, chain-specific pairs, DEX mappings, and default configuration.
 *
 * @module simulation
 */

import type {
  SimulationConfig,
  BridgeCostConfig,
  SimulatedOpportunityType,
  MarketRegime,
  RegimeConfig,
} from './types';
import { parseEnvIntSafe, parseEnvFloatSafe } from '../utils/env-utils';

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_CONFIG: SimulationConfig = {
  // W2-L1 FIX: Use ?? for convention compliance
  volatility: parseEnvFloatSafe('SIMULATION_VOLATILITY', 0.02, 0),
  updateIntervalMs: parseEnvIntSafe('SIMULATION_UPDATE_INTERVAL_MS', 1000, 100),
  arbitrageChance: 0.05, // 5% chance per update
  arbitrageSpread: 0.005, // 0.5% spread
  // S3.1.2: All 11 chains across 4 partitions
  chains: [
    // P1 Asia-Fast
    'bsc', 'polygon', 'avalanche', 'fantom',
    // P2 L2-Turbo
    'arbitrum', 'optimism', 'base',
    // P3 High-Value
    'ethereum', 'zksync', 'linea',
    // P4 Solana-Native
    'solana'
  ],
  pairs: [
    // Common stablecoin pairs
    ['WETH', 'USDC'],
    ['WETH', 'USDT'],
    ['WBTC', 'WETH'],
    ['WBTC', 'USDC'],
    // Chain-specific pairs
    ['WBNB', 'BUSD'],
    ['WBNB', 'USDT'],
    ['MATIC', 'USDC'],
    ['AVAX', 'USDC'],
    ['FTM', 'USDC'],
    ['SOL', 'USDC'],
    // DeFi tokens
    ['LINK', 'WETH'],
    ['ARB', 'WETH'],
    ['OP', 'WETH']
  ],
  dexesPerChain: 2
};

// =============================================================================
// Token Prices
// =============================================================================

// Base prices for tokens (in USD)
// S3.1.2: Extended for all 11 chains with their native and common tokens
// Enhancement S5: Added chain-specific governance, LST, and meme tokens
//
// Fix P3-005: All keys normalized to UPPERCASE for consistent lookup.
// Use getTokenPrice() helper for case-insensitive access.
export const BASE_PRICES: Record<string, number> = {
  // Major assets
  'WETH': 3200,
  'ETH': 3200,      // BSC bridged ETH
  'WBTC': 65000,
  'BTCB': 65000,    // BSC wrapped BTC

  // Native tokens by chain
  'WBNB': 580,      // BSC
  'BNB': 580,
  'MATIC': 0.85,    // Polygon
  'WMATIC': 0.85,
  'AVAX': 35,       // Avalanche
  'WAVAX': 35,
  'FTM': 0.45,      // Fantom
  'WFTM': 0.45,
  'SOL': 175,       // Solana

  // Stablecoins
  'USDC': 1.0,
  'USDT': 1.0,
  'BUSD': 1.0,
  'DAI': 1.0,
  'FRAX': 1.0,
  'SUSD': 1.0,      // Synthetix USD (normalized)

  // Governance tokens
  'ARB': 1.15,      // Arbitrum
  'OP': 2.50,       // Optimism
  'UNI': 12.50,     // Uniswap

  // DeFi tokens
  'LINK': 15.0,
  'AAVE': 185,
  'GMX': 30,
  'CRV': 0.55,      // Curve
  'PENDLE': 4.50,   // Pendle Finance
  'MAGIC': 0.85,    // Treasure/Arbitrum

  // LST tokens (Liquid Staking) - normalized to uppercase
  'WSTETH': 3400,
  'RETH': 3350,
  'STETH': 3200,
  'CBETH': 3250,    // Coinbase staked ETH
  'MSOL': 185,      // Marinade staked SOL
  'JITOSOL': 190,   // Jito staked SOL
  'STMATIC': 0.90,  // Lido staked MATIC

  // Chain-specific DEX tokens
  'CAKE': 2.50,     // PancakeSwap
  'JOE': 0.45,      // Trader Joe
  'AERO': 1.20,     // Aerodrome
  'VELO': 0.12,     // Velodrome
  'QUICK': 0.045,   // QuickSwap
  'XVS': 8.50,      // Venus Protocol (BSC)

  // Meme tokens
  'PEPE': 0.000012,
  'SHIB': 0.000022,
  'DOGE': 0.12,

  // Solana tokens
  'JUP': 0.85,      // Jupiter
  'RAY': 4.50,      // Raydium
  'ORCA': 3.20,     // Orca
  'BONK': 0.000025,
  'WIF': 2.50,
  'JTO': 3.80,      // Jito governance
  'PYTH': 0.45,     // Pyth Network
  'MNDE': 0.12,     // Marinade governance
  'W': 0.35,        // Wormhole
  'BSOL': 180,      // BlazeStake SOL

  // Mantle native token
  'MNT': 0.40,
  'WMNT': 0.40,
};

/**
 * Get token price with case-insensitive lookup.
 *
 * Fix P3-005: Normalize token symbols to uppercase for consistent lookup.
 * This prevents failures when symbols come from external sources with different casing.
 */
export function getTokenPrice(symbol: string): number {
  return BASE_PRICES[symbol.toUpperCase()] || 1;
}

// =============================================================================
// Chain-Specific Pairs
// =============================================================================

/**
 * Chain-specific token pairs for more realistic simulation.
 * These supplement the common pairs with chain-native assets.
 * @see docs/reports/SIMULATION_MODE_ENHANCEMENT_RESEARCH.md - Solution S5
 */
export const CHAIN_SPECIFIC_PAIRS: Record<string, string[][]> = {
  ethereum: [
    ['stETH', 'WETH'], ['rETH', 'WETH'], ['cbETH', 'WETH'],
    ['wstETH', 'WETH'], ['PEPE', 'WETH'], ['SHIB', 'WETH'],
    ['CRV', 'WETH'], ['AAVE', 'WETH'],
  ],
  arbitrum: [
    ['ARB', 'WETH'], ['ARB', 'USDC'], ['GMX', 'WETH'],
    ['MAGIC', 'WETH'], ['PENDLE', 'WETH'],
  ],
  optimism: [
    ['OP', 'WETH'], ['OP', 'USDC'], ['VELO', 'WETH'],
    ['sUSD', 'USDC'],
  ],
  base: [
    ['AERO', 'WETH'], ['cbETH', 'WETH'], ['AERO', 'USDC'],
  ],
  bsc: [
    ['CAKE', 'WBNB'], ['XVS', 'WBNB'], ['CAKE', 'BUSD'],
    ['BTCB', 'WBNB'],
  ],
  polygon: [
    ['stMATIC', 'WMATIC'], ['QUICK', 'WMATIC'], ['QUICK', 'USDC'],
  ],
  avalanche: [
    ['JOE', 'WAVAX'], ['JOE', 'USDC'],
  ],
  fantom: [
    ['WFTM', 'USDC'], ['WFTM', 'DAI'],
  ],
  zksync: [
    ['WETH', 'USDC'],
  ],
  linea: [
    ['WETH', 'USDC'],
  ],
  solana: [
    ['SOL', 'USDC'], ['JUP', 'SOL'], ['RAY', 'SOL'],
    ['ORCA', 'SOL'], ['BONK', 'SOL'], ['WIF', 'SOL'],
    ['JTO', 'SOL'], ['PYTH', 'SOL'], ['mSOL', 'SOL'],
    ['jitoSOL', 'SOL'], ['MNDE', 'SOL'], ['W', 'SOL'],
    ['BSOL', 'SOL'],
  ],
};

// =============================================================================
// DEX Names per Chain
// =============================================================================

// S3.1.2: All 11 chains with their primary DEXes
export const DEXES: Record<string, string[]> = {
  // P1 Asia-Fast
  bsc: ['pancakeswap_v3', 'pancakeswap_v2', 'biswap'],
  polygon: ['quickswap_v3', 'uniswap_v3', 'sushiswap'],
  avalanche: ['trader_joe_v2', 'pangolin', 'sushiswap'],
  fantom: ['spookyswap', 'spiritswap', 'equalizer'],

  // P2 L2-Turbo
  arbitrum: ['uniswap_v3', 'camelot_v3', 'sushiswap'],
  optimism: ['velodrome', 'uniswap_v3', 'sushiswap'],
  base: ['aerodrome', 'uniswap_v3', 'baseswap'],

  // P3 High-Value
  ethereum: ['uniswap_v3', 'sushiswap'],
  zksync: ['syncswap', 'mute'],
  linea: ['syncswap', 'velocore'],

  // Emerging L2s (config present, limited DEX coverage)
  blast: ['aerodrome', 'uniswap_v3', 'baseswap'],
  scroll: ['aerodrome', 'uniswap_v3', 'baseswap'],
  mantle: ['aerodrome', 'uniswap_v3', 'baseswap'],
  mode: ['aerodrome', 'uniswap_v3', 'baseswap'],

  // P4 Solana-Native
  solana: ['raydium', 'orca', 'meteora']
};

// =============================================================================
// Default Bridge Costs
// =============================================================================

/**
 * Default bridge costs per route.
 * Format: 'sourceChain-destChain' -> costs
 */
export const DEFAULT_BRIDGE_COSTS: Record<string, BridgeCostConfig> = {
  // Stargate routes (L1 <-> L2)
  'ethereum-arbitrum': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-optimism': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-base': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-polygon': { fixedCost: 20, percentageFee: 0.0006, estimatedTimeSeconds: 1200 },
  'ethereum-avalanche': { fixedCost: 25, percentageFee: 0.0008, estimatedTimeSeconds: 900 },
  'ethereum-bsc': { fixedCost: 20, percentageFee: 0.0006, estimatedTimeSeconds: 900 },

  // L2 <-> L2 routes (faster, cheaper)
  'arbitrum-optimism': { fixedCost: 5, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
  'arbitrum-base': { fixedCost: 4, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
  'optimism-base': { fixedCost: 3, percentageFee: 0.0003, estimatedTimeSeconds: 60 },
  'optimism-arbitrum': { fixedCost: 5, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
  'base-arbitrum': { fixedCost: 4, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
  'base-optimism': { fixedCost: 3, percentageFee: 0.0003, estimatedTimeSeconds: 60 },

  // Asia chains
  'bsc-polygon': { fixedCost: 8, percentageFee: 0.0005, estimatedTimeSeconds: 300 },
  'polygon-bsc': { fixedCost: 8, percentageFee: 0.0005, estimatedTimeSeconds: 300 },
  'avalanche-bsc': { fixedCost: 10, percentageFee: 0.0005, estimatedTimeSeconds: 300 },
  'avalanche-polygon': { fixedCost: 10, percentageFee: 0.0005, estimatedTimeSeconds: 300 },

  // P2-22 FIX: Emerging L2s — L1 <-> L2 routes
  'ethereum-zksync': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-linea': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-blast': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-scroll': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-mantle': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-mode': { fixedCost: 15, percentageFee: 0.0006, estimatedTimeSeconds: 600 },
  'ethereum-fantom': { fixedCost: 20, percentageFee: 0.0006, estimatedTimeSeconds: 900 },

  // Emerging L2 <-> L2 routes (via shared bridge protocols)
  'arbitrum-blast': { fixedCost: 3, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
  'arbitrum-scroll': { fixedCost: 4, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
  'optimism-blast': { fixedCost: 3, percentageFee: 0.0003, estimatedTimeSeconds: 60 },
  'base-blast': { fixedCost: 3, percentageFee: 0.0003, estimatedTimeSeconds: 60 },
  'base-scroll': { fixedCost: 4, percentageFee: 0.0004, estimatedTimeSeconds: 120 },
};

// =============================================================================
// Pair Activity Tiers
// =============================================================================

/**
 * Pair activity probability — chance a pair has a trade in any given block.
 * Based on typical DEX trading patterns:
 * - Tier 1 (blue-chip): active in 60-80% of blocks
 * - Tier 2 (medium): active in 20-40% of blocks
 * - Tier 3 (low-cap/chain-specific): active in 3-15% of blocks
 *
 * Key format: 'TOKEN0/TOKEN1' (uppercase, canonical order from DEFAULT_CONFIG.pairs)
 *
 * @see docs/reports/SIMULATION_REWORK_RESEARCH_2026-03-01.md — Section 8.2
 */
export const PAIR_ACTIVITY_TIERS: Record<string, number> = {
  // Tier 1: Blue-chip stablecoin pairs
  'WETH/USDC': 0.75, 'WETH/USDT': 0.70, 'WBTC/WETH': 0.65, 'WBTC/USDC': 0.60,
  'WBNB/BUSD': 0.70, 'WBNB/USDT': 0.65, 'SOL/USDC': 0.75,

  // Tier 2: Medium-cap pairs
  'ARB/WETH': 0.35, 'ARB/USDC': 0.30, 'OP/WETH': 0.30, 'OP/USDC': 0.25,
  'LINK/WETH': 0.30, 'MATIC/USDC': 0.35, 'AVAX/USDC': 0.30, 'FTM/USDC': 0.25,
  'JUP/SOL': 0.30, 'RAY/SOL': 0.25, 'ORCA/SOL': 0.20,

  // Tier 2b: LST pairs (high correlation, steady flow)
  'stETH/WETH': 0.20, 'rETH/WETH': 0.18, 'wstETH/WETH': 0.22, 'cbETH/WETH': 0.15,
  'mSOL/SOL': 0.25, 'jitoSOL/SOL': 0.20, 'stMATIC/WMATIC': 0.15,

  // Tier 3: Low-cap/chain-specific pairs
  'CAKE/WBNB': 0.15, 'CAKE/BUSD': 0.12, 'XVS/WBNB': 0.08,
  'BTCB/WBNB': 0.18, 'QUICK/WMATIC': 0.08, 'QUICK/USDC': 0.06,
  'JOE/WAVAX': 0.12, 'JOE/USDC': 0.10,
  'WFTM/USDC': 0.15, 'WFTM/DAI': 0.10,
  'AERO/WETH': 0.15, 'AERO/USDC': 0.12, 'VELO/WETH': 0.10,
  'sUSD/USDC': 0.08, 'GMX/WETH': 0.12, 'MAGIC/WETH': 0.08, 'PENDLE/WETH': 0.10,
  'CRV/WETH': 0.12, 'AAVE/WETH': 0.15,

  // Tier 3b: Meme/micro-cap
  'PEPE/WETH': 0.08, 'SHIB/WETH': 0.06, 'DOGE/WETH': 0.05,
  'BONK/SOL': 0.10, 'WIF/SOL': 0.12, 'JTO/SOL': 0.15,
  'PYTH/SOL': 0.10, 'MNDE/SOL': 0.06, 'W/SOL': 0.08, 'BSOL/SOL': 0.12,
};

/** Default activity probability for pairs not listed in PAIR_ACTIVITY_TIERS */
export const DEFAULT_PAIR_ACTIVITY = 0.15;

// =============================================================================
// Strategy Distribution Weights
// =============================================================================

/**
 * Strategy type distribution weights for realistic simulation.
 * Weights sum to 1.0 and reflect typical mainnet opportunity distribution.
 *
 * cross-dex dominates because most real arbitrage is between DEXes on the same chain.
 * Cross-chain is handled separately by CrossChainSimulator (weight here is for
 * occasional same-chain-simulator cross-chain hints).
 * Solana-specific type is handled by the non-EVM simulator (weight here is minimal).
 *
 * @see docs/reports/SIMULATION_REWORK_RESEARCH_2026-03-01.md — Section 8.4
 */
export const STRATEGY_WEIGHTS: Record<SimulatedOpportunityType, number> = {
  'cross-dex': 0.30,
  'simple': 0.20,
  'flash-loan': 0.12,
  'triangular': 0.08,
  'backrun': 0.06,
  'intra-dex': 0.05,
  'statistical': 0.05,
  'cross-chain': 0.04,
  'uniswapx': 0.03,
  'predictive': 0.02,
  'quadrilateral': 0.02,
  'multi-leg': 0.02,
  'solana': 0.01,
};

/**
 * Select a strategy type using weighted random selection.
 * Falls back to 'cross-dex' if weights somehow don't sum to 1.0.
 */
export function selectWeightedStrategyType(): SimulatedOpportunityType {
  const rand = Math.random();
  let cumulative = 0;
  for (const [type, weight] of Object.entries(STRATEGY_WEIGHTS)) {
    cumulative += weight;
    if (rand < cumulative) return type as SimulatedOpportunityType;
  }
  return 'cross-dex';
}

// =============================================================================
// Fast Lane Strategy Distribution
// =============================================================================

/**
 * Default fast-lane opportunity generation rate.
 * Fraction of ticks that produce a fast-lane-eligible opportunity.
 * Overridden by SIMULATION_FAST_LANE_RATE env var.
 *
 * @default 0.15 (15% of ticks)
 */
export const DEFAULT_FAST_LANE_RATE = 0.15;

/**
 * Strategy type weights for fast-lane opportunities.
 * Tuned for high-confidence, high-profit types that are realistic fast-lane
 * candidates. Weights sum to 1.0.
 *
 * Excludes types with inherently low confidence (backrun, predictive)
 * and solana (handled by non-EVM simulator).
 */
export const FAST_LANE_STRATEGY_WEIGHTS: Partial<Record<SimulatedOpportunityType, number>> = {
  'flash-loan': 0.30,
  'cross-dex': 0.25,
  'simple': 0.15,
  'triangular': 0.10,
  'intra-dex': 0.08,
  'statistical': 0.05,
  'uniswapx': 0.04,
  'multi-leg': 0.03,
};

/**
 * Select a strategy type for fast-lane opportunities using weighted random.
 * Falls back to 'flash-loan' if weights don't sum to 1.0.
 */
export function selectFastLaneStrategyType(): SimulatedOpportunityType {
  const rand = Math.random();
  let cumulative = 0;
  for (const [type, weight] of Object.entries(FAST_LANE_STRATEGY_WEIGHTS)) {
    cumulative += weight as number;
    if (rand < cumulative) return type as SimulatedOpportunityType;
  }
  return 'flash-loan';
}

// =============================================================================
// Market Regime Model
// =============================================================================

/**
 * Behavior multipliers per market regime.
 *
 * Quiet (~60% steady-state): Few pair updates, low volatility, rare opportunities.
 * Normal (~30% steady-state): Moderate activity.
 * Burst (~10% steady-state): Many pairs affected, correlated moves, higher arb chance.
 *
 * @see docs/reports/SIMULATION_REWORK_RESEARCH_2026-03-01.md — Section 8.5
 */
export const REGIME_CONFIGS: Record<MarketRegime, RegimeConfig> = {
  quiet:  { pairActivityMultiplier: 0.3, volatilityMultiplier: 0.5, arbChanceMultiplier: 0.3 },
  normal: { pairActivityMultiplier: 1.0, volatilityMultiplier: 1.0, arbChanceMultiplier: 1.0 },
  burst:  { pairActivityMultiplier: 2.0, volatilityMultiplier: 3.0, arbChanceMultiplier: 2.5 },
};

/**
 * Markov chain transition probabilities per tick.
 * Each row sums to 1.0.
 */
export const REGIME_TRANSITIONS: Record<MarketRegime, Record<MarketRegime, number>> = {
  quiet:  { quiet: 0.94, normal: 0.05, burst: 0.01 },
  normal: { quiet: 0.10, normal: 0.87, burst: 0.03 },
  burst:  { quiet: 0.05, normal: 0.15, burst: 0.80 },
};

/**
 * Transition to the next regime using Markov chain probabilities.
 */
export function transitionRegime(current: MarketRegime): MarketRegime {
  const transitions = REGIME_TRANSITIONS[current];
  const rand = Math.random();
  let cumulative = 0;
  for (const [regime, prob] of Object.entries(transitions)) {
    cumulative += prob;
    if (rand < cumulative) return regime as MarketRegime;
  }
  return current;
}

// =============================================================================
// Token Correlation Matrix (Batch 1, Task 1.2)
// =============================================================================

/**
 * Pairwise correlation coefficients between tokens.
 * When token A's price changes, correlated tokens B receive a proportional move:
 *   B_change = correlation * A_change + noise
 *
 * Key format: 'TOKEN_A:TOKEN_B' (uppercase, order matters — define both directions).
 * Correlation is symmetric so both A:B and B:A should have the same value.
 *
 * Groups:
 * - ETH derivatives: WETH, stETH, wstETH, rETH, cbETH (0.995-0.999)
 * - Stablecoins: USDC, USDT, DAI, BUSD, FRAX (0.999)
 * - ETH-BTC: ~0.85
 * - SOL LSTs: SOL, mSOL, jitoSOL, BSOL (0.995-0.998)
 * - Native wrapped: BNB/WBNB, FTM/WFTM etc. (1.0)
 *
 * @see docs/plans/2026-03-11-simulation-realism-enhancement.md — Task 1.2
 */
export const TOKEN_CORRELATIONS: Record<string, number> = {
  // ETH derivatives — near-perfect correlation
  'WETH:STETH': 0.998, 'STETH:WETH': 0.998,
  'WETH:WSTETH': 0.997, 'WSTETH:WETH': 0.997,
  'WETH:RETH': 0.996, 'RETH:WETH': 0.996,
  'WETH:CBETH': 0.995, 'CBETH:WETH': 0.995,
  'STETH:WSTETH': 0.999, 'WSTETH:STETH': 0.999,
  'STETH:RETH': 0.996, 'RETH:STETH': 0.996,
  'STETH:CBETH': 0.995, 'CBETH:STETH': 0.995,
  'WSTETH:RETH': 0.996, 'RETH:WSTETH': 0.996,
  'WSTETH:CBETH': 0.995, 'CBETH:WSTETH': 0.995,
  'RETH:CBETH': 0.994, 'CBETH:RETH': 0.994,

  // ETH ↔ ETH alias (identical asset)
  'WETH:ETH': 1.0, 'ETH:WETH': 1.0,

  // Native token ↔ wrapped (identical asset)
  'BNB:WBNB': 1.0, 'WBNB:BNB': 1.0,
  'FTM:WFTM': 1.0, 'WFTM:FTM': 1.0,
  'AVAX:WAVAX': 1.0, 'WAVAX:AVAX': 1.0,
  'MATIC:WMATIC': 1.0, 'WMATIC:MATIC': 1.0,
  'MNT:WMNT': 1.0, 'WMNT:MNT': 1.0,
  'WBTC:BTCB': 1.0, 'BTCB:WBTC': 1.0,

  // Stablecoins — near-perfect peg
  'USDC:USDT': 0.999, 'USDT:USDC': 0.999,
  'USDC:DAI': 0.999, 'DAI:USDC': 0.999,
  'USDC:BUSD': 0.999, 'BUSD:USDC': 0.999,
  'USDC:FRAX': 0.998, 'FRAX:USDC': 0.998,
  'USDT:DAI': 0.999, 'DAI:USDT': 0.999,
  'USDT:BUSD': 0.999, 'BUSD:USDT': 0.999,
  'USDT:FRAX': 0.998, 'FRAX:USDT': 0.998,
  'DAI:BUSD': 0.999, 'BUSD:DAI': 0.999,
  'DAI:FRAX': 0.998, 'FRAX:DAI': 0.998,
  'BUSD:FRAX': 0.998, 'FRAX:BUSD': 0.998,

  // ETH ↔ BTC — strong but not pegged
  'WETH:WBTC': 0.85, 'WBTC:WETH': 0.85,
  'ETH:WBTC': 0.85, 'WBTC:ETH': 0.85,

  // SOL LST derivatives — near-perfect correlation
  'SOL:MSOL': 0.997, 'MSOL:SOL': 0.997,
  'SOL:JITOSOL': 0.996, 'JITOSOL:SOL': 0.996,
  'SOL:BSOL': 0.995, 'BSOL:SOL': 0.995,
  'MSOL:JITOSOL': 0.998, 'JITOSOL:MSOL': 0.998,
  'MSOL:BSOL': 0.996, 'BSOL:MSOL': 0.996,
  'JITOSOL:BSOL': 0.996, 'BSOL:JITOSOL': 0.996,

  // MATIC LST
  'WMATIC:STMATIC': 0.996, 'STMATIC:WMATIC': 0.996,
  'MATIC:STMATIC': 0.996, 'STMATIC:MATIC': 0.996,
};

/**
 * Get correlated tokens for a given symbol.
 * Returns array of [symbol, correlation] pairs sorted by correlation descending.
 * Results are cached for performance.
 */
const correlationCache = new Map<string, [string, number][]>();

export function getCorrelatedTokens(symbol: string): [string, number][] {
  const upper = symbol.toUpperCase();
  const cached = correlationCache.get(upper);
  if (cached) return cached;

  const result: [string, number][] = [];
  const prefix = upper + ':';
  for (const [key, corr] of Object.entries(TOKEN_CORRELATIONS)) {
    if (key.startsWith(prefix)) {
      result.push([key.slice(prefix.length), corr]);
    }
  }
  result.sort((a, b) => b[1] - a[1]);
  correlationCache.set(upper, result);
  return result;
}

// =============================================================================
// Pegged Pair Definitions (Batch 1, Task 1.4)
// =============================================================================

/**
 * Pairs that mean-revert to a target ratio via Ornstein-Uhlenbeck process.
 *
 * The OU process: dX = theta * (mu - X) * dt + sigma * dW
 * - theta: mean-reversion speed (higher = faster reversion)
 * - mu: target ratio (1.0 for same-denomination pairs)
 * - sigma: volatility of deviations from peg
 *
 * Key format: 'TOKEN0/TOKEN1' (matches pair key format).
 *
 * @see docs/plans/2026-03-11-simulation-realism-enhancement.md — Task 1.4
 */
export interface PeggedPairConfig {
  /** Target price ratio (token1/token0 in price terms) */
  targetRatio: number;
  /** Mean-reversion speed (Ornstein-Uhlenbeck theta). Higher = faster reversion. */
  meanReversionSpeed: number;
  /** Volatility of deviations from peg (Ornstein-Uhlenbeck sigma) */
  pegVolatility: number;
}

export const PEGGED_PAIRS: Record<string, PeggedPairConfig> = {
  // Stablecoin pairs — tight peg, fast reversion
  'USDC/USDT': { targetRatio: 1.0, meanReversionSpeed: 0.5, pegVolatility: 0.0002 },
  'USDT/USDC': { targetRatio: 1.0, meanReversionSpeed: 0.5, pegVolatility: 0.0002 },
  'USDC/DAI': { targetRatio: 1.0, meanReversionSpeed: 0.4, pegVolatility: 0.0003 },
  'DAI/USDC': { targetRatio: 1.0, meanReversionSpeed: 0.4, pegVolatility: 0.0003 },
  'USDC/BUSD': { targetRatio: 1.0, meanReversionSpeed: 0.5, pegVolatility: 0.0002 },
  'BUSD/USDC': { targetRatio: 1.0, meanReversionSpeed: 0.5, pegVolatility: 0.0002 },
  'USDT/DAI': { targetRatio: 1.0, meanReversionSpeed: 0.4, pegVolatility: 0.0003 },
  'DAI/USDT': { targetRatio: 1.0, meanReversionSpeed: 0.4, pegVolatility: 0.0003 },
  'sUSD/USDC': { targetRatio: 1.0, meanReversionSpeed: 0.3, pegVolatility: 0.0005 },

  // ETH LST pairs — slight premium for liquid staking, moderate reversion
  'stETH/WETH': { targetRatio: 1.0, meanReversionSpeed: 0.3, pegVolatility: 0.001 },
  'wstETH/WETH': { targetRatio: 1.0625, meanReversionSpeed: 0.3, pegVolatility: 0.001 },
  'rETH/WETH': { targetRatio: 1.047, meanReversionSpeed: 0.25, pegVolatility: 0.0012 },
  'cbETH/WETH': { targetRatio: 1.016, meanReversionSpeed: 0.25, pegVolatility: 0.0012 },

  // SOL LST pairs
  'mSOL/SOL': { targetRatio: 1.057, meanReversionSpeed: 0.25, pegVolatility: 0.001 },
  'jitoSOL/SOL': { targetRatio: 1.086, meanReversionSpeed: 0.25, pegVolatility: 0.001 },
  'BSOL/SOL': { targetRatio: 1.03, meanReversionSpeed: 0.25, pegVolatility: 0.0012 },

  // MATIC LST
  'stMATIC/WMATIC': { targetRatio: 1.06, meanReversionSpeed: 0.25, pegVolatility: 0.001 },
};
