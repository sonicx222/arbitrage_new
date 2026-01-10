export interface QualityMetrics {
    detectionLatency: {
        p50: number;
        p95: number;
        p99: number;
        max: number;
    };
    detectionAccuracy: {
        precision: number;
        recall: number;
        f1Score: number;
        falsePositiveRate: number;
    };
    systemReliability: {
        uptime: number;
        availability: number;
        errorRate: number;
        recoveryTime: number;
    };
    operationalConsistency: {
        performanceVariance: number;
        throughputStability: number;
        memoryStability: number;
        loadHandling: number;
    };
}
export interface ProfessionalQualityScore {
    overallScore: number;
    grade: 'F' | 'D' | 'C' | 'B' | 'A' | 'A+';
    componentScores: {
        detectionPerformance: number;
        detectionAccuracy: number;
        systemReliability: number;
        operationalConsistency: number;
    };
    metrics: QualityMetrics;
    timestamp: number;
    assessmentPeriod: {
        start: number;
        end: number;
        duration: number;
    };
    recommendations: string[];
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}
export declare class ProfessionalQualityMonitor {
    private redis;
    private metricsBuffer;
    private scoreHistory;
    private readonly METRICS_RETENTION_PERIOD;
    private readonly ASSESSMENT_INTERVAL;
    private readonly THRESHOLDS;
    constructor();
    recordDetectionResult(result: {
        latency: number;
        isTruePositive: boolean;
        isFalsePositive: boolean;
        isFalseNegative: boolean;
        timestamp: number;
        operationId: string;
    }): Promise<void>;
    recordSystemHealth(health: {
        uptime: number;
        availability: number;
        errorRate: number;
        recoveryTime: number;
        timestamp: number;
    }): Promise<void>;
    recordOperationalMetrics(metrics: {
        performanceVariance: number;
        throughputStability: number;
        memoryStability: number;
        loadHandling: number;
        timestamp: number;
    }): Promise<void>;
    calculateQualityScore(assessmentPeriod?: {
        start: number;
        end: number;
    }): Promise<ProfessionalQualityScore>;
    getCurrentQualityScore(): Promise<ProfessionalQualityScore | null>;
    getQualityScoreHistory(limit?: number): Promise<ProfessionalQualityScore[]>;
    assessFeatureImpact(baselineScore: ProfessionalQualityScore, newScore: ProfessionalQualityScore): Promise<{
        impact: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'CRITICAL';
        scoreChange: number;
        componentChanges: Record<string, number>;
        recommendations: string[];
    }>;
    private gatherMetricsForPeriod;
    private calculateLatencyMetrics;
    private calculateDetectionPerformanceScore;
    private calculateDetectionAccuracyScore;
    private calculateSystemReliabilityScore;
    private calculateOperationalConsistencyScore;
    private determineGradeAndRisk;
    private generateRecommendations;
    private generateFeatureImpactRecommendations;
    private getDetectionLatenciesForPeriod;
    private getDetectionAccuracyForPeriod;
    private getSystemReliabilityForPeriod;
    private getOperationalConsistencyForPeriod;
    private updateRollingMetrics;
    private startPeriodicAssessment;
}
export declare function createProfessionalQualityMonitor(): ProfessionalQualityMonitor;
export declare function getProfessionalQualityMonitor(): ProfessionalQualityMonitor;
//# sourceMappingURL=professional-quality-monitor.d.ts.map