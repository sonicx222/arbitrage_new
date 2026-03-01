/**
 * Per-chain throughput profiles calibrated to real on-chain data.
 *
 * Each profile provides block timing, swap frequency, DEX market share,
 * trade size distribution, and gas economics for realistic simulation.
 *
 * @module simulation
 * @see docs/plans/2026-03-01-realistic-throughput-simulation-design.md
 */

import type { ChainThroughputProfile } from './types';
import { getTokenPrice } from './constants';
import { weightedRandomSelect } from './math-utils';

// =============================================================================
// Native Token Mapping
// =============================================================================

/**
 * Maps chain ID to the wrapped native token symbol used in BASE_PRICES.
 */
export const NATIVE_TOKENS: Record<string, string> = {
  ethereum: 'WETH',
  bsc: 'WBNB',
  polygon: 'WMATIC',
  avalanche: 'WAVAX',
  fantom: 'WFTM',
  arbitrum: 'WETH',
  optimism: 'WETH',
  base: 'WETH',
  zksync: 'WETH',
  linea: 'WETH',
  blast: 'WETH',
  scroll: 'WETH',
  mantle: 'WETH',
  mode: 'WETH',
  solana: 'SOL',
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get the native token price for a chain in USD.
 * Falls back to 1 USD for unknown chains.
 *
 * @param chainId - Chain identifier (e.g. 'ethereum', 'bsc')
 * @returns Native token price in USD
 */
export function getNativeTokenPrice(chainId: string): number {
  const symbol = NATIVE_TOKENS[chainId];
  if (!symbol) return 1;
  return getTokenPrice(symbol);
}

/**
 * Select a DEX from a market share distribution using weighted random selection.
 *
 * @param marketShare - DEX name to market share weight mapping
 * @returns Selected DEX name
 */
export function selectWeightedDex(marketShare: Record<string, number>): string {
  const dexNames = Object.keys(marketShare);
  const weights = Object.values(marketShare);
  return weightedRandomSelect(dexNames, weights);
}

// =============================================================================
// Chain Throughput Profiles
// =============================================================================

/**
 * Per-chain throughput profiles for all 15 supported chains.
 *
 * Data sources:
 * - Block times from on-chain measurements (etherscan, bscscan, etc.)
 * - Swap counts from Dune Analytics average DEX swap events per block
 * - Gas models from recent 7-day median gas price data
 * - DEX market share from DeFiLlama volume data
 *
 * @see docs/plans/2026-03-01-realistic-throughput-simulation-design.md
 */
export const CHAIN_THROUGHPUT_PROFILES: Readonly<Record<string, ChainThroughputProfile>> = {
  // =========================================================================
  // P3 High-Value
  // =========================================================================

  ethereum: {
    blockTimeMs: 12000,
    blockTimeJitterMs: 500,
    slotMissRate: 0.01,
    dexSwapsPerBlock: 40,
    dexMarketShare: {
      uniswap_v3: 0.65,
      sushiswap: 0.35,
    },
    tradeSizeRange: [5000, 200000],
    gasModel: {
      baseFeeAvg: 25,
      baseFeeStdDev: 15,
      priorityFeeAvg: 2.0,
      priorityFeeStdDev: 1.5,
      swapGasUnits: 150000,
      burstMultiplier: 5,
    },
  },

  zksync: {
    blockTimeMs: 1000,
    blockTimeJitterMs: 300,
    slotMissRate: 0.005,
    dexSwapsPerBlock: 4,
    dexMarketShare: {
      syncswap: 0.65,
      mute: 0.35,
    },
    tradeSizeRange: [200, 15000],
    gasModel: {
      baseFeeAvg: 0.25,
      baseFeeStdDev: 0.1,
      priorityFeeAvg: 0,
      priorityFeeStdDev: 0,
      swapGasUnits: 500000,
      burstMultiplier: 3,
    },
  },

  linea: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 300,
    slotMissRate: 0,
    dexSwapsPerBlock: 3,
    dexMarketShare: {
      syncswap: 0.60,
      velocore: 0.40,
    },
    tradeSizeRange: [100, 10000],
    gasModel: {
      baseFeeAvg: 0.5,
      baseFeeStdDev: 0.2,
      priorityFeeAvg: 0.1,
      priorityFeeStdDev: 0.05,
      swapGasUnits: 150000,
      burstMultiplier: 2,
    },
  },

  // =========================================================================
  // P1 Asia-Fast
  // =========================================================================

  bsc: {
    blockTimeMs: 3000,
    blockTimeJitterMs: 200,
    slotMissRate: 0,
    dexSwapsPerBlock: 80,
    dexMarketShare: {
      pancakeswap_v3: 0.50,
      pancakeswap_v2: 0.30,
      biswap: 0.20,
    },
    tradeSizeRange: [500, 50000],
    gasModel: {
      baseFeeAvg: 3,
      baseFeeStdDev: 1,
      priorityFeeAvg: 0,
      priorityFeeStdDev: 0,
      swapGasUnits: 120000,
      burstMultiplier: 2,
    },
  },

  polygon: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 300,
    slotMissRate: 0.005,
    dexSwapsPerBlock: 25,
    dexMarketShare: {
      quickswap_v3: 0.45,
      uniswap_v3: 0.35,
      sushiswap: 0.20,
    },
    tradeSizeRange: [200, 20000],
    gasModel: {
      baseFeeAvg: 30,
      baseFeeStdDev: 10,
      priorityFeeAvg: 30,
      priorityFeeStdDev: 10,
      swapGasUnits: 150000,
      burstMultiplier: 3,
    },
  },

  avalanche: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 300,
    slotMissRate: 0,
    dexSwapsPerBlock: 6,
    dexMarketShare: {
      trader_joe_v2: 0.55,
      pangolin: 0.25,
      sushiswap: 0.20,
    },
    tradeSizeRange: [200, 20000],
    gasModel: {
      baseFeeAvg: 25,
      baseFeeStdDev: 8,
      priorityFeeAvg: 1,
      priorityFeeStdDev: 0.5,
      swapGasUnits: 150000,
      burstMultiplier: 3,
    },
  },

  fantom: {
    blockTimeMs: 1000,
    blockTimeJitterMs: 200,
    slotMissRate: 0,
    dexSwapsPerBlock: 3,
    dexMarketShare: {
      spookyswap: 0.60,
      spiritswap: 0.25,
      equalizer: 0.15,
    },
    tradeSizeRange: [100, 10000],
    gasModel: {
      baseFeeAvg: 10,
      baseFeeStdDev: 5,
      priorityFeeAvg: 0,
      priorityFeeStdDev: 0,
      swapGasUnits: 130000,
      burstMultiplier: 2,
    },
  },

  // =========================================================================
  // P2 L2-Turbo
  // =========================================================================

  arbitrum: {
    blockTimeMs: 250,
    blockTimeJitterMs: 80,
    slotMissRate: 0,
    dexSwapsPerBlock: 5,
    dexMarketShare: {
      uniswap_v3: 0.55,
      camelot_v3: 0.25,
      sushiswap: 0.20,
    },
    tradeSizeRange: [500, 50000],
    gasModel: {
      baseFeeAvg: 0.1,
      baseFeeStdDev: 0.05,
      priorityFeeAvg: 0.01,
      priorityFeeStdDev: 0.01,
      swapGasUnits: 800000,
      burstMultiplier: 3,
    },
  },

  optimism: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 100,
    slotMissRate: 0,
    dexSwapsPerBlock: 8,
    dexMarketShare: {
      velodrome: 0.50,
      uniswap_v3: 0.30,
      sushiswap: 0.20,
    },
    tradeSizeRange: [500, 30000],
    gasModel: {
      baseFeeAvg: 0.005,
      baseFeeStdDev: 0.002,
      priorityFeeAvg: 0.001,
      priorityFeeStdDev: 0.001,
      swapGasUnits: 150000,
      burstMultiplier: 3,
    },
  },

  base: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 100,
    slotMissRate: 0,
    dexSwapsPerBlock: 25,
    dexMarketShare: {
      aerodrome: 0.55,
      uniswap_v3: 0.30,
      baseswap: 0.15,
    },
    tradeSizeRange: [200, 30000],
    gasModel: {
      baseFeeAvg: 0.005,
      baseFeeStdDev: 0.002,
      priorityFeeAvg: 0.001,
      priorityFeeStdDev: 0.001,
      swapGasUnits: 150000,
      burstMultiplier: 3,
    },
  },

  // =========================================================================
  // Emerging L2s
  // =========================================================================

  blast: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 100,
    slotMissRate: 0,
    dexSwapsPerBlock: 4,
    dexMarketShare: {
      aerodrome: 0.50,
      uniswap_v3: 0.30,
      baseswap: 0.20,
    },
    tradeSizeRange: [200, 15000],
    gasModel: {
      baseFeeAvg: 0.005,
      baseFeeStdDev: 0.002,
      priorityFeeAvg: 0.001,
      priorityFeeStdDev: 0.001,
      swapGasUnits: 150000,
      burstMultiplier: 3,
    },
  },

  scroll: {
    blockTimeMs: 3000,
    blockTimeJitterMs: 500,
    slotMissRate: 0.005,
    dexSwapsPerBlock: 3,
    dexMarketShare: {
      aerodrome: 0.55,
      uniswap_v3: 0.25,
      baseswap: 0.20,
    },
    tradeSizeRange: [100, 10000],
    gasModel: {
      baseFeeAvg: 0.1,
      baseFeeStdDev: 0.05,
      priorityFeeAvg: 0.01,
      priorityFeeStdDev: 0.01,
      swapGasUnits: 400000,
      burstMultiplier: 3,
    },
  },

  mantle: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 300,
    slotMissRate: 0,
    dexSwapsPerBlock: 1,
    dexMarketShare: {
      aerodrome: 0.50,
      uniswap_v3: 0.30,
      baseswap: 0.20,
    },
    tradeSizeRange: [100, 5000],
    gasModel: {
      baseFeeAvg: 0.02,
      baseFeeStdDev: 0.01,
      priorityFeeAvg: 0,
      priorityFeeStdDev: 0,
      swapGasUnits: 150000,
      burstMultiplier: 2,
    },
  },

  mode: {
    blockTimeMs: 2000,
    blockTimeJitterMs: 300,
    slotMissRate: 0,
    dexSwapsPerBlock: 1,
    dexMarketShare: {
      aerodrome: 0.50,
      uniswap_v3: 0.30,
      baseswap: 0.20,
    },
    tradeSizeRange: [50, 3000],
    gasModel: {
      baseFeeAvg: 0.005,
      baseFeeStdDev: 0.002,
      priorityFeeAvg: 0,
      priorityFeeStdDev: 0,
      swapGasUnits: 150000,
      burstMultiplier: 2,
    },
  },

  // =========================================================================
  // P4 Solana-Native
  // =========================================================================

  solana: {
    blockTimeMs: 400,
    blockTimeJitterMs: 100,
    slotMissRate: 0.005,
    dexSwapsPerBlock: 120,
    dexMarketShare: {
      raydium: 0.40,
      orca: 0.35,
      meteora: 0.25,
    },
    tradeSizeRange: [50, 10000],
    gasModel: {
      baseFeeAvg: 5000,       // lamports per compute unit
      baseFeeStdDev: 2000,
      priorityFeeAvg: 1000,
      priorityFeeStdDev: 500,
      swapGasUnits: 200000,   // compute units
      burstMultiplier: 4,
    },
  },
};
