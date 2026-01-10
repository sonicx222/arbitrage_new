import { MatrixPriceCache } from './matrix-cache';
export interface CorrelationData {
    pairKey: string;
    score: number;
    strength: 'weak' | 'medium' | 'strong';
}
export interface CorrelationGraph {
    [pairKey: string]: CorrelationData[];
}
export declare class PredictiveCacheWarmer {
    private cache;
    private correlationGraph;
    private warmupQueue;
    private accessHistory;
    private correlationCache;
    constructor(cache?: MatrixPriceCache);
    onPriceUpdate(pairKey: string, dexName: string): Promise<void>;
    onArbitrageDetected(opportunity: any): Promise<void>;
    warmupBasedOnPatterns(): Promise<void>;
    private processWarmupQueue;
    private batchWarmPrices;
    private recordAccess;
    private getCorrelatedPairs;
    private calculateCorrelation;
    private countCoOccurrences;
    private identifyHotPairs;
    private extractPairsFromOpportunity;
    getCorrelationGraph(): CorrelationGraph;
    getAccessStats(): {
        [pairKey: string]: {
            accessCount: number;
            lastAccess: number;
        };
    };
    getWarmupQueueStats(): {
        queueLength: number;
        processedToday: number;
    };
    clearOldHistory(maxAgeMs?: number): number;
    updateCorrelations(): void;
}
export declare function getPredictiveCacheWarmer(): PredictiveCacheWarmer;
//# sourceMappingURL=predictive-warmer.d.ts.map