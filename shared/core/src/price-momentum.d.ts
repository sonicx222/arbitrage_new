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
/**
 * T2.7: Price Momentum Tracker
 *
 * Tracks price history for multiple pairs and calculates momentum signals
 * for improved arbitrage entry timing.
 */
export declare class PriceMomentumTracker {
    private config;
    private pairs;
    private emaShortMultiplier;
    private emaMediumMultiplier;
    private emaLongMultiplier;
    private volumeEmaMultiplier;
    constructor(config?: Partial<MomentumConfig>);
    /**
     * Add a price update for a pair.
     * O(1) operation using circular buffer.
     */
    addPriceUpdate(pair: string, price: number, volume: number, timestamp?: number): void;
    /**
     * Get current statistics for a pair.
     */
    getStats(pair: string): PairStats | null;
    /**
     * Calculate momentum signal for a pair.
     * Returns null if insufficient data.
     */
    getMomentumSignal(pair: string): MomentumSignal | null;
    /**
     * Reset data for a specific pair.
     */
    resetPair(pair: string): void;
    /**
     * Reset all tracked pairs.
     */
    resetAll(): void;
    /**
     * Get all tracked pairs.
     */
    getTrackedPairs(): string[];
    /**
     * Get number of currently tracked pairs.
     */
    getTrackedPairsCount(): number;
    /**
     * Evict least recently used pairs if we're at the max pairs limit.
     * Removes the oldest 10% of pairs to make room for new ones.
     */
    private evictLRUPairsIfNeeded;
    /**
     * Update EMA with new value.
     * EMA = (price * k) + (prevEMA * (1 - k))
     */
    private updateEma;
    /**
     * Extract prices from circular buffer in chronological order.
     */
    private getPrices;
    /**
     * Extract volumes from circular buffer in chronological order.
     */
    private getVolumes;
    /**
     * Calculate mean of an array.
     */
    private calculateMean;
    /**
     * Calculate standard deviation.
     */
    private calculateStdDev;
    /**
     * Detect trend based on price vs EMAs.
     */
    private detectTrend;
    /**
     * Calculate signal confidence based on multiple factors.
     */
    private calculateConfidence;
}
/**
 * Get the singleton PriceMomentumTracker instance.
 * Configuration is only applied on first call; subsequent calls return the existing instance.
 *
 * @param config - Optional configuration (only used on first initialization)
 * @returns The singleton PriceMomentumTracker instance
 */
export declare function getPriceMomentumTracker(config?: Partial<MomentumConfig>): PriceMomentumTracker;
/**
 * Reset the singleton instance.
 * Use for testing or when reconfiguration is needed.
 */
export declare function resetPriceMomentumTracker(): void;
//# sourceMappingURL=price-momentum.d.ts.map