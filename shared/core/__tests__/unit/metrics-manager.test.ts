/**
 * MEV Metrics Manager Unit Tests
 *
 * Tests for MevMetricsManager - the thread-safe metrics management component
 * shared by all MEV protection providers (FlashbotsProvider, JitoProvider, etc.)
 *
 * @module mev-protection/metrics-manager
 */

import {
  MevMetricsManager,
  createMevMetricsManager,
  IncrementableMetricField,
} from '../../src/mev-protection/metrics-manager';

// =============================================================================
// Test Suite
// =============================================================================

describe('MevMetricsManager', () => {
  let metricsManager: MevMetricsManager;

  beforeEach(() => {
    metricsManager = new MevMetricsManager();
  });

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    it('should initialize with zero metrics', () => {
      const metrics = metricsManager.getMetrics();

      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.successfulSubmissions).toBe(0);
      expect(metrics.failedSubmissions).toBe(0);
      expect(metrics.fallbackSubmissions).toBe(0);
      expect(metrics.averageLatencyMs).toBe(0);
      expect(metrics.bundlesIncluded).toBe(0);
      expect(metrics.bundlesReverted).toBe(0);
    });

    it('should set lastUpdated timestamp on creation', () => {
      const metrics = metricsManager.getMetrics();
      const now = Date.now();

      // Should be within 100ms of now
      expect(metrics.lastUpdated).toBeGreaterThan(now - 100);
      expect(metrics.lastUpdated).toBeLessThanOrEqual(now);
    });
  });

  // ===========================================================================
  // getMetrics Tests
  // ===========================================================================

  describe('getMetrics', () => {
    it('should return a copy of metrics (not reference)', () => {
      const metrics1 = metricsManager.getMetrics();
      const metrics2 = metricsManager.getMetrics();

      expect(metrics1).not.toBe(metrics2);
      expect(metrics1).toEqual(metrics2);
    });

    it('should not allow external modification of internal metrics', () => {
      const metrics = metricsManager.getMetrics();
      metrics.totalSubmissions = 9999;

      const internalMetrics = metricsManager.getMetrics();
      expect(internalMetrics.totalSubmissions).toBe(0);
    });
  });

  // ===========================================================================
  // resetMetrics Tests
  // ===========================================================================

  describe('resetMetrics', () => {
    it('should reset all metrics to zero', async () => {
      // First increment some metrics
      await metricsManager.increment('totalSubmissions');
      await metricsManager.increment('successfulSubmissions');
      await metricsManager.increment('failedSubmissions');

      // Reset
      metricsManager.resetMetrics();

      const metrics = metricsManager.getMetrics();
      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.successfulSubmissions).toBe(0);
      expect(metrics.failedSubmissions).toBe(0);
    });

    it('should update lastUpdated timestamp', () => {
      const beforeReset = metricsManager.getMetrics().lastUpdated;

      // Wait a bit to ensure different timestamp
      metricsManager.resetMetrics();

      const afterReset = metricsManager.getMetrics().lastUpdated;
      expect(afterReset).toBeGreaterThanOrEqual(beforeReset);
    });
  });

  // ===========================================================================
  // increment Tests
  // ===========================================================================

  describe('increment', () => {
    it('should increment totalSubmissions', async () => {
      await metricsManager.increment('totalSubmissions');

      const metrics = metricsManager.getMetrics();
      expect(metrics.totalSubmissions).toBe(1);
    });

    it('should increment successfulSubmissions', async () => {
      await metricsManager.increment('successfulSubmissions');

      const metrics = metricsManager.getMetrics();
      expect(metrics.successfulSubmissions).toBe(1);
    });

    it('should increment failedSubmissions', async () => {
      await metricsManager.increment('failedSubmissions');

      const metrics = metricsManager.getMetrics();
      expect(metrics.failedSubmissions).toBe(1);
    });

    it('should increment fallbackSubmissions', async () => {
      await metricsManager.increment('fallbackSubmissions');

      const metrics = metricsManager.getMetrics();
      expect(metrics.fallbackSubmissions).toBe(1);
    });

    it('should increment bundlesIncluded', async () => {
      await metricsManager.increment('bundlesIncluded');

      const metrics = metricsManager.getMetrics();
      expect(metrics.bundlesIncluded).toBe(1);
    });

    it('should increment bundlesReverted', async () => {
      await metricsManager.increment('bundlesReverted');

      const metrics = metricsManager.getMetrics();
      expect(metrics.bundlesReverted).toBe(1);
    });

    it('should update lastUpdated on increment', async () => {
      const before = metricsManager.getMetrics().lastUpdated;

      await metricsManager.increment('totalSubmissions');

      const after = metricsManager.getMetrics().lastUpdated;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('should handle multiple increments correctly', async () => {
      await metricsManager.increment('totalSubmissions');
      await metricsManager.increment('totalSubmissions');
      await metricsManager.increment('totalSubmissions');

      const metrics = metricsManager.getMetrics();
      expect(metrics.totalSubmissions).toBe(3);
    });
  });

  // ===========================================================================
  // updateLatency Tests
  // ===========================================================================

  describe('updateLatency', () => {
    it('should calculate latency correctly', async () => {
      const startTime = Date.now() - 100; // 100ms ago

      await metricsManager.updateLatency(startTime);

      const metrics = metricsManager.getMetrics();
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(100);
      expect(metrics.averageLatencyMs).toBeLessThan(200); // Should be close to 100
    });

    it('should handle negative latency (clock skew) gracefully', async () => {
      const futureTime = Date.now() + 10000; // 10 seconds in future

      await metricsManager.updateLatency(futureTime);

      const metrics = metricsManager.getMetrics();
      // Should not crash and should not store negative value
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('should calculate running average correctly', async () => {
      // Simulate submissions with known latencies
      // successfulSubmissions must be > 0 for average calculation to work correctly
      await metricsManager.increment('successfulSubmissions');
      await metricsManager.updateLatency(Date.now() - 100);

      await metricsManager.increment('successfulSubmissions');
      await metricsManager.updateLatency(Date.now() - 200);

      const metrics = metricsManager.getMetrics();
      // Average should be between 100 and 200
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(100);
      expect(metrics.averageLatencyMs).toBeLessThanOrEqual(200);
    });

    it('should handle zero successful submissions (edge case)', async () => {
      // Update latency without any successful submissions
      await metricsManager.updateLatency(Date.now() - 50);

      const metrics = metricsManager.getMetrics();
      // Should store as baseline
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(50);
    });
  });

  // ===========================================================================
  // batchUpdate Tests
  // ===========================================================================

  describe('batchUpdate', () => {
    it('should update multiple metrics atomically', async () => {
      await metricsManager.batchUpdate({
        totalSubmissions: 5,
        successfulSubmissions: 3,
        failedSubmissions: 2,
      });

      const metrics = metricsManager.getMetrics();
      expect(metrics.totalSubmissions).toBe(5);
      expect(metrics.successfulSubmissions).toBe(3);
      expect(metrics.failedSubmissions).toBe(2);
    });

    it('should update latency when startTime provided', async () => {
      const startTime = Date.now() - 150;

      await metricsManager.batchUpdate(
        { successfulSubmissions: 1 },
        startTime
      );

      const metrics = metricsManager.getMetrics();
      expect(metrics.successfulSubmissions).toBe(1);
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(150);
    });

    it('should handle zero and undefined counts gracefully', async () => {
      await metricsManager.batchUpdate({
        totalSubmissions: 0,
        successfulSubmissions: 1,
      });

      const metrics = metricsManager.getMetrics();
      // Zero should not increment
      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.successfulSubmissions).toBe(1);
    });

    it('should be more efficient than multiple increment calls', async () => {
      // This test verifies behavior, not timing
      // With batchUpdate, we acquire mutex once instead of 3 times
      await metricsManager.batchUpdate({
        successfulSubmissions: 1,
        bundlesIncluded: 1,
        fallbackSubmissions: 1,
      });

      const metrics = metricsManager.getMetrics();
      expect(metrics.successfulSubmissions).toBe(1);
      expect(metrics.bundlesIncluded).toBe(1);
      expect(metrics.fallbackSubmissions).toBe(1);
    });

    it('should handle negative latency in batch update gracefully', async () => {
      const futureTime = Date.now() + 10000;

      await metricsManager.batchUpdate(
        { successfulSubmissions: 1 },
        futureTime
      );

      const metrics = metricsManager.getMetrics();
      // Should not store negative latency
      expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ===========================================================================
  // Concurrent Access Tests (Thread-Safety)
  // ===========================================================================

  describe('Concurrent Access', () => {
    it('should handle concurrent increments correctly', async () => {
      const incrementCount = 100;

      // Fire off many concurrent increments
      const promises = Array.from({ length: incrementCount }, () =>
        metricsManager.increment('totalSubmissions')
      );

      await Promise.all(promises);

      const metrics = metricsManager.getMetrics();
      expect(metrics.totalSubmissions).toBe(incrementCount);
    });

    it('should handle concurrent batch updates correctly', async () => {
      const updateCount = 50;

      // Fire off many concurrent batch updates
      const promises = Array.from({ length: updateCount }, () =>
        metricsManager.batchUpdate({
          totalSubmissions: 1,
          successfulSubmissions: 1,
        })
      );

      await Promise.all(promises);

      const metrics = metricsManager.getMetrics();
      expect(metrics.totalSubmissions).toBe(updateCount);
      expect(metrics.successfulSubmissions).toBe(updateCount);
    });

    it('should handle mixed concurrent operations', async () => {
      const operationCount = 30;

      const increments = Array.from({ length: operationCount }, () =>
        metricsManager.increment('totalSubmissions')
      );

      const batchUpdates = Array.from({ length: operationCount }, () =>
        metricsManager.batchUpdate({ successfulSubmissions: 1 })
      );

      const latencyUpdates = Array.from({ length: operationCount }, () =>
        metricsManager.updateLatency(Date.now() - 100)
      );

      await Promise.all([...increments, ...batchUpdates, ...latencyUpdates]);

      const metrics = metricsManager.getMetrics();
      expect(metrics.totalSubmissions).toBe(operationCount);
      expect(metrics.successfulSubmissions).toBe(operationCount);
    });
  });

  // ===========================================================================
  // Factory Function Tests
  // ===========================================================================

  describe('createMevMetricsManager', () => {
    it('should create a new MevMetricsManager instance', () => {
      const manager = createMevMetricsManager();

      expect(manager).toBeInstanceOf(MevMetricsManager);
    });

    it('should create independent instances', async () => {
      const manager1 = createMevMetricsManager();
      const manager2 = createMevMetricsManager();

      await manager1.increment('totalSubmissions');

      const metrics1 = manager1.getMetrics();
      const metrics2 = manager2.getMetrics();

      expect(metrics1.totalSubmissions).toBe(1);
      expect(metrics2.totalSubmissions).toBe(0);
    });
  });

  // ===========================================================================
  // Edge Case Tests
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle very large increment counts', async () => {
      for (let i = 0; i < 1000; i++) {
        await metricsManager.increment('totalSubmissions');
      }

      const metrics = metricsManager.getMetrics();
      expect(metrics.totalSubmissions).toBe(1000);
    });

    it('should handle batch update with all fields', async () => {
      await metricsManager.batchUpdate({
        totalSubmissions: 10,
        successfulSubmissions: 5,
        failedSubmissions: 3,
        fallbackSubmissions: 2,
        bundlesIncluded: 4,
        bundlesReverted: 1,
      });

      const metrics = metricsManager.getMetrics();
      expect(metrics.totalSubmissions).toBe(10);
      expect(metrics.successfulSubmissions).toBe(5);
      expect(metrics.failedSubmissions).toBe(3);
      expect(metrics.fallbackSubmissions).toBe(2);
      expect(metrics.bundlesIncluded).toBe(4);
      expect(metrics.bundlesReverted).toBe(1);
    });

    it('should handle rapid reset and update cycles', async () => {
      for (let cycle = 0; cycle < 10; cycle++) {
        await metricsManager.increment('totalSubmissions');
        await metricsManager.increment('successfulSubmissions');
        metricsManager.resetMetrics();
      }

      const metrics = metricsManager.getMetrics();
      expect(metrics.totalSubmissions).toBe(0);
      expect(metrics.successfulSubmissions).toBe(0);
    });
  });
});
