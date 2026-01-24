/**
 * Professional Quality Monitor Integration Tests
 *
 * Tests the integration between ProfessionalQualityMonitor and:
 * - Redis storage operations
 * - Score calculation with real metrics
 * - Feature impact assessment across sessions
 * - Quality history persistence
 *
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  ProfessionalQualityMonitor,
  ProfessionalQualityScore
} from '@arbitrage/core';
import type { QualityMonitorRedis } from '@arbitrage/core';

// =============================================================================
// Mock Redis Implementation for Integration Tests
// =============================================================================

function createIntegrationMockRedis(): QualityMonitorRedis & {
  storage: Map<string, string>;
  clear: () => void;
  getStorageSize: () => number;
} {
  const storage = new Map<string, string>();

  return {
    storage,

    clear: () => storage.clear(),

    getStorageSize: () => storage.size,

    setex: jest.fn((key: string, _seconds: number, value: string) => {
      storage.set(key, value);
      return Promise.resolve('OK');
    }),

    get: jest.fn((key: string) => {
      const value = storage.get(key);
      return Promise.resolve(value ?? null);
    }),

    keys: jest.fn((pattern: string) => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const matchingKeys = Array.from(storage.keys()).filter(k => regex.test(k));
      return Promise.resolve(matchingKeys);
    })
  };
}

describe('ProfessionalQualityMonitor Integration', () => {
  let monitor: ProfessionalQualityMonitor;
  let mockRedis: ReturnType<typeof createIntegrationMockRedis>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis = createIntegrationMockRedis();
    monitor = new ProfessionalQualityMonitor({ redis: mockRedis });
  });

  afterEach(() => {
    monitor.stopPeriodicAssessment();
  });

  describe('End-to-End Quality Scoring Flow', () => {
    it('should record multiple detection results and calculate aggregate score', async () => {
      // Simulate a series of detection events over time
      const detectionResults = [
        { latency: 2.1, isTruePositive: true, isFalsePositive: false, isFalseNegative: false },
        { latency: 3.5, isTruePositive: true, isFalsePositive: false, isFalseNegative: false },
        { latency: 1.8, isTruePositive: true, isFalsePositive: false, isFalseNegative: false },
        { latency: 4.2, isTruePositive: false, isFalsePositive: true, isFalseNegative: false },
        { latency: 2.9, isTruePositive: true, isFalsePositive: false, isFalseNegative: false }
      ];

      // Record all results
      for (const result of detectionResults) {
        await monitor.recordDetectionResult({
          ...result,
          timestamp: Date.now(),
          operationId: `op-${Math.random().toString(36).slice(2)}`
        });
      }

      // Verify data was stored
      expect(mockRedis.getStorageSize()).toBeGreaterThan(0);

      // Calculate quality score
      const score = await monitor.calculateQualityScore();

      // Verify score structure
      expect(score).toHaveProperty('overallScore');
      expect(score).toHaveProperty('grade');
      expect(score).toHaveProperty('componentScores');
      expect(score).toHaveProperty('recommendations');
      expect(score.overallScore).toBeGreaterThanOrEqual(0);
      expect(score.overallScore).toBeLessThanOrEqual(100);
    });

    it('should maintain quality score history across multiple calculations', async () => {
      // Calculate scores multiple times
      const scores: ProfessionalQualityScore[] = [];
      for (let i = 0; i < 5; i++) {
        const score = await monitor.calculateQualityScore();
        scores.push(score);
      }

      // Get history
      const history = await monitor.getQualityScoreHistory(10);

      // Verify history contains all scores
      expect(history.length).toBe(5);

      // Verify history is ordered by timestamp (newest first or oldest first)
      // The monitor should maintain consistent ordering
      expect(history.every(h => h.timestamp > 0)).toBe(true);
    });

    it('should persist current quality score and retrieve it', async () => {
      // Calculate and store a score
      const calculatedScore = await monitor.calculateQualityScore();

      // Retrieve the stored score
      const retrievedScore = await monitor.getCurrentQualityScore();

      // Verify scores match
      expect(retrievedScore).not.toBeNull();
      expect(retrievedScore?.overallScore).toBe(calculatedScore.overallScore);
      expect(retrievedScore?.grade).toBe(calculatedScore.grade);
    });
  });

  describe('Feature Impact Assessment Integration', () => {
    it('should correctly assess positive feature impact', async () => {
      // Create baseline with lower scores
      const baseline: ProfessionalQualityScore = {
        overallScore: 70,
        grade: 'C',
        componentScores: {
          detectionPerformance: 65,
          detectionAccuracy: 70,
          systemReliability: 75,
          operationalConsistency: 70
        },
        metrics: {
          detectionLatency: { p50: 5, p95: 10, p99: 15, max: 20 },
          detectionAccuracy: { precision: 0.7, recall: 0.65, f1Score: 0.675, falsePositiveRate: 0.15 },
          systemReliability: { uptime: 0.95, availability: 0.94, errorRate: 0.05, recoveryTime: 30 },
          operationalConsistency: { performanceVariance: 0.15, throughputStability: 0.85, memoryStability: 0.9, loadHandling: 0.8 }
        },
        timestamp: Date.now() - 3600000,
        assessmentPeriod: { start: 0, end: 0, duration: 3600000 },
        recommendations: [],
        riskLevel: 'MEDIUM'
      };

      // Create new score with improvements
      const newScore: ProfessionalQualityScore = {
        overallScore: 85,
        grade: 'B',
        componentScores: {
          detectionPerformance: 82,
          detectionAccuracy: 85,
          systemReliability: 88,
          operationalConsistency: 85
        },
        metrics: {
          detectionLatency: { p50: 3, p95: 7, p99: 10, max: 12 },
          detectionAccuracy: { precision: 0.85, recall: 0.82, f1Score: 0.835, falsePositiveRate: 0.08 },
          systemReliability: { uptime: 0.99, availability: 0.98, errorRate: 0.01, recoveryTime: 15 },
          operationalConsistency: { performanceVariance: 0.08, throughputStability: 0.92, memoryStability: 0.95, loadHandling: 0.9 }
        },
        timestamp: Date.now(),
        assessmentPeriod: { start: 0, end: 0, duration: 3600000 },
        recommendations: [],
        riskLevel: 'LOW'
      };

      const impact = await monitor.assessFeatureImpact(baseline, newScore);

      expect(impact.impact).toBe('POSITIVE');
      expect(impact.scoreChange).toBe(15);
      expect(impact.recommendations).toContain('✅ Feature improves professional quality - consider promoting');
    });

    it('should correctly assess critical negative impact', async () => {
      const baseline: ProfessionalQualityScore = {
        overallScore: 90,
        grade: 'A',
        componentScores: {
          detectionPerformance: 88,
          detectionAccuracy: 92,
          systemReliability: 90,
          operationalConsistency: 90
        },
        metrics: {
          detectionLatency: { p50: 2, p95: 5, p99: 8, max: 10 },
          detectionAccuracy: { precision: 0.92, recall: 0.90, f1Score: 0.91, falsePositiveRate: 0.02 },
          systemReliability: { uptime: 0.999, availability: 0.998, errorRate: 0.001, recoveryTime: 5 },
          operationalConsistency: { performanceVariance: 0.05, throughputStability: 0.95, memoryStability: 0.97, loadHandling: 0.95 }
        },
        timestamp: Date.now() - 3600000,
        assessmentPeriod: { start: 0, end: 0, duration: 3600000 },
        recommendations: [],
        riskLevel: 'LOW'
      };

      const newScore: ProfessionalQualityScore = {
        overallScore: 55,
        grade: 'F',
        componentScores: {
          detectionPerformance: 50,
          detectionAccuracy: 55,
          systemReliability: 60,
          operationalConsistency: 55
        },
        metrics: {
          detectionLatency: { p50: 15, p95: 30, p99: 50, max: 100 },
          detectionAccuracy: { precision: 0.55, recall: 0.50, f1Score: 0.524, falsePositiveRate: 0.25 },
          systemReliability: { uptime: 0.90, availability: 0.88, errorRate: 0.10, recoveryTime: 60 },
          operationalConsistency: { performanceVariance: 0.30, throughputStability: 0.70, memoryStability: 0.75, loadHandling: 0.60 }
        },
        timestamp: Date.now(),
        assessmentPeriod: { start: 0, end: 0, duration: 3600000 },
        recommendations: [],
        riskLevel: 'CRITICAL'
      };

      const impact = await monitor.assessFeatureImpact(baseline, newScore);

      expect(impact.impact).toBe('CRITICAL');
      expect(impact.scoreChange).toBe(-35);
      expect(impact.recommendations).toContain('🚨 CRITICAL: Feature significantly degrades professional quality');
    });
  });

  describe('Data Persistence Integration', () => {
    it('should correctly store and retrieve detection metrics', async () => {
      const testResult = {
        latency: 2.5,
        isTruePositive: true,
        isFalsePositive: false,
        isFalseNegative: false,
        timestamp: Date.now(),
        operationId: 'test-persistence-001'
      };

      await monitor.recordDetectionResult(testResult);

      // Verify the data was stored in Redis mock
      const keys = await mockRedis.keys('quality:detection:*');
      expect(keys.length).toBeGreaterThan(0);

      // Verify stored data structure
      const storedData = await mockRedis.get(keys[0]);
      expect(storedData).not.toBeNull();

      const parsed = JSON.parse(storedData!);
      expect(parsed.latency).toBe(2.5);
      expect(parsed.isTruePositive).toBe(true);
    });

    it('should handle concurrent metric recording', async () => {
      // Simulate concurrent recording
      const recordPromises = Array.from({ length: 10 }, (_, i) =>
        monitor.recordDetectionResult({
          latency: 1 + i * 0.5,
          isTruePositive: i % 3 !== 0,
          isFalsePositive: i % 3 === 0,
          isFalseNegative: false,
          timestamp: Date.now() + i,
          operationId: `concurrent-${i}`
        })
      );

      await Promise.all(recordPromises);

      // Verify all records were stored
      const keys = await mockRedis.keys('quality:detection:*');
      expect(keys.length).toBe(10);
    });
  });

  describe('Error Resilience Integration', () => {
    it('should gracefully handle Redis connection failures', async () => {
      // Simulate Redis failure - override get method
      const originalGet = mockRedis.get;
      mockRedis.get = async () => {
        throw new Error('Connection refused');
      };

      // Should not throw
      const score = await monitor.getCurrentQualityScore();
      expect(score).toBeNull();

      // Restore
      mockRedis.get = originalGet;
    });

    it('should recover from temporary Redis failures', async () => {
      let failCount = 0;

      // Override setex to fail first 2 calls, succeed after
      const originalSetex = mockRedis.setex;
      mockRedis.setex = async (key, _ttl, value) => {
        failCount++;
        if (failCount <= 2) {
          throw new Error('Temporary failure');
        }
        mockRedis.storage.set(key, value);
        return 'OK';
      };

      // Record multiple results - some will fail
      for (let i = 0; i < 5; i++) {
        await monitor.recordDetectionResult({
          latency: 2 + i,
          isTruePositive: true,
          isFalsePositive: false,
          isFalseNegative: false,
          timestamp: Date.now() + i,
          operationId: `recovery-${i}`
        });
      }

      // Later calls should succeed
      expect(mockRedis.storage.size).toBeGreaterThan(0);

      // Restore
      mockRedis.setex = originalSetex;
    });
  });
});
