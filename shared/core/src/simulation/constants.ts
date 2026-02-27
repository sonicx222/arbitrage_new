/**
 * Simulation Mode Constants
 *
 * Token prices, chain-specific pairs, DEX mappings, and default configuration.
 *
 * @module simulation
 */

import type { SimulationConfig, BridgeCostConfig } from './types';

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_CONFIG: SimulationConfig = {
  // W2-L1 FIX: Use ?? for convention compliance
  volatility: parseFloat(process.env.SIMULATION_VOLATILITY ?? '0.02'),
  updateIntervalMs: parseInt(process.env.SIMULATION_UPDATE_INTERVAL_MS ?? '1000', 10),
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
};
