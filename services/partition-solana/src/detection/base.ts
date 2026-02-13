/**
 * Base Detection Utilities
 *
 * Shared utilities and constants for arbitrage detection modules.
 *
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

import { basisPointsToDecimal, meetsThreshold, getDefaultPrice } from '@arbitrage/core';
import type { InternalPoolInfo, SolanaArbitrageLogger } from '../types';

// =============================================================================
// Constants
// =============================================================================

/**
 * Minimum valid price value.
 * Prevents division by zero and precision issues.
 */
export const MIN_VALID_PRICE = 1e-12;

/**
 * Default SOL price fallback in USD.
 * Used when price oracle doesn't have SOL price.
 */
export const DEFAULT_SOL_PRICE_USD = 100;

/**
 * Compute unit estimates for different operations.
 */
export const COMPUTE_UNITS = {
  SIMPLE_SWAP: 150000,
  CLMM_SWAP: 300000,
  TRIANGULAR_BASE: 400000,
} as const;

/**
 * Urgency multipliers for priority fees.
 */
export const URGENCY_MULTIPLIERS = {
  low: 0.5,
  medium: 1.0,
  high: 2.0,
} as const;

/**
 * Maximum pool comparisons per pair for O(n²) detection.
 * Prevents performance degradation with many pools per pair.
 */
export const MAX_COMPARISONS_PER_PAIR = 500;

/**
 * Maximum paths to explore per level during triangular path finding.
 */
export const MAX_PATHS_PER_LEVEL = 100;

/**
 * Maximum size for memoization cache in path finding.
 */
export const MAX_MEMO_CACHE_SIZE = 10000;

/**
 * Cross-chain opportunities need longer expiry due to bridge delays.
 */
export const CROSS_CHAIN_EXPIRY_MULTIPLIER = 10;

/**
 * Per-chain EVM gas cost estimates in USD.
 *
 * Gas costs vary significantly across chains:
 * - L2s (Arbitrum, Base, Optimism, Linea, zkSync): Very low ($0.01-$0.50)
 * - Sidechains (BSC, Polygon, Fantom, Avalanche): Low ($0.05-$1.00)
 * - Ethereum mainnet: High ($5-$50 depending on congestion)
 *
 * Values represent typical cost for ~150k gas swap transaction.
 * Used by cross-chain detector to estimate arbitrage profitability per chain.
 *
 * @see Fix #21 - partition-solana-deep-analysis.md
 */
export const EVM_GAS_COSTS_USD: Readonly<Record<string, number>> = {
  ethereum: 15,
  arbitrum: 0.10,
  base: 0.05,
  optimism: 0.05,
  linea: 0.25,
  zksync: 0.25,
  polygon: 0.50,
  bsc: 0.30,
  avalanche: 0.50,
  fantom: 0.10,
};

/**
 * Get EVM gas cost for a specific chain, falling back to default.
 *
 * @param chain - EVM chain name (lowercase)
 * @param defaultCostUsd - Fallback cost if chain not in lookup table
 * @returns Gas cost in USD
 */
export function getEvmGasCostUsd(chain: string, defaultCostUsd: number): number {
  return EVM_GAS_COSTS_USD[chain.toLowerCase()] ?? defaultCostUsd;
}

/**
 * Circuit breaker configuration for detection methods.
 */
export const CIRCUIT_BREAKER_CONFIG = {
  /** Number of consecutive failures before circuit opens */
  FAILURE_THRESHOLD: 5,
  /** Time in ms before attempting to close circuit (half-open state) */
  RESET_TIMEOUT_MS: 30000, // 30 seconds
} as const;

/**
 * Default configuration values.
 */
export const DEFAULT_DETECTION_CONFIG = {
  chainId: 'solana',
  minProfitThreshold: 0.3, // 0.3%
  priorityFeeMultiplier: 1.0,
  basePriorityFeeLamports: 10000, // 0.00001 SOL
  crossChainEnabled: true,
  triangularEnabled: true,
  maxTriangularDepth: 3,
  opportunityExpiryMs: 1000, // 1 second (Solana is fast)
  priceStalenessMs: 5000, // 5 seconds
  defaultTradeValueUsd: 1000,
  normalizeLiquidStaking: true,
  crossChainCosts: {
    bridgeFeeDefault: 0.001, // 0.1%
    evmGasCostUsd: 15, // ~150k gas at 30 gwei, ETH ~$3000
    solanaTxCostUsd: 0.01, // ~5000 compute units at priority
    latencyRiskPremium: 0.002, // 0.2% price movement risk during bridge
  },
} as const;

// =============================================================================
// Validation Utilities
// =============================================================================

/**
 * Check if price is valid (non-zero, not too small).
 *
 * @param price - Price to validate
 * @returns true if price is valid
 */
export function isValidPrice(price: number | undefined): price is number {
  return price !== undefined && price >= MIN_VALID_PRICE && isFinite(price);
}

/**
 * Validate that a fee value is within the valid range for BASIS POINTS format.
 *
 * @param fee - Fee in basis points (0-10000)
 * @returns true if fee is valid
 */
export function isValidFee(fee: number): boolean {
  return typeof fee === 'number' && isFinite(fee) && fee >= 0 && fee <= 10000;
}

/**
 * Validate that a fee value is within the valid range for DECIMAL format.
 *
 * @param fee - Fee as decimal (0-1)
 * @returns true if fee is valid
 */
export function isValidDecimalFee(fee: number): boolean {
  return typeof fee === 'number' && isFinite(fee) && fee >= 0 && fee < 1;
}

/**
 * Check if a pool's price is stale.
 *
 * @param pool - Pool to check
 * @param priceStalenessMs - Staleness threshold in milliseconds
 * @param logger - Optional logger for debug messages
 * @returns true if price is stale
 */
export function isPriceStale(
  pool: InternalPoolInfo,
  priceStalenessMs: number,
  logger?: SolanaArbitrageLogger
): boolean {
  if (!pool.lastUpdated) {
    logger?.debug('Pool missing lastUpdated timestamp, treating as stale', {
      address: pool.address,
    });
    return true;
  }
  return Date.now() - pool.lastUpdated > priceStalenessMs;
}

// =============================================================================
// Gas Cost Estimation
// =============================================================================

/**
 * Calculate priority fee for a transaction.
 *
 * @param computeUnits - Expected compute units
 * @param urgency - Urgency level
 * @param config - Fee configuration
 * @returns Priority fee estimate
 */
export function calculatePriorityFee(
  computeUnits: number,
  urgency: 'low' | 'medium' | 'high',
  config: {
    basePriorityFeeLamports: number;
    priorityFeeMultiplier: number;
  }
): {
  baseFee: number;
  priorityFee: number;
  totalFee: number;
  computeUnits: number;
  microLamportsPerCu: number;
} {
  const urgencyMultiplier = URGENCY_MULTIPLIERS[urgency];
  const baseFee = config.basePriorityFeeLamports;

  const microLamportsPerCu = Math.ceil(
    (baseFee * 1e6 / COMPUTE_UNITS.SIMPLE_SWAP) *
    urgencyMultiplier *
    config.priorityFeeMultiplier
  );

  const priorityFee = Math.ceil((computeUnits * microLamportsPerCu) / 1e6);
  const totalFee = baseFee + priorityFee;

  return {
    baseFee,
    priorityFee,
    totalFee,
    computeUnits,
    microLamportsPerCu,
  };
}

/**
 * Estimate gas cost as a decimal fraction of trade value.
 *
 * @param computeUnits - Expected compute units
 * @param tradeValueUsd - Trade value in USD
 * @param config - Fee configuration
 * @returns Gas cost as decimal (e.g., 0.001 = 0.1%)
 */
export function estimateGasCost(
  computeUnits: number,
  tradeValueUsd: number,
  config: {
    basePriorityFeeLamports: number;
    priorityFeeMultiplier: number;
  }
): number {
  const feeEstimate = calculatePriorityFee(computeUnits, 'medium', config);
  const feeInSol = feeEstimate.totalFee / 1e9;
  const solPriceUsd = getDefaultPrice('SOL') ?? DEFAULT_SOL_PRICE_USD;
  const feeInUsd = feeInSol * solPriceUsd;
  return feeInUsd / tradeValueUsd;
}

// =============================================================================
// Re-exports from @arbitrage/core
// =============================================================================

export { basisPointsToDecimal, meetsThreshold, getDefaultPrice };
