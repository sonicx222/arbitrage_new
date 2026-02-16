/**
 * Solana Arbitrage Detector
 *
 * ARCH-REFACTOR: Extracted from solana-detector.ts
 * Pure computation module: compares pool prices, calculates
 * net profit after fees, determines buy/sell direction.
 *
 * Accesses pools via a lock-free snapshot callback.
 * No cleanup needed — stateless module.
 *
 * @see ADR-014: Modular Detector Components
 */

import type { ArbitrageOpportunity } from '@arbitrage/types';
import { meetsThreshold } from '../components/price-calculator';
import { basisPointsToDecimal } from '../utils/fee-utils';
import type { SolanaDetectorLogger, SolanaPool } from './solana-types';
import { SOLANA_DEFAULT_GAS_ESTIMATE } from './solana-types';

// =============================================================================
// Public Interface
// =============================================================================

export interface SolanaArbitrageDetectorModule {
  checkArbitrage(): Promise<ArbitrageOpportunity[]>;
}

export interface ArbitrageDetectorConfig {
  /** Minimum profit threshold in percent form (0.3 = 0.3%). */
  minProfitThreshold: number;
  /** Opportunity expiry in milliseconds. */
  opportunityExpiryMs: number;
  /** Maximum slot age before pool data is considered stale (default: 10, ~4s at 400ms/slot). */
  maxSlotAge?: number;
  /**
   * Minimum net profit ratio floor (default: 0.005 = 0.5%).
   * Ensures opportunities cover Solana tx costs (~5000 lamports base + priority fee).
   * TODO: Replace with absolute profit check when trade amounts are available in this module.
   */
  minNetProfitFloor?: number;
}

export interface ArbitrageDetectorDeps {
  logger: SolanaDetectorLogger;
  /** Lock-free snapshot of pools and pair entries. */
  getPoolsSnapshot: () => { pools: Map<string, SolanaPool>; pairEntries: [string, Set<string>][] };
  /** Get current slot for confidence calculation. */
  getCurrentSlot: () => number;
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Solana arbitrage detector.
 *
 * @param config - Detection configuration
 * @param deps - Dependencies
 * @returns SolanaArbitrageDetectorModule
 */
export function createSolanaArbitrageDetector(
  config: ArbitrageDetectorConfig,
  deps: ArbitrageDetectorDeps
): SolanaArbitrageDetectorModule {
  const { logger } = deps;

  // Convert percent threshold to decimal once
  const thresholdDecimal = config.minProfitThreshold / 100;

  /** Maximum slot age before pool data is considered stale (~4 seconds at 400ms/slot). */
  const MAX_SLOT_AGE = config.maxSlotAge ?? 10;

  /** Minimum net profit ratio floor to cover Solana tx costs. */
  const MIN_NET_PROFIT_FLOOR = config.minNetProfitFloor ?? 0.005;

  function calculateArbitrageOpportunity(
    pool1: SolanaPool,
    pool2: SolanaPool
  ): ArbitrageOpportunity | null {
    if (!pool1.price || !pool2.price) return null;

    // Reject stale pool data (Fix 9)
    const currentSlot = deps.getCurrentSlot();
    const pool1Age = currentSlot - (pool1.lastSlot ?? 0);
    const pool2Age = currentSlot - (pool2.lastSlot ?? 0);
    if (pool1Age > MAX_SLOT_AGE || pool2Age > MAX_SLOT_AGE) return null;

    const minPrice = Math.min(pool1.price, pool2.price);
    const maxPrice = Math.max(pool1.price, pool2.price);
    const grossDiff = (maxPrice - minPrice) / minPrice;

    const fee1 = basisPointsToDecimal(pool1.fee);
    const fee2 = basisPointsToDecimal(pool2.fee);
    const totalFees = fee1 + fee2;

    const netProfit = grossDiff - totalFees;

    if (!meetsThreshold(netProfit, thresholdDecimal)) {
      return null;
    }

    // Minimum absolute profit floor to ensure tx costs are covered (Fix 6)
    if (netProfit < MIN_NET_PROFIT_FLOOR) {
      return null;
    }

    const buyPool = pool1.price < pool2.price ? pool1 : pool2;
    const sellPool = pool1.price < pool2.price ? pool2 : pool1;

    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).slice(2, 11);

    // Dynamic confidence based on slot age (reuses currentSlot from stale-data check above)
    const slotAge = Math.max(0, currentSlot - Math.max(
      pool1.lastSlot ?? currentSlot,
      pool2.lastSlot ?? currentSlot
    ));
    const confidence = Math.min(0.95, Math.max(0.5, 1.0 - slotAge * 0.01));
    const safeConfidence = Number.isFinite(confidence) ? confidence : 0.5;

    return {
      id: `solana-${buyPool.address}-${sellPool.address}-${timestamp}-${randomSuffix}`,
      type: buyPool.dex === sellPool.dex ? 'intra-dex' : 'cross-dex',
      chain: 'solana',
      buyDex: buyPool.dex,
      sellDex: sellPool.dex,
      buyPair: buyPool.address,
      sellPair: sellPool.address,
      token0: buyPool.token0.mint,
      token1: buyPool.token1.mint,
      buyPrice: buyPool.price,
      sellPrice: sellPool.price,
      profitPercentage: netProfit * 100,
      expectedProfit: netProfit,
      confidence: safeConfidence,
      timestamp,
      expiresAt: timestamp + config.opportunityExpiryMs,
      gasEstimate: SOLANA_DEFAULT_GAS_ESTIMATE,
      status: 'pending'
    };
  }

  async function checkArbitrage(): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];
    const snapshot = deps.getPoolsSnapshot();

    for (const [_pairKey, poolAddresses] of snapshot.pairEntries) {
      if (poolAddresses.size < 2) continue;

      const pools = Array.from(poolAddresses)
        .map(addr => snapshot.pools.get(addr))
        .filter((p): p is SolanaPool => p !== undefined && p.price !== undefined);

      if (pools.length < 2) continue;

      // Compare all pool pairs
      for (let i = 0; i < pools.length; i++) {
        for (let j = i + 1; j < pools.length; j++) {
          const opportunity = calculateArbitrageOpportunity(pools[i], pools[j]);
          if (opportunity) {
            opportunities.push(opportunity);
          }
        }
      }
    }

    return opportunities;
  }

  return {
    checkArbitrage,
  };
}
