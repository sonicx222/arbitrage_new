export declare enum MarketRegime {
    MEAN_REVERTING = "mean_reverting",
    TRENDING_UP = "trending_up",
    TRENDING_DOWN = "trending_down",
    HIGH_VOLATILITY = "high_volatility",
    LOW_VOLATILITY = "low_volatility",
    BREAKOUT = "breakout",
    UNKNOWN = "unknown"
}
export interface StatisticalSignal {
    pair: string;
    zScore: number;
    regime: MarketRegime;
    confidence: number;
    direction: 'buy' | 'sell' | 'neutral';
    strength: number;
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
export declare class AdvancedStatisticalArbitrage {
    private cache;
    private regimeHistory;
    private transitionMatrix;
    private adaptiveThresholds;
    constructor();
    generateSignal(pair: string, currentSpread: number, priceHistory: number[], volumeHistory?: number[]): Promise<StatisticalSignal>;
    private detectMarketRegime;
    private calculateAdaptiveZScore;
    private calculateSignal;
    private getAdaptiveThresholds;
    private updateRegimeHistory;
    private recordRegimeTransition;
    getTransitionProbability(pair: string, fromRegime: MarketRegime, toRegime: MarketRegime): number;
    predictNextRegime(pair: string, currentRegime: MarketRegime): MarketRegime;
    private calculateReturns;
    private calculateVolatility;
    private calculateTrend;
    private calculateMeanReversionStrength;
    private detectVolumeSpike;
    private initializeDefaultThresholds;
    getStats(): any;
}
//# sourceMappingURL=advanced-statistical-arbitrage.d.ts.map