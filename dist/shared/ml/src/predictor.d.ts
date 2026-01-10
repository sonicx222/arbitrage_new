export interface PriceHistory {
    timestamp: number;
    price: number;
    volume: number;
    high: number;
    low: number;
}
export interface PredictionResult {
    predictedPrice: number;
    confidence: number;
    direction: 'up' | 'down' | 'sideways';
    timeHorizon: number;
    features: number[];
}
export interface PatternResult {
    pattern: string;
    confidence: number;
    expectedOutcome: string;
    timeHorizon: number;
    features: number[];
}
export interface TrainingData {
    inputs: number[][];
    outputs: number[][];
    timestamps: number[];
}
export declare class LSTMPredictor {
    private model;
    private isTrained;
    private featureCount;
    private sequenceLength;
    private lastTrainingTime;
    private predictionHistory;
    constructor();
    private initializeModel;
    predictPrice(priceHistory: PriceHistory[], context: {
        currentPrice: number;
        volume24h: number;
        marketCap: number;
        volatility: number;
    }): Promise<PredictionResult>;
    trainModel(trainingData: TrainingData): Promise<void>;
    updateModel(actualPrice: number, predictedPrice: number, timestamp: number): Promise<void>;
    private retrainOnRecentData;
    private createTrainingDataFromHistory;
    private extractFeatures;
    private extractFeaturesFromHistory;
    private calculatePriceFeatures;
    private calculateVolumeFeatures;
    private calculateVolatility;
    private calculateTrend;
    private calculateErrorFeatures;
    private calculateRecentAccuracy;
    private fallbackPrediction;
    getModelStats(): {
        isTrained: boolean;
        lastTrainingTime: number;
        predictionCount: number;
        recentAccuracy: number;
    };
}
export declare class PatternRecognizer {
    private patterns;
    constructor();
    private initializePatterns;
    detectPattern(priceHistory: PriceHistory[], volumeHistory: number[]): PatternResult | null;
    private calculateReturns;
    private calculateVolumeChanges;
    private calculateSimilarity;
}
export declare function getLSTMPredictor(): LSTMPredictor;
export declare function getPatternRecognizer(): PatternRecognizer;
//# sourceMappingURL=predictor.d.ts.map