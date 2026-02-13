/**
 * Intra-Solana Arbitrage Detector
 *
 * Detects arbitrage opportunities between different Solana DEXs.
 * Compares prices for the same token pair across pools.
 *
 * Features:
 * - O(n²) bounded comparison with configurable limit
 * - Fee-aware profit calculation
 * - Stale price filtering
 * - Circuit breaker support
 *
 * @see R1 - Solana Arbitrage Detection Modules extraction
 */

import type { VersionedPoolStore } from '../pool/versioned-pool-store';
import type { OpportunityFactory } from '../opportunity-factory';
import type {
  InternalPoolInfo,
  SolanaArbitrageOpportunity,
  SolanaArbitrageLogger,
} from '../types';
import {
  isValidPrice,
  isValidFee,
  isPriceStale,
  estimateGasCost,
  basisPointsToDecimal,
  meetsThreshold,
  COMPUTE_UNITS,
  MAX_COMPARISONS_PER_PAIR,
} from './base';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for intra-Solana detection.
 */
export interface IntraSolanaDetectorConfig {
  /** Minimum profit threshold as decimal (e.g., 0.003 = 0.3%) */
  minProfitThreshold: number;
  /** Price staleness threshold in ms */
  priceStalenessMs: number;
  /** Base priority fee in lamports */
  basePriorityFeeLamports: number;
  /** Priority fee multiplier */
  priorityFeeMultiplier: number;
  /** Default trade value in USD for gas estimation */
  defaultTradeValueUsd: number;
}

/**
 * Detection result with statistics.
 */
export interface IntraSolanaDetectionResult {
  /** Found opportunities */
  opportunities: SolanaArbitrageOpportunity[];
  /** Number of stale pools skipped */
  stalePoolsSkipped: number;
  /** Detection latency in ms */
  latencyMs: number;
}

// =============================================================================
// Detector
// =============================================================================

/**
 * Detect intra-Solana arbitrage opportunities.
 *
 * Compares prices for the same token pair across different DEXs/pools.
 * Uses bounded O(n²) comparison to prevent performance issues.
 *
 * @param poolStore - Pool store to read from
 * @param opportunityFactory - Factory for creating opportunities
 * @param config - Detection configuration
 * @param logger - Optional logger
 * @returns Detection result with opportunities and statistics
 */
export function detectIntraSolanaArbitrage(
  poolStore: VersionedPoolStore,
  opportunityFactory: OpportunityFactory,
  config: IntraSolanaDetectorConfig,
  logger?: SolanaArbitrageLogger
): IntraSolanaDetectionResult {
  const startTime = Date.now();
  const opportunities: SolanaArbitrageOpportunity[] = [];
  const thresholdDecimal = config.minProfitThreshold / 100;
  let staleSkipped = 0;

  // Get all pair keys
  const pairKeys = poolStore.getPairKeys();

  for (const pairKey of pairKeys) {
    // Get pools for this pair, filtering out invalid/stale prices
    const allPools = poolStore.getPoolsForPair(pairKey);
    const pools: InternalPoolInfo[] = [];
    for (const p of allPools) {
      if (!isValidPrice(p.price)) continue;
      if (isPriceStale(p, config.priceStalenessMs, logger)) {
        staleSkipped++;
        continue;
      }
      pools.push(p);
    }

    if (pools.length < 2) continue;

    // Track comparisons to prevent O(n²) performance issues
    let comparisons = 0;
    let limitReached = false;

    // Compare all pool pairs with bounded iteration
    for (let i = 0; i < pools.length && !limitReached; i++) {
      for (let j = i + 1; j < pools.length && !limitReached; j++) {
        comparisons++;
        if (comparisons > MAX_COMPARISONS_PER_PAIR) {
          limitReached = true;
          logger?.debug('Comparison limit reached for pair', {
            pairKey,
            totalPools: pools.length,
            comparisons: comparisons - 1,
            maxComparisons: MAX_COMPARISONS_PER_PAIR,
          });
          break;
        }

        const opportunity = calculateOpportunity(
          pools[i],
          pools[j],
          thresholdDecimal,
          config,
          opportunityFactory,
          logger
        );

        if (opportunity) {
          opportunities.push(opportunity);
        }
      }
    }
  }

  return {
    opportunities,
    stalePoolsSkipped: staleSkipped,
    latencyMs: Date.now() - startTime,
  };
}

/**
 * Calculate arbitrage opportunity between two pools.
 *
 * @param pool1 - First pool
 * @param pool2 - Second pool
 * @param thresholdDecimal - Minimum profit threshold as decimal
 * @param config - Detection configuration
 * @param opportunityFactory - Factory for creating opportunities
 * @param logger - Optional logger
 * @returns Opportunity if profitable, null otherwise
 */
function calculateOpportunity(
  pool1: InternalPoolInfo,
  pool2: InternalPoolInfo,
  thresholdDecimal: number,
  config: IntraSolanaDetectorConfig,
  opportunityFactory: OpportunityFactory,
  logger?: SolanaArbitrageLogger
): SolanaArbitrageOpportunity | null {
  // Already validated in caller, but double-check
  if (!isValidPrice(pool1.price) || !isValidPrice(pool2.price)) return null;

  // Validate fees are within valid range
  if (!isValidFee(pool1.fee) || !isValidFee(pool2.fee)) {
    logger?.debug('Invalid fee value detected, skipping opportunity', {
      pool1Address: pool1.address,
      pool1Fee: pool1.fee,
      pool2Address: pool2.address,
      pool2Fee: pool2.fee,
    });
    return null;
  }

  // Calculate price difference
  const minPrice = Math.min(pool1.price, pool2.price);
  const maxPrice = Math.max(pool1.price, pool2.price);
  const grossDiff = (maxPrice - minPrice) / minPrice;

  // Calculate fees
  const fee1 = basisPointsToDecimal(pool1.fee);
  const fee2 = basisPointsToDecimal(pool2.fee);
  const totalFees = fee1 + fee2;

  // Net profit after fees
  const netProfit = grossDiff - totalFees;

  // Check against threshold
  if (!meetsThreshold(netProfit, thresholdDecimal)) {
    return null;
  }

  // Determine buy/sell direction
  const buyPool = pool1.price < pool2.price ? pool1 : pool2;
  const sellPool = pool1.price < pool2.price ? pool2 : pool1;

  // Estimate gas cost
  const gasCost = estimateGasCost(COMPUTE_UNITS.SIMPLE_SWAP, config.defaultTradeValueUsd, {
    basePriorityFeeLamports: config.basePriorityFeeLamports,
    priorityFeeMultiplier: config.priorityFeeMultiplier,
  });

  return opportunityFactory.createIntraSolana(buyPool, sellPool, netProfit, gasCost);
}

// =============================================================================
// Exports
// =============================================================================

export type { InternalPoolInfo } from '../types';
