// Advanced Statistical Arbitrage Engine
// Implements multi-regime detection, adaptive parameters, and sophisticated mean-reversion strategies

import { createLogger } from './logger';
import { getHierarchicalCache } from './caching/hierarchical-cache';

const logger = createLogger('advanced-statistical-arbitrage');

export enum MarketRegime {
  MEAN_REVERTING = 'mean_reverting',
  TRENDING_UP = 'trending_up',
  TRENDING_DOWN = 'trending_down',
  HIGH_VOLATILITY = 'high_volatility',
  LOW_VOLATILITY = 'low_volatility',
  BREAKOUT = 'breakout',
  UNKNOWN = 'unknown'
}

export interface StatisticalSignal {
  pair: string;
  zScore: number;
  regime: MarketRegime;
  confidence: number;
  direction: 'buy' | 'sell' | 'neutral';
  strength: number; // 0-1
  adaptiveThreshold: number;
  volatilityAdjustment: number;
  timestamp: number;
}

export interface RegimeTransition {
  fromRegime: MarketRegime;
  toRegime: MarketRegime;
  transitionProbability: number;
  timestamp: number;
}

export interface AdaptiveThresholds {
  zScoreThreshold: number;
  volatilityMultiplier: number;
  lookbackPeriod: number;
  confidenceThreshold: number;
}

export class AdvancedStatisticalArbitrage {
  private cache = getHierarchicalCache();
  private regimeHistory = new Map<string, MarketRegime[]>();
  private transitionMatrix = new Map<string, Map<MarketRegime, Map<MarketRegime, number>>>();
  private adaptiveThresholds = new Map<string, AdaptiveThresholds>();

  constructor() {
    this.initializeDefaultThresholds();
  }

  // Main signal generation with regime detection
  async generateSignal(
    pair: string,
    currentSpread: number,
    priceHistory: number[],
    volumeHistory?: number[]
  ): Promise<StatisticalSignal> {
    const startTime = Date.now();

    // Detect current market regime
    const regime = this.detectMarketRegime(pair, priceHistory, volumeHistory);

    // Get adaptive thresholds for this regime
    const thresholds = await this.getAdaptiveThresholds(pair, regime);

    // Calculate regime-aware z-score
    const zScore = this.calculateAdaptiveZScore(currentSpread, priceHistory, thresholds);

    // Calculate signal confidence and direction
    const signal = this.calculateSignal(zScore, regime, thresholds, priceHistory);

    // Update regime history
    this.updateRegimeHistory(pair, regime);

    const processingTime = Date.now() - startTime;
    logger.debug(`Generated statistical signal for ${pair}`, {
      regime,
      zScore: zScore.toFixed(3),
      signal: signal.direction,
      confidence: signal.confidence.toFixed(3),
      processingTime
    });

    return {
      ...signal,
      timestamp: Date.now()
    };
  }

  // Advanced regime detection using multiple indicators
  private detectMarketRegime(
    pair: string,
    priceHistory: number[],
    volumeHistory?: number[]
  ): MarketRegime {
    if (priceHistory.length < 50) {
      return MarketRegime.UNKNOWN;
    }

    // Calculate multiple indicators
    const returns = this.calculateReturns(priceHistory);
    const volatility = this.calculateVolatility(returns);
    const trend = this.calculateTrend(priceHistory);
    const meanReversion = this.calculateMeanReversionStrength(priceHistory);
    const volumeSpike = volumeHistory ? this.detectVolumeSpike(volumeHistory) : false;

    // Regime classification logic
    if (Math.abs(trend) > 0.002) { // Strong trend
      if (trend > 0) {
        return volumeSpike ? MarketRegime.BREAKOUT : MarketRegime.TRENDING_UP;
      } else {
        return volumeSpike ? MarketRegime.BREAKOUT : MarketRegime.TRENDING_DOWN;
      }
    }

    if (volatility > 0.05) { // High volatility
      return MarketRegime.HIGH_VOLATILITY;
    }

    if (volatility < 0.01) { // Low volatility
      return MarketRegime.LOW_VOLATILITY;
    }

    if (meanReversion > 0.7) { // Strong mean reversion
      return MarketRegime.MEAN_REVERTING;
    }

    return MarketRegime.UNKNOWN;
  }

  // Calculate adaptive z-score based on regime
  private calculateAdaptiveZScore(
    currentSpread: number,
    priceHistory: number[],
    thresholds: AdaptiveThresholds
  ): number {
    // Use adaptive lookback period
    const lookback = Math.min(thresholds.lookbackPeriod, priceHistory.length - 1);
    const recentPrices = priceHistory.slice(-lookback);

    const mean = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
    const variance = recentPrices.reduce((acc, price) => acc + Math.pow(price - mean, 2), 0) / recentPrices.length;
    const stdDev = Math.sqrt(variance);

    // Apply volatility adjustment
    const adjustedStdDev = stdDev * thresholds.volatilityMultiplier;

    return adjustedStdDev > 0 ? (currentSpread - mean) / adjustedStdDev : 0;
  }

  // Calculate signal with regime-aware logic
  private calculateSignal(
    zScore: number,
    regime: MarketRegime,
    thresholds: AdaptiveThresholds,
    priceHistory: number[]
  ): Omit<StatisticalSignal, 'timestamp'> {
    let direction: 'buy' | 'sell' | 'neutral' = 'neutral';
    let confidence = 0;
    let strength = 0;

    // Regime-specific signal logic
    switch (regime) {
      case MarketRegime.MEAN_REVERTING:
        // Strong mean reversion signals
        if (Math.abs(zScore) > thresholds.zScoreThreshold) {
          direction = zScore > 0 ? 'sell' : 'buy';
          confidence = Math.min(Math.abs(zScore) / 3.0, 1.0); // Normalize to 0-1
          strength = Math.abs(zScore) / 4.0; // Higher z-score = stronger signal
        }
        break;

      case MarketRegime.TRENDING_UP:
      case MarketRegime.TRENDING_DOWN:
        // Weaker signals in trending markets
        if (Math.abs(zScore) > thresholds.zScoreThreshold * 1.5) {
          direction = zScore > 0 ? 'sell' : 'buy';
          confidence = Math.min(Math.abs(zScore) / 4.0, 0.7); // Lower confidence in trends
          strength = Math.abs(zScore) / 6.0;
        }
        break;

      case MarketRegime.HIGH_VOLATILITY:
        // Conservative signals in high volatility
        if (Math.abs(zScore) > thresholds.zScoreThreshold * 2.0) {
          direction = zScore > 0 ? 'sell' : 'buy';
          confidence = Math.min(Math.abs(zScore) / 5.0, 0.5);
          strength = Math.abs(zScore) / 8.0;
        }
        break;

      case MarketRegime.LOW_VOLATILITY:
        // Stronger signals in low volatility (more predictable)
        if (Math.abs(zScore) > thresholds.zScoreThreshold * 0.8) {
          direction = zScore > 0 ? 'sell' : 'buy';
          confidence = Math.min(Math.abs(zScore) / 2.5, 0.9);
          strength = Math.abs(zScore) / 3.5;
        }
        break;

      case MarketRegime.BREAKOUT:
        // Very conservative during breakouts
        if (Math.abs(zScore) > thresholds.zScoreThreshold * 3.0) {
          direction = zScore > 0 ? 'sell' : 'buy';
          confidence = Math.min(Math.abs(zScore) / 6.0, 0.3);
          strength = Math.abs(zScore) / 10.0;
        }
        break;

      default:
        // Unknown regime - very conservative
        if (Math.abs(zScore) > thresholds.zScoreThreshold * 2.0) {
          direction = zScore > 0 ? 'sell' : 'buy';
          confidence = Math.min(Math.abs(zScore) / 5.0, 0.4);
          strength = Math.abs(zScore) / 8.0;
        }
    }

    return {
      pair: '', // Will be set by caller
      zScore,
      regime,
      confidence: Math.max(0, Math.min(1, confidence)),
      direction,
      strength: Math.max(0, Math.min(1, strength)),
      adaptiveThreshold: thresholds.zScoreThreshold,
      volatilityAdjustment: thresholds.volatilityMultiplier
    };
  }

  // Get adaptive thresholds for a pair and regime
  private async getAdaptiveThresholds(pair: string, regime: MarketRegime): Promise<AdaptiveThresholds> {
    // Check cache first
    const cacheKey = `thresholds:${pair}:${regime}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached as unknown as AdaptiveThresholds;
    }

    // Calculate adaptive thresholds based on regime
    let baseThreshold = 2.0; // Standard 2-sigma
    let volatilityMultiplier = 1.0;
    let lookbackPeriod = 100;
    let confidenceThreshold = 0.7;

    switch (regime) {
      case MarketRegime.MEAN_REVERTING:
        baseThreshold = 1.8; // More sensitive to mean reversion
        volatilityMultiplier = 0.9;
        lookbackPeriod = 120;
        confidenceThreshold = 0.75;
        break;

      case MarketRegime.TRENDING_UP:
      case MarketRegime.TRENDING_DOWN:
        baseThreshold = 2.5; // Less sensitive during trends
        volatilityMultiplier = 1.2;
        lookbackPeriod = 80;
        confidenceThreshold = 0.8;
        break;

      case MarketRegime.HIGH_VOLATILITY:
        baseThreshold = 3.0; // Much less sensitive
        volatilityMultiplier = 1.5;
        lookbackPeriod = 60;
        confidenceThreshold = 0.85;
        break;

      case MarketRegime.LOW_VOLATILITY:
        baseThreshold = 1.5; // More sensitive in calm markets
        volatilityMultiplier = 0.8;
        lookbackPeriod = 150;
        confidenceThreshold = 0.65;
        break;

      case MarketRegime.BREAKOUT:
        baseThreshold = 4.0; // Extremely conservative
        volatilityMultiplier = 2.0;
        lookbackPeriod = 40;
        confidenceThreshold = 0.9;
        break;
    }

    const thresholds: AdaptiveThresholds = {
      zScoreThreshold: baseThreshold,
      volatilityMultiplier,
      lookbackPeriod,
      confidenceThreshold
    };

    // Cache for 5 minutes
    await this.cache.set(cacheKey, thresholds, 300);
    return thresholds;
  }

  // Update regime transition probabilities
  private updateRegimeHistory(pair: string, newRegime: MarketRegime): void {
    if (!this.regimeHistory.has(pair)) {
      this.regimeHistory.set(pair, []);
    }

    const history = this.regimeHistory.get(pair)!;
    const previousRegime = history[history.length - 1];

    // Record transition if regime changed
    if (previousRegime && previousRegime !== newRegime) {
      this.recordRegimeTransition(pair, previousRegime, newRegime);
    }

    // Keep only recent history (last 1000 transitions)
    history.push(newRegime);
    if (history.length > 1000) {
      history.shift();
    }

    this.regimeHistory.set(pair, history);
  }

  // Record regime transition for probability calculation
  private recordRegimeTransition(pair: string, fromRegime: MarketRegime, toRegime: MarketRegime): void {
    const pairKey = `${pair}`;

    if (!this.transitionMatrix.has(pairKey)) {
      this.transitionMatrix.set(pairKey, new Map());
    }

    const fromTransitions = this.transitionMatrix.get(pairKey)!;

    if (!fromTransitions.has(fromRegime)) {
      fromTransitions.set(fromRegime, new Map());
    }

    const toTransitions = fromTransitions.get(fromRegime)!;
    const currentCount = toTransitions.get(toRegime) || 0;
    toTransitions.set(toRegime, currentCount + 1);
  }

  // Calculate regime transition probability
  getTransitionProbability(
    pair: string,
    fromRegime: MarketRegime,
    toRegime: MarketRegime
  ): number {
    const pairKey = `${pair}`;
    const fromTransitions = this.transitionMatrix.get(pairKey)?.get(fromRegime);

    if (!fromTransitions) return 0;

    const totalTransitions = Array.from(fromTransitions.values()).reduce((a, b) => a + b, 0);
    const toTransitions = fromTransitions.get(toRegime) || 0;

    return totalTransitions > 0 ? toTransitions / totalTransitions : 0;
  }

  // Predict next regime based on transition probabilities
  predictNextRegime(pair: string, currentRegime: MarketRegime): MarketRegime {
    const pairKey = `${pair}`;
    const fromTransitions = this.transitionMatrix.get(pairKey)?.get(currentRegime);

    if (!fromTransitions) return currentRegime;

    let maxProbability = 0;
    let predictedRegime = currentRegime;

    for (const [toRegime, count] of fromTransitions.entries()) {
      const probability = count / Array.from(fromTransitions.values()).reduce((a, b) => a + b, 0);
      if (probability > maxProbability) {
        maxProbability = probability;
        predictedRegime = toRegime as MarketRegime;
      }
    }

    return predictedRegime;
  }

  // Utility functions
  private calculateReturns(prices: number[]): number[] {
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
    return returns;
  }

  private calculateVolatility(returns: number[]): number {
    if (returns.length < 2) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((acc, ret) => acc + Math.pow(ret - mean, 2), 0) / returns.length;

    return Math.sqrt(variance);
  }

  private calculateTrend(prices: number[]): number {
    if (prices.length < 2) return 0;

    // Simple linear regression slope
    const n = prices.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = prices.reduce((a, b) => a + b, 0);
    const sumXY = prices.reduce((acc, price, i) => acc + price * i, 0);
    const sumXX = (n * (n - 1) * (2 * n - 1)) / 6;

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    return slope / prices[prices.length - 1]; // Normalize by current price
  }

  private calculateMeanReversionStrength(prices: number[]): number {
    if (prices.length < 20) return 0;

    // Calculate autocorrelation at lag 1 (mean reversion indicator)
    const returns = this.calculateReturns(prices);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;

    let autocorr = 0;
    for (let i = 1; i < returns.length; i++) {
      autocorr += (returns[i] - mean) * (returns[i - 1] - mean);
    }

    const variance = returns.reduce((acc, ret) => acc + Math.pow(ret - mean, 2), 0) / returns.length;
    autocorr = autocorr / ((returns.length - 1) * variance);

    // Convert to strength indicator (negative autocorrelation = mean reversion)
    return Math.max(0, Math.min(1, -autocorr));
  }

  private detectVolumeSpike(volumeHistory: number[]): boolean {
    if (volumeHistory.length < 20) return false;

    const recentVolumes = volumeHistory.slice(-10);
    const historicalVolumes = volumeHistory.slice(-50, -10);

    const recentAvg = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const historicalAvg = historicalVolumes.reduce((a, b) => a + b, 0) / historicalVolumes.length;

    // Volume spike if recent volume is 3x historical average
    return recentAvg > historicalAvg * 3;
  }

  private initializeDefaultThresholds(): void {
    // Set some reasonable defaults
    this.adaptiveThresholds.set('default', {
      zScoreThreshold: 2.0,
      volatilityMultiplier: 1.0,
      lookbackPeriod: 100,
      confidenceThreshold: 0.7
    });
  }

  // Get statistics for monitoring
  getStats(): any {
    return {
      pairsTracked: this.regimeHistory.size,
      totalRegimeTransitions: Array.from(this.transitionMatrix.values())
        .reduce((total, fromMap) =>
          total + Array.from(fromMap.values())
            .reduce((fromTotal, toMap) =>
              fromTotal + Array.from(toMap.values()).reduce((toTotal, count) => toTotal + count, 0), 0), 0),
      timestamp: Date.now()
    };
  }
}