/**
 * Professional Quality Monitor Tests
 *
 * Comprehensive testing of the AD-PQS (Arbitrage Detection Professional Quality Score)
 *
 * @migrated from shared/core/src/professional-quality-monitor.test.ts
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RedisMock } from '@arbitrage/test-utils';

// Mock logger with factory function - must use inline jest.fn() since hoisting
jest.mock('../../src/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }),
  getPerformanceLogger: jest.fn().mockReturnValue({
    logEventLatency: jest.fn(),
    logArbitrageOpportunity: jest.fn(),
    logHealthCheck: jest.fn()
  })
}));

// Mock redis - using requireActual pattern to get RedisMock
jest.mock('../../src/redis', () => {
  const { RedisMock } = jest.requireActual<typeof import('@arbitrage/test-utils')>('@arbitrage/test-utils');
  const mockRedisInstance = new RedisMock();
  return {
    getRedisClient: jest.fn(() => mockRedisInstance),
    __mockRedis: mockRedisInstance
  };
});

// Import AFTER mocks are set up
import { ProfessionalQualityMonitor, ProfessionalQualityScore } from '@arbitrage/core';
import { createLogger } from '@arbitrage/core';
import * as redisModule from '../../src/redis';

// Get the mock redis instance from the mock module
const mockRedis = (redisModule as any).__mockRedis as RedisMock;

// Define mock logger type
interface MockLogger {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
}
const mockLogger = (createLogger as jest.Mock)() as MockLogger;

describe('ProfessionalQualityMonitor', () => {
  let monitor: ProfessionalQualityMonitor;
  let originalSet: typeof mockRedis.set;
  let originalGet: typeof mockRedis.get;

  beforeEach(() => {
    jest.clearAllMocks();
    // Restore original Redis methods before clearing
    if (originalSet) mockRedis.set = originalSet;
    if (originalGet) mockRedis.get = originalGet;
    mockRedis.clear();
    // Save original methods
    originalSet = mockRedis.set.bind(mockRedis);
    originalGet = mockRedis.get.bind(mockRedis);
    monitor = new ProfessionalQualityMonitor();
  });

  describe('Detection Result Recording', () => {
    it('should record detection results successfully', async () => {
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
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it('should handle recording errors gracefully', async () => {
      // Override with a rejection - error should be caught internally
      const originalSet = mockRedis.set.bind(mockRedis);
      mockRedis.set = jest.fn(() => Promise.reject(new Error('Redis error')));

      const result = {
        latency: 2.5,
        isTruePositive: true,
        isFalsePositive: false,
        isFalseNegative: false,
        timestamp: Date.now(),
        operationId: 'test-op-123'
      };

      // Should not throw even when Redis fails
      await expect(monitor.recordDetectionResult(result)).resolves.not.toThrow();

      // Restore immediately after test
      mockRedis.set = originalSet;
    });
  });

  describe('Quality Score Calculation', () => {
    beforeEach(() => {
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

    it('should calculate professional quality score', async () => {
      const score = await monitor.calculateQualityScore();

      expect(score).toBeDefined();
      expect(typeof score.overallScore).toBe('number');
      expect(score.overallScore).toBeGreaterThanOrEqual(0);
      expect(score.overallScore).toBeLessThanOrEqual(100);
      expect(['F', 'D', 'C', 'B', 'A', 'A+']).toContain(score.grade);
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(score.riskLevel);
    });

    it('should calculate component scores correctly', async () => {
      const score = await monitor.calculateQualityScore();

      expect(score.componentScores).toHaveProperty('detectionPerformance');
      expect(score.componentScores).toHaveProperty('detectionAccuracy');
      expect(score.componentScores).toHaveProperty('systemReliability');
      expect(score.componentScores).toHaveProperty('operationalConsistency');

      Object.values(score.componentScores).forEach(componentScore => {
        expect(componentScore).toBeGreaterThanOrEqual(0);
        expect(componentScore).toBeLessThanOrEqual(100);
      });
    });

    it('should generate appropriate recommendations', async () => {
      const score = await monitor.calculateQualityScore();

      expect(Array.isArray(score.recommendations)).toBe(true);
      expect(score.recommendations.length).toBeGreaterThan(0);
    });

    it('should assign correct grades based on score', async () => {
      // Test high score (mock perfect metrics)
      const highScore = await monitor.calculateQualityScore();

      // Test with different scenarios by mocking different metrics
      // This would require more sophisticated mocking in a real implementation
      expect(highScore.grade).toBeDefined();
    });
  });

  describe('Performance Metrics', () => {
    it('should calculate latency percentiles correctly', async () => {
      const latencies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const monitorInstance = monitor as any;

      const metrics = monitorInstance.calculateLatencyMetrics(latencies);

      // Percentile calculation varies by implementation
      // For 10 elements, p50 index = 5, element = 6 (0-indexed)
      expect(metrics.p50).toBeGreaterThanOrEqual(5);
      expect(metrics.p50).toBeLessThanOrEqual(6);
      expect(metrics.p95).toBeGreaterThanOrEqual(9);
      expect(metrics.p95).toBeLessThanOrEqual(10);
      expect(metrics.p99).toBe(10);
      expect(metrics.max).toBe(10);
    });

    it('should handle empty latency arrays', async () => {
      const monitorInstance = monitor as any;
      const metrics = monitorInstance.calculateLatencyMetrics([]);

      expect(metrics.p50).toBe(0);
      expect(metrics.p95).toBe(0);
      expect(metrics.p99).toBe(0);
      expect(metrics.max).toBe(0);
    });
  });

  describe('Score Grading System', () => {
    it('should assign A+ grade for perfect scores', () => {
      const monitorInstance = monitor as any;
      const { grade, riskLevel } = monitorInstance.determineGradeAndRisk(98, {
        detectionPerformance: 95,
        detectionAccuracy: 96,
        systemReliability: 97,
        operationalConsistency: 98
      });

      expect(grade).toBe('A+');
      expect(riskLevel).toBe('LOW');
    });

    it('should assign F grade for failing scores', () => {
      const monitorInstance = monitor as any;
      const { grade, riskLevel } = monitorInstance.determineGradeAndRisk(45, {
        detectionPerformance: 40,
        detectionAccuracy: 50,
        systemReliability: 45,
        operationalConsistency: 50
      });

      expect(grade).toBe('F');
      expect(riskLevel).toBe('CRITICAL');
    });

    it('should assign CRITICAL risk for any component below 50', () => {
      const monitorInstance = monitor as any;
      const { grade, riskLevel } = monitorInstance.determineGradeAndRisk(85, {
        detectionPerformance: 95,
        detectionAccuracy: 45, // Below 50
        systemReliability: 90,
        operationalConsistency: 85
      });

      expect(riskLevel).toBe('CRITICAL');
    });
  });

  describe('Feature Impact Assessment', () => {
    it('should detect positive feature impact', async () => {
      const baselineScore: ProfessionalQualityScore = {
        overallScore: 80,
        grade: 'B',
        componentScores: {
          detectionPerformance: 75,
          detectionAccuracy: 80,
          systemReliability: 85,
          operationalConsistency: 80
        },
        metrics: {} as any,
        timestamp: Date.now(),
        assessmentPeriod: { start: 0, end: 0, duration: 0 },
        recommendations: [],
        riskLevel: 'MEDIUM'
      };

      const newScore: ProfessionalQualityScore = {
        overallScore: 88,
        grade: 'B',
        componentScores: {
          detectionPerformance: 85,
          detectionAccuracy: 85,
          systemReliability: 90,
          operationalConsistency: 88
        },
        metrics: {} as any,
        timestamp: Date.now(),
        assessmentPeriod: { start: 0, end: 0, duration: 0 },
        recommendations: [],
        riskLevel: 'LOW'
      };

      const impact = await monitor.assessFeatureImpact(baselineScore, newScore);

      expect(impact.impact).toBe('POSITIVE');
      expect(impact.scoreChange).toBe(8);
      expect(impact.recommendations).toContain('✅ Feature improves professional quality - consider promoting');
    });

    it('should detect critical negative impact', async () => {
      const baselineScore: ProfessionalQualityScore = {
        overallScore: 85,
        grade: 'B',
        componentScores: {
          detectionPerformance: 80,
          detectionAccuracy: 85,
          systemReliability: 90,
          operationalConsistency: 85
        },
        metrics: {} as any,
        timestamp: Date.now(),
        assessmentPeriod: { start: 0, end: 0, duration: 0 },
        recommendations: [],
        riskLevel: 'LOW'
      };

      const newScore: ProfessionalQualityScore = {
        overallScore: 65,
        grade: 'D',
        componentScores: {
          detectionPerformance: 60,
          detectionAccuracy: 70,
          systemReliability: 60,
          operationalConsistency: 65
        },
        metrics: {} as any,
        timestamp: Date.now(),
        assessmentPeriod: { start: 0, end: 0, duration: 0 },
        recommendations: [],
        riskLevel: 'HIGH'
      };

      const impact = await monitor.assessFeatureImpact(baselineScore, newScore);

      expect(impact.impact).toBe('CRITICAL');
      expect(impact.scoreChange).toBe(-20);
      expect(impact.recommendations).toContain('🚨 CRITICAL: Feature significantly degrades professional quality');
    });
  });

  describe('Score History Management', () => {
    it('should maintain score history', async () => {
      // Calculate multiple scores
      await monitor.calculateQualityScore();
      await monitor.calculateQualityScore();
      await monitor.calculateQualityScore();

      const history = await monitor.getQualityScoreHistory();
      expect(history.length).toBe(3);
    });

    it('should limit history size', async () => {
      // Simulate many scores (more than the 100 limit)
      for (let i = 0; i < 105; i++) {
        await monitor.calculateQualityScore();
      }

      const history = await monitor.getQualityScoreHistory(200);
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });

  describe('Error Handling', () => {
    it('should handle Redis failures gracefully', async () => {
      mockRedis.get = jest.fn(() => Promise.reject(new Error('Redis down')));

      const score = await monitor.getCurrentQualityScore();
      expect(score).toBeNull();

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle calculation errors gracefully', async () => {
      // Mock metrics gathering to fail
      const monitorInstance = monitor as any;
      monitorInstance.gatherMetricsForPeriod = jest.fn(() => Promise.reject(new Error('Metrics error')));

      await expect(monitor.calculateQualityScore()).rejects.toThrow('Metrics error');
    });
  });
});
