/**
 * Statistical Arbitrage Detector
 *
 * Orchestrates the three statistical analytics components to generate
 * statistical arbitrage opportunities:
 * - PairCorrelationTracker: Ensures price pairs are sufficiently correlated
 * - SpreadTracker: Generates Bollinger Band entry/exit signals
 * - RegimeDetector: Confirms mean-reverting market regime via Hurst exponent
 *
 * An opportunity is emitted only when ALL three conditions are met:
 * 1. Spread signal is 'entry_long' or 'entry_short' (spread outside Bollinger Bands)
 * 2. Regime is 'mean_reverting' (Hurst exponent indicates anti-persistence)
 * 3. Correlation exceeds threshold (pair prices move together historically)
 *
 * @see shared/core/src/analytics/pair-correlation-tracker.ts
 * @see shared/core/src/analytics/spread-tracker.ts
 * @see shared/core/src/analytics/regime-detector.ts
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger';
import type { PairCorrelationTracker } from '../analytics/pair-correlation-tracker';
import type { SpreadTracker, SpreadSignal } from '../analytics/spread-tracker';
import type { RegimeDetector } from '../analytics/regime-detector';
import type { ArbitrageOpportunity } from '@arbitrage/types';

const logger = createLogger('statistical-arbitrage-detector');

// =============================================================================
// Types
// =============================================================================

export interface StatArbPairConfig {
  /** Unique identifier for this pair */
  id: string;
  /** Token A address */
  tokenA: string;
  /** Token B address */
  tokenB: string;
  /** Chains where this pair trades */
  chains: string[];
}

export interface StatArbDetectorConfig {
  /** Pairs to monitor for statistical arbitrage */
  pairs: StatArbPairConfig[];
  /** Minimum correlation for eligibility (default: 0.7) */
  minCorrelation: number;
  /** Bollinger Band std dev multiplier (default: 2.0) */
  bollingerStdDev: number;
  /** Regime window size for Hurst calculation (default: 100) */
  regimeWindowSize: number;
  /** Default position size in USD for expectedProfit estimation (default: 50000) */
  defaultPositionSizeUsd: number;
}

// =============================================================================
// Default Configuration
// =============================================================================

const DEFAULT_CONFIG: Omit<StatArbDetectorConfig, 'pairs'> = {
  minCorrelation: 0.7,
  bollingerStdDev: 2.0,
  regimeWindowSize: 100,
  defaultPositionSizeUsd: 50_000,
};

// =============================================================================
// Statistical Arbitrage Detector
// =============================================================================

/**
 * Orchestrates correlation, spread, and regime analysis to detect
 * statistical arbitrage opportunities.
 *
 * Emits 'opportunity' events with ArbitrageOpportunity objects when
 * all three conditions are satisfied.
 */
export class StatisticalArbitrageDetector extends EventEmitter {
  /** Default max listeners to prevent Node.js warnings */
  static readonly DEFAULT_MAX_LISTENERS = 20;
  private readonly correlationTracker: PairCorrelationTracker;
  private readonly spreadTracker: SpreadTracker;
  private readonly regimeDetector: RegimeDetector;
  private readonly config: StatArbDetectorConfig;
  private readonly activeSignals: Map<string, SpreadSignal> = new Map();
  /** O(1) pair config lookup by pairId */
  private readonly pairConfigMap: Map<string, StatArbPairConfig> = new Map();
  private running: boolean = false;

  constructor(
    correlationTracker: PairCorrelationTracker,
    spreadTracker: SpreadTracker,
    regimeDetector: RegimeDetector,
    config: StatArbDetectorConfig,
  ) {
    super();
    this.setMaxListeners(StatisticalArbitrageDetector.DEFAULT_MAX_LISTENERS);
    this.correlationTracker = correlationTracker;
    this.spreadTracker = spreadTracker;
    this.regimeDetector = regimeDetector;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };

    // Build O(1) lookup map for pair configs
    for (const pair of this.config.pairs) {
      this.pairConfigMap.set(pair.id, pair);
    }

    logger.info('StatisticalArbitrageDetector initialized', {
      pairs: this.config.pairs.length,
      minCorrelation: this.config.minCorrelation,
      bollingerStdDev: this.config.bollingerStdDev,
    });
  }

  /**
   * Process a price update for a pair.
   *
   * Feeds prices to all three analytics components, then checks if
   * all conditions are met for an opportunity.
   *
   * @param pairId - Pair identifier (must match a configured pair)
   * @param priceA - Current price of token A
   * @param priceB - Current price of token B
   * @param timestamp - Price update timestamp
   */
  onPriceUpdate(pairId: string, priceA: number, priceB: number, timestamp: number): void {
    if (!this.running) {
      return;
    }

    // Feed prices to all analytics components
    this.correlationTracker.addSample(pairId, priceA, priceB, timestamp);
    this.spreadTracker.addSpread(pairId, priceA, priceB);

    // Feed log-spread to regime detector.
    // SpreadTracker also computes log(priceA/priceB) internally, but RegimeDetector
    // uses a different circular buffer so we need to feed it explicitly.
    if (priceA > 0 && priceB > 0) {
      this.regimeDetector.addSample(pairId, Math.log(priceA / priceB));
    }

    // Check for opportunity
    const signal = this.spreadTracker.getSignal(pairId);
    this.activeSignals.set(pairId, signal);

    // Only proceed if there's an actionable entry signal
    if (signal !== 'entry_long' && signal !== 'entry_short') {
      return;
    }

    // Check regime: must be mean-reverting
    if (!this.regimeDetector.isFavorable(pairId)) {
      logger.debug('Signal rejected: regime not mean_reverting', {
        pairId,
        signal,
        regime: this.regimeDetector.getRegime(pairId),
      });
      return;
    }

    // Check correlation: must exceed threshold
    if (!this.correlationTracker.isEligible(pairId)) {
      logger.debug('Signal rejected: correlation below threshold', {
        pairId,
        signal,
        correlation: this.correlationTracker.getCorrelation(pairId),
      });
      return;
    }

    // All three conditions met - emit opportunity
    const pairConfig = this.pairConfigMap.get(pairId);
    if (!pairConfig) {
      logger.warn('Signal for unconfigured pair', { pairId });
      return;
    }

    const correlation = this.correlationTracker.getCorrelation(pairId) ?? 0;
    const bands = this.spreadTracker.getBollingerBands(pairId);
    const hurst = this.regimeDetector.getHurstExponent(pairId) ?? 0.5;

    // Compute confidence based on correlation strength + regime confidence
    // Higher correlation and lower Hurst (more mean-reverting) = higher confidence
    const correlationConfidence = Math.min(1, Math.abs(correlation));
    const regimeConfidence = Math.max(0, 1 - hurst * 2); // H=0 -> 1.0, H=0.5 -> 0
    const confidence = Math.min(1, (correlationConfidence + regimeConfidence) / 2);

    // Expected profit from spread deviation, scaled to USD.
    // spreadDeviation is in log-spread units (≈ fractional price deviation for small values).
    // Multiply by position size to get approximate USD profit.
    const spreadDeviation = bands
      ? Math.abs(bands.currentSpread - bands.middle)
      : 0;
    const expectedProfit = spreadDeviation * this.config.defaultPositionSizeUsd;

    // Determine token direction based on signal
    const tokenIn = signal === 'entry_long' ? pairConfig.tokenB : pairConfig.tokenA;
    const tokenOut = signal === 'entry_long' ? pairConfig.tokenA : pairConfig.tokenB;

    const opportunity: ArbitrageOpportunity = {
      id: `stat-arb-${pairId}-${timestamp}`,
      type: 'statistical',
      chain: pairConfig.chains[0],
      tokenIn,
      tokenOut,
      confidence,
      expectedProfit,
      timestamp,
      // amountIn intentionally omitted. The detector computes expectedProfit in USD
      // but cannot convert to token-native units (lamports, wei) without on-chain
      // price data. Downstream execution strategies size the trade from expectedProfit
      // and route context instead. Setting a USD value here would be misinterpreted
      // as lamports/wei by Jupiter/flash-loan paths, causing orders-of-magnitude errors.
    };

    logger.info('Statistical arbitrage opportunity detected', {
      pairId,
      signal,
      correlation,
      hurst,
      confidence,
      expectedProfit,
      chain: pairConfig.chains[0],
    });

    this.emit('opportunity', opportunity);
  }

  /**
   * Get currently active signals for all monitored pairs.
   */
  getActiveSignals(): Map<string, SpreadSignal> {
    return new Map(this.activeSignals);
  }

  /**
   * Start monitoring configured pairs.
   */
  start(): void {
    this.running = true;
    logger.info('StatisticalArbitrageDetector started', {
      monitoredPairs: this.config.pairs.length,
    });
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    this.running = false;
    this.activeSignals.clear();
    logger.info('StatisticalArbitrageDetector stopped');
  }
}
