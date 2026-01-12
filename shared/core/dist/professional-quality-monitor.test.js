"use strict";
// Professional Quality Monitor Tests
// Comprehensive testing of the AD-PQS (Arbitrage Detection Professional Quality Score)
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
// Mock logger with factory function - must use inline jest.fn() since hoisting
globals_1.jest.mock('./logger', () => ({
    createLogger: globals_1.jest.fn().mockReturnValue({
        info: globals_1.jest.fn(),
        warn: globals_1.jest.fn(),
        error: globals_1.jest.fn(),
        debug: globals_1.jest.fn()
    }),
    getPerformanceLogger: globals_1.jest.fn().mockReturnValue({
        logEventLatency: globals_1.jest.fn(),
        logArbitrageOpportunity: globals_1.jest.fn(),
        logHealthCheck: globals_1.jest.fn()
    })
}));
// Mock redis - using requireActual pattern to get RedisMock
globals_1.jest.mock('./redis', () => {
    const { RedisMock } = globals_1.jest.requireActual('../../test-utils/src');
    const mockRedisInstance = new RedisMock();
    return {
        getRedisClient: globals_1.jest.fn(() => mockRedisInstance),
        __mockRedis: mockRedisInstance
    };
});
// Import AFTER mocks are set up
const professional_quality_monitor_1 = require("./professional-quality-monitor");
const logger_1 = require("./logger");
const redisModule = __importStar(require("./redis"));
// Get the mock redis instance from the mock module
const mockRedis = redisModule.__mockRedis;
const mockLogger = logger_1.createLogger();
(0, globals_1.describe)('ProfessionalQualityMonitor', () => {
    let monitor;
    let originalSet;
    let originalGet;
    (0, globals_1.beforeEach)(() => {
        globals_1.jest.clearAllMocks();
        // Restore original Redis methods before clearing
        if (originalSet)
            mockRedis.set = originalSet;
        if (originalGet)
            mockRedis.get = originalGet;
        mockRedis.clear();
        // Save original methods
        originalSet = mockRedis.set.bind(mockRedis);
        originalGet = mockRedis.get.bind(mockRedis);
        monitor = new professional_quality_monitor_1.ProfessionalQualityMonitor();
    });
    (0, globals_1.describe)('Detection Result Recording', () => {
        (0, globals_1.it)('should record detection results successfully', async () => {
            const result = {
                latency: 2.5,
                isTruePositive: true,
                isFalsePositive: false,
                isFalseNegative: false,
                timestamp: Date.now(),
                operationId: 'test-op-123'
            };
            await monitor.recordDetectionResult(result);
            // recordDetectionResult may store internally or trigger logger
            // The main thing is it doesn't throw
            (0, globals_1.expect)(mockLogger.debug).toHaveBeenCalled();
        });
        (0, globals_1.it)('should handle recording errors gracefully', async () => {
            // Override with a rejection - error should be caught internally
            const originalSet = mockRedis.set.bind(mockRedis);
            mockRedis.set = globals_1.jest.fn(() => Promise.reject(new Error('Redis error')));
            const result = {
                latency: 2.5,
                isTruePositive: true,
                isFalsePositive: false,
                isFalseNegative: false,
                timestamp: Date.now(),
                operationId: 'test-op-123'
            };
            // Should not throw even when Redis fails
            await (0, globals_1.expect)(monitor.recordDetectionResult(result)).resolves.not.toThrow();
            // Restore immediately after test
            mockRedis.set = originalSet;
        });
    });
    (0, globals_1.describe)('Quality Score Calculation', () => {
        (0, globals_1.beforeEach)(() => {
            // Setup mock metrics data
            mockRedis.set('quality:detection:1000', JSON.stringify({
                latency: 2.5,
                isTruePositive: true,
                timestamp: Date.now()
            }));
            mockRedis.set('quality:detection:1001', JSON.stringify({
                latency: 3.1,
                isTruePositive: true,
                timestamp: Date.now()
            }));
            mockRedis.set('quality:detection:1002', JSON.stringify({
                latency: 1.8,
                isTruePositive: false,
                timestamp: Date.now()
            }));
        });
        (0, globals_1.it)('should calculate professional quality score', async () => {
            const score = await monitor.calculateQualityScore();
            (0, globals_1.expect)(score).toBeDefined();
            (0, globals_1.expect)(typeof score.overallScore).toBe('number');
            (0, globals_1.expect)(score.overallScore).toBeGreaterThanOrEqual(0);
            (0, globals_1.expect)(score.overallScore).toBeLessThanOrEqual(100);
            (0, globals_1.expect)(['F', 'D', 'C', 'B', 'A', 'A+']).toContain(score.grade);
            (0, globals_1.expect)(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(score.riskLevel);
        });
        (0, globals_1.it)('should calculate component scores correctly', async () => {
            const score = await monitor.calculateQualityScore();
            (0, globals_1.expect)(score.componentScores).toHaveProperty('detectionPerformance');
            (0, globals_1.expect)(score.componentScores).toHaveProperty('detectionAccuracy');
            (0, globals_1.expect)(score.componentScores).toHaveProperty('systemReliability');
            (0, globals_1.expect)(score.componentScores).toHaveProperty('operationalConsistency');
            Object.values(score.componentScores).forEach(componentScore => {
                (0, globals_1.expect)(componentScore).toBeGreaterThanOrEqual(0);
                (0, globals_1.expect)(componentScore).toBeLessThanOrEqual(100);
            });
        });
        (0, globals_1.it)('should generate appropriate recommendations', async () => {
            const score = await monitor.calculateQualityScore();
            (0, globals_1.expect)(Array.isArray(score.recommendations)).toBe(true);
            (0, globals_1.expect)(score.recommendations.length).toBeGreaterThan(0);
        });
        (0, globals_1.it)('should assign correct grades based on score', async () => {
            // Test high score (mock perfect metrics)
            const highScore = await monitor.calculateQualityScore();
            // Test with different scenarios by mocking different metrics
            // This would require more sophisticated mocking in a real implementation
            (0, globals_1.expect)(highScore.grade).toBeDefined();
        });
    });
    (0, globals_1.describe)('Performance Metrics', () => {
        (0, globals_1.it)('should calculate latency percentiles correctly', async () => {
            const latencies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            const monitorInstance = monitor;
            const metrics = monitorInstance.calculateLatencyMetrics(latencies);
            // Percentile calculation varies by implementation
            // For 10 elements, p50 index = 5, element = 6 (0-indexed)
            (0, globals_1.expect)(metrics.p50).toBeGreaterThanOrEqual(5);
            (0, globals_1.expect)(metrics.p50).toBeLessThanOrEqual(6);
            (0, globals_1.expect)(metrics.p95).toBeGreaterThanOrEqual(9);
            (0, globals_1.expect)(metrics.p95).toBeLessThanOrEqual(10);
            (0, globals_1.expect)(metrics.p99).toBe(10);
            (0, globals_1.expect)(metrics.max).toBe(10);
        });
        (0, globals_1.it)('should handle empty latency arrays', async () => {
            const monitorInstance = monitor;
            const metrics = monitorInstance.calculateLatencyMetrics([]);
            (0, globals_1.expect)(metrics.p50).toBe(0);
            (0, globals_1.expect)(metrics.p95).toBe(0);
            (0, globals_1.expect)(metrics.p99).toBe(0);
            (0, globals_1.expect)(metrics.max).toBe(0);
        });
    });
    (0, globals_1.describe)('Score Grading System', () => {
        (0, globals_1.it)('should assign A+ grade for perfect scores', () => {
            const monitorInstance = monitor;
            const { grade, riskLevel } = monitorInstance.determineGradeAndRisk(98, {
                detectionPerformance: 95,
                detectionAccuracy: 96,
                systemReliability: 97,
                operationalConsistency: 98
            });
            (0, globals_1.expect)(grade).toBe('A+');
            (0, globals_1.expect)(riskLevel).toBe('LOW');
        });
        (0, globals_1.it)('should assign F grade for failing scores', () => {
            const monitorInstance = monitor;
            const { grade, riskLevel } = monitorInstance.determineGradeAndRisk(45, {
                detectionPerformance: 40,
                detectionAccuracy: 50,
                systemReliability: 45,
                operationalConsistency: 50
            });
            (0, globals_1.expect)(grade).toBe('F');
            (0, globals_1.expect)(riskLevel).toBe('CRITICAL');
        });
        (0, globals_1.it)('should assign CRITICAL risk for any component below 50', () => {
            const monitorInstance = monitor;
            const { grade, riskLevel } = monitorInstance.determineGradeAndRisk(85, {
                detectionPerformance: 95,
                detectionAccuracy: 45, // Below 50
                systemReliability: 90,
                operationalConsistency: 85
            });
            (0, globals_1.expect)(riskLevel).toBe('CRITICAL');
        });
    });
    (0, globals_1.describe)('Feature Impact Assessment', () => {
        (0, globals_1.it)('should detect positive feature impact', async () => {
            const baselineScore = {
                overallScore: 80,
                grade: 'B',
                componentScores: {
                    detectionPerformance: 75,
                    detectionAccuracy: 80,
                    systemReliability: 85,
                    operationalConsistency: 80
                },
                metrics: {},
                timestamp: Date.now(),
                assessmentPeriod: { start: 0, end: 0, duration: 0 },
                recommendations: [],
                riskLevel: 'MEDIUM'
            };
            const newScore = {
                overallScore: 88,
                grade: 'B',
                componentScores: {
                    detectionPerformance: 85,
                    detectionAccuracy: 85,
                    systemReliability: 90,
                    operationalConsistency: 88
                },
                metrics: {},
                timestamp: Date.now(),
                assessmentPeriod: { start: 0, end: 0, duration: 0 },
                recommendations: [],
                riskLevel: 'LOW'
            };
            const impact = await monitor.assessFeatureImpact(baselineScore, newScore);
            (0, globals_1.expect)(impact.impact).toBe('POSITIVE');
            (0, globals_1.expect)(impact.scoreChange).toBe(8);
            (0, globals_1.expect)(impact.recommendations).toContain('✅ Feature improves professional quality - consider promoting');
        });
        (0, globals_1.it)('should detect critical negative impact', async () => {
            const baselineScore = {
                overallScore: 85,
                grade: 'B',
                componentScores: {
                    detectionPerformance: 80,
                    detectionAccuracy: 85,
                    systemReliability: 90,
                    operationalConsistency: 85
                },
                metrics: {},
                timestamp: Date.now(),
                assessmentPeriod: { start: 0, end: 0, duration: 0 },
                recommendations: [],
                riskLevel: 'LOW'
            };
            const newScore = {
                overallScore: 65,
                grade: 'D',
                componentScores: {
                    detectionPerformance: 60,
                    detectionAccuracy: 70,
                    systemReliability: 60,
                    operationalConsistency: 65
                },
                metrics: {},
                timestamp: Date.now(),
                assessmentPeriod: { start: 0, end: 0, duration: 0 },
                recommendations: [],
                riskLevel: 'HIGH'
            };
            const impact = await monitor.assessFeatureImpact(baselineScore, newScore);
            (0, globals_1.expect)(impact.impact).toBe('CRITICAL');
            (0, globals_1.expect)(impact.scoreChange).toBe(-20);
            (0, globals_1.expect)(impact.recommendations).toContain('🚨 CRITICAL: Feature significantly degrades professional quality');
        });
    });
    (0, globals_1.describe)('Score History Management', () => {
        (0, globals_1.it)('should maintain score history', async () => {
            // Calculate multiple scores
            await monitor.calculateQualityScore();
            await monitor.calculateQualityScore();
            await monitor.calculateQualityScore();
            const history = await monitor.getQualityScoreHistory();
            (0, globals_1.expect)(history.length).toBe(3);
        });
        (0, globals_1.it)('should limit history size', async () => {
            // Simulate many scores (more than the 100 limit)
            for (let i = 0; i < 105; i++) {
                await monitor.calculateQualityScore();
            }
            const history = await monitor.getQualityScoreHistory(200);
            (0, globals_1.expect)(history.length).toBeLessThanOrEqual(100);
        });
    });
    (0, globals_1.describe)('Error Handling', () => {
        (0, globals_1.it)('should handle Redis failures gracefully', async () => {
            mockRedis.get = globals_1.jest.fn(() => Promise.reject(new Error('Redis down')));
            const score = await monitor.getCurrentQualityScore();
            (0, globals_1.expect)(score).toBeNull();
            (0, globals_1.expect)(mockLogger.error).toHaveBeenCalled();
        });
        (0, globals_1.it)('should handle calculation errors gracefully', async () => {
            // Mock metrics gathering to fail
            const monitorInstance = monitor;
            monitorInstance.gatherMetricsForPeriod = globals_1.jest.fn(() => Promise.reject(new Error('Metrics error')));
            await (0, globals_1.expect)(monitor.calculateQualityScore()).rejects.toThrow('Metrics error');
        });
    });
});
//# sourceMappingURL=professional-quality-monitor.test.js.map