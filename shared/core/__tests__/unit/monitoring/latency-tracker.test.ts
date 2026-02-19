/**
 * LatencyTracker Tests
 *
 * Unit tests for the E2E pipeline latency tracker including:
 * - Recording individual stage latencies
 * - Recording E2E latencies
 * - Ring buffer overflow/wrapping behavior
 * - Percentile calculation (p50, p95, p99)
 * - getMetrics() output shape
 * - recordFromTimestamps() with PipelineTimestamps
 * - Health data output
 * - Reset behavior
 * - Edge cases (empty buffers, NaN, single sample)
 *
 * @see monitoring/latency-tracker.ts
 * @see ADR-022 Hot-path memory optimization
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  LatencyTracker,
  getLatencyTracker,
  resetLatencyTracker,
  PIPELINE_STAGES,
} from '../../../src/monitoring/latency-tracker';
import type {
  PercentileStats,
  LatencyMetrics,
} from '../../../src/monitoring/latency-tracker';
import type { PipelineTimestamps } from '@arbitrage/types';

describe('LatencyTracker', () => {
  let tracker: LatencyTracker;

  beforeEach(() => {
    tracker = new LatencyTracker({ bufferCapacity: 100 });
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should create tracker with default capacity', () => {
      const defaultTracker = new LatencyTracker();
      const metrics = defaultTracker.getMetrics();
      expect(metrics.e2e.count).toBe(0);
      expect(metrics.wsToDetector.count).toBe(0);
      expect(metrics.detectorToPublish.count).toBe(0);
    });

    it('should create tracker with custom capacity', () => {
      const customTracker = new LatencyTracker({ bufferCapacity: 50 });
      const metrics = customTracker.getMetrics();
      expect(metrics.e2e.count).toBe(0);
    });

    it('should pre-allocate buffers for default pipeline stages', () => {
      const metrics = tracker.getMetrics();
      for (const stage of PIPELINE_STAGES) {
        expect(metrics.stageBreakdown[stage]).toBeDefined();
        expect(metrics.stageBreakdown[stage].count).toBe(0);
      }
    });
  });

  // ==========================================================================
  // recordStageLatency
  // ==========================================================================

  describe('recordStageLatency', () => {
    it('should record latencies for known stages', () => {
      tracker.recordStageLatency('ws_receive', 5.0);
      tracker.recordStageLatency('ws_receive', 7.0);
      tracker.recordStageLatency('detector_process', 12.0);

      const metrics = tracker.getMetrics();
      expect(metrics.stageBreakdown['ws_receive'].count).toBe(2);
      expect(metrics.stageBreakdown['ws_receive'].avg).toBe(6.0);
      expect(metrics.stageBreakdown['detector_process'].count).toBe(1);
      expect(metrics.stageBreakdown['detector_process'].avg).toBe(12.0);
    });

    it('should lazily create buffers for custom stages', () => {
      tracker.recordStageLatency('custom_stage', 10.0);

      const metrics = tracker.getMetrics();
      expect(metrics.stageBreakdown['custom_stage']).toBeDefined();
      expect(metrics.stageBreakdown['custom_stage'].count).toBe(1);
      expect(metrics.stageBreakdown['custom_stage'].avg).toBe(10.0);
    });

    it('should silently discard NaN values', () => {
      tracker.recordStageLatency('ws_receive', 5.0);
      tracker.recordStageLatency('ws_receive', NaN);
      tracker.recordStageLatency('ws_receive', 10.0);

      const metrics = tracker.getMetrics();
      expect(metrics.stageBreakdown['ws_receive'].count).toBe(2);
      expect(metrics.stageBreakdown['ws_receive'].avg).toBe(7.5);
    });
  });

  // ==========================================================================
  // recordE2ELatency
  // ==========================================================================

  describe('recordE2ELatency', () => {
    it('should record full pipeline latencies', () => {
      tracker.recordE2ELatency(42.0);
      tracker.recordE2ELatency(38.0);
      tracker.recordE2ELatency(45.0);

      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(3);
      expect(metrics.e2e.avg).toBeCloseTo(41.667, 2);
    });

    it('should discard NaN E2E latencies', () => {
      tracker.recordE2ELatency(10.0);
      tracker.recordE2ELatency(NaN);

      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(1);
      expect(metrics.e2e.avg).toBe(10.0);
    });
  });

  // ==========================================================================
  // Percentile calculations
  // ==========================================================================

  describe('percentile calculations', () => {
    it('should compute correct p50 (median)', () => {
      // Push 100 values: 1, 2, 3, ..., 100
      for (let i = 1; i <= 100; i++) {
        tracker.recordE2ELatency(i);
      }

      const metrics = tracker.getMetrics();
      // p50 of [1..100] = value at index ceil(0.5*100)-1 = 49 => value 50
      expect(metrics.e2e.p50).toBe(50);
    });

    it('should compute correct p95', () => {
      for (let i = 1; i <= 100; i++) {
        tracker.recordE2ELatency(i);
      }

      const metrics = tracker.getMetrics();
      // p95 of [1..100] = value at index ceil(0.95*100)-1 = 94 => value 95
      expect(metrics.e2e.p95).toBe(95);
    });

    it('should compute correct p99', () => {
      for (let i = 1; i <= 100; i++) {
        tracker.recordE2ELatency(i);
      }

      const metrics = tracker.getMetrics();
      // p99 of [1..100] = value at index ceil(0.99*100)-1 = 98 => value 99
      expect(metrics.e2e.p99).toBe(99);
    });

    it('should return zeros for empty buffer', () => {
      const metrics = tracker.getMetrics();
      const emptyStats: PercentileStats = {
        p50: 0,
        p95: 0,
        p99: 0,
        count: 0,
        avg: 0,
      };
      expect(metrics.e2e).toEqual(emptyStats);
    });

    it('should handle single sample', () => {
      tracker.recordE2ELatency(42.0);

      const metrics = tracker.getMetrics();
      expect(metrics.e2e.p50).toBe(42.0);
      expect(metrics.e2e.p95).toBe(42.0);
      expect(metrics.e2e.p99).toBe(42.0);
      expect(metrics.e2e.count).toBe(1);
      expect(metrics.e2e.avg).toBe(42.0);
    });

    it('should handle two samples', () => {
      tracker.recordE2ELatency(10.0);
      tracker.recordE2ELatency(20.0);

      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(2);
      expect(metrics.e2e.avg).toBe(15.0);
      // Sorted: [10, 20]
      // p50: ceil(0.5*2)-1 = 0 => 10
      expect(metrics.e2e.p50).toBe(10.0);
      // p95: ceil(0.95*2)-1 = 1 => 20
      expect(metrics.e2e.p95).toBe(20.0);
      // p99: ceil(0.99*2)-1 = 1 => 20
      expect(metrics.e2e.p99).toBe(20.0);
    });

    it('should compute percentiles from unsorted input', () => {
      // Push values out of order
      const values = [50, 10, 90, 30, 70, 20, 80, 40, 60, 100];
      for (const v of values) {
        tracker.recordE2ELatency(v);
      }

      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(10);
      expect(metrics.e2e.avg).toBe(55); // (10+20+...+100)/10 = 550/10
      // Sorted: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
      // p50: ceil(0.5*10)-1 = 4 => 50
      expect(metrics.e2e.p50).toBe(50);
      // p95: ceil(0.95*10)-1 = 9 => 100
      expect(metrics.e2e.p95).toBe(100);
    });
  });

  // ==========================================================================
  // Ring buffer overflow/wrapping
  // ==========================================================================

  describe('ring buffer overflow/wrapping', () => {
    it('should handle buffer overflow correctly', () => {
      // Create tracker with small capacity
      const smallTracker = new LatencyTracker({ bufferCapacity: 5 });

      // Push 10 values into size-5 buffer
      for (let i = 1; i <= 10; i++) {
        smallTracker.recordE2ELatency(i);
      }

      const metrics = smallTracker.getMetrics();
      // Buffer should contain [6, 7, 8, 9, 10]
      expect(metrics.e2e.count).toBe(5);
      expect(metrics.e2e.avg).toBe(8); // (6+7+8+9+10)/5 = 40/5
    });

    it('should maintain correct percentiles after wrapping', () => {
      const smallTracker = new LatencyTracker({ bufferCapacity: 10 });

      // Fill with low values
      for (let i = 0; i < 10; i++) {
        smallTracker.recordE2ELatency(5);
      }

      // Overwrite with high values
      for (let i = 0; i < 10; i++) {
        smallTracker.recordE2ELatency(100);
      }

      const metrics = smallTracker.getMetrics();
      // All values should now be 100
      expect(metrics.e2e.p50).toBe(100);
      expect(metrics.e2e.p95).toBe(100);
      expect(metrics.e2e.p99).toBe(100);
      expect(metrics.e2e.avg).toBe(100);
    });

    it('should maintain correct count at capacity', () => {
      const smallTracker = new LatencyTracker({ bufferCapacity: 3 });

      smallTracker.recordE2ELatency(1);
      smallTracker.recordE2ELatency(2);
      smallTracker.recordE2ELatency(3);
      expect(smallTracker.getMetrics().e2e.count).toBe(3);

      smallTracker.recordE2ELatency(4); // wraps
      expect(smallTracker.getMetrics().e2e.count).toBe(3); // still 3

      smallTracker.recordE2ELatency(5);
      smallTracker.recordE2ELatency(6);
      expect(smallTracker.getMetrics().e2e.count).toBe(3);
    });
  });

  // ==========================================================================
  // recordFromTimestamps
  // ==========================================================================

  describe('recordFromTimestamps', () => {
    it('should compute E2E latency from wsReceivedAt to executionReceivedAt', () => {
      const timestamps: PipelineTimestamps = {
        wsReceivedAt: 1000,
        publishedAt: 1005,
        consumedAt: 1010,
        detectedAt: 1035,
        coordinatorAt: 1042,
        executionReceivedAt: 1048,
      };

      tracker.recordFromTimestamps(timestamps);

      const metrics = tracker.getMetrics();
      // E2E: 1048 - 1000 = 48
      expect(metrics.e2e.count).toBe(1);
      expect(metrics.e2e.avg).toBe(48);
    });

    it('should compute E2E latency falling back to coordinatorAt', () => {
      const timestamps: PipelineTimestamps = {
        wsReceivedAt: 1000,
        publishedAt: 1005,
        consumedAt: 1010,
        detectedAt: 1035,
        coordinatorAt: 1042,
      };

      tracker.recordFromTimestamps(timestamps);

      const metrics = tracker.getMetrics();
      // E2E: 1042 - 1000 = 42
      expect(metrics.e2e.avg).toBe(42);
    });

    it('should compute E2E latency falling back to detectedAt', () => {
      const timestamps: PipelineTimestamps = {
        wsReceivedAt: 1000,
        detectedAt: 1035,
      };

      tracker.recordFromTimestamps(timestamps);

      const metrics = tracker.getMetrics();
      // E2E: 1035 - 1000 = 35
      expect(metrics.e2e.avg).toBe(35);
    });

    it('should compute wsToDetector latency', () => {
      const timestamps: PipelineTimestamps = {
        wsReceivedAt: 1000,
        detectedAt: 1035,
      };

      tracker.recordFromTimestamps(timestamps);

      const metrics = tracker.getMetrics();
      // wsToDetector: 1035 - 1000 = 35
      expect(metrics.wsToDetector.count).toBe(1);
      expect(metrics.wsToDetector.avg).toBe(35);
    });

    it('should compute detectorToPublish latency', () => {
      const timestamps: PipelineTimestamps = {
        wsReceivedAt: 1000,
        publishedAt: 1005,
        detectedAt: 1035,
        coordinatorAt: 1042,
      };

      tracker.recordFromTimestamps(timestamps);

      const metrics = tracker.getMetrics();
      // detectorToPublish: 1042 - 1035 = 7
      expect(metrics.detectorToPublish.count).toBe(1);
      expect(metrics.detectorToPublish.avg).toBe(7);
    });

    it('should compute individual stage latencies', () => {
      const timestamps: PipelineTimestamps = {
        wsReceivedAt: 1000,
        publishedAt: 1005,
        consumedAt: 1010,
        detectedAt: 1035,
        coordinatorAt: 1042,
      };

      tracker.recordFromTimestamps(timestamps);

      const metrics = tracker.getMetrics();
      // ws_receive: 1005 - 1000 = 5
      expect(metrics.stageBreakdown['ws_receive'].avg).toBe(5);
      // batcher_flush: 1010 - 1005 = 5
      expect(metrics.stageBreakdown['batcher_flush'].avg).toBe(5);
      // detector_process: 1035 - 1010 = 25
      expect(metrics.stageBreakdown['detector_process'].avg).toBe(25);
      // opportunity_publish: 1042 - 1035 = 7
      expect(metrics.stageBreakdown['opportunity_publish'].avg).toBe(7);
    });

    it('should handle partial timestamps gracefully', () => {
      // Only wsReceivedAt -- no other timestamps, so nothing recorded
      const timestamps: PipelineTimestamps = {
        wsReceivedAt: 1000,
      };

      tracker.recordFromTimestamps(timestamps);

      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(0);
      expect(metrics.wsToDetector.count).toBe(0);
      expect(metrics.detectorToPublish.count).toBe(0);
    });

    it('should handle empty timestamps gracefully', () => {
      const timestamps: PipelineTimestamps = {};

      tracker.recordFromTimestamps(timestamps);

      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(0);
    });

    it('should accumulate from multiple timestamp recordings', () => {
      tracker.recordFromTimestamps({
        wsReceivedAt: 1000,
        detectedAt: 1030,
        coordinatorAt: 1040,
      });
      tracker.recordFromTimestamps({
        wsReceivedAt: 2000,
        detectedAt: 2050,
        coordinatorAt: 2060,
      });

      const metrics = tracker.getMetrics();
      // E2E: (40 + 60) / 2 = 50
      expect(metrics.e2e.count).toBe(2);
      expect(metrics.e2e.avg).toBe(50);
      // wsToDetector: (30 + 50) / 2 = 40
      expect(metrics.wsToDetector.count).toBe(2);
      expect(metrics.wsToDetector.avg).toBe(40);
    });
  });

  // ==========================================================================
  // getMetrics output shape
  // ==========================================================================

  describe('getMetrics', () => {
    it('should return correct LatencyMetrics shape', () => {
      tracker.recordE2ELatency(10);
      tracker.recordStageLatency('ws_receive', 3);
      tracker.recordStageLatency('detector_process', 5);

      const metrics: LatencyMetrics = tracker.getMetrics();

      // Verify top-level structure
      expect(metrics).toHaveProperty('e2e');
      expect(metrics).toHaveProperty('wsToDetector');
      expect(metrics).toHaveProperty('detectorToPublish');
      expect(metrics).toHaveProperty('stageBreakdown');

      // Verify PercentileStats shape
      const statsKeys = ['p50', 'p95', 'p99', 'count', 'avg'];
      for (const key of statsKeys) {
        expect(metrics.e2e).toHaveProperty(key);
        expect(typeof (metrics.e2e as unknown as Record<string, unknown>)[key]).toBe('number');
      }

      // Verify stage breakdown includes default stages
      for (const stage of PIPELINE_STAGES) {
        expect(metrics.stageBreakdown).toHaveProperty(stage);
      }
    });
  });

  // ==========================================================================
  // getHealthData
  // ==========================================================================

  describe('getHealthData', () => {
    it('should return metrics plus bufferCapacity', () => {
      tracker.recordE2ELatency(25);

      const health = tracker.getHealthData();
      expect(health.bufferCapacity).toBe(100);
      expect(health.e2e.count).toBe(1);
      expect(health.e2e.avg).toBe(25);
      expect(health).toHaveProperty('stageBreakdown');
    });
  });

  // ==========================================================================
  // reset
  // ==========================================================================

  describe('reset', () => {
    it('should clear all buffers', () => {
      tracker.recordE2ELatency(10);
      tracker.recordStageLatency('ws_receive', 5);
      tracker.recordStageLatency('detector_process', 8);
      tracker.recordFromTimestamps({
        wsReceivedAt: 1000,
        detectedAt: 1030,
      });

      tracker.reset();

      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(0);
      expect(metrics.wsToDetector.count).toBe(0);
      expect(metrics.detectorToPublish.count).toBe(0);
      for (const stage of PIPELINE_STAGES) {
        expect(metrics.stageBreakdown[stage].count).toBe(0);
      }
    });

    it('should allow reuse after reset', () => {
      tracker.recordE2ELatency(100);
      tracker.reset();

      tracker.recordE2ELatency(50);
      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(1);
      expect(metrics.e2e.avg).toBe(50);
    });
  });

  // ==========================================================================
  // Singleton / Factory
  // ==========================================================================

  describe('singleton', () => {
    afterEach(() => {
      resetLatencyTracker();
    });

    it('should return same instance from getLatencyTracker', () => {
      const t1 = getLatencyTracker();
      const t2 = getLatencyTracker();
      expect(t1).toBe(t2);
    });

    it('should reset singleton via resetLatencyTracker', () => {
      const t1 = getLatencyTracker();
      t1.recordE2ELatency(99);

      resetLatencyTracker();

      const t2 = getLatencyTracker();
      expect(t2).not.toBe(t1);
      expect(t2.getMetrics().e2e.count).toBe(0);
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle very large latency values', () => {
      tracker.recordE2ELatency(Number.MAX_SAFE_INTEGER);
      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(1);
      expect(metrics.e2e.avg).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should handle zero latency', () => {
      tracker.recordE2ELatency(0);
      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(1);
      expect(metrics.e2e.avg).toBe(0);
      expect(metrics.e2e.p50).toBe(0);
    });

    it('should handle negative latency values (clock skew)', () => {
      // Negative values can occur with clock skew between services
      tracker.recordE2ELatency(-5);
      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(1);
      expect(metrics.e2e.avg).toBe(-5);
    });

    it('should handle many samples for accuracy', () => {
      const smallTracker = new LatencyTracker({ bufferCapacity: 1000 });

      // Push 1000 samples
      for (let i = 1; i <= 1000; i++) {
        smallTracker.recordE2ELatency(i);
      }

      const metrics = smallTracker.getMetrics();
      expect(metrics.e2e.count).toBe(1000);
      expect(metrics.e2e.avg).toBeCloseTo(500.5, 1);
      expect(metrics.e2e.p50).toBe(500);
      expect(metrics.e2e.p95).toBe(950);
      expect(metrics.e2e.p99).toBe(990);
    });

    it('should handle interleaved stage and E2E recordings', () => {
      tracker.recordStageLatency('ws_receive', 5);
      tracker.recordE2ELatency(40);
      tracker.recordStageLatency('detector_process', 20);
      tracker.recordE2ELatency(45);

      const metrics = tracker.getMetrics();
      expect(metrics.e2e.count).toBe(2);
      expect(metrics.stageBreakdown['ws_receive'].count).toBe(1);
      expect(metrics.stageBreakdown['detector_process'].count).toBe(1);
    });
  });
});
