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

    const series = this.getSamplesInOrder(state);
    const hurst = this.computeHurstExponent(series);
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
   * Extract samples from circular buffer in chronological order.
   */
  private getSamplesInOrder(state: RegimeState): number[] {
    const result: number[] = [];
    const count = state.sampleCount;
    const startIndex = count < this.config.windowSize
      ? 0
      : state.writeIndex;

    for (let i = 0; i < count; i++) {
      const idx = (startIndex + i) % this.config.windowSize;
      result.push(state.samples[idx]);
    }

    return result;
  }

  /**
   * Compute Hurst exponent via Rescaled Range (R/S) method.
   *
   * For each subseries length n (powers of 2 from MIN_SUBSERIES_LENGTH up to N/2):
   * 1. Split series into floor(N/n) non-overlapping subseries
   * 2. For each subseries: compute R/S ratio
   * 3. Average R/S across all subseries for that n
   *
   * Then H = slope of log(mean R/S) vs log(n) via OLS linear regression.
   */
  private computeHurstExponent(series: number[]): number | undefined {
    const N = series.length;
    if (N < MIN_SUBSERIES_LENGTH * 2) {
      return undefined;
    }

    // Generate subseries lengths: 8, 16, 32, ... up to N/2
    const subserieLengths: number[] = [];
    let n = MIN_SUBSERIES_LENGTH;
    while (n <= Math.floor(N / 2)) {
      subserieLengths.push(n);
      n *= 2;
    }

    if (subserieLengths.length < 2) {
      // Need at least 2 points for linear regression
      return undefined;
    }

    const logN: number[] = [];
    const logRS: number[] = [];

    for (const subLen of subserieLengths) {
      const numSubseries = Math.floor(N / subLen);
      let totalRS = 0;
      let validCount = 0;

      for (let s = 0; s < numSubseries; s++) {
        const start = s * subLen;
        const sub = series.slice(start, start + subLen);

        const rs = this.computeRescaledRange(sub);
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

    // Linear regression: logRS = H * logN + c
    const slope = this.linearRegressionSlope(logN, logRS);

    // Clamp to [0, 1] range
    return Math.max(0, Math.min(1, slope));
  }

  /**
   * Compute R/S (Rescaled Range) for a subseries.
   *
   * 1. Compute mean of series
   * 2. Create cumulative deviations from mean
   * 3. R = max(cumulative) - min(cumulative)
   * 4. S = standard deviation of original series
   * 5. Return R/S
   */
  private computeRescaledRange(sub: number[]): number | undefined {
    const n = sub.length;
    if (n < 2) {
      return undefined;
    }

    // Mean
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += sub[i];
    }
    const mean = sum / n;

    // Standard deviation (population)
    let sumSqDiff = 0;
    for (let i = 0; i < n; i++) {
      const diff = sub[i] - mean;
      sumSqDiff += diff * diff;
    }
    const stdDev = Math.sqrt(sumSqDiff / n);

    if (stdDev === 0) {
      return undefined; // Constant series, can't compute R/S
    }

    // Cumulative deviation from mean
    let cumDev = 0;
    let maxCumDev = -Infinity;
    let minCumDev = Infinity;

    for (let i = 0; i < n; i++) {
      cumDev += sub[i] - mean;
      if (cumDev > maxCumDev) maxCumDev = cumDev;
      if (cumDev < minCumDev) minCumDev = cumDev;
    }

    const range = maxCumDev - minCumDev;

    return range / stdDev;
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
