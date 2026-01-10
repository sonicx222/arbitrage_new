export interface ExperimentConfig {
    id: string;
    name: string;
    description: string;
    variants: ExperimentVariant[];
    targetMetric: string;
    minimumSampleSize: number;
    confidenceLevel: number;
    startTime?: number;
    endTime?: number;
    status: 'draft' | 'running' | 'completed' | 'stopped';
}
export interface ExperimentVariant {
    id: string;
    name: string;
    description: string;
    weight: number;
    config: any;
}
export interface ExperimentResult {
    experimentId: string;
    variantId: string;
    metricName: string;
    value: number;
    timestamp: number;
    userId?: string;
    context?: any;
}
export interface StatisticalResult {
    experimentId: string;
    winner: string;
    confidence: number;
    improvement: number;
    statisticalSignificance: boolean;
    sampleSizes: {
        [variantId: string]: number;
    };
    means: {
        [variantId: string]: number;
    };
    pValue: number;
}
export declare class ABTestingFramework {
    private redis;
    private experiments;
    private resultsBuffer;
    private flushInterval;
    private isFlushing;
    private bufferLock;
    constructor();
    createExperiment(config: Omit<ExperimentConfig, 'status'>): Promise<string>;
    startExperiment(experimentId: string): Promise<void>;
    stopExperiment(experimentId: string): Promise<void>;
    getExperiment(experimentId: string): Promise<ExperimentConfig | null>;
    assignVariant(experimentId: string, userId?: string): Promise<ExperimentVariant | null>;
    recordResult(result: ExperimentResult): void;
    recordBatchResults(results: ExperimentResult[]): Promise<void>;
    analyzeExperiment(experimentId: string): Promise<StatisticalResult | null>;
    getRealtimeStats(experimentId: string): Promise<any>;
    private validateExperiment;
    private hashString;
    private seededRandom;
    private getExperimentResults;
    private performStatisticalAnalysis;
    private calculateMedian;
    private calculateStdDev;
    private calculateTStatistic;
    private calculateVariance;
    private approximatePValue;
    private normalCDF;
    private flushResults;
    private startPeriodicFlush;
    destroy(): void;
}
export declare function createABTestingFramework(): ABTestingFramework;
export declare function getABTestingFramework(): ABTestingFramework;
export declare function quickExperiment(experimentId: string, variants: {
    id: string;
    name: string;
    weight: number;
}[], userId?: string): Promise<string>;
//# sourceMappingURL=ab-testing.d.ts.map