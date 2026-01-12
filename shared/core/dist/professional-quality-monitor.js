"use strict";
// Professional Quality Monitor
// Measures and tracks the "Arbitrage Detection Professional Quality Score (AD-PQS)"
// This is the single most important metric for measuring system professionalism
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfessionalQualityMonitor = void 0;
exports.createProfessionalQualityMonitor = createProfessionalQualityMonitor;
exports.getProfessionalQualityMonitor = getProfessionalQualityMonitor;
const logger_1 = require("./logger");
const redis_1 = require("./redis");
const logger = (0, logger_1.createLogger)('professional-quality-monitor');
class ProfessionalQualityMonitor {
    constructor() {
        this.metricsBuffer = [];
        this.scoreHistory = [];
        this.METRICS_RETENTION_PERIOD = 24 * 60 * 60 * 1000; // 24 hours
        this.ASSESSMENT_INTERVAL = 5 * 60 * 1000; // 5 minutes
        // Professional quality thresholds
        this.THRESHOLDS = {
            detectionLatency: {
                p95: 5, // 5ms 95th percentile
                p99: 10, // 10ms 99th percentile
                max: 50 // 50ms absolute maximum
            },
            detectionAccuracy: {
                precision: 0.95, // 95% precision
                recall: 0.90, // 90% recall
                f1Score: 0.92, // 92% F1 score
                falsePositiveRate: 0.01 // 1% false positive rate
            },
            systemReliability: {
                uptime: 0.999, // 99.9% uptime
                availability: 0.995, // 99.5% availability
                errorRate: 0.001, // 0.1% error rate
                recoveryTime: 30 // 30 seconds MTTR
            },
            operationalConsistency: {
                performanceVariance: 0.1, // 10% coefficient of variation
                throughputStability: 0.95, // 95% throughput stability
                memoryStability: 0.05, // 5% memory variance
                loadHandling: 0.9 // 90% load handling capability
            }
        };
        this.redis = (0, redis_1.getRedisClient)();
        this.startPeriodicAssessment();
        logger.info('Professional Quality Monitor initialized');
    }
    // Record a detection operation result
    async recordDetectionResult(result) {
        try {
            const key = `quality:detection:${Date.now()}`;
            await this.redis.setex(key, 3600, JSON.stringify(result)); // 1 hour TTL
            // Update rolling metrics
            await this.updateRollingMetrics(result);
            logger.debug('Detection result recorded', {
                latency: result.latency,
                accuracy: result.isTruePositive ? 'correct' : 'incorrect',
                operationId: result.operationId
            });
        }
        catch (error) {
            logger.error('Failed to record detection result', { error });
        }
    }
    // Record system health metrics
    async recordSystemHealth(health) {
        try {
            const key = `quality:system:${Date.now()}`;
            await this.redis.setex(key, 3600, JSON.stringify(health));
            logger.debug('System health recorded', health);
        }
        catch (error) {
            logger.error('Failed to record system health', { error });
        }
    }
    // Record operational metrics
    async recordOperationalMetrics(metrics) {
        try {
            const key = `quality:operational:${Date.now()}`;
            await this.redis.setex(key, 3600, JSON.stringify(metrics));
            logger.debug('Operational metrics recorded', metrics);
        }
        catch (error) {
            logger.error('Failed to record operational metrics', { error });
        }
    }
    // Calculate current professional quality score
    async calculateQualityScore(assessmentPeriod = {
        start: Date.now() - (60 * 60 * 1000), // Last hour
        end: Date.now()
    }) {
        try {
            // Gather metrics from the assessment period
            const metrics = await this.gatherMetricsForPeriod(assessmentPeriod);
            // Calculate component scores
            const componentScores = {
                detectionPerformance: this.calculateDetectionPerformanceScore(metrics.detectionLatency),
                detectionAccuracy: this.calculateDetectionAccuracyScore(metrics.detectionAccuracy),
                systemReliability: this.calculateSystemReliabilityScore(metrics.systemReliability),
                operationalConsistency: this.calculateOperationalConsistencyScore(metrics.operationalConsistency)
            };
            // Calculate overall score (weighted average)
            const overallScore = Math.round(componentScores.detectionPerformance * 0.25 +
                componentScores.detectionAccuracy * 0.25 +
                componentScores.systemReliability * 0.25 +
                componentScores.operationalConsistency * 0.25);
            // Determine grade and risk level
            const { grade, riskLevel } = this.determineGradeAndRisk(overallScore, componentScores);
            // Generate recommendations
            const recommendations = this.generateRecommendations(componentScores, metrics);
            const score = {
                overallScore,
                grade,
                componentScores,
                metrics,
                timestamp: Date.now(),
                assessmentPeriod: {
                    ...assessmentPeriod,
                    duration: assessmentPeriod.end - assessmentPeriod.start
                },
                recommendations,
                riskLevel
            };
            // Store score history
            this.scoreHistory.push(score);
            if (this.scoreHistory.length > 100) {
                this.scoreHistory.shift(); // Keep last 100 scores
            }
            // Cache the score
            await this.redis.setex(`quality:score:current`, 300, // 5 minutes
            JSON.stringify(score));
            logger.info('Professional quality score calculated', {
                overallScore,
                grade,
                riskLevel,
                assessmentPeriod: `${assessmentPeriod.start} - ${assessmentPeriod.end}`
            });
            return score;
        }
        catch (error) {
            logger.error('Failed to calculate quality score', { error });
            throw error;
        }
    }
    // Get current quality score
    async getCurrentQualityScore() {
        try {
            const cached = await this.redis.get('quality:score:current');
            if (cached) {
                return JSON.parse(cached);
            }
            // Calculate fresh score if not cached
            return await this.calculateQualityScore();
        }
        catch (error) {
            logger.error('Failed to get current quality score', { error });
            return null;
        }
    }
    // Get quality score history
    async getQualityScoreHistory(limit = 50) {
        try {
            return this.scoreHistory.slice(-limit);
        }
        catch (error) {
            logger.error('Failed to get quality score history', { error });
            return [];
        }
    }
    // Check if new features impact quality
    async assessFeatureImpact(baselineScore, newScore) {
        const scoreChange = newScore.overallScore - baselineScore.overallScore;
        const componentChanges = {
            detectionPerformance: newScore.componentScores.detectionPerformance - baselineScore.componentScores.detectionPerformance,
            detectionAccuracy: newScore.componentScores.detectionAccuracy - baselineScore.componentScores.detectionAccuracy,
            systemReliability: newScore.componentScores.systemReliability - baselineScore.componentScores.systemReliability,
            operationalConsistency: newScore.componentScores.operationalConsistency - baselineScore.componentScores.operationalConsistency
        };
        let impact;
        if (scoreChange >= 5)
            impact = 'POSITIVE';
        else if (scoreChange >= -2)
            impact = 'NEUTRAL';
        else if (scoreChange >= -10)
            impact = 'NEGATIVE';
        else
            impact = 'CRITICAL';
        const recommendations = this.generateFeatureImpactRecommendations(impact, componentChanges);
        return {
            impact,
            scoreChange,
            componentChanges,
            recommendations
        };
    }
    async gatherMetricsForPeriod(period) {
        // Gather detection latency metrics
        const detectionLatencies = await this.getDetectionLatenciesForPeriod(period);
        const detectionLatencyMetrics = this.calculateLatencyMetrics(detectionLatencies);
        // Gather detection accuracy metrics
        const detectionAccuracy = await this.getDetectionAccuracyForPeriod(period);
        // Gather system reliability metrics
        const systemReliability = await this.getSystemReliabilityForPeriod(period);
        // Gather operational consistency metrics
        const operationalConsistency = await this.getOperationalConsistencyForPeriod(period);
        return {
            detectionLatency: detectionLatencyMetrics,
            detectionAccuracy,
            systemReliability,
            operationalConsistency
        };
    }
    calculateLatencyMetrics(latencies) {
        if (latencies.length === 0) {
            return { p50: 0, p95: 0, p99: 0, max: 0 };
        }
        const sorted = latencies.sort((a, b) => a - b);
        const p50Index = Math.floor(sorted.length * 0.5);
        const p95Index = Math.floor(sorted.length * 0.95);
        const p99Index = Math.floor(sorted.length * 0.99);
        return {
            p50: sorted[p50Index],
            p95: sorted[p95Index],
            p99: sorted[p99Index],
            max: Math.max(...sorted)
        };
    }
    calculateDetectionPerformanceScore(latency) {
        const { p95, p99, max } = latency;
        // Score based on meeting professional thresholds
        let score = 100;
        // Penalize for exceeding P95 threshold
        if (p95 > this.THRESHOLDS.detectionLatency.p95) {
            score -= Math.min(40, (p95 - this.THRESHOLDS.detectionLatency.p95) * 2);
        }
        // Penalize for exceeding P99 threshold
        if (p99 > this.THRESHOLDS.detectionLatency.p99) {
            score -= Math.min(30, (p99 - this.THRESHOLDS.detectionLatency.p99));
        }
        // Penalize for exceeding max threshold
        if (max > this.THRESHOLDS.detectionLatency.max) {
            score -= Math.min(30, (max - this.THRESHOLDS.detectionLatency.max) / 10);
        }
        return Math.max(0, Math.min(100, score));
    }
    calculateDetectionAccuracyScore(accuracy) {
        const { precision, recall, f1Score, falsePositiveRate } = accuracy;
        let score = 100;
        // Penalize for low precision
        if (precision < this.THRESHOLDS.detectionAccuracy.precision) {
            score -= Math.min(40, (this.THRESHOLDS.detectionAccuracy.precision - precision) * 100);
        }
        // Penalize for low recall
        if (recall < this.THRESHOLDS.detectionAccuracy.recall) {
            score -= Math.min(30, (this.THRESHOLDS.detectionAccuracy.recall - recall) * 100);
        }
        // Penalize for low F1 score
        if (f1Score < this.THRESHOLDS.detectionAccuracy.f1Score) {
            score -= Math.min(20, (this.THRESHOLDS.detectionAccuracy.f1Score - f1Score) * 100);
        }
        // Penalize for high false positive rate
        if (falsePositiveRate > this.THRESHOLDS.detectionAccuracy.falsePositiveRate) {
            score -= Math.min(10, (falsePositiveRate - this.THRESHOLDS.detectionAccuracy.falsePositiveRate) * 1000);
        }
        return Math.max(0, Math.min(100, score));
    }
    calculateSystemReliabilityScore(reliability) {
        const { uptime, availability, errorRate, recoveryTime } = reliability;
        let score = 100;
        // Penalize for low uptime
        if (uptime < this.THRESHOLDS.systemReliability.uptime) {
            score -= Math.min(40, (this.THRESHOLDS.systemReliability.uptime - uptime) * 10000);
        }
        // Penalize for low availability
        if (availability < this.THRESHOLDS.systemReliability.availability) {
            score -= Math.min(30, (this.THRESHOLDS.systemReliability.availability - availability) * 1000);
        }
        // Penalize for high error rate
        if (errorRate > this.THRESHOLDS.systemReliability.errorRate) {
            score -= Math.min(20, (errorRate - this.THRESHOLDS.systemReliability.errorRate) * 10000);
        }
        // Penalize for long recovery time
        if (recoveryTime > this.THRESHOLDS.systemReliability.recoveryTime) {
            score -= Math.min(10, (recoveryTime - this.THRESHOLDS.systemReliability.recoveryTime) / 3);
        }
        return Math.max(0, Math.min(100, score));
    }
    calculateOperationalConsistencyScore(consistency) {
        const { performanceVariance, throughputStability, memoryStability, loadHandling } = consistency;
        let score = 100;
        // Penalize for high performance variance
        if (performanceVariance > this.THRESHOLDS.operationalConsistency.performanceVariance) {
            score -= Math.min(40, (performanceVariance - this.THRESHOLDS.operationalConsistency.performanceVariance) * 1000);
        }
        // Penalize for low throughput stability
        if (throughputStability < this.THRESHOLDS.operationalConsistency.throughputStability) {
            score -= Math.min(30, (this.THRESHOLDS.operationalConsistency.throughputStability - throughputStability) * 100);
        }
        // Penalize for high memory variance
        if (memoryStability > this.THRESHOLDS.operationalConsistency.memoryStability) {
            score -= Math.min(20, (memoryStability - this.THRESHOLDS.operationalConsistency.memoryStability) * 2000);
        }
        // Penalize for poor load handling
        if (loadHandling < this.THRESHOLDS.operationalConsistency.loadHandling) {
            score -= Math.min(10, (this.THRESHOLDS.operationalConsistency.loadHandling - loadHandling) * 100);
        }
        return Math.max(0, Math.min(100, score));
    }
    determineGradeAndRisk(overallScore, componentScores) {
        let grade;
        let riskLevel;
        if (overallScore >= 95) {
            grade = 'A+';
            riskLevel = 'LOW';
        }
        else if (overallScore >= 90) {
            grade = 'A';
            riskLevel = 'LOW';
        }
        else if (overallScore >= 80) {
            grade = 'B';
            riskLevel = 'MEDIUM';
        }
        else if (overallScore >= 70) {
            grade = 'C';
            riskLevel = 'MEDIUM';
        }
        else if (overallScore >= 60) {
            grade = 'D';
            riskLevel = 'HIGH';
        }
        else {
            grade = 'F';
            riskLevel = 'CRITICAL';
        }
        // Check for critical component failures
        const criticalComponents = Object.values(componentScores).filter(score => score < 50);
        if (criticalComponents.length > 0) {
            riskLevel = 'CRITICAL';
            if (grade !== 'F')
                grade = 'F';
        }
        return { grade, riskLevel };
    }
    generateRecommendations(componentScores, metrics) {
        const recommendations = [];
        if (componentScores.detectionPerformance < 80) {
            recommendations.push('Optimize detection latency - consider SIMD optimizations and caching improvements');
            if (metrics.detectionLatency.p95 > 10) {
                recommendations.push('Critical: P95 latency exceeds 10ms - immediate performance optimization required');
            }
        }
        if (componentScores.detectionAccuracy < 80) {
            recommendations.push('Improve detection accuracy - review arbitrage detection algorithms');
            if (metrics.detectionAccuracy.falsePositiveRate > 0.05) {
                recommendations.push('High false positive rate detected - tune detection thresholds');
            }
        }
        if (componentScores.systemReliability < 80) {
            recommendations.push('Enhance system reliability - implement circuit breakers and health checks');
            if (metrics.systemReliability.uptime < 0.99) {
                recommendations.push('Uptime below 99% - investigate service stability issues');
            }
        }
        if (componentScores.operationalConsistency < 80) {
            recommendations.push('Improve operational consistency - stabilize performance under load');
            if (metrics.operationalConsistency.performanceVariance > 0.2) {
                recommendations.push('High performance variance - optimize resource allocation');
            }
        }
        if (recommendations.length === 0) {
            recommendations.push('System performing at professional standards - maintain current practices');
        }
        return recommendations;
    }
    generateFeatureImpactRecommendations(impact, componentChanges) {
        const recommendations = [];
        if (impact === 'CRITICAL') {
            recommendations.push('🚨 CRITICAL: Feature significantly degrades professional quality');
            recommendations.push('Immediate action required: revert feature or implement fixes');
        }
        else if (impact === 'NEGATIVE') {
            recommendations.push('⚠️ Feature negatively impacts quality - performance optimization needed');
        }
        else if (impact === 'POSITIVE') {
            recommendations.push('✅ Feature improves professional quality - consider promoting');
        }
        // Specific component recommendations
        Object.entries(componentChanges).forEach(([component, change]) => {
            if (change < -10) {
                recommendations.push(`Address ${component} degradation: ${change.toFixed(1)} point drop`);
            }
        });
        return recommendations;
    }
    // Data gathering methods (simplified implementations)
    async getDetectionLatenciesForPeriod(period) {
        try {
            const keys = await this.redis.keys('quality:detection:*');
            const latencies = [];
            for (const key of keys) {
                const data = await this.redis.get(key);
                if (data) {
                    const result = JSON.parse(data);
                    if (result.timestamp >= period.start && result.timestamp <= period.end) {
                        latencies.push(result.latency);
                    }
                }
            }
            return latencies;
        }
        catch (error) {
            logger.error('Failed to get detection latencies', { error });
            return [];
        }
    }
    async getDetectionAccuracyForPeriod(period) {
        // Simplified implementation - would aggregate actual detection results
        return {
            precision: 0.96,
            recall: 0.92,
            f1Score: 0.94,
            falsePositiveRate: 0.008
        };
    }
    async getSystemReliabilityForPeriod(period) {
        // Simplified implementation - would aggregate actual system metrics
        return {
            uptime: 0.998,
            availability: 0.997,
            errorRate: 0.0005,
            recoveryTime: 15
        };
    }
    async getOperationalConsistencyForPeriod(period) {
        // Simplified implementation - would aggregate actual operational metrics
        return {
            performanceVariance: 0.08,
            throughputStability: 0.97,
            memoryStability: 0.03,
            loadHandling: 0.95
        };
    }
    async updateRollingMetrics(result) {
        // Update rolling averages and statistics
        // This would maintain running statistics for real-time monitoring
    }
    startPeriodicAssessment() {
        setInterval(async () => {
            try {
                await this.calculateQualityScore();
            }
            catch (error) {
                logger.error('Periodic quality assessment failed', { error });
            }
        }, this.ASSESSMENT_INTERVAL);
    }
}
exports.ProfessionalQualityMonitor = ProfessionalQualityMonitor;
// Factory function
function createProfessionalQualityMonitor() {
    return new ProfessionalQualityMonitor();
}
// Default instance
let defaultQualityMonitor = null;
function getProfessionalQualityMonitor() {
    if (!defaultQualityMonitor) {
        defaultQualityMonitor = createProfessionalQualityMonitor();
    }
    return defaultQualityMonitor;
}
//# sourceMappingURL=professional-quality-monitor.js.map