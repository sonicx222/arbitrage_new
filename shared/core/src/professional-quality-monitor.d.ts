/**
 * Interface for Redis-like operations needed by ProfessionalQualityMonitor.
 * Allows injecting mock Redis for testing.
 */
export interface QualityMonitorRedis {
    setex(key: string, seconds: number, value: string): Promise<string>;
    get(key: string): Promise<string | null>;
    keys(pattern: string): Promise<string[]>;
}
/**
 * Dependencies that can be injected into ProfessionalQualityMonitor.
 * This enables proper testing without Jest mock hoisting issues.
 */
export interface QualityMonitorDeps {
    /** Redis client instance - if provided, used directly (no async init needed) */
    redis?: QualityMonitorRedis;
}
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
    private redisPromise;
    private metricsBuffer;
    private scoreHistory;
    private readonly METRICS_RETENTION_PERIOD;
    private readonly ASSESSMENT_INTERVAL;
    private assessmentInterval;
    private readonly THRESHOLDS;
    /**
     * Create a ProfessionalQualityMonitor.
     * @param deps - Optional dependencies for testing. If redis is provided, it's used directly.
     */
    constructor(deps?: QualityMonitorDeps);
    /**
     * Get the Redis client, initializing lazily if needed.
     * Uses singleton pattern for production, direct injection for tests.
     * Creates an adapter around RedisClient that implements QualityMonitorRedis.
     */
    private getRedis;
    /**
     * Stop the periodic assessment (for cleanup in tests).
     */
    stopPeriodicAssessment(): void;
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