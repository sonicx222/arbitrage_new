// Professional Quality Integration Tests
// End-to-end testing of the AD-PQS metric during live system operations

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { TestEnvironment, createMockPriceUpdate, createMockArbitrageOpportunity } from '../../shared/test-utils/src';
import { ProfessionalQualityMonitor, getProfessionalQualityMonitor } from '../../shared/core/src/professional-quality-monitor';
import { BSCDetectorService } from '../../services/bsc-detector/src/detector';
// ArbitrageDetector module not yet implemented - tests work with detector service directly
// import { ArbitrageDetector } from '../../shared/core/src/arbitrage-detector';

describe('Professional Quality Integration Tests', () => {
  let testEnv: TestEnvironment;
  let qualityMonitor: ProfessionalQualityMonitor;
  let detector: BSCDetectorService;
  // ArbitrageDetector not available yet
  // let arbitrageDetector: ArbitrageDetector;

  beforeAll(async () => {
    testEnv = await TestEnvironment.create();
    qualityMonitor = getProfessionalQualityMonitor();

    // Start services
    detector = await testEnv.startService('bsc-detector', BSCDetectorService, {
      chain: 'bsc',
      enabled: true,
      wsUrl: 'ws://mock-ws',
      rpcUrl: 'http://mock-rpc'
    });

    // ArbitrageDetector not available yet - uses detector service directly
    // arbitrageDetector = new ArbitrageDetector({
    //   minProfitThreshold: 0.005,
    //   maxSlippage: 0.01,
    //   detectionTimeout: 5000
    // });
  });

  afterAll(async () => {
    await testEnv.stopService('bsc-detector');
    await testEnv.cleanup();
  });

  describe('End-to-End Arbitrage Detection Quality', () => {
    it('should maintain high professional quality during normal operations', async () => {
      // Setup baseline price data
      await testEnv.setupArbitrageOpportunity();

      // Record baseline quality score
      const baselineScore = await qualityMonitor.calculateQualityScore({
        start: Date.now() - 60000, // Last minute
        end: Date.now()
      });

      // Perform multiple arbitrage detection operations
      const operations = [];
      const startTime = performance.now();

      for (let i = 0; i < 10; i++) {
        operations.push(
          Promise.all([
            testEnv.waitForOpportunity(1000).catch(() => null),
            simulateDetectionLatency()
          ])
        );
      }

      const results = await Promise.all(operations);
      const endTime = performance.now();

      // Record detection results
      for (let i = 0; i < results.length; i++) {
        const [opportunity, latency] = results[i];

        await qualityMonitor.recordDetectionResult({
          latency,
          isTruePositive: opportunity !== null,
          isFalsePositive: false, // Assume no false positives in test
          isFalseNegative: opportunity === null,
          timestamp: Date.now(),
          operationId: `integration-test-${i}`
        });
      }

      // Calculate post-operation quality score
      const postOperationScore = await qualityMonitor.calculateQualityScore({
        start: Date.now() - 120000, // Last 2 minutes
        end: Date.now()
      });

      // Assess feature impact (simulating a "new feature" - the test operations)
      const impact = await qualityMonitor.assessFeatureImpact(baselineScore, postOperationScore);

      // Assertions for professional quality
      expect(postOperationScore.overallScore).toBeGreaterThanOrEqual(80);
      expect(postOperationScore.componentScores.detectionPerformance).toBeGreaterThanOrEqual(75);
      expect(postOperationScore.componentScores.detectionAccuracy).toBeGreaterThanOrEqual(85);

      // Should not have significant negative impact
      expect(impact.impact).not.toBe('CRITICAL');
      expect(impact.impact).not.toBe('NEGATIVE');

      // Log results for analysis
      console.log('Professional Quality Integration Test Results:', {
        baselineScore: baselineScore.overallScore,
        postOperationScore: postOperationScore.overallScore,
        impact: impact.impact,
        scoreChange: impact.scoreChange,
        averageLatency: results.reduce((sum, [_, latency]) => sum + latency, 0) / results.length,
        grade: postOperationScore.grade,
        riskLevel: postOperationScore.riskLevel
      });
    });

    it('should handle load spikes without quality degradation', async () => {
      // Record baseline
      const baselineScore = await qualityMonitor.calculateQualityScore();

      // Simulate load spike - many concurrent operations
      const concurrentOperations = 50;
      const loadSpikePromises = [];

      for (let i = 0; i < concurrentOperations; i++) {
        loadSpikePromises.push(
          Promise.all([
            testEnv.waitForOpportunity(500).catch(() => null),
            simulateDetectionLatency(10, 50) // Higher latency under load
          ])
        );
      }

      const loadResults = await Promise.all(loadSpikePromises);

      // Record results under load
      for (let i = 0; i < loadResults.length; i++) {
        const [opportunity, latency] = loadResults[i];

        await qualityMonitor.recordDetectionResult({
          latency,
          isTruePositive: opportunity !== null,
          isFalsePositive: false,
          isFalseNegative: opportunity === null,
          timestamp: Date.now(),
          operationId: `load-test-${i}`
        });
      }

      // Calculate score under load
      const loadScore = await qualityMonitor.calculateQualityScore();

      // Assess impact of load
      const loadImpact = await qualityMonitor.assessFeatureImpact(baselineScore, loadScore);

      // Under load, score should not drop more than 15 points
      expect(loadImpact.scoreChange).toBeGreaterThan(-15);

      // Detection performance might degrade under load but should remain professional
      expect(loadScore.componentScores.detectionPerformance).toBeGreaterThan(60);

      // System should remain operational
      expect(loadScore.componentScores.systemReliability).toBeGreaterThan(70);

      console.log('Load Spike Test Results:', {
        baselineScore: baselineScore.overallScore,
        loadScore: loadScore.overallScore,
        loadImpact: loadImpact.impact,
        scoreChange: loadImpact.scoreChange,
        averageLoadLatency: loadResults.reduce((sum, [_, latency]) => sum + latency, 0) / loadResults.length,
        operationsCompleted: loadResults.length
      });
    });

    it('should recover quality after service restart', async () => {
      // Record baseline before restart
      const beforeRestartScore = await qualityMonitor.calculateQualityScore();

      // Simulate service restart
      await testEnv.stopService('bsc-detector');
      await new Promise(resolve => setTimeout(resolve, 1000)); // Brief downtime

      // Restart service
      const newDetector = await testEnv.startService('bsc-detector-restarted', BSCDetectorService, {
        chain: 'bsc',
        enabled: true,
        wsUrl: 'ws://mock-ws',
        rpcUrl: 'http://mock-rpc'
      });

      // Allow recovery time
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Perform operations after restart
      const recoveryOperations = [];
      for (let i = 0; i < 5; i++) {
        recoveryOperations.push(
          Promise.all([
            testEnv.waitForOpportunity(1000).catch(() => null),
            simulateDetectionLatency()
          ])
        );
      }

      const recoveryResults = await Promise.all(recoveryOperations);

      // Record recovery results
      for (let i = 0; i < recoveryResults.length; i++) {
        const [opportunity, latency] = recoveryResults[i];

        await qualityMonitor.recordDetectionResult({
          latency,
          isTruePositive: opportunity !== null,
          isFalsePositive: false,
          isFalseNegative: opportunity === null,
          timestamp: Date.now(),
          operationId: `recovery-test-${i}`
        });
      }

      // Calculate score after recovery
      const afterRecoveryScore = await qualityMonitor.calculateQualityScore();

      // Assess recovery impact
      const recoveryImpact = await qualityMonitor.assessFeatureImpact(beforeRestartScore, afterRecoveryScore);

      // Recovery should not cause significant quality degradation
      expect(recoveryImpact.scoreChange).toBeGreaterThan(-10);

      // System should recover to professional levels quickly
      expect(afterRecoveryScore.overallScore).toBeGreaterThan(75);

      console.log('Service Recovery Test Results:', {
        beforeRestartScore: beforeRestartScore.overallScore,
        afterRecoveryScore: afterRecoveryScore.overallScore,
        recoveryImpact: recoveryImpact.impact,
        recoveryTime: '2 seconds simulated',
        finalGrade: afterRecoveryScore.grade
      });

      // Cleanup
      await testEnv.stopService('bsc-detector-restarted');
    });
  });

  describe('Quality Metric Validation', () => {
    it('should validate latency thresholds for professional quality', async () => {
      // Test with excellent latency
      await qualityMonitor.recordDetectionResult({
        latency: 1.5, // Excellent latency
        isTruePositive: true,
        isFalsePositive: false,
        isFalseNegative: false,
        timestamp: Date.now(),
        operationId: 'latency-test-excellent'
      });

      const excellentScore = await qualityMonitor.calculateQualityScore();

      // Test with poor latency
      await qualityMonitor.recordDetectionResult({
        latency: 25.0, // Poor latency
        isTruePositive: true,
        isFalsePositive: false,
        isFalseNegative: false,
        timestamp: Date.now(),
        operationId: 'latency-test-poor'
      });

      const poorScore = await qualityMonitor.calculateQualityScore();

      // Poor latency should impact detection performance score
      expect(poorScore.componentScores.detectionPerformance)
        .toBeLessThan(excellentScore.componentScores.detectionPerformance);

      // But overall score should remain professional
      expect(poorScore.overallScore).toBeGreaterThan(70);
    });

    it('should validate accuracy metrics', async () => {
      // Simulate high accuracy scenario
      for (let i = 0; i < 10; i++) {
        await qualityMonitor.recordDetectionResult({
          latency: 2.0,
          isTruePositive: true,
          isFalsePositive: false,
          isFalseNegative: false,
          timestamp: Date.now(),
          operationId: `accuracy-test-high-${i}`
        });
      }

      const highAccuracyScore = await qualityMonitor.calculateQualityScore();

      // Simulate accuracy issues
      for (let i = 0; i < 5; i++) {
        await qualityMonitor.recordDetectionResult({
          latency: 2.0,
          isTruePositive: false,
          isFalsePositive: true, // False positive
          isFalseNegative: false,
          timestamp: Date.now(),
          operationId: `accuracy-test-low-${i}`
        });
      }

      const lowAccuracyScore = await qualityMonitor.calculateQualityScore();

      // Accuracy issues should impact detection accuracy score
      expect(lowAccuracyScore.componentScores.detectionAccuracy)
        .toBeLessThan(highAccuracyScore.componentScores.detectionAccuracy);
    });
  });

  describe('Performance Regression Detection', () => {
    it('should detect performance regressions', async () => {
      // Establish baseline performance
      const baselineLatencies = [];
      for (let i = 0; i < 20; i++) {
        const latency = 2.0 + Math.random() * 1.0; // 2-3ms range
        baselineLatencies.push(latency);

        await qualityMonitor.recordDetectionResult({
          latency,
          isTruePositive: true,
          isFalsePositive: false,
          isFalseNegative: false,
          timestamp: Date.now(),
          operationId: `baseline-${i}`
        });
      }

      const baselineScore = await qualityMonitor.calculateQualityScore();

      // Introduce performance regression
      const regressionLatencies = [];
      for (let i = 0; i < 10; i++) {
        const latency = 8.0 + Math.random() * 4.0; // 8-12ms range (regression)
        regressionLatencies.push(latency);

        await qualityMonitor.recordDetectionResult({
          latency,
          isTruePositive: true,
          isFalsePositive: false,
          isFalseNegative: false,
          timestamp: Date.now(),
          operationId: `regression-${i}`
        });
      }

      const regressionScore = await qualityMonitor.calculateQualityScore();

      // Regression should be detected
      expect(regressionScore.componentScores.detectionPerformance)
        .toBeLessThan(baselineScore.componentScores.detectionPerformance);

      // Assess the regression impact
      const regressionImpact = await qualityMonitor.assessFeatureImpact(baselineScore, regressionScore);

      expect(regressionImpact.impact).toBe('NEGATIVE');
      expect(regressionImpact.scoreChange).toBeLessThan(0);

      // Should generate appropriate recommendations
      expect(regressionImpact.recommendations.some(rec =>
        rec.includes('optimize') || rec.includes('performance')
      )).toBe(true);

      console.log('Performance Regression Test Results:', {
        baselineP95: baselineLatencies.sort((a, b) => a - b)[Math.floor(baselineLatencies.length * 0.95)],
        regressionP95: regressionLatencies.sort((a, b) => a - b)[Math.floor(regressionLatencies.length * 0.95)],
        baselineScore: baselineScore.componentScores.detectionPerformance,
        regressionScore: regressionScore.componentScores.detectionPerformance,
        impact: regressionImpact.impact,
        scoreChange: regressionImpact.scoreChange
      });
    });
  });
});

// Helper functions
async function simulateDetectionLatency(baseLatency: number = 2.0, variance: number = 2.0): Promise<number> {
  // Simulate realistic detection latency with some variance
  const latency = baseLatency + Math.random() * variance;

  // Simulate processing time
  await new Promise(resolve => setTimeout(resolve, Math.min(latency, 10)));

  return latency;
}

async function simulateNetworkDelay(delay: number = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delay));
}

async function simulateSystemLoad(duration: number = 5000): Promise<void> {
  const startTime = Date.now();

  // Simulate CPU-intensive operations
  while (Date.now() - startTime < duration) {
    for (let i = 0; i < 10000; i++) {
      Math.sqrt(i) * Math.sin(i);
    }
    await new Promise(resolve => setImmediate(() => {}));
  }
}