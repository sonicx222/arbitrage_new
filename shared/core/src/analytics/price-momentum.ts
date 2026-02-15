/**
 * T2.7: Price Momentum Detection
 *
 * Tracks price history and calculates momentum signals for arbitrage entry timing.
 * Implements circular buffer for memory efficiency and O(1) updates.
 *
 * Features:
 * - EMA (Exponential Moving Average) calculations: 5/15/60 periods
 * - Price velocity and acceleration detection
 * - Z-score deviation alerts for mean reversion
 * - Volume spike correlation
 * - Trend detection (bullish/bearish/neutral)
 *
 * @see docs/DETECTOR_OPTIMIZATION_ANALYSIS.md - Finding 1.4
 */

import { createLogger } from '../logger';
import { createConfigurableSingleton } from '../async/async-singleton';
import { findKSmallest } from '../data-structures/min-heap';

const logger = createLogger('price-momentum');

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for PriceMomentumTracker
 */
export interface MomentumConfig {
  /** Maximum samples to keep per pair (circular buffer size) */
  windowSize: number;
  /** Short-period EMA (e.g., 5 samples) */
  emaShortPeriod: number;
  /** Medium-period EMA (e.g., 15 samples) */
  emaMediumPeriod: number;
  /** Long-period EMA (e.g., 60 samples) */
  emaLongPeriod: number;
  /** Z-score threshold for mean reversion alerts */
  zScoreThreshold: number;
  /** Volume spike multiplier threshold (e.g., 2.5x average) */
  volumeSpikeThreshold: number;
  /** Maximum number of pairs to track (prevents unbounded memory growth) */
  maxPairs?: number;
}

/**
 * Price data point for tracking
 */
interface PricePoint {
  price: number;
  volume: number;
  timestamp: number;
}

/**
 * Internal state for a tracked pair
 */
interface PairState {
  prices: PricePoint[];
  writeIndex: number;
  sampleCount: number;
  emaShort: number;
  emaMedium: number;
  emaLong: number;
  volumeEma: number;
  /** Timestamp of last access for LRU eviction */
  lastAccessTime: number;
}

/**
 * Statistics for a tracked pair
 */
export interface PairStats {
  sampleCount: number;
  currentPrice: number;
  averagePrice: number;
  priceStdDev: number;
  emaShort: number;
  emaMedium: number;
  emaLong: number;
  averageVolume: number;
  minPrice: number;
  maxPrice: number;
}

/**
 * Momentum signal output
 */
export interface MomentumSignal {
  /** Pair identifier */
  pair: string;
  /** Current price */
  currentPrice: number;
  /** Price velocity (rate of change as decimal, e.g., 0.02 = 2%) */
  velocity: number;
  /** Price acceleration (change in velocity) */
  acceleration: number;
  /** Z-score deviation from mean */
  zScore: number;
  /** Whether mean reversion signal is triggered */
  meanReversionSignal: boolean;
  /** Whether volume spike is detected */
  volumeSpike: boolean;
  /** Volume ratio vs average (e.g., 3.0 = 3x average) */
  volumeRatio: number;
  /** Trend direction */
  trend: 'bullish' | 'bearish' | 'neutral';
  /** Signal confidence (0-1) */
  confidence: number;
  /** EMA values */
  emaShort: number;
  emaMedium: number;
  emaLong: number;
  /** Timestamp of signal generation */
  timestamp: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

// Maximum number of pairs to track to prevent unbounded memory growth
const DEFAULT_MAX_PAIRS = 1000;

const DEFAULT_CONFIG: MomentumConfig = {
  windowSize: 100,
  emaShortPeriod: 5,
  emaMediumPeriod: 15,
  emaLongPeriod: 60,
  zScoreThreshold: 2.0,
  volumeSpikeThreshold: 2.5,
  maxPairs: DEFAULT_MAX_PAIRS
};

// =============================================================================
// Price Momentum Tracker
// =============================================================================

/**
 * T2.7: Price Momentum Tracker
 *
 * Tracks price history for multiple pairs and calculates momentum signals
 * for improved arbitrage entry timing.
 */
export class PriceMomentumTracker {
  private config: MomentumConfig;
  private pairs: Map<string, PairState> = new Map();

  // EMA multipliers (pre-calculated for performance)
  private emaShortMultiplier: number;
  private emaMediumMultiplier: number;
  private emaLongMultiplier: number;
  private volumeEmaMultiplier: number;

  constructor(config: Partial<MomentumConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Pre-calculate EMA multipliers: k = 2 / (period + 1)
    this.emaShortMultiplier = 2 / (this.config.emaShortPeriod + 1);
    this.emaMediumMultiplier = 2 / (this.config.emaMediumPeriod + 1);
    this.emaLongMultiplier = 2 / (this.config.emaLongPeriod + 1);
    this.volumeEmaMultiplier = 2 / (this.config.emaMediumPeriod + 1);

    logger.info('PriceMomentumTracker initialized', {
      windowSize: this.config.windowSize,
      emaPeriods: [this.config.emaShortPeriod, this.config.emaMediumPeriod, this.config.emaLongPeriod]
    });
  }

  /**
   * Add a price update for a pair.
   * O(1) operation using circular buffer.
   */
  addPriceUpdate(pair: string, price: number, volume: number, timestamp?: number): void {
    const ts = timestamp ?? Date.now();

    let state = this.pairs.get(pair);
    if (!state) {
      // Check max pairs limit before adding new pair
      this.evictLRUPairsIfNeeded();

      // Initialize new pair state
      state = {
        prices: new Array(this.config.windowSize),
        writeIndex: 0,
        sampleCount: 0,
        emaShort: price,
        emaMedium: price,
        emaLong: price,
        volumeEma: volume,
        lastAccessTime: ts
      };
      this.pairs.set(pair, state);
    }

    // Update last access time
    state.lastAccessTime = ts;

    // Add to circular buffer
    state.prices[state.writeIndex] = { price, volume, timestamp: ts };
    state.writeIndex = (state.writeIndex + 1) % this.config.windowSize;
    state.sampleCount = Math.min(state.sampleCount + 1, this.config.windowSize);

    // Update EMAs
    state.emaShort = this.updateEma(state.emaShort, price, this.emaShortMultiplier);
    state.emaMedium = this.updateEma(state.emaMedium, price, this.emaMediumMultiplier);
    state.emaLong = this.updateEma(state.emaLong, price, this.emaLongMultiplier);
    state.volumeEma = this.updateEma(state.volumeEma, volume, this.volumeEmaMultiplier);
  }

  /**
   * Get current statistics for a pair.
   */
  getStats(pair: string): PairStats | null {
    const state = this.pairs.get(pair);
    if (!state || state.sampleCount === 0) {
      return null;
    }

    const prices = this.getPrices(state);
    const volumes = this.getVolumes(state);

    const currentPrice = prices[prices.length - 1];
    const averagePrice = this.calculateMean(prices);
    const priceStdDev = this.calculateStdDev(prices, averagePrice);
    const averageVolume = this.calculateMean(volumes);

    return {
      sampleCount: state.sampleCount,
      currentPrice,
      averagePrice,
      priceStdDev,
      emaShort: state.emaShort,
      emaMedium: state.emaMedium,
      emaLong: state.emaLong,
      averageVolume,
      minPrice: prices.reduce((a, b) => a < b ? a : b, prices[0]),
      maxPrice: prices.reduce((a, b) => a > b ? a : b, prices[0])
    };
  }

  /**
   * Calculate momentum signal for a pair.
   * Returns null if insufficient data.
   */
  getMomentumSignal(pair: string): MomentumSignal | null {
    const state = this.pairs.get(pair);
    if (!state || state.sampleCount < 2) {
      return null;
    }

    const prices = this.getPrices(state);
    const volumes = this.getVolumes(state);
    const currentPrice = prices[prices.length - 1];
    const previousPrice = prices[prices.length - 2];
    const currentVolume = volumes[volumes.length - 1];

    // Calculate velocity (rate of change) - guard against division by zero
    const velocity = previousPrice !== 0
      ? (currentPrice - previousPrice) / previousPrice
      : 0;

    // Calculate acceleration (change in velocity) - guard against division by zero
    let acceleration = 0;
    if (prices.length >= 3) {
      const thirdLastPrice = prices[prices.length - 3];
      const prevVelocity = thirdLastPrice !== 0
        ? (previousPrice - thirdLastPrice) / thirdLastPrice
        : 0;
      acceleration = velocity - prevVelocity;
    }

    // Calculate z-score for mean reversion
    const mean = this.calculateMean(prices);
    const stdDev = this.calculateStdDev(prices, mean);
    const zScore = stdDev > 0 ? (currentPrice - mean) / stdDev : 0;

    // Mean reversion signal
    const meanReversionSignal = Math.abs(zScore) > this.config.zScoreThreshold;

    // Volume analysis - calculate historical average (excluding current) for spike detection
    // This prevents the spike from inflating the average before comparison
    const historicalVolumes = volumes.slice(0, -1);
    const historicalAvgVolume = historicalVolumes.length > 0
      ? this.calculateMean(historicalVolumes)
      : state.volumeEma;
    const volumeRatio = historicalAvgVolume > 0 ? currentVolume / historicalAvgVolume : 0;
    const volumeSpike = volumeRatio > this.config.volumeSpikeThreshold;

    // Trend detection
    const trend = this.detectTrend(currentPrice, state);

    // Calculate confidence
    const confidence = this.calculateConfidence(
      prices,
      velocity,
      zScore,
      volumeRatio,
      trend,
      state.sampleCount
    );

    return {
      pair,
      currentPrice,
      velocity,
      acceleration,
      zScore,
      meanReversionSignal,
      volumeSpike,
      volumeRatio,
      trend,
      confidence,
      emaShort: state.emaShort,
      emaMedium: state.emaMedium,
      emaLong: state.emaLong,
      timestamp: Date.now()
    };
  }

  /**
   * Reset data for a specific pair.
   */
  resetPair(pair: string): void {
    this.pairs.delete(pair);
  }

  /**
   * Reset all tracked pairs.
   */
  resetAll(): void {
    this.pairs.clear();
  }

  /**
   * Get all tracked pairs.
   */
  getTrackedPairs(): string[] {
    return Array.from(this.pairs.keys());
  }

  /**
   * Get number of currently tracked pairs.
   */
  getTrackedPairsCount(): number {
    return this.pairs.size;
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Evict least recently used pairs if we're at the max pairs limit.
   * Removes the oldest 10% of pairs to make room for new ones.
   */
  private evictLRUPairsIfNeeded(): void {
    const maxPairs = this.config.maxPairs ?? DEFAULT_MAX_PAIRS;
    if (maxPairs <= 0 || this.pairs.size < maxPairs) {
      return;
    }

    // Find and remove the oldest 10% of pairs (at least 1)
    // Uses O(N*k) partial selection instead of O(N log N) full sort
    const toRemove = Math.max(1, Math.floor(maxPairs * 0.1));
    const oldestEntries = findKSmallest(
      this.pairs.entries(),
      toRemove,
      ([, a], [, b]) => a.lastAccessTime - b.lastAccessTime
    );
    const oldest = oldestEntries.map(([key]) => key);

    for (const key of oldest) {
      this.pairs.delete(key);
    }

    logger.debug('Evicted LRU pairs due to max limit', {
      evicted: toRemove,
      remaining: this.pairs.size,
      maxPairs
    });
  }

  /**
   * Update EMA with new value.
   * EMA = (price * k) + (prevEMA * (1 - k))
   */
  private updateEma(prevEma: number, newValue: number, multiplier: number): number {
    return (newValue * multiplier) + (prevEma * (1 - multiplier));
  }

  /**
   * Extract prices from circular buffer in chronological order.
   */
  private getPrices(state: PairState): number[] {
    const prices: number[] = [];
    const count = state.sampleCount;
    const startIndex = count < this.config.windowSize
      ? 0
      : state.writeIndex;

    for (let i = 0; i < count; i++) {
      const idx = (startIndex + i) % this.config.windowSize;
      if (state.prices[idx]) {
        prices.push(state.prices[idx].price);
      }
    }

    return prices;
  }

  /**
   * Extract volumes from circular buffer in chronological order.
   */
  private getVolumes(state: PairState): number[] {
    const volumes: number[] = [];
    const count = state.sampleCount;
    const startIndex = count < this.config.windowSize
      ? 0
      : state.writeIndex;

    for (let i = 0; i < count; i++) {
      const idx = (startIndex + i) % this.config.windowSize;
      if (state.prices[idx]) {
        volumes.push(state.prices[idx].volume);
      }
    }

    return volumes;
  }

  /**
   * Calculate mean of an array.
   */
  private calculateMean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /**
   * Calculate sample standard deviation (Bessel's correction: N-1).
   */
  private calculateStdDev(values: number[], mean?: number): number {
    if (values.length < 2) return 0;
    const avg = mean ?? this.calculateMean(values);
    const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
    const variance = squaredDiffs.reduce((sum, v) => sum + v, 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  /**
   * Detect trend based on price vs EMAs.
   */
  private detectTrend(
    currentPrice: number,
    state: PairState
  ): 'bullish' | 'bearish' | 'neutral' {
    const aboveShort = currentPrice > state.emaShort;
    const aboveMedium = currentPrice > state.emaMedium;
    const aboveLong = currentPrice > state.emaLong;

    // Strong bullish: price above all EMAs
    if (aboveShort && aboveMedium && aboveLong) {
      return 'bullish';
    }

    // Strong bearish: price below all EMAs
    if (!aboveShort && !aboveMedium && !aboveLong) {
      return 'bearish';
    }

    // Mixed signals = neutral
    return 'neutral';
  }

  /**
   * Calculate signal confidence based on multiple factors.
   */
  private calculateConfidence(
    prices: number[],
    velocity: number,
    zScore: number,
    volumeRatio: number,
    trend: 'bullish' | 'bearish' | 'neutral',
    sampleCount: number
  ): number {
    let confidence = 0.5; // Base confidence

    // More samples = higher confidence (max +0.2)
    const sampleFactor = Math.min(sampleCount / this.config.windowSize, 1) * 0.2;
    confidence += sampleFactor;

    // Strong trend = higher confidence (+0.15)
    if (trend !== 'neutral') {
      confidence += 0.15;
    }

    // Volume confirmation = higher confidence (+0.1)
    if (volumeRatio > 1.5) {
      confidence += 0.1;
    }

    // Calculate trend consistency (lower variance = more consistent)
    if (prices.length >= 5) {
      const recentPrices = prices.slice(-5);
      const changes: number[] = [];
      for (let i = 1; i < recentPrices.length; i++) {
        // Guard against division by zero
        const prevPrice = recentPrices[i - 1];
        const change = prevPrice !== 0
          ? (recentPrices[i] - prevPrice) / prevPrice
          : 0;
        changes.push(change);
      }

      // Check if all non-zero changes are in same direction (treat 0 as neutral)
      const nonZeroChanges = changes.filter(c => c !== 0);
      const allPositive = nonZeroChanges.length > 0 && nonZeroChanges.every(c => c > 0);
      const allNegative = nonZeroChanges.length > 0 && nonZeroChanges.every(c => c < 0);
      const allStable = nonZeroChanges.length === 0; // All prices identical

      if (allPositive || allNegative || allStable) {
        confidence += 0.15; // Consistent direction or stable prices
      } else {
        // Choppy action (actual reversals) reduces confidence significantly
        // Base penalty for non-consistent direction
        confidence -= 0.15;
        // Count actual sign reversals (exclude transitions to/from zero)
        const signChanges = changes.filter((c, i) =>
          i > 0 &&
          c !== 0 && changes[i - 1] !== 0 &&
          Math.sign(c) !== Math.sign(changes[i - 1])
        ).length;
        confidence -= signChanges * 0.05;
      }
    }

    // Extreme z-score = higher confidence for mean reversion
    if (Math.abs(zScore) > 2) {
      confidence += 0.1;
    }

    // Insufficient data penalty
    if (sampleCount < 5) {
      confidence *= 0.5;
    }

    return Math.max(0, Math.min(1, confidence));
  }
}

// =============================================================================
// Singleton Factory (P1-FIX: Using createConfigurableSingleton)
// =============================================================================

/**
 * P1-FIX: Migrated to createConfigurableSingleton for standardized singleton pattern.
 * This utility handles configurable singletons - configuration is only applied on first call.
 */
const priceMomentumSingleton = createConfigurableSingleton<PriceMomentumTracker, Partial<MomentumConfig>>(
  (config) => new PriceMomentumTracker(config),
  (instance) => instance.resetAll(),
  'price-momentum-tracker'
);

/**
 * Get the singleton PriceMomentumTracker instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton PriceMomentumTracker instance
 */
export const getPriceMomentumTracker = priceMomentumSingleton.get;

/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export const resetPriceMomentumTracker = priceMomentumSingleton.reset;
