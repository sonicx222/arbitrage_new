/**
 * Pair Correlation Tracker
 *
 * Calculates rolling Pearson correlation between two price series using
 * circular buffers and running sums for O(1) updates.
 *
 * Features:
 * - Rolling Pearson correlation coefficient [-1, 1]
 * - Circular buffer pattern (same as PriceMomentumTracker)
 * - Running sums for efficient incremental updates
 * - LRU eviction when maxPairs is exceeded
 * - Configurable correlation threshold for eligibility
 *
 * @see shared/core/src/analytics/price-momentum.ts - Circular buffer pattern reference
 */

import { createLogger } from '../logger';
import { findKSmallest } from '../data-structures/min-heap';

const logger = createLogger('pair-correlation-tracker');

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for PairCorrelationTracker
 */
export interface CorrelationConfig {
  /** Number of samples in the rolling window (default: 60) */
  windowSize: number;
  /** Minimum |correlation| to be considered eligible (default: 0.7) */
  minCorrelation: number;
  /** Maximum number of pairs to track (default: 50) */
  maxPairs: number;
}

/**
 * Internal state for a tracked pair.
 * Uses running sums for O(1) correlation updates.
 */
interface PairCorrelationState {
  /** Circular buffer for price A samples */
  pricesA: number[];
  /** Circular buffer for price B samples */
  pricesB: number[];
  /** Write index into circular buffers */
  writeIndex: number;
  /** Number of samples recorded (capped at windowSize) */
  sampleCount: number;
  /** Running sum: Σx (price A) */
  sumX: number;
  /** Running sum: Σy (price B) */
  sumY: number;
  /** Running sum: Σx² */
  sumX2: number;
  /** Running sum: Σy² */
  sumY2: number;
  /** Running sum: Σxy */
  sumXY: number;
  /** Last access timestamp for LRU eviction */
  lastAccessTime: number;
  /** Counter for periodic recomputation to combat FP drift */
  updatesSinceRecompute: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: CorrelationConfig = {
  windowSize: 60,
  minCorrelation: 0.7,
  maxPairs: 50,
};

/** Recompute running sums from scratch every N updates to combat FP drift */
const RECOMPUTE_INTERVAL = 500;

// =============================================================================
// Pair Correlation Tracker
// =============================================================================

/**
 * Tracks rolling Pearson correlation between paired price series.
 *
 * Uses circular buffers with running sums for O(1) sample updates.
 * When the window is full, the oldest sample is subtracted from running
 * sums before adding the new one.
 */
export class PairCorrelationTracker {
  private readonly config: CorrelationConfig;
  private readonly pairs: Map<string, PairCorrelationState> = new Map();

  constructor(config?: Partial<CorrelationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('PairCorrelationTracker initialized', {
      windowSize: this.config.windowSize,
      minCorrelation: this.config.minCorrelation,
      maxPairs: this.config.maxPairs,
    });
  }

  /**
   * Add a paired price sample for a pair.
   *
   * @param pairId - Unique identifier for the price pair
   * @param priceA - Price of asset A
   * @param priceB - Price of asset B
   * @param timestamp - Sample timestamp (used for LRU tracking)
   */
  addSample(pairId: string, priceA: number, priceB: number, timestamp: number): void {
    let state = this.pairs.get(pairId);

    if (!state) {
      this.evictLRUPairsIfNeeded();

      // Initialize new pair state with pre-allocated circular buffers
      // Uses inline circular buffer per ADR-022 (hot-path performance).
      state = {
        pricesA: new Array<number>(this.config.windowSize).fill(0),
        pricesB: new Array<number>(this.config.windowSize).fill(0),
        writeIndex: 0,
        sampleCount: 0,
        sumX: 0,
        sumY: 0,
        sumX2: 0,
        sumY2: 0,
        sumXY: 0,
        lastAccessTime: timestamp,
        updatesSinceRecompute: 0,
      };
      this.pairs.set(pairId, state);
    }

    state.lastAccessTime = timestamp;

    // If buffer is full, subtract the oldest sample from running sums
    if (state.sampleCount >= this.config.windowSize) {
      const oldA = state.pricesA[state.writeIndex];
      const oldB = state.pricesB[state.writeIndex];
      state.sumX -= oldA;
      state.sumY -= oldB;
      state.sumX2 -= oldA * oldA;
      state.sumY2 -= oldB * oldB;
      state.sumXY -= oldA * oldB;
    }

    // Write new sample to circular buffer
    state.pricesA[state.writeIndex] = priceA;
    state.pricesB[state.writeIndex] = priceB;

    // Update running sums
    state.sumX += priceA;
    state.sumY += priceB;
    state.sumX2 += priceA * priceA;
    state.sumY2 += priceB * priceB;
    state.sumXY += priceA * priceB;

    // Advance write index (circular)
    state.writeIndex = (state.writeIndex + 1) % this.config.windowSize;
    state.sampleCount = Math.min(state.sampleCount + 1, this.config.windowSize);

    // Periodic recomputation to combat floating-point accumulation drift
    state.updatesSinceRecompute++;
    if (state.updatesSinceRecompute >= RECOMPUTE_INTERVAL) {
      this.recomputeRunningTotals(state);
    }
  }

  /**
   * Get Pearson correlation coefficient for a pair.
   *
   * Formula: r = (n * Σxy - Σx * Σy) / sqrt((n * Σx² - (Σx)²) * (n * Σy² - (Σy)²))
   *
   * @returns Correlation coefficient [-1, 1] or undefined if insufficient data (< 3 samples)
   */
  getCorrelation(pairId: string): number | undefined {
    const state = this.pairs.get(pairId);
    if (!state || state.sampleCount < 3) {
      return undefined;
    }

    const n = state.sampleCount;
    const numerator = n * state.sumXY - state.sumX * state.sumY;
    const denomA = n * state.sumX2 - state.sumX * state.sumX;
    const denomB = n * state.sumY2 - state.sumY * state.sumY;

    // Guard: zero variance in either series means correlation is undefined
    if (denomA <= 0 || denomB <= 0) {
      return 0;
    }

    const denominator = Math.sqrt(denomA * denomB);
    if (denominator === 0) {
      return 0;
    }

    // Clamp to [-1, 1] to handle floating-point drift
    return Math.max(-1, Math.min(1, numerator / denominator));
  }

  /**
   * Check if a pair meets the correlation threshold.
   *
   * @returns true if |correlation| >= minCorrelation
   */
  isEligible(pairId: string): boolean {
    const corr = this.getCorrelation(pairId);
    if (corr === undefined) {
      return false;
    }
    return Math.abs(corr) >= this.config.minCorrelation;
  }

  /**
   * Get all pairs meeting the correlation threshold.
   *
   * @returns Array of pair IDs where |correlation| >= minCorrelation
   */
  getEligiblePairs(): string[] {
    const eligible: string[] = [];
    for (const pairId of this.pairs.keys()) {
      if (this.isEligible(pairId)) {
        eligible.push(pairId);
      }
    }
    return eligible;
  }

  /**
   * Get sample count for a pair.
   */
  getSampleCount(pairId: string): number {
    const state = this.pairs.get(pairId);
    return state?.sampleCount ?? 0;
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
   * Recompute running sums from scratch to eliminate floating-point drift.
   * Called periodically (every RECOMPUTE_INTERVAL updates).
   */
  private recomputeRunningTotals(state: PairCorrelationState): void {
    const n = state.sampleCount;
    let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, sumXY = 0;
    const startIdx = n < this.config.windowSize ? 0 : state.writeIndex;

    for (let i = 0; i < n; i++) {
      const idx = (startIdx + i) % this.config.windowSize;
      const a = state.pricesA[idx];
      const b = state.pricesB[idx];
      sumX += a;
      sumY += b;
      sumX2 += a * a;
      sumY2 += b * b;
      sumXY += a * b;
    }

    state.sumX = sumX;
    state.sumY = sumY;
    state.sumX2 = sumX2;
    state.sumY2 = sumY2;
    state.sumXY = sumXY;
    state.updatesSinceRecompute = 0;
  }

  /**
   * Evict least recently used pairs if at max capacity.
   * Removes the single oldest pair to make room for new ones.
   */
  private evictLRUPairsIfNeeded(): void {
    if (this.pairs.size < this.config.maxPairs) {
      return;
    }

    // Find and remove the oldest pair
    const toRemove = Math.max(1, Math.floor(this.config.maxPairs * 0.1));
    const oldestEntries = findKSmallest(
      this.pairs.entries(),
      toRemove,
      ([, a], [, b]) => a.lastAccessTime - b.lastAccessTime,
    );
    const oldest = oldestEntries.map(([key]) => key);

    for (const key of oldest) {
      this.pairs.delete(key);
    }

    logger.debug('Evicted LRU correlation pairs', {
      evicted: oldest.length,
      remaining: this.pairs.size,
      maxPairs: this.config.maxPairs,
    });
  }
}
