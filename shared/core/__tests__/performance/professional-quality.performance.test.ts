/**
 * Professional Quality Monitor Performance Tests
 *
 * Tests the performance characteristics of the ProfessionalQualityMonitor:
 * - Metric recording throughput
 * - Score calculation latency
 * - Memory efficiency under load
 * - Concurrent operation handling
 *
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ProfessionalQualityMonitor } from '@arbitrage/core/analytics';
import type { QualityMonitorRedis } from '@arbitrage/core/analytics';

// =============================================================================
// Performance Test Configuration
// =============================================================================

const PERFORMANCE_THRESHOLDS = {
  // Maximum time for recording a single detection result (ms)
  recordingLatencyMax: 10,
  // Maximum time for calculating quality score (ms)
  scoreCalculationMax: 100,
  // Minimum throughput for concurrent recording (ops/sec)
  recordingThroughputMin: 100,
  // Maximum memory growth during sustained load (MB)
  memoryGrowthMax: 50
};

// =============================================================================
// High-Performance Mock Redis
// =============================================================================

function createPerformanceMockRedis(): QualityMonitorRedis & {
  storage: Map<string, string>;
  clear: () => void;
  operationCount: number;
} {
  const storage = new Map<string, string>();
  let operationCount = 0;

  return {
    storage,
    operationCount,

    clear: () => {
      storage.clear();
      operationCount = 0;
    },

    setex: jest.fn((key: string, _seconds: number, value: string) => {
      operationCount++;
      storage.set(key, value);
      return Promise.resolve('OK');
    }),

    get: jest.fn((key: string) => {
      operationCount++;
      const value = storage.get(key);
      return Promise.resolve(value ?? null);
    }),

    keys: jest.fn((pattern: string) => {
      operationCount++;
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const matchingKeys = Array.from(storage.keys()).filter(k => regex.test(k));
      return Promise.resolve(matchingKeys);
    }),

    scan: jest.fn((cursor: string, pattern: string, count: number) => {
      operationCount++;
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const allKeys = Array.from(storage.keys()).filter(k => regex.test(k));

      const cursorNum = parseInt(cursor, 10);
      const start = cursorNum;
      const end = Math.min(start + count, allKeys.length);
      const keys = allKeys.slice(start, end);
      const nextCursor = end < allKeys.length ? String(end) : '0';

      return Promise.resolve<[string, string[]]>([nextCursor, keys]);
    })
  };
}

describe('ProfessionalQualityMonitor Performance', () => {
  let monitor: ProfessionalQualityMonitor;
  let mockRedis: ReturnType<typeof createPerformanceMockRedis>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis = createPerformanceMockRedis();
    monitor = new ProfessionalQualityMonitor({ redis: mockRedis });
  });

  afterEach(() => {
    monitor.stopPeriodicAssessment();
  });

  describe('Recording Performance', () => {
    it('should record detection results within latency threshold', async () => {
      const iterations = 100;
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await monitor.recordDetectionResult({
          latency: 2 + Math.random() * 3,
          isTruePositive: Math.random() > 0.1,
          isFalsePositive: Math.random() < 0.1,
          isFalseNegative: false,
          timestamp: Date.now(),
          operationId: `perf-${i}`
        });
        latencies.push(performance.now() - start);
      }

      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);
      const p95Latency = latencies.sort((a, b) => a - b)[Math.floor(iterations * 0.95)];

      // Log performance metrics
      console.log(`Recording Performance: avg=${avgLatency.toFixed(2)}ms, p95=${p95Latency.toFixed(2)}ms, max=${maxLatency.toFixed(2)}ms`);

      expect(avgLatency).toBeLessThan(PERFORMANCE_THRESHOLDS.recordingLatencyMax);
      expect(p95Latency).toBeLessThan(PERFORMANCE_THRESHOLDS.recordingLatencyMax * 2);
    });

    it('should maintain throughput under concurrent load', async () => {
      const concurrency = 50;
      const operationsPerWorker = 20;
      const totalOperations = concurrency * operationsPerWorker;

      const start = performance.now();

      // Launch concurrent workers
      const workers = Array.from({ length: concurrency }, (_, workerId) =>
        (async () => {
          for (let i = 0; i < operationsPerWorker; i++) {
            await monitor.recordDetectionResult({
              latency: 1 + Math.random() * 5,
              isTruePositive: Math.random() > 0.15,
              isFalsePositive: Math.random() < 0.15,
              isFalseNegative: false,
              timestamp: Date.now(),
              operationId: `worker-${workerId}-op-${i}`
            });
          }
        })()
      );

      await Promise.all(workers);

      const duration = (performance.now() - start) / 1000; // seconds
      const throughput = totalOperations / duration;

      console.log(`Concurrent Recording: ${totalOperations} ops in ${duration.toFixed(2)}s = ${throughput.toFixed(0)} ops/sec`);

      expect(throughput).toBeGreaterThan(PERFORMANCE_THRESHOLDS.recordingThroughputMin);
    });
  });

  describe('Score Calculation Performance', () => {
    beforeEach(async () => {
      // Pre-populate with test data
      for (let i = 0; i < 1000; i++) {
        mockRedis.storage.set(`quality:detection:${Date.now() - i * 100}`, JSON.stringify({
          latency: 1 + Math.random() * 5,
          isTruePositive: Math.random() > 0.1,
          isFalsePositive: Math.random() < 0.1,
          timestamp: Date.now() - i * 100
        }));
      }
    });

    it('should calculate quality score within latency threshold', async () => {
      const iterations = 10;
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await monitor.calculateQualityScore();
        latencies.push(performance.now() - start);
      }

      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);

      console.log(`Score Calculation: avg=${avgLatency.toFixed(2)}ms, max=${maxLatency.toFixed(2)}ms`);

      expect(avgLatency).toBeLessThan(PERFORMANCE_THRESHOLDS.scoreCalculationMax);
    });

    it('should efficiently retrieve quality history', async () => {
      // Calculate and store multiple scores
      for (let i = 0; i < 50; i++) {
        await monitor.calculateQualityScore();
      }

      const start = performance.now();
      const history = await monitor.getQualityScoreHistory(100);
      const duration = performance.now() - start;

      console.log(`History Retrieval: ${history.length} scores in ${duration.toFixed(2)}ms`);

      expect(duration).toBeLessThan(50); // Should be very fast
      expect(history.length).toBe(50);
    });
  });

  describe('Memory Efficiency', () => {
    it('should not leak memory during sustained operations', async () => {
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const initialMemory = process.memoryUsage().heapUsed / 1024 / 1024; // MB

      // Perform sustained operations
      for (let batch = 0; batch < 10; batch++) {
        for (let i = 0; i < 100; i++) {
          await monitor.recordDetectionResult({
            latency: Math.random() * 10,
            isTruePositive: Math.random() > 0.1,
            isFalsePositive: Math.random() < 0.1,
            isFalseNegative: false,
            timestamp: Date.now(),
            operationId: `mem-test-${batch}-${i}`
          });
        }

        // Calculate score periodically
        await monitor.calculateQualityScore();
      }

      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed / 1024 / 1024; // MB
      const memoryGrowth = finalMemory - initialMemory;

      console.log(`Memory: initial=${initialMemory.toFixed(2)}MB, final=${finalMemory.toFixed(2)}MB, growth=${memoryGrowth.toFixed(2)}MB`);

      // Memory growth should be bounded
      expect(memoryGrowth).toBeLessThan(PERFORMANCE_THRESHOLDS.memoryGrowthMax);
    });
  });

  describe('Feature Impact Assessment Performance', () => {
    it('should assess feature impact efficiently', async () => {
      const baselineScore = {
        overallScore: 80,
        grade: 'B' as const,
        componentScores: {
          detectionPerformance: 75,
          detectionAccuracy: 80,
          systemReliability: 85,
          operationalConsistency: 80
        },
        metrics: {
          detectionLatency: { p50: 3, p95: 8, p99: 12, max: 15 },
          detectionAccuracy: { precision: 0.8, recall: 0.75, f1Score: 0.774, falsePositiveRate: 0.05 },
          systemReliability: { uptime: 0.98, availability: 0.99, errorRate: 0.02, recoveryTime: 5 },
          operationalConsistency: { performanceVariance: 0.1, throughputStability: 0.95, memoryStability: 0.98, loadHandling: 0.9 }
        },
        timestamp: Date.now() - 3600000,
        assessmentPeriod: { start: 0, end: 0, duration: 3600000 },
        recommendations: [] as string[],
        riskLevel: 'MEDIUM' as const
      };

      const newScore = {
        ...baselineScore,
        overallScore: 85,
        timestamp: Date.now()
      };

      const iterations = 100;
      const latencies: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await monitor.assessFeatureImpact(baselineScore, newScore);
        latencies.push(performance.now() - start);
      }

      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      console.log(`Impact Assessment: avg=${avgLatency.toFixed(2)}ms over ${iterations} iterations`);

      expect(avgLatency).toBeLessThan(5); // Should be very fast
    });
  });

  describe('Scalability', () => {
    it('should handle large volumes of historical data', async () => {
      // Populate with large dataset
      const dataPoints = 10000;
      for (let i = 0; i < dataPoints; i++) {
        mockRedis.storage.set(`quality:detection:${Date.now() - i * 10}`, JSON.stringify({
          latency: 1 + Math.random() * 10,
          isTruePositive: Math.random() > 0.1,
          timestamp: Date.now() - i * 10
        }));
      }

      console.log(`Populated with ${dataPoints} data points`);

      const start = performance.now();
      const score = await monitor.calculateQualityScore();
      const duration = performance.now() - start;

      console.log(`Large Dataset Score Calculation: ${duration.toFixed(2)}ms`);

      expect(score).toBeDefined();
      expect(duration).toBeLessThan(500); // Should complete in reasonable time
    });
  });
});
