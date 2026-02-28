/**
 * Simple Arbitrage Detector
 *
 * Detects simple two-pool arbitrage opportunities between DEXes.
 * Extracted from chain-instance.ts for single-responsibility principle.
 *
 * ## Hot-Path Performance
 *
 * This module is in the HOT PATH (called 100-1000 times/sec).
 * - ⚠️ No allocations in tight loops
 * - ⚠️ Uses pre-computed BigInt values from PairSnapshot
 * - ⚠️ Fee validation is trusted (done at source)
 *
 * ## Price Calculation Safety
 *
 * Uses configurable price bounds to prevent:
 * - Division by zero (price near 0)
 * - Overflow on inversion (1/price when price is tiny)
 * - Precision loss (price > 1e18)
 *
 * See FIX 4.1 in docs/reports/BUG_FIX_LOG_2026-02.md for details.
 *
 * ## Fee Representation
 *
 * Fees are in DECIMAL format (0.003 = 0.30%).
 * See types.ts for conversion functions if working with basis points.
 *
 * @module detection/simple-arbitrage-detector
 * @see R3 - Chain Instance Detection Strategies
 * @see docs/reports/BUG_FIX_LOG_2026-02.md - Fix 4.1
 * @see ADR-014 - Modular Detector Components
 */

import { calculatePriceFromBigIntReserves, isReverseOrderPreNormalized } from '@arbitrage/core/components';
import { MIN_SAFE_PRICE, MAX_SAFE_PRICE } from '@arbitrage/core/utils';

import { ARBITRAGE_CONFIG, DETECTOR_CONFIG } from '@arbitrage/config';
import type { ArbitrageOpportunity } from '@arbitrage/types';

// NOTE: Fee validation is done at source (pair creation) and SnapshotManager.
// This detector trusts pre-validated fee values for hot-path performance.

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

/** FIX 2.2: Rejection statistics for observability */
export interface RejectionStats {
  zeroReserves: number;
  nullPrice: number;
  priceBoundsP1: number;
  priceBoundsP2: number;
  belowProfitThreshold: number;
  unrealisticProfit: number;
  dustAmount: number;
  total: number;
}

/** Minimal logger interface for optional structured logging */
interface DetectorLogger {
  debug(msg: string, obj?: Record<string, unknown>): void;
  // FIX M9: info-level for periodic production visibility (5-min summary)
  info?(msg: string, obj?: Record<string, unknown>): void;
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
  /**
   * Minimum safe price for calculations (prevents division overflow).
   * Default: 1e-18 (supports tokens with up to 18 decimals at very low prices).
   *
   * FIX 4.1: Lowered from 1e-15 to 1e-18 to support low-value memecoins.
   * At 1e-18, the inverse (1/price) = 1e18 which is still safe for Number.
   */
  minSafePrice?: number;
  /**
   * Maximum safe price for calculations (prevents precision loss).
   * Default: 1e18 (inverse of minSafePrice for symmetry).
   */
  maxSafePrice?: number;
  /** FIX 2.2: Optional logger for rejection stats (backward compatible) */
  logger?: DetectorLogger;
}

/**
 * Simple Arbitrage Detector
 *
 * Calculates arbitrage opportunities between two pools trading the same token pair.
 */
export class SimpleArbitrageDetector {
  private readonly config: SimpleArbitrageConfig;
  private readonly minProfitThreshold: number;
  // FIX 4.1: Configurable price bounds for different token types
  private readonly minSafePrice: number;
  private readonly maxSafePrice: number;
  // FIX #32: Counter-based ID generation avoids 2 string allocations per opportunity
  private idCounter: number = 0;

  // FIX 2.2: Rejection counters for observability (near-zero cost increment)
  private readonly logger: DetectorLogger | null;
  private rejectionStats: RejectionStats = {
    zeroReserves: 0,
    nullPrice: 0,
    priceBoundsP1: 0,
    priceBoundsP2: 0,
    belowProfitThreshold: 0,
    unrealisticProfit: 0,
    dustAmount: 0,
    total: 0,
  };
  /** Timestamp of last stats log emission (throttled to every 60s) */
  private lastStatsLogTime = 0;

  constructor(config: SimpleArbitrageConfig) {
    this.config = config;
    this.logger = config.logger ?? null;
    // Use chain-specific minimum profit threshold
    const chainMinProfits = ARBITRAGE_CONFIG.chainMinProfits as Record<string, number>;
    this.minProfitThreshold = chainMinProfits[config.chainId] ?? 0.003; // Default 0.3%

    // FIX 4.1 + FIX 6: Use shared price bounds constants from @arbitrage/core
    // Ensures consistency with isValidPrice() and other validators
    this.minSafePrice = config.minSafePrice ?? MIN_SAFE_PRICE;
    this.maxSafePrice = config.maxSafePrice ?? MAX_SAFE_PRICE;
  }

  /**
   * Calculate arbitrage opportunity between two pairs.
   *
   * @note Gas cost filtering is intentionally NOT applied here. The detector's
   * responsibility is finding price discrepancies between DEXes. The execution
   * engine (`services/execution-engine`) applies chain-specific gas cost thresholds
   * before submitting transactions, using real-time gas price oracles. This separation
   * avoids coupling the detector to chain-specific gas pricing, which varies by L1/L2,
   * EIP-1559 vs legacy, and network congestion.
   *
   * @param pair1 - First pair snapshot
   * @param pair2 - Second pair snapshot
   * @returns ArbitrageOpportunity if profitable after swap fees, null otherwise
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
      this.rejectionStats.zeroReserves++;
      this.trackRejection();
      return null;
    }

    // P0-1 FIX: Use precision-safe price calculation
    const price1 = calculatePriceFromBigIntReserves(reserve1_0, reserve1_1);
    const price2Raw = calculatePriceFromBigIntReserves(reserve2_0, reserve2_1);

    if (price1 === null || price2Raw === null) {
      this.rejectionStats.nullPrice++;
      this.trackRejection();
      return null;
    }

    // FIX 4.1: Validate prices BEFORE any division using configurable bounds
    // This prevents division overflow and precision loss while supporting memecoins
    if (!Number.isFinite(price1) || price1 < this.minSafePrice || price1 > this.maxSafePrice) {
      this.rejectionStats.priceBoundsP1++;
      this.trackRejection();
      return null;
    }
    if (!Number.isFinite(price2Raw) || price2Raw < this.minSafePrice || price2Raw > this.maxSafePrice) {
      this.rejectionStats.priceBoundsP2++;
      this.trackRejection();
      return null;
    }

    // BUG FIX: Adjust price for reverse order pairs
    const isReversed = isReverseOrderPreNormalized(pair1.token0, pair2.token0);
    const price2 = isReversed ? 1 / price2Raw : price2Raw;

    const minPrice = Math.min(price1, price2);

    // Calculate price difference as a percentage of the lower price
    const priceDiff = Math.abs(price1 - price2) / minPrice;

    // Calculate fee-adjusted profit
    // NOTE: Fees are validated at source (pair creation) and again in SnapshotManager.
    // Direct use here avoids redundant validation in the hot path.
    const totalFees = pair1.fee + pair2.fee;
    const netProfitPct = priceDiff - totalFees;

    // Check if profitable after fees
    if (netProfitPct < this.minProfitThreshold) {
      this.rejectionStats.belowProfitThreshold++;
      this.trackRejection();
      return null;
    }

    // FIX #22c: Filter unrealistic profit percentages.
    // Real-world arbitrage is typically 0.01-5%. Values above 20% indicate
    // stale reserves or simulation drift. Lowered from 500% after terminal
    // analysis showed simulation generating 100-500% profits.
    if (netProfitPct > 0.20) {
      this.rejectionStats.unrealisticProfit++;
      this.trackRejection();
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
      this.rejectionStats.dustAmount++;
      this.trackRejection();
      return null;
    }

    // CRITICAL FIX: Calculate expectedProfit as ABSOLUTE value
    const expectedProfitAbsolute = Number(amountIn) * netProfitPct;

    // FIX W2-35: Cache Date.now() once — avoids 3 syscalls per opportunity and ensures
    // consistent timestamps across id, timestamp, and expiresAt fields
    const now = Date.now();

    const opportunity: ArbitrageOpportunity = {
      // FIX #32: Counter-based ID avoids Math.random().toString(36) string allocations in hot path
      id: `${this.config.chainId}-${now}-${++this.idCounter}`,
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
      timestamp: now,
      expiresAt: now + this.config.expiryMs,
      blockNumber: pair1.blockNumber,
      status: 'pending'
    };

    return opportunity;
  }

  /**
   * Get the minimum profit threshold for this detector.
   */
  getMinProfitThreshold(): number {
    return this.minProfitThreshold;
  }

  /**
   * FIX 2.2: Track rejection and emit throttled log.
   * Uses counter-modulo approach: only checks time every ~1000 rejections
   * to avoid Date.now() overhead on every call (hot path: 100-1000 calls/sec).
   */
  private trackRejection(): void {
    this.rejectionStats.total++;

    // Only consider logging every 1000 rejections to amortize Date.now() cost
    if (this.rejectionStats.total % 1000 === 0 && this.logger) {
      const now = Date.now();
      // FIX M9: Emit periodic info-level summary (every 5 min) for production visibility.
      // Debug-level stats fire every 60s for detailed monitoring.
      // At production LOG_LEVEL=info, operators need some visibility into why
      // the detector stopped finding opportunities (rejection patterns).
      if (now - this.lastStatsLogTime >= 300_000) {
        this.lastStatsLogTime = now;
        // FIX M9: Use info if available, fallback to debug for backwards compatibility
        const logFn = this.logger.info?.bind(this.logger) ?? this.logger.debug.bind(this.logger);
        logFn('Arbitrage rejection stats (5m summary)', {
          chainId: this.config.chainId,
          ...this.rejectionStats,
        });
      } else if (now - this.lastStatsLogTime >= 60_000) {
        this.lastStatsLogTime = now;
        this.logger.debug('Arbitrage rejection stats', {
          chainId: this.config.chainId,
          ...this.rejectionStats,
        });
      }
    }
  }

  /**
   * FIX 2.2: Get current rejection statistics for external consumers.
   * Returns a snapshot copy of the current counters.
   */
  getStats(): Readonly<RejectionStats> {
    return { ...this.rejectionStats };
  }

  /**
   * FIX 2.2: Reset rejection statistics (e.g., after periodic reporting).
   */
  resetStats(): void {
    this.rejectionStats = {
      zeroReserves: 0,
      nullPrice: 0,
      priceBoundsP1: 0,
      priceBoundsP2: 0,
      belowProfitThreshold: 0,
      unrealisticProfit: 0,
      dustAmount: 0,
      total: 0,
    };
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
