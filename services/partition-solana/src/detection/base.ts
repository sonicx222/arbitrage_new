/**
 * Base Detection Utilities
 *
 * Shared utilities and constants for arbitrage detection modules.
 *
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

import { getDefaultPrice } from '@arbitrage/core/analytics';
import { bpsToDecimal, meetsThreshold } from '@arbitrage/core/components';
import { getEstimatedGasCostUsd } from '@arbitrage/config';
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
export const DEFAULT_SOL_PRICE_USD = 200;

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
 * Get EVM gas cost for a specific chain, falling back to default.
 *
 * P1-4 FIX: Delegates to centralized getEstimatedGasCostUsd() from @arbitrage/config
 * which includes L1 data posting fees for rollup chains (P2-8 fix).
 * Previous local EVM_GAS_COSTS_USD table had stale execution-only values that
 * underestimated L2 gas costs by 2-3x (e.g., Arbitrum $0.10 vs correct $0.30).
 *
 * @param chain - EVM chain name (lowercase)
 * @param defaultCostUsd - Fallback cost if chain not in centralized config
 * @returns Gas cost in USD
 * @see shared/config/src/thresholds.ts chainEstimatedGasCostUsd — single source of truth
 */
export function getEvmGasCostUsd(chain: string, defaultCostUsd: number): number {
  const centralizedCost = getEstimatedGasCostUsd(chain);
  // getEstimatedGasCostUsd returns $15 (Ethereum fallback) for unknown chains.
  // Use caller's defaultCostUsd if the chain isn't in the centralized config
  // and the centralized fallback ($15) seems unreasonably high for an L2.
  // Known chains are handled by the centralized config directly.
  return centralizedCost !== 15 ? centralizedCost : (defaultCostUsd < 15 ? defaultCostUsd : centralizedCost);
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
  // P3 Fix CC-8: This 1s expiry is the Solana-specific detection window (fast 400ms blocks).
  // detector-config.ts:expiryMs (5s) is the data freshness/staleness tolerance, not the same concept.
  opportunityExpiryMs: 1000, // 1 second (Solana is fast)
  priceStalenessMs: 5000, // 5 seconds
  defaultTradeValueUsd: 1000,
  normalizeLiquidStaking: false, // Phase 0 Item 2: LST price deviation IS the arb opportunity
  crossChainCosts: {
    bridgeFeeDefault: 0.001, // 0.1%
    // M-11 FIX: Lowered from $15 (Ethereum-level) to $2 as fallback for unknown chains.
    // Per-chain costs are resolved via EVM_GAS_COSTS_USD lookup in getEvmGasCostUsd().
    evmGasCostUsd: 2,
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

export { bpsToDecimal, meetsThreshold, getDefaultPrice };
