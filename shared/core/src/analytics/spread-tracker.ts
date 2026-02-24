/**
 * Spread Tracker with Bollinger Bands
 *
 * Tracks the log-spread between paired assets and generates Bollinger Band
 * signals for statistical arbitrage entry/exit timing.
 *
 * The spread is defined as: spread = log(priceA / priceB)
 *
 * When the spread deviates significantly from its mean (outside Bollinger Bands),
 * it signals a potential mean-reversion opportunity.
 *
 * Signal logic:
 * - entry_long: spread < lower band (A is cheap relative to B, buy A sell B)
 * - entry_short: spread > upper band (A is expensive relative to B, sell A buy B)
 * - exit: spread crossed back through middle band (mean reversion complete)
 * - none: spread is within bands, no actionable signal
 *
 * @see shared/core/src/analytics/pair-correlation-tracker.ts - Used together for stat arb
 */

import { createLogger } from '../logger';

const logger = createLogger('spread-tracker');

// =============================================================================
// Types
// =============================================================================

export type SpreadSignal = 'entry_long' | 'entry_short' | 'exit' | 'none';

export interface SpreadConfig {
  /** Bollinger Band SMA period (default: 20) */
  bollingerPeriod: number;
  /** Bollinger Band standard deviation multiplier (default: 2.0) */
  bollingerStdDev: number;
  /** Maximum number of pairs to track (default: 50) */
  maxPairs: number;
}

export interface BollingerBands {
  /** Upper band: middle + stdDev * multiplier */
  upper: number;
  /** Middle band: SMA of spread */
  middle: number;
  /** Lower band: middle - stdDev * multiplier */
  lower: number;
  /** Current spread value */
  currentSpread: number;
}

/**
 * Internal state for a tracked spread pair.
 * Uses a circular buffer for the spread history.
 */
interface SpreadState {
  /** Circular buffer of log-spread values */
  spreads: number[];
  /** Write index into circular buffer */
  writeIndex: number;
  /** Number of samples recorded (capped at bollingerPeriod) */
  sampleCount: number;
  /** Previous signal for exit detection */
  previousSignal: SpreadSignal;
  /** Whether we're currently in a position (had an entry signal) */
  inPosition: boolean;
  /** Cached Bollinger Bands (invalidated on each addSpread) */
  cachedBands: BollingerBands | undefined;
  /** Last access timestamp for LRU eviction */
  lastAccessTime: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: SpreadConfig = {
  bollingerPeriod: 20,
  bollingerStdDev: 2.0,
  maxPairs: 50,
};

// =============================================================================
// Spread Tracker
// =============================================================================

/**
 * Tracks log-spread between paired assets with Bollinger Band signal generation.
 */
export class SpreadTracker {
  private readonly config: SpreadConfig;
  private readonly pairs: Map<string, SpreadState> = new Map();

  constructor(config?: Partial<SpreadConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.info('SpreadTracker initialized', {
      bollingerPeriod: this.config.bollingerPeriod,
      bollingerStdDev: this.config.bollingerStdDev,
      maxPairs: this.config.maxPairs,
    });
  }

  /**
   * Add a new spread observation computed from two prices.
   * Spread = log(priceA / priceB)
   *
   * @param pairId - Unique identifier for the price pair
   * @param priceA - Price of asset A (must be > 0)
   * @param priceB - Price of asset B (must be > 0)
   */
  addSpread(pairId: string, priceA: number, priceB: number): void {
    if (priceA <= 0 || priceB <= 0) {
      logger.warn('Invalid prices for spread calculation', { pairId, priceA, priceB });
      return;
    }

    const spread = Math.log(priceA / priceB);

    let state = this.pairs.get(pairId);
    if (!state) {
      if (this.pairs.size >= this.config.maxPairs) {
        // LRU eviction: remove the least-recently-used pair
        this.evictLRUPair();
      }

      state = {
        spreads: new Array<number>(this.config.bollingerPeriod).fill(0),
        writeIndex: 0,
        sampleCount: 0,
        previousSignal: 'none',
        inPosition: false,
        cachedBands: undefined,
        lastAccessTime: Date.now(),
      };
      this.pairs.set(pairId, state);
    }

    state.lastAccessTime = Date.now();

    // Write to circular buffer
    state.spreads[state.writeIndex] = spread;
    state.writeIndex = (state.writeIndex + 1) % this.config.bollingerPeriod;
    state.sampleCount = Math.min(state.sampleCount + 1, this.config.bollingerPeriod);

    // Compute and cache Bollinger Bands (avoids recomputing in getSignal)
    state.cachedBands = this.computeBollingerBands(state);

    // Update position tracking based on new signal
    if (state.cachedBands) {
      if (spread < state.cachedBands.lower || spread > state.cachedBands.upper) {
        state.inPosition = true;
      }
      // Check for exit: spread crossed back through middle
      if (state.inPosition) {
        const prevSpread = this.getPreviousSpread(state);
        if (prevSpread !== undefined) {
          const crossedMiddle =
            (prevSpread < state.cachedBands.middle && spread >= state.cachedBands.middle) ||
            (prevSpread > state.cachedBands.middle && spread <= state.cachedBands.middle);
          if (crossedMiddle) {
            state.inPosition = false;
          }
        }
      }
    }
  }

  /**
   * Get current trading signal for a pair.
   *
   * @returns The current signal based on spread position relative to Bollinger Bands
   */
  getSignal(pairId: string): SpreadSignal {
    const state = this.pairs.get(pairId);
    if (!state || state.sampleCount < this.config.bollingerPeriod) {
      return 'none';
    }

    // Use cached bands from addSpread() — avoids recomputing
    const bands = state.cachedBands;
    if (!bands) {
      return 'none';
    }

    const currentSpread = bands.currentSpread;

    // Entry signals
    if (currentSpread < bands.lower) {
      return 'entry_long';
    }
    if (currentSpread > bands.upper) {
      return 'entry_short';
    }

    // Exit signal: position was closed via middle-band crossing in addSpread().
    // inPosition transitions from true→false only when spread crosses middle,
    // so check if that transition just happened (previous spread was outside bands).
    if (!state.inPosition) {
      const prevSpread = this.getPreviousSpread(state);
      if (prevSpread !== undefined) {
        const prevWasOutside = prevSpread < bands.lower || prevSpread > bands.upper;
        if (prevWasOutside) {
          return 'exit';
        }
      }
    }

    return 'none';
  }

  /**
   * Get Bollinger Bands for a pair.
   *
   * @returns BollingerBands or undefined if insufficient data
   */
  getBollingerBands(pairId: string): BollingerBands | undefined {
    const state = this.pairs.get(pairId);
    if (!state || state.sampleCount < this.config.bollingerPeriod) {
      return undefined;
    }

    // Return cached bands from addSpread() — avoids recomputing
    return state.cachedBands;
  }

  /**
   * Get raw spread history for a pair in chronological order.
   */
  getSpreadHistory(pairId: string): number[] {
    const state = this.pairs.get(pairId);
    if (!state) {
      return [];
    }

    return this.getSpreadsInOrder(state);
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
   * Evict the least-recently-used pair to make room for new entries.
   */
  private evictLRUPair(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, state] of this.pairs) {
      if (state.lastAccessTime < oldestTime) {
        oldestTime = state.lastAccessTime;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      this.pairs.delete(oldestKey);
    }
  }

  /**
   * Compute Bollinger Bands from the spread state.
   */
  private computeBollingerBands(state: SpreadState): BollingerBands | undefined {
    if (state.sampleCount < 2) {
      return undefined;
    }

    // Compute SMA and stddev directly from circular buffer — avoids array allocation.
    const n = state.sampleCount;
    const startIndex = n < this.config.bollingerPeriod ? 0 : state.writeIndex;
    const period = this.config.bollingerPeriod;

    // SMA (middle band)
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += state.spreads[(startIndex + i) % period];
    }
    const middle = sum / n;

    // Standard deviation
    let sumSqDiff = 0;
    for (let i = 0; i < n; i++) {
      const diff = state.spreads[(startIndex + i) % period] - middle;
      sumSqDiff += diff * diff;
    }
    // Use population std dev for Bollinger Bands (N, not N-1)
    const stdDev = Math.sqrt(sumSqDiff / n);

    // Current spread is the last written value
    const currentIdx = (state.writeIndex - 1 + period) % period;
    const currentSpread = state.spreads[currentIdx];

    return {
      upper: middle + this.config.bollingerStdDev * stdDev,
      middle,
      lower: middle - this.config.bollingerStdDev * stdDev,
      currentSpread,
    };
  }

  /**
   * Extract spreads from circular buffer in chronological order.
   */
  private getSpreadsInOrder(state: SpreadState): number[] {
    const result: number[] = [];
    const count = state.sampleCount;
    const startIndex = count < this.config.bollingerPeriod
      ? 0
      : state.writeIndex;

    for (let i = 0; i < count; i++) {
      const idx = (startIndex + i) % this.config.bollingerPeriod;
      result.push(state.spreads[idx]);
    }

    return result;
  }

  /**
   * Get the previous spread value (second to last in chronological order).
   */
  private getPreviousSpread(state: SpreadState): number | undefined {
    if (state.sampleCount < 2) {
      return undefined;
    }

    // The previous value is at writeIndex - 2 (wrapping)
    const prevIdx = (state.writeIndex - 2 + this.config.bollingerPeriod) % this.config.bollingerPeriod;
    return state.spreads[prevIdx];
  }
}
