import { CrossChainBridge } from '@arbitrage/types';
export interface BridgePrediction {
    bridgeName: string;
    estimatedLatency: number;
    estimatedCost: number;
    confidence: number;
    historicalAccuracy: number;
}
export interface BridgeMetrics {
    bridgeName: string;
    avgLatency: number;
    minLatency: number;
    maxLatency: number;
    avgCost: number;
    successRate: number;
    sampleCount: number;
}
export declare class BridgeLatencyPredictor {
    private bridgeHistory;
    private predictionModel;
    private metricsCache;
    constructor();
    predictLatency(bridge: CrossChainBridge): BridgePrediction;
    updateModel(actualResult: {
        bridge: CrossChainBridge;
        actualLatency: number;
        actualCost: number;
        success: boolean;
        timestamp: number;
    }): void;
    getBridgeMetrics(bridgeKey: string): BridgeMetrics | null;
    getAvailableRoutes(sourceChain: string, targetChain: string): string[];
    predictOptimalBridge(sourceChain: string, targetChain: string, amount: number, urgency?: 'low' | 'medium' | 'high'): BridgePrediction | null;
    private initializeModels;
    private predictUsingModel;
    private getConservativeEstimate;
    private updateStatisticalModel;
    private calculateVariance;
    private calculateTrend;
    private calculateHistoricalAccuracy;
    private estimateCongestion;
    private estimateGasPrice;
    cleanup(maxAge?: number): void;
}
//# sourceMappingURL=bridge-predictor.d.ts.map