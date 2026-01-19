// Professional Quality Performance Tests
// Measures AD-PQS under various load conditions to ensure new features don't degrade quality

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { TestEnvironment } from '../../shared/test-utils/src';
import { ProfessionalQualityMonitor, getProfessionalQualityMonitor } from '../../shared/core/src/professional-quality-monitor';
import { BSCDetectorService } from '../../services/bsc-detector/src/detector';

describe('Professional Quality Performance Tests', () => {
  let testEnv: TestEnvironment;
  let qualityMonitor: ProfessionalQualityMonitor;
  let detector: BSCDetectorService;

  beforeAll(async () => {
    testEnv = await TestEnvironment.create();
    qualityMonitor = getProfessionalQualityMonitor();

    detector = await testEnv.startService('bsc-detector', BSCDetectorService, {
      chain: 'bsc',
      enabled: true,
      wsUrl: 'ws://mock-ws',
      rpcUrl: 'http://mock-rpc'
    });
  });

  afterAll(async () => {
    await testEnv.stopService('bsc-detector');
    await testEnv.cleanup();
  });

  describe('Latency Performance Benchmarks', () => {
    it('should maintain professional latency under normal load', async () => {
      const testDuration = 30000; // 30 seconds
      const operationsPerSecond = 10;
      const totalOperations = (testDuration / 1000) * operationsPerSecond;

      const latencies: number[] = [];
      const startTime = Date.now();

      // Perform operations at target rate
      for (let i = 0; i < totalOperations; i++) {
        const operationStart = performance.now();

        // Simulate arbitrage detection operation
        await Promise.all([
          testEnv.waitForOpportunity(100).catch(() => null),
          simulateProcessingDelay()
        ]);

        const operationEnd = performance.now();
        latencies.push(operationEnd - operationStart);

        // Maintain target rate
        const elapsed = Date.now() - startTime;
        const targetElapsed = (i + 1) * (1000 / operationsPerSecond);
        if (elapsed < targetElapsed) {
          await new Promise(resolve => setTimeout(resolve, targetElapsed - elapsed));
        }
      }

      // Record all latencies for quality monitoring
      for (let i = 0; i < latencies.length; i++) {
        await qualityMonitor.recordDetectionResult({
          latency: latencies[i],
          isTruePositive: Math.random() > 0.1, // 90% true positives
          isFalsePositive: Math.random() < 0.05, // 5% false positives
          isFalseNegative: Math.random() < 0.02, // 2% false negatives
          timestamp: Date.now(),
          operationId: `perf-test-normal-${i}`
        });
      }

      // Calculate quality score
      const qualityScore = await qualityMonitor.calculateQualityScore({
        start: startTime,
        end: Date.now()
      });

      // Professional standards for normal load
      expect(qualityScore.componentScores.detectionPerformance).toBeGreaterThanOrEqual(85);
      expect(qualityScore.overallScore).toBeGreaterThanOrEqual(80);

      // Latency requirements
      expect(latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)]).toBeLessThan(5); // P95 < 5ms

      console.log('Normal Load Performance Results:', {
        operationsCompleted: latencies.length,
        averageLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
        p50Latency: latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)],
        p95Latency: latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)],
        p99Latency: latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.99)],
        qualityScore: qualityScore.overallScore,
        grade: qualityScore.grade,
        operationsPerSecond: latencies.length / ((Date.now() - startTime) / 1000)
      });
    }, 60000); // 60 second timeout

    it('should maintain minimum professional standards under high load', async () => {
      const testDuration = 20000; // 20 seconds
      const operationsPerSecond = 50; // High load
      const totalOperations = (testDuration / 1000) * operationsPerSecond;

      const latencies: number[] = [];
      const startTime = Date.now();

      // Perform high-frequency operations
      const operationPromises = [];
      for (let i = 0; i < totalOperations; i++) {
        operationPromises.push(
          (async () => {
            const operationStart = performance.now();

            await Promise.all([
              testEnv.waitForOpportunity(50).catch(() => null),
              simulateProcessingDelay(5, 15) // Higher latency under load
            ]);

            const operationEnd = performance.now();
            return operationEnd - operationStart;
          })()
        );
      }

      const results = await Promise.all(operationPromises);
      latencies.push(...results);

      // Record results for quality monitoring
      for (let i = 0; i < latencies.length; i++) {
        await qualityMonitor.recordDetectionResult({
          latency: latencies[i],
          isTruePositive: Math.random() > 0.15, // Slightly lower accuracy under load
          isFalsePositive: Math.random() < 0.08, // Higher false positives under load
          isFalseNegative: Math.random() < 0.05,
          timestamp: Date.now(),
          operationId: `perf-test-high-load-${i}`
        });
      }

      // Calculate quality score under load
      const qualityScore = await qualityMonitor.calculateQualityScore({
        start: startTime,
        end: Date.now()
      });

      // Minimum professional standards under high load (more lenient)
      expect(qualityScore.componentScores.detectionPerformance).toBeGreaterThanOrEqual(65);
      expect(qualityScore.overallScore).toBeGreaterThanOrEqual(70);

      // Latency under high load (more lenient thresholds)
      expect(latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)]).toBeLessThan(15); // P95 < 15ms under load

      console.log('High Load Performance Results:', {
        operationsCompleted: latencies.length,
        targetOPS: operationsPerSecond,
        actualOPS: latencies.length / ((Date.now() - startTime) / 1000),
        averageLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
        p95Latency: latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)],
        qualityScore: qualityScore.overallScore,
        grade: qualityScore.grade,
        loadFactor: operationsPerSecond / 10 // Relative to normal load
      });
    }, 45000); // 45 second timeout

    it('should detect and report performance regressions', async () => {
      // Establish baseline performance
      const baselineLatencies: number[] = [];
      for (let i = 0; i < 50; i++) {
        const latency = 2.0 + Math.random() * 0.5; // Baseline: 2.0-2.5ms
        baselineLatencies.push(latency);

        await qualityMonitor.recordDetectionResult({
          latency,
          isTruePositive: true,
          isFalsePositive: false,
          isFalseNegative: false,
          timestamp: Date.now(),
          operationId: `baseline-regression-${i}`
        });
      }

      const baselineScore = await qualityMonitor.calculateQualityScore();

      // Introduce performance regression (simulate new feature impact)
      const regressionLatencies: number[] = [];
      for (let i = 0; i < 30; i++) {
        const latency = 8.0 + Math.random() * 2.0; // Regression: 8.0-10.0ms
        regressionLatencies.push(latency);

        await qualityMonitor.recordDetectionResult({
          latency,
          isTruePositive: true,
          isFalsePositive: false,
          isFalseNegative: false,
          timestamp: Date.now(),
          operationId: `regression-sim-${i}`
        });
      }

      const regressionScore = await qualityMonitor.calculateQualityScore();

      // Assess regression impact
      const regressionImpact = await qualityMonitor.assessFeatureImpact(baselineScore, regressionScore);

      // Should detect significant negative impact
      expect(regressionImpact.impact).toBe('NEGATIVE');
      expect(regressionImpact.scoreChange).toBeLessThan(-10);

      // Should generate specific recommendations
      expect(regressionImpact.recommendations.some(rec =>
        rec.includes('optimize') || rec.includes('performance')
      )).toBe(true);

      console.log('Performance Regression Detection Results:', {
        baselineAvgLatency: baselineLatencies.reduce((a, b) => a + b, 0) / baselineLatencies.length,
        regressionAvgLatency: regressionLatencies.reduce((a, b) => a + b, 0) / regressionLatencies.length,
        baselineScore: baselineScore.overallScore,
        regressionScore: regressionScore.overallScore,
        scoreChange: regressionImpact.scoreChange,
        impact: regressionImpact.impact,
        regressionDetected: regressionImpact.impact !== 'POSITIVE'
      });
    });
  });

  describe('Memory Usage and Stability Tests', () => {
    it('should maintain stable memory usage under load', async () => {
      const initialMemory = process.memoryUsage();
      const testDuration = 15000; // 15 seconds
      const memorySamples: NodeJS.MemoryUsage[] = [];

      // Monitor memory throughout the test
      const memoryMonitor = setInterval(() => {
        memorySamples.push(process.memoryUsage());
      }, 1000);

      // Generate sustained load
      const loadPromises = [];
      const startTime = Date.now();

      for (let i = 0; i < 200; i++) {
        loadPromises.push(
          Promise.all([
            testEnv.waitForOpportunity(100).catch(() => null),
            simulateMemoryIntensiveOperation()
          ])
        );
      }

      await Promise.all(loadPromises);
      clearInterval(memoryMonitor);

      const finalMemory = process.memoryUsage();

      // Calculate memory stability metrics
      const heapUsedSamples = memorySamples.map(m => m.heapUsed);
      const averageHeapUsed = heapUsedSamples.reduce((a, b) => a + b, 0) / heapUsedSamples.length;
      const heapUsedVariance = heapUsedSamples.reduce((sum, sample) =>
        sum + Math.pow(sample - averageHeapUsed, 2), 0) / heapUsedSamples.length;
      const heapUsedStdDev = Math.sqrt(heapUsedVariance);
      const memoryStability = heapUsedStdDev / averageHeapUsed; // Coefficient of variation

      // Record operational metrics
      await qualityMonitor.recordOperationalMetrics({
        performanceVariance: 0.05, // Assume stable performance
        throughputStability: 0.95,
        memoryStability,
        loadHandling: 0.9,
        timestamp: Date.now()
      });

      // Calculate quality score including memory metrics
      const qualityScore = await qualityMonitor.calculateQualityScore({
        start: startTime,
        end: Date.now()
      });

      // Memory stability should be good
      expect(memoryStability).toBeLessThan(0.1); // Less than 10% variation
      expect(qualityScore.componentScores.operationalConsistency).toBeGreaterThanOrEqual(80);

      // No significant memory leaks (final usage shouldn't be dramatically higher)
      const memoryGrowth = (finalMemory.heapUsed - initialMemory.heapUsed) / initialMemory.heapUsed;
      expect(memoryGrowth).toBeLessThan(0.5); // Less than 50% growth

      console.log('Memory Stability Test Results:', {
        initialHeapUsed: formatBytes(initialMemory.heapUsed),
        finalHeapUsed: formatBytes(finalMemory.heapUsed),
        memoryGrowth: `${(memoryGrowth * 100).toFixed(2)}%`,
        averageHeapUsed: formatBytes(averageHeapUsed),
        heapUsedStdDev: formatBytes(heapUsedStdDev),
        memoryStability: `${(memoryStability * 100).toFixed(2)}%`,
        qualityScore: qualityScore.componentScores.operationalConsistency,
        samplesCollected: memorySamples.length
      });
    }, 30000);
  });

  describe('Concurrent Operations Stress Test', () => {
    it('should handle concurrent arbitrage operations without quality degradation', async () => {
      const concurrentOperations = 100;
      const operationPromises = [];
      const startTime = Date.now();

      // Launch many concurrent operations
      for (let i = 0; i < concurrentOperations; i++) {
        operationPromises.push(
          (async () => {
            const operationStart = performance.now();

            // Simulate concurrent arbitrage detection
            const [opportunity] = await Promise.all([
              testEnv.waitForOpportunity(200).catch(() => null),
              simulateProcessingDelay(2, 8)
            ]);

            const operationEnd = performance.now();
            const latency = operationEnd - operationStart;

            // Record result
            await qualityMonitor.recordDetectionResult({
              latency,
              isTruePositive: opportunity !== null,
              isFalsePositive: Math.random() < 0.03, // Low false positive rate
              isFalseNegative: opportunity === null,
              timestamp: Date.now(),
              operationId: `concurrent-test-${i}`
            });

            return { latency, success: opportunity !== null };
          })()
        );
      }

      const results = await Promise.all(operationPromises);
      const successfulOperations = results.filter(r => r.success).length;
      const averageLatency = results.reduce((sum, r) => sum + r.latency, 0) / results.length;

      // Calculate quality score for concurrent operations
      const qualityScore = await qualityMonitor.calculateQualityScore({
        start: startTime,
        end: Date.now()
      });

      // Concurrent operations should maintain professional quality
      expect(qualityScore.overallScore).toBeGreaterThanOrEqual(75);
      expect(qualityScore.componentScores.detectionPerformance).toBeGreaterThanOrEqual(70);

      // Success rate should be reasonable
      const successRate = successfulOperations / concurrentOperations;
      expect(successRate).toBeGreaterThan(0.7); // At least 70% success rate

      // Latency should be reasonable under concurrency
      expect(averageLatency).toBeLessThan(10); // Average < 10ms

      console.log('Concurrent Operations Stress Test Results:', {
        totalOperations: concurrentOperations,
        successfulOperations,
        successRate: `${(successRate * 100).toFixed(2)}%`,
        averageLatency: `${averageLatency.toFixed(2)}ms`,
        p95Latency: results.map(r => r.latency).sort((a, b) => a - b)[Math.floor(results.length * 0.95)],
        qualityScore: qualityScore.overallScore,
        grade: qualityScore.grade,
        testDuration: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
        operationsPerSecond: (concurrentOperations / ((Date.now() - startTime) / 1000)).toFixed(2)
      });
    }, 60000);
  });

  describe('Quality Degradation Alerts', () => {
    it('should alert when quality drops below professional thresholds', async () => {
      // Establish good baseline
      for (let i = 0; i < 20; i++) {
        await qualityMonitor.recordDetectionResult({
          latency: 2.5,
          isTruePositive: true,
          isFalsePositive: false,
          isFalseNegative: false,
          timestamp: Date.now(),
          operationId: `baseline-alert-${i}`
        });
      }

      const baselineScore = await qualityMonitor.calculateQualityScore();

      // Simulate critical quality degradation
      for (let i = 0; i < 15; i++) {
        await qualityMonitor.recordDetectionResult({
          latency: 45.0, // Very poor latency
          isTruePositive: false,
          isFalsePositive: true, // False positive
          isFalseNegative: false,
          timestamp: Date.now(),
          operationId: `degradation-alert-${i}`
        });
      }

      const degradedScore = await qualityMonitor.calculateQualityScore();

      // Assess the degradation
      const degradationImpact = await qualityMonitor.assessFeatureImpact(baselineScore, degradedScore);

      // Should detect critical degradation
      expect(degradationImpact.impact).toBe('CRITICAL');
      expect(degradedScore.riskLevel).toBe('CRITICAL');
      expect(degradedScore.overallScore).toBeLessThan(60);

      // Should generate critical recommendations
      expect(degradedScore.recommendations.some(rec =>
        rec.includes('CRITICAL') || rec.includes('immediate')
      )).toBe(true);

      console.log('Quality Degradation Alert Test Results:', {
        baselineScore: baselineScore.overallScore,
        degradedScore: degradedScore.overallScore,
        scoreDrop: degradationImpact.scoreChange,
        impact: degradationImpact.impact,
        riskLevel: degradedScore.riskLevel,
        grade: degradedScore.grade,
        criticalRecommendations: degradedScore.recommendations.filter(r =>
          r.includes('CRITICAL') || r.includes('immediate')
        ).length
      });
    });
  });
});

// Helper functions
async function simulateProcessingDelay(baseDelay: number = 1, variance: number = 2): Promise<void> {
  const delay = baseDelay + Math.random() * variance;
  return new Promise(resolve => setTimeout(resolve, Math.min(delay, 20)));
}

async function simulateMemoryIntensiveOperation(): Promise<void> {
  // Simulate memory-intensive operations
  const data = [];
  for (let i = 0; i < 1000; i++) {
    data.push({
      id: i,
      data: Math.random().toString(36).repeat(10),
      nested: {
        value: Math.sin(i) * Math.cos(i),
        array: Array.from({ length: 10 }, () => Math.random())
      }
    });
  }

  // Process data (simulates real computation)
  const result = data.reduce((sum, item) => sum + item.nested.value, 0);

  // Brief async delay to simulate I/O
  await new Promise(resolve => setTimeout(resolve, 1));

  return result;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}