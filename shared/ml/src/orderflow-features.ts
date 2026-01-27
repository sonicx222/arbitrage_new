/**
 * T4.3.1: Orderflow Feature Engineering
 *
 * Extracts orderflow features for the Orderflow Predictor model.
 * Features include whale behavior, time patterns, pool dynamics, and liquidation signals.
 *
 * These features extend the existing ML infrastructure (LSTMPredictor, PatternRecognizer)
 * with orderflow-specific signals for improved prediction accuracy.
 *
 * Performance optimizations:
 * - Pre-allocated Float64Array for feature vectors (hot-path efficiency)
 * - Direct property assignment instead of object spreads
 * - WhaleActivityTracker cached via lazy initialization
 *
 * @see docs/reports/implementation_plan_v3.md - Phase 4, Task 4.3.1
 */

import { createLogger, getWhaleActivityTracker } from '@arbitrage/core';
import type { WhaleActivitySummary } from '@arbitrage/core';

const logger = createLogger('orderflow-features');

// =============================================================================
// Constants
// =============================================================================

/**
 * Number of features in the orderflow feature vector.
 * Used for pre-allocation and validation.
 */
export const ORDERFLOW_FEATURE_COUNT = 10;

/**
 * Maximum safe BigInt for Number conversion without precision loss.
 * Values above this threshold will log a warning.
 */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// =============================================================================
// Types
// =============================================================================

/**
 * Whale net direction based on buy/sell volume analysis
 */
export type WhaleNetDirection = 'accumulating' | 'distributing' | 'neutral';

/**
 * Orderflow features for ML model input.
 *
 * These features capture market microstructure signals that complement
 * price-based features in the existing LSTM predictor.
 */
export interface OrderflowFeatures {
  // Whale behavior
  /** Number of whale swaps in the past hour */
  whaleSwapCount1h: number;
  /** Net whale trading direction */
  whaleNetDirection: WhaleNetDirection;

  // Time patterns
  /** Hour of day (0-23 UTC) */
  hourOfDay: number;
  /** Day of week (0=Sunday, 1=Monday, ..., 6=Saturday) */
  dayOfWeek: number;
  /** Whether US stock market is open (9:30-16:00 ET) */
  isUsMarketOpen: boolean;
  /** Whether Asia (Tokyo) stock market is open (9:00-15:00 JST) */
  isAsiaMarketOpen: boolean;

  // Pool dynamics
  /** Reserve imbalance ratio: (r0 - r1) / (r0 + r1) */
  reserveImbalanceRatio: number;
  /** Sum of signed recent swap amounts (positive = net buying) */
  recentSwapMomentum: number;

  // Liquidation signals
  /** Distance to nearest liquidation level (0-1, where 1 = at current price) */
  nearestLiquidationLevel: number;
  /** 24h change in open interest (percentage) */
  openInterestChange24h: number;
}

/**
 * Normalized orderflow features (0-1 range for ML input)
 */
export interface NormalizedOrderflowFeatures {
  whaleSwapCount1h: number;
  whaleNetDirection: number; // -1 (distributing) to 1 (accumulating)
  hourOfDay: number;
  dayOfWeek: number;
  isUsMarketOpen: number;
  isAsiaMarketOpen: number;
  reserveImbalanceRatio: number;
  recentSwapMomentum: number;
  nearestLiquidationLevel: number;
  openInterestChange24h: number;
}

/**
 * Recent swap data for momentum calculation
 */
export interface RecentSwap {
  direction: 'buy' | 'sell';
  amountUsd: number;
  timestamp: number;
}

/**
 * Liquidation data from external sources (e.g., derivatives exchanges)
 */
export interface LiquidationData {
  /** Distance to nearest liquidation level (0-1) */
  nearestLiquidationLevel: number;
  /** 24h change in open interest (percentage, can be negative) */
  openInterestChange24h: number;
}

/**
 * Pool reserves for imbalance calculation
 */
export interface PoolReserves {
  reserve0: bigint;
  reserve1: bigint;
}

/**
 * Input for orderflow feature extraction
 */
export interface OrderflowFeatureInput {
  /** Trading pair key (e.g., "WETH-USDC") */
  pairKey: string;
  /** Chain identifier (e.g., "ethereum") */
  chain: string;
  /** Current timestamp (ms since epoch) */
  currentTimestamp: number;
  /** Pool reserves for imbalance calculation */
  poolReserves: PoolReserves;
  /** Recent swaps for momentum calculation */
  recentSwaps: RecentSwap[];
  /** Liquidation data (optional) */
  liquidationData?: LiquidationData;
}

/**
 * Configuration for OrderflowFeatureExtractor
 */
export interface OrderflowExtractorConfig {
  /** Window for whale activity (ms, default: 1 hour) */
  whaleActivityWindowMs?: number;
  /** Maximum whale count for normalization (default: 100) */
  maxWhaleCountForNorm?: number;
  /** Maximum momentum for normalization (default: $10M) */
  maxMomentumForNorm?: number;
  /** Whether to warn on BigInt precision loss (default: true) */
  warnOnPrecisionLoss?: boolean;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: Required<OrderflowExtractorConfig> = {
  whaleActivityWindowMs: 3600000, // 1 hour
  maxWhaleCountForNorm: 100,
  maxMomentumForNorm: 10000000, // $10M
  warnOnPrecisionLoss: true
};

// =============================================================================
// Market Hours Constants
// =============================================================================

/**
 * US market hours in UTC.
 * NYSE/NASDAQ: 9:30-16:00 ET
 * ET = UTC - 5 (EST) or UTC - 4 (EDT)
 * Using EST (winter time) for safety: 14:30-21:00 UTC
 */
const US_MARKET_OPEN_UTC = 14.5; // 14:30 UTC = 9:30 ET
const US_MARKET_CLOSE_UTC = 21; // 21:00 UTC = 16:00 ET

/**
 * Asia (Tokyo) market hours in UTC.
 * TSE: 9:00-15:00 JST
 * JST = UTC + 9
 * 9:00-15:00 JST = 00:00-06:00 UTC
 */
const ASIA_MARKET_OPEN_UTC = 0; // 00:00 UTC = 9:00 JST
const ASIA_MARKET_CLOSE_UTC = 6; // 06:00 UTC = 15:00 JST

// =============================================================================
// OrderflowFeatureExtractor Class
// =============================================================================

/**
 * T4.3.1: Orderflow Feature Extractor
 *
 * Extracts orderflow features from market data for use in ML prediction models.
 * Integrates with WhaleActivityTracker for whale behavior signals.
 *
 * Performance optimizations:
 * - WhaleActivityTracker is lazy-loaded to avoid circular dependency issues
 * - Pre-allocated Float64Array for feature vectors (10.3)
 * - Direct property assignment instead of object spreads (10.4)
 * - BigInt precision warnings for very large reserves (Bug 4.5)
 */
export class OrderflowFeatureExtractor {
  private readonly config: Required<OrderflowExtractorConfig>;
  private whaleTracker: ReturnType<typeof getWhaleActivityTracker> | null = null;

  // Pre-allocated feature buffer for hot-path efficiency (performance optimization 10.3)
  private readonly featureBuffer: Float64Array;
  private readonly normalizedBuffer: Float64Array;

  // Track if we've already warned about precision loss
  private precisionWarningLogged = false;

  constructor(config: OrderflowExtractorConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.featureBuffer = new Float64Array(ORDERFLOW_FEATURE_COUNT);
    this.normalizedBuffer = new Float64Array(ORDERFLOW_FEATURE_COUNT);

    logger.info('OrderflowFeatureExtractor initialized', {
      whaleActivityWindowMs: this.config.whaleActivityWindowMs,
      maxWhaleCountForNorm: this.config.maxWhaleCountForNorm
    });
  }

  /**
   * Get cached whale tracker instance.
   * Lazy initialization to avoid circular dependency issues at module load time.
   */
  private getWhaleTracker(): ReturnType<typeof getWhaleActivityTracker> {
    if (!this.whaleTracker) {
      this.whaleTracker = getWhaleActivityTracker();
    }
    return this.whaleTracker;
  }

  /**
   * Extract orderflow features from market data.
   *
   * This method is synchronous for hot-path performance. All sub-operations
   * are CPU-bound calculations with no I/O.
   *
   * @param input - Market data input
   * @returns Extracted orderflow features
   */
  extractFeatures(input: OrderflowFeatureInput): OrderflowFeatures {
    const { pairKey, chain, currentTimestamp, poolReserves, recentSwaps, liquidationData } = input;

    // Get whale activity from tracker
    const whaleSwapCount1h = this.extractWhaleCount(pairKey, chain);
    const whaleNetDirection = this.extractWhaleDirection(pairKey, chain);

    // Extract time patterns
    const date = new Date(currentTimestamp);
    const hourOfDay = date.getUTCHours();
    const dayOfWeek = date.getUTCDay();
    const hourWithMinutes = hourOfDay + date.getUTCMinutes() / 60;
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

    const isUsMarketOpen = isWeekday &&
      hourWithMinutes >= US_MARKET_OPEN_UTC &&
      hourWithMinutes < US_MARKET_CLOSE_UTC;

    const isAsiaMarketOpen = isWeekday &&
      hourWithMinutes >= ASIA_MARKET_OPEN_UTC &&
      hourWithMinutes < ASIA_MARKET_CLOSE_UTC;

    // Calculate pool dynamics with BigInt precision handling (Bug 4.5 fix)
    const reserveImbalanceRatio = this.calculateReserveImbalance(poolReserves);
    const recentSwapMomentum = this.calculateSwapMomentum(recentSwaps);

    // Get liquidation signals
    const nearestLiquidationLevel = liquidationData?.nearestLiquidationLevel ?? 0;
    const openInterestChange24h = liquidationData?.openInterestChange24h ?? 0;

    // Return directly constructed object (performance optimization 10.4)
    return {
      whaleSwapCount1h,
      whaleNetDirection,
      hourOfDay,
      dayOfWeek,
      isUsMarketOpen,
      isAsiaMarketOpen,
      reserveImbalanceRatio,
      recentSwapMomentum,
      nearestLiquidationLevel,
      openInterestChange24h
    };
  }

  /**
   * Convert features to a numeric array for ML model input.
   * Uses pre-allocated Float64Array for hot-path efficiency.
   *
   * @param features - Orderflow features object
   * @returns Numeric feature vector (10 elements)
   */
  toFeatureVector(features: OrderflowFeatures): Float64Array {
    this.featureBuffer[0] = features.whaleSwapCount1h;
    this.featureBuffer[1] = this.directionToNumeric(features.whaleNetDirection);
    this.featureBuffer[2] = features.hourOfDay;
    this.featureBuffer[3] = features.dayOfWeek;
    this.featureBuffer[4] = features.isUsMarketOpen ? 1 : 0;
    this.featureBuffer[5] = features.isAsiaMarketOpen ? 1 : 0;
    this.featureBuffer[6] = features.reserveImbalanceRatio;
    this.featureBuffer[7] = features.recentSwapMomentum;
    this.featureBuffer[8] = features.nearestLiquidationLevel;
    this.featureBuffer[9] = features.openInterestChange24h;

    return this.featureBuffer;
  }

  /**
   * Convert features to a plain number array (for compatibility).
   *
   * @param features - Orderflow features object
   * @returns Numeric feature vector as standard array
   */
  toFeatureArray(features: OrderflowFeatures): number[] {
    return Array.from(this.toFeatureVector(features));
  }

  /**
   * Normalize features to 0-1 range for ML input.
   * Uses pre-allocated buffer for efficiency.
   *
   * Note: Hour normalization uses /24 for mathematical consistency
   * with a 24-hour cycle (0-23 → 0-0.958).
   *
   * @param features - Raw orderflow features
   * @returns Normalized features
   */
  normalizeFeatures(features: OrderflowFeatures): NormalizedOrderflowFeatures {
    // Whale count normalized by max expected
    const whaleSwapCount1h = Math.min(features.whaleSwapCount1h / this.config.maxWhaleCountForNorm, 1);

    // Direction: -1 (distributing) to 1 (accumulating), then scaled to 0-1
    const whaleNetDirection = (this.directionToNumeric(features.whaleNetDirection) + 1) / 2;

    // Hour normalized to 0-1 using /24 for mathematical consistency
    // (Fix: previously used /23 which is inconsistent for a 24-hour cycle)
    const hourOfDay = features.hourOfDay / 24;

    // Day normalized to 0-1 (0-6 → 0-1)
    const dayOfWeek = features.dayOfWeek / 7;

    // Boolean to 0/1
    const isUsMarketOpen = features.isUsMarketOpen ? 1 : 0;
    const isAsiaMarketOpen = features.isAsiaMarketOpen ? 1 : 0;

    // Imbalance is already -1 to 1, normalize to 0-1
    const reserveImbalanceRatio = (features.reserveImbalanceRatio + 1) / 2;

    // Momentum normalized by max expected, clamped to -1 to 1, then to 0-1
    const normalizedMomentum = Math.max(-1, Math.min(1,
      features.recentSwapMomentum / this.config.maxMomentumForNorm
    ));
    const recentSwapMomentum = (normalizedMomentum + 1) / 2;

    // Liquidation level is already 0-1
    const nearestLiquidationLevel = Math.max(0, Math.min(1, features.nearestLiquidationLevel));

    // OI change: normalize 100% change to 1, clamped to 0-1
    const normalizedOI = Math.max(-1, Math.min(1, features.openInterestChange24h / 100));
    const openInterestChange24h = (normalizedOI + 1) / 2;

    return {
      whaleSwapCount1h,
      whaleNetDirection,
      hourOfDay,
      dayOfWeek,
      isUsMarketOpen,
      isAsiaMarketOpen,
      reserveImbalanceRatio,
      recentSwapMomentum,
      nearestLiquidationLevel,
      openInterestChange24h
    };
  }

  /**
   * Get normalized features as Float64Array for ML input.
   */
  normalizeToBuffer(features: OrderflowFeatures): Float64Array {
    const normalized = this.normalizeFeatures(features);
    this.normalizedBuffer[0] = normalized.whaleSwapCount1h;
    this.normalizedBuffer[1] = normalized.whaleNetDirection;
    this.normalizedBuffer[2] = normalized.hourOfDay;
    this.normalizedBuffer[3] = normalized.dayOfWeek;
    this.normalizedBuffer[4] = normalized.isUsMarketOpen;
    this.normalizedBuffer[5] = normalized.isAsiaMarketOpen;
    this.normalizedBuffer[6] = normalized.reserveImbalanceRatio;
    this.normalizedBuffer[7] = normalized.recentSwapMomentum;
    this.normalizedBuffer[8] = normalized.nearestLiquidationLevel;
    this.normalizedBuffer[9] = normalized.openInterestChange24h;
    return this.normalizedBuffer;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Required<OrderflowExtractorConfig> {
    return { ...this.config };
  }

  // ===========================================================================
  // Private Extraction Methods
  // ===========================================================================

  /**
   * Extract whale swap count from tracker.
   */
  private extractWhaleCount(pairKey: string, chain: string): number {
    try {
      const tracker = this.getWhaleTracker();
      const summary: WhaleActivitySummary = tracker.getActivitySummary(
        pairKey,
        chain,
        this.config.whaleActivityWindowMs
      );
      return summary.whaleCount;
    } catch (error) {
      logger.warn('Failed to extract whale count, using default', {
        pairKey,
        chain,
        error: error instanceof Error ? error.message : String(error)
      });
      return 0;
    }
  }

  /**
   * Extract whale net direction from tracker.
   */
  private extractWhaleDirection(pairKey: string, chain: string): WhaleNetDirection {
    try {
      const tracker = this.getWhaleTracker();
      const summary: WhaleActivitySummary = tracker.getActivitySummary(
        pairKey,
        chain,
        this.config.whaleActivityWindowMs
      );

      const totalVolume = summary.buyVolumeUsd + summary.sellVolumeUsd;
      if (totalVolume <= 0) return 'neutral';

      const buyRatio = summary.buyVolumeUsd / totalVolume;
      if (buyRatio > 0.6) return 'accumulating';
      if (buyRatio < 0.4) return 'distributing';
      return 'neutral';
    } catch (error) {
      logger.warn('Failed to extract whale direction, using neutral', {
        pairKey,
        chain,
        error: error instanceof Error ? error.message : String(error)
      });
      return 'neutral';
    }
  }

  /**
   * Calculate reserve imbalance ratio with BigInt precision handling.
   * Warns (once) if reserves exceed Number.MAX_SAFE_INTEGER.
   *
   * Bug 4.5 fix: Added precision loss warning for large reserves.
   */
  private calculateReserveImbalance(reserves: PoolReserves): number {
    // Check for precision loss (Bug 4.5 fix)
    if (this.config.warnOnPrecisionLoss && !this.precisionWarningLogged) {
      if (reserves.reserve0 > MAX_SAFE_BIGINT || reserves.reserve1 > MAX_SAFE_BIGINT) {
        logger.warn('Reserve values exceed Number.MAX_SAFE_INTEGER, precision may be lost', {
          reserve0: reserves.reserve0.toString(),
          reserve1: reserves.reserve1.toString(),
          maxSafe: Number.MAX_SAFE_INTEGER.toString()
        });
        this.precisionWarningLogged = true;
      }
    }

    // For extremely large reserves, use BigInt arithmetic
    const totalReserves = reserves.reserve0 + reserves.reserve1;
    if (totalReserves === 0n) return 0;

    // Use BigInt arithmetic for large values, then convert to Number at the end
    if (reserves.reserve0 > MAX_SAFE_BIGINT || reserves.reserve1 > MAX_SAFE_BIGINT) {
      // Scale down by common factor to preserve precision
      const scaleFactor = 1000000n; // 1M
      const r0Scaled = reserves.reserve0 / scaleFactor;
      const r1Scaled = reserves.reserve1 / scaleFactor;
      const totalScaled = r0Scaled + r1Scaled;

      if (totalScaled === 0n) return 0;
      return Number(r0Scaled - r1Scaled) / Number(totalScaled);
    }

    // Standard calculation for normal-sized reserves
    const r0 = Number(reserves.reserve0);
    const r1 = Number(reserves.reserve1);
    const total = r0 + r1;

    return total > 0 ? (r0 - r1) / total : 0;
  }

  /**
   * Calculate swap momentum from recent swaps.
   */
  private calculateSwapMomentum(recentSwaps: RecentSwap[]): number {
    let momentum = 0;
    for (let i = 0; i < recentSwaps.length; i++) {
      const swap = recentSwaps[i];
      momentum += swap.direction === 'buy' ? swap.amountUsd : -swap.amountUsd;
    }
    return momentum;
  }

  /**
   * Convert whale direction to numeric value.
   */
  private directionToNumeric(direction: WhaleNetDirection): number {
    switch (direction) {
      case 'accumulating':
        return 1;
      case 'distributing':
        return -1;
      case 'neutral':
      default:
        return 0;
    }
  }
}

// =============================================================================
// Singleton Factory
// =============================================================================

/**
 * Singleton Pattern Note:
 * This uses a configurable singleton pattern rather than `createSingleton` from async-singleton.ts
 * because it requires configuration parameters on first initialization. The standard createSingleton
 * pattern uses a fixed factory function which doesn't support runtime configuration.
 *
 * Thread safety: JavaScript is single-threaded for synchronous code, so this pattern
 * is safe. The check-and-set is atomic in the JS event loop.
 */
let extractorInstance: OrderflowFeatureExtractor | null = null;

/**
 * Get the singleton OrderflowFeatureExtractor instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton OrderflowFeatureExtractor instance
 */
export function getOrderflowFeatureExtractor(
  config?: OrderflowExtractorConfig
): OrderflowFeatureExtractor {
  if (!extractorInstance) {
    extractorInstance = new OrderflowFeatureExtractor(config);
  }
  return extractorInstance;
}

/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export function resetOrderflowFeatureExtractor(): void {
  extractorInstance = null;
}
