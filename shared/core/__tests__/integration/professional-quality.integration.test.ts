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
          latency: { p50: 5, p95: 10, p99: 15, max: 20 },
          accuracy: { precision: 0.7, recall: 0.65, f1Score: 0.675 },
          reliability: { uptime: 0.95, errorRate: 0.05 },
          consistency: { variance: 0.15 }
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
          latency: { p50: 3, p95: 7, p99: 10, max: 12 },
          accuracy: { precision: 0.85, recall: 0.82, f1Score: 0.835 },
          reliability: { uptime: 0.99, errorRate: 0.01 },
          consistency: { variance: 0.08 }
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
          latency: { p50: 2, p95: 5, p99: 8, max: 10 },
          accuracy: { precision: 0.92, recall: 0.90, f1Score: 0.91 },
          reliability: { uptime: 0.999, errorRate: 0.001 },
          consistency: { variance: 0.05 }
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
          latency: { p50: 15, p95: 30, p99: 50, max: 100 },
          accuracy: { precision: 0.55, recall: 0.50, f1Score: 0.524 },
          reliability: { uptime: 0.90, errorRate: 0.10 },
          consistency: { variance: 0.30 }
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
      // Simulate Redis failure
      mockRedis.get = jest.fn().mockRejectedValue(new Error('Connection refused'));

      // Should not throw
      const score = await monitor.getCurrentQualityScore();
      expect(score).toBeNull();
    });

    it('should recover from temporary Redis failures', async () => {
      let failCount = 0;

      // Fail first 2 calls, succeed after
      mockRedis.setex = jest.fn().mockImplementation((key, _ttl, value) => {
        failCount++;
        if (failCount <= 2) {
          return Promise.reject(new Error('Temporary failure'));
        }
        mockRedis.storage.set(key, value);
        return Promise.resolve('OK');
      });

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
    });
  });
});
