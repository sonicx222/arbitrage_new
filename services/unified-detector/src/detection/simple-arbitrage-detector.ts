/**
 * Simple Arbitrage Detector
 *
 * Detects simple two-pool arbitrage opportunities between DEXes.
 * Extracted from chain-instance.ts for single-responsibility principle.
 *
 * @see R3 - Chain Instance Detection Strategies
 * @see REFACTORING_ROADMAP.md
 */

import {
  // P0-1 FIX: Use precision-safe price calculation
  calculatePriceFromBigIntReserves,
} from '@arbitrage/core';

import { ARBITRAGE_CONFIG, DETECTOR_CONFIG } from '@arbitrage/config';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// P0-2 FIX: Use centralized fee validation (FIX 9.3)
import { validateFee } from '../types';

/**
 * Snapshot of pair data for thread-safe arbitrage detection.
 * Captures reserve values at a point in time to avoid race conditions.
 */
export interface PairSnapshot {
  address: string;
  dex: string;
  token0: string;
  token1: string;
  reserve0: string;
  reserve1: string;
  fee: number;
  blockNumber: number;
  // PERF 10.1: Cached BigInt values for hot-path calculations
  reserve0BigInt: bigint;
  reserve1BigInt: bigint;
}

/**
 * Configuration for simple arbitrage detection.
 */
export interface SimpleArbitrageConfig {
  /** Chain identifier */
  chainId: string;
  /** Gas estimate for the trade */
  gasEstimate: number;
  /** Confidence level for opportunities */
  confidence: number;
  /** Opportunity expiry time in milliseconds */
  expiryMs: number;
}

/**
 * Simple Arbitrage Detector
 *
 * Calculates arbitrage opportunities between two pools trading the same token pair.
 */
export class SimpleArbitrageDetector {
  private readonly config: SimpleArbitrageConfig;
  private readonly minProfitThreshold: number;

  constructor(config: SimpleArbitrageConfig) {
    this.config = config;
    // Use chain-specific minimum profit threshold
    const chainMinProfits = ARBITRAGE_CONFIG.chainMinProfits as Record<string, number>;
    this.minProfitThreshold = chainMinProfits[config.chainId] ?? 0.003; // Default 0.3%
  }

  /**
   * Calculate arbitrage opportunity between two pairs.
   *
   * @param pair1 - First pair snapshot
   * @param pair2 - Second pair snapshot
   * @returns ArbitrageOpportunity if profitable, null otherwise
   */
  calculateArbitrage(
    pair1: PairSnapshot,
    pair2: PairSnapshot
  ): ArbitrageOpportunity | null {
    // PERF 10.1: Use pre-cached BigInt values from snapshot
    const reserve1_0 = pair1.reserve0BigInt;
    const reserve1_1 = pair1.reserve1BigInt;
    const reserve2_0 = pair2.reserve0BigInt;
    const reserve2_1 = pair2.reserve1BigInt;

    if (reserve1_0 === 0n || reserve1_1 === 0n || reserve2_0 === 0n || reserve2_1 === 0n) {
      return null;
    }

    // P0-1 FIX: Use precision-safe price calculation
    const price1 = calculatePriceFromBigIntReserves(reserve1_0, reserve1_1);
    const price2Raw = calculatePriceFromBigIntReserves(reserve2_0, reserve2_1);

    if (price1 === null || price2Raw === null) {
      return null;
    }

    // FIX Bug 4.1: Validate prices BEFORE any division
    const MIN_SAFE_PRICE = 1e-15;
    const MAX_SAFE_PRICE = 1e15;

    if (!Number.isFinite(price1) || price1 < MIN_SAFE_PRICE || price1 > MAX_SAFE_PRICE) {
      return null;
    }
    if (!Number.isFinite(price2Raw) || price2Raw < MIN_SAFE_PRICE || price2Raw > MAX_SAFE_PRICE) {
      return null;
    }

    // BUG FIX: Adjust price for reverse order pairs
    const isReversed = this.isReverseOrder(pair1, pair2);
    const price2 = isReversed ? 1 / price2Raw : price2Raw;

    const minPrice = Math.min(price1, price2);

    // Calculate price difference as a percentage of the lower price
    const priceDiff = Math.abs(price1 - price2) / minPrice;

    // Calculate fee-adjusted profit (P0-2 FIX: use centralized validateFee)
    const totalFees = validateFee(pair1.fee) + validateFee(pair2.fee);
    const netProfitPct = priceDiff - totalFees;

    // Check if profitable after fees
    if (netProfitPct < this.minProfitThreshold) {
      return null;
    }

    // Determine buy/sell sides based on prices
    const buyFromPair1 = price1 < price2;
    const buyPair = buyFromPair1 ? pair1 : pair2;
    const sellPair = buyFromPair1 ? pair2 : pair1;

    // CRITICAL FIX: Calculate tokenIn, tokenOut, and amountIn for execution engine
    const tokenIn = buyPair.token1;
    const tokenOut = buyPair.token0;

    // CRITICAL FIX: Calculate optimal amountIn based on reserves
    const buyReserve1 = buyFromPair1 ? reserve1_1 : reserve2_1;
    const sellReserve1 = buyFromPair1 ? reserve2_1 : reserve1_1;

    // Use 1% of the smaller liquidity pool to minimize slippage
    const maxTradePercent = 0.01;
    const smallerReserve = buyReserve1 < sellReserve1 ? buyReserve1 : sellReserve1;
    const amountIn = (smallerReserve * BigInt(Math.floor(maxTradePercent * 10000))) / 10000n;

    // Skip if calculated amount is too small (dust)
    if (amountIn < 1000n) {
      return null;
    }

    // CRITICAL FIX: Calculate expectedProfit as ABSOLUTE value
    const expectedProfitAbsolute = Number(amountIn) * netProfitPct;

    const opportunity: ArbitrageOpportunity = {
      id: `${this.config.chainId}-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      type: 'simple',
      chain: this.config.chainId,
      buyDex: buyPair.dex,
      sellDex: sellPair.dex,
      buyPair: buyPair.address,
      sellPair: sellPair.address,
      token0: pair1.token0,
      token1: pair1.token1,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      buyPrice: Math.min(price1, price2),
      sellPrice: Math.max(price1, price2),
      profitPercentage: netProfitPct * 100,
      expectedProfit: expectedProfitAbsolute,
      estimatedProfit: 0,
      gasEstimate: String(this.config.gasEstimate),
      confidence: this.config.confidence,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.config.expiryMs,
      blockNumber: pair1.blockNumber,
      status: 'pending'
    };

    return opportunity;
  }

  /**
   * Check if token order is reversed between two pairs.
   */
  private isReverseOrder(pair1: PairSnapshot, pair2: PairSnapshot): boolean {
    const token1_0 = pair1.token0.toLowerCase();
    const token1_1 = pair1.token1.toLowerCase();
    const token2_0 = pair2.token0.toLowerCase();
    const token2_1 = pair2.token1.toLowerCase();

    return token1_0 === token2_1 && token1_1 === token2_0;
  }

  // P0-2 FIX: Removed private validateFee() - now uses centralized version from ../types

  /**
   * Get the minimum profit threshold for this detector.
   */
  getMinProfitThreshold(): number {
    return this.minProfitThreshold;
  }
}

/**
 * Create a simple arbitrage detector instance.
 *
 * @param chainId - Chain identifier
 * @param detectorConfig - Optional detector config override
 * @returns SimpleArbitrageDetector instance
 */
export function createSimpleArbitrageDetector(
  chainId: string,
  detectorConfig?: typeof DETECTOR_CONFIG[keyof typeof DETECTOR_CONFIG]
): SimpleArbitrageDetector {
  const config = detectorConfig || DETECTOR_CONFIG[chainId as keyof typeof DETECTOR_CONFIG] || DETECTOR_CONFIG.ethereum;

  return new SimpleArbitrageDetector({
    chainId,
    gasEstimate: config.gasEstimate,
    confidence: config.confidence,
    expiryMs: config.expiryMs,
  });
}
