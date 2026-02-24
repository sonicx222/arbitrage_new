/**
 * Regime Detector (Hurst Exponent)
 *
 * Classifies market regime using the Hurst exponent estimated via the
 * Rescaled Range (R/S) method.
 *
 * Hurst Exponent Interpretation:
 * - H < 0.4: Mean-reverting (anti-persistent) - favorable for stat arb
 * - 0.4 <= H <= 0.6: Random walk (no predictable pattern)
 * - H > 0.6: Trending (persistent) - not favorable for stat arb
 *
 * Rescaled Range Method (simplified):
 * 1. Take spread series of length N
 * 2. For subseries lengths n in [8, 16, 32, ...]:
 *    a. Split series into N/n subseries
 *    b. For each subseries: compute mean, cumulative deviations, range R, std dev S
 *    c. Average R/S across subseries
 * 3. H = slope of log(mean R/S) vs log(n) via linear regression
 *
 * @see shared/core/src/analytics/spread-tracker.ts - Provides spread input
 */

import { createLogger } from '../logger';

const logger = createLogger('regime-detector');

// =============================================================================
// Types
// =============================================================================

export type Regime = 'mean_reverting' | 'trending' | 'random_walk';

export interface RegimeConfig {
  /** Minimum number of samples before regime can be classified (default: 100) */
  windowSize: number;
  /** Hurst exponent below this = mean reverting (default: 0.4) */
  hurstThresholdLow: number;
  /** Hurst exponent above this = trending (default: 0.6) */
  hurstThresholdHigh: number;
  /** If true, isFavorable() returns true during warm-up (insufficient data).
   *  Useful to avoid dead time at startup. Default: false */
  favorableDuringWarmup: boolean;
}

/**
 * Internal state for a tracked pair's regime.
 */
interface RegimeState {
  /** Circular buffer of spread samples */
  samples: number[];
  /** Write index for circular buffer */
  writeIndex: number;
  /** Number of samples recorded (capped at windowSize) */
  sampleCount: number;
  /** Cached Hurst exponent (recomputed on each getRegime call) */
  cachedHurst: number | undefined;
  /** Whether cache is stale */
  dirty: boolean;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: RegimeConfig = {
  windowSize: 100,
  hurstThresholdLow: 0.4,
  hurstThresholdHigh: 0.6,
  favorableDuringWarmup: false,
};

/** Minimum subseries length for R/S calculation */
const MIN_SUBSERIES_LENGTH = 8;

// =============================================================================
// Regime Detector
// =============================================================================

/**
 * Classifies market regime using Hurst exponent via Rescaled Range analysis.
 */
export class RegimeDetector {
  private readonly config: RegimeConfig;
  private readonly pairs: Map<string, RegimeState> = new Map();

  constructor(config?: Partial<RegimeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('RegimeDetector initialized', {
      windowSize: this.config.windowSize,
      hurstThresholdLow: this.config.hurstThresholdLow,
      hurstThresholdHigh: this.config.hurstThresholdHigh,
    });
  }

  /**
   * Add a spread sample for regime analysis.
   *
   * @param pairId - Unique identifier for the pair
   * @param spread - The log-spread value to analyze
   */
  addSample(pairId: string, spread: number): void {
    let state = this.pairs.get(pairId);

    if (!state) {
      state = {
        samples: new Array<number>(this.config.windowSize).fill(0),
        writeIndex: 0,
        sampleCount: 0,
        cachedHurst: undefined,
        dirty: true,
      };
      this.pairs.set(pairId, state);
    }

    state.samples[state.writeIndex] = spread;
    state.writeIndex = (state.writeIndex + 1) % this.config.windowSize;
    state.sampleCount = Math.min(state.sampleCount + 1, this.config.windowSize);
    state.dirty = true;
  }

  /**
   * Get current regime classification for a pair.
   *
   * @returns Regime classification ('mean_reverting', 'trending', or 'random_walk')
   */
  getRegime(pairId: string): Regime {
    const hurst = this.getHurstExponent(pairId);

    if (hurst === undefined) {
      return 'random_walk'; // Default for insufficient data
    }

    if (hurst < this.config.hurstThresholdLow) {
      return 'mean_reverting';
    }
    if (hurst > this.config.hurstThresholdHigh) {
      return 'trending';
    }
    return 'random_walk';
  }

  /**
   * Get the raw Hurst exponent estimate for a pair.
   *
   * @returns Hurst exponent [0, 1] or undefined if insufficient data
   */
  getHurstExponent(pairId: string): number | undefined {
    const state = this.pairs.get(pairId);
    if (!state || state.sampleCount < MIN_SUBSERIES_LENGTH * 2) {
      return undefined;
    }

    // Return cached value if not dirty
    if (!state.dirty && state.cachedHurst !== undefined) {
      return state.cachedHurst;
    }

    const hurst = this.computeHurstFromBuffer(state);
    state.cachedHurst = hurst;
    state.dirty = false;
    return hurst;
  }

  /**
   * Check if stat arb is favorable (mean_reverting regime).
   *
   * @returns true only if the regime is 'mean_reverting'
   */
  isFavorable(pairId: string): boolean {
    // During warm-up, if configured, assume favorable to avoid dead time at startup
    if (this.config.favorableDuringWarmup) {
      const state = this.pairs.get(pairId);
      if (!state || state.sampleCount < MIN_SUBSERIES_LENGTH * 2) {
        return true;
      }
    }
    return this.getRegime(pairId) === 'mean_reverting';
  }

  /**
   * Reset all tracking data.
   */
  reset(): void {
    this.pairs.clear();
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================


  /**
   * Compute Hurst exponent directly from circular buffer state.
   * Avoids allocating arrays by indexing into the buffer directly.
   */
  private computeHurstFromBuffer(state: RegimeState): number | undefined {
    const N = state.sampleCount;
    if (N < MIN_SUBSERIES_LENGTH * 2) {
      return undefined;
    }

    // The chronological start index in the circular buffer
    const bufStart = N < this.config.windowSize ? 0 : state.writeIndex;
    const bufSize = this.config.windowSize;

    // Generate subseries lengths: 8, 16, 32, ... up to N/2
    const subserieLengths: number[] = [];
    let n = MIN_SUBSERIES_LENGTH;
    while (n <= Math.floor(N / 2)) {
      subserieLengths.push(n);
      n *= 2;
    }

    if (subserieLengths.length < 2) {
      return undefined;
    }

    const logN: number[] = [];
    const logRS: number[] = [];

    for (const subLen of subserieLengths) {
      const numSubseries = Math.floor(N / subLen);
      let totalRS = 0;
      let validCount = 0;

      for (let s = 0; s < numSubseries; s++) {
        const chronStart = s * subLen;
        const rs = this.computeRescaledRangeFromBuffer(
          state.samples, bufStart, bufSize, chronStart, subLen,
        );
        if (rs !== undefined && rs > 0) {
          totalRS += rs;
          validCount++;
        }
      }

      if (validCount > 0) {
        const meanRS = totalRS / validCount;
        logN.push(Math.log(subLen));
        logRS.push(Math.log(meanRS));
      }
    }

    if (logN.length < 2) {
      return undefined;
    }

    const slope = this.linearRegressionSlope(logN, logRS);
    return Math.max(0, Math.min(1, slope));
  }

  /**
   * Compute R/S (Rescaled Range) for a subseries, reading directly from
   * the circular buffer without allocating a sub-array.
   *
   * @param buf - The circular buffer
   * @param bufStart - Chronological start index in the buffer
   * @param bufSize - Buffer capacity (windowSize)
   * @param chronStart - Chronological offset of this subseries within the full series
   * @param subLen - Length of this subseries
   */
  private computeRescaledRangeFromBuffer(
    buf: number[], bufStart: number, bufSize: number,
    chronStart: number, subLen: number,
  ): number | undefined {
    if (subLen < 2) {
      return undefined;
    }

    // Compute mean
    let sum = 0;
    for (let i = 0; i < subLen; i++) {
      sum += buf[(bufStart + chronStart + i) % bufSize];
    }
    const mean = sum / subLen;

    // Standard deviation (population)
    let sumSqDiff = 0;
    for (let i = 0; i < subLen; i++) {
      const diff = buf[(bufStart + chronStart + i) % bufSize] - mean;
      sumSqDiff += diff * diff;
    }
    const stdDev = Math.sqrt(sumSqDiff / subLen);

    if (stdDev === 0) {
      return undefined;
    }

    // Cumulative deviation from mean
    let cumDev = 0;
    let maxCumDev = -Infinity;
    let minCumDev = Infinity;

    for (let i = 0; i < subLen; i++) {
      cumDev += buf[(bufStart + chronStart + i) % bufSize] - mean;
      if (cumDev > maxCumDev) maxCumDev = cumDev;
      if (cumDev < minCumDev) minCumDev = cumDev;
    }

    return (maxCumDev - minCumDev) / stdDev;
  }

  /**
   * Compute the slope of a simple linear regression (OLS).
   * slope = (n * Σxy - Σx * Σy) / (n * Σx² - (Σx)²)
   */
  private linearRegressionSlope(x: number[], y: number[]): number {
    const n = x.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;

    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) {
      return 0.5; // Default to random walk
    }

    return (n * sumXY - sumX * sumY) / denominator;
  }
}
