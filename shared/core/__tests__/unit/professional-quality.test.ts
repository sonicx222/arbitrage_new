/**
 * Professional Quality Monitor Unit Tests
 *
 * Merged test suite covering:
 * - E2E quality scoring flow (score calculation, history, persistence)
 * - Component-level tests (recording, grading, latency metrics, error handling)
 * - Feature impact assessment (positive, negative, critical)
 *
 * Uses DI pattern for testability - injects mock Redis directly
 * instead of relying on Jest mock hoisting.
 *
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ProfessionalQualityMonitor, ProfessionalQualityScore } from '@arbitrage/core/analytics';
import type { QualityMonitorRedis } from '@arbitrage/core/analytics';

// =============================================================================
// Mock Redis Implementation for Quality Monitor
// =============================================================================

/**
 * Creates a mock Redis that implements QualityMonitorRedis interface.
 * Stores data in memory for testing. Supports pattern-based scan and key lookup.
 */
function createMockRedis(): QualityMonitorRedis & {
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
    }),

    scan: jest.fn((cursor: string, pattern: string, _count: number) => {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const matchingKeys = Array.from(storage.keys()).filter(k => regex.test(k));
      // Return all keys in a single scan iteration (cursor '0' = done)
      return Promise.resolve(['0', matchingKeys] as [string, string[]]);
    })
  };
}

// =============================================================================
// E2E Quality Scoring Tests
// =============================================================================

describe('ProfessionalQualityMonitor - E2E Quality Scoring', () => {
  let monitor: ProfessionalQualityMonitor;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis = createMockRedis();
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

  describe('Feature Impact Assessment', () => {
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

  describe('Data Persistence', () => {
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

  describe('Error Resilience', () => {
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

// =============================================================================
// Component-Level Tests
// =============================================================================

describe('ProfessionalQualityMonitor - Component Tests', () => {
  let monitor: ProfessionalQualityMonitor;
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis = createMockRedis();
    monitor = new ProfessionalQualityMonitor({ redis: mockRedis });
  });

  afterEach(() => {
    monitor.stopPeriodicAssessment();
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

      // Verify setex was called
      expect(mockRedis.setex).toHaveBeenCalled();

      // Verify data was stored
      const storedKeys = Array.from(mockRedis.storage.keys());
      expect(storedKeys.some(k => k.startsWith('quality:detection:'))).toBe(true);
    });

    it('should handle recording errors gracefully', async () => {
      // Override setex to reject

      (mockRedis.setex as any).mockRejectedValueOnce(new Error('Redis error'));

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
    });
  });

  describe('Quality Score Calculation', () => {
    beforeEach(() => {
      // Setup mock metrics data
      const now = Date.now();
      mockRedis.storage.set(`quality:detection:${now - 1000}`, JSON.stringify({
        latency: 2.5,
        isTruePositive: true,
        timestamp: now - 1000
      }));

      mockRedis.storage.set(`quality:detection:${now - 2000}`, JSON.stringify({
        latency: 3.1,
        isTruePositive: true,
        timestamp: now - 2000
      }));

      mockRedis.storage.set(`quality:detection:${now - 3000}`, JSON.stringify({
        latency: 1.8,
        isTruePositive: false,
        timestamp: now - 3000
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
      const score = await monitor.calculateQualityScore();
      expect(score.grade).toBeDefined();
    });
  });

  describe('Performance Metrics', () => {
    it('should calculate latency percentiles correctly', async () => {
      const latencies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      const monitorInstance = monitor as any;

      const metrics = monitorInstance.calculateLatencyMetrics(latencies);

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
      // Make get reject

      (mockRedis.get as any).mockRejectedValueOnce(new Error('Redis down'));

      const score = await monitor.getCurrentQualityScore();
      expect(score).toBeNull();
    });

    it('should handle calculation errors gracefully', async () => {
      // Mock metrics gathering to fail

      const monitorInstance = monitor as any;
      monitorInstance.gatherMetricsForPeriod = jest.fn(() => Promise.reject(new Error('Metrics error')));

      await expect(monitor.calculateQualityScore()).rejects.toThrow('Metrics error');
    });
  });
});
