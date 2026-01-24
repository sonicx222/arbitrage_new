/**
 * Tests for Hot Path Performance Monitor
 *
 * Tests for latency monitoring of critical hot path operations.
 *
 * @see Task 2.3: Hot Path Latency Monitoring
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Import will be done in beforeEach to allow reset
let HotPathMonitor: any;
let measureHotPath: any;
let measureHotPathAsync: any;

describe('HotPathMonitor', () => {
  beforeEach(() => {
    // Reset modules for clean state
    jest.resetModules();

    // Mock console.warn to suppress warnings in tests
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Import fresh module
    const module = require('../../src/performance-monitor');
    HotPathMonitor = module.HotPathMonitor;
    measureHotPath = module.measureHotPath;
    measureHotPathAsync = module.measureHotPathAsync;

    // Reset singleton
    module.resetHotPathMonitor();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = HotPathMonitor.getInstance();
      const instance2 = HotPathMonitor.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('recordLatency', () => {
    it('should record latency metrics', () => {
      const monitor = HotPathMonitor.getInstance();

      monitor.recordLatency('price-calculation', 50); // 50 microseconds

      const stats = monitor.getStats('price-calculation');
      expect(stats.avg).toBeGreaterThan(0);
    });

    it('should accumulate multiple latency recordings', () => {
      const monitor = HotPathMonitor.getInstance();

      monitor.recordLatency('price-calculation', 100);
      monitor.recordLatency('price-calculation', 200);
      monitor.recordLatency('price-calculation', 300);

      const stats = monitor.getStats('price-calculation');
      expect(stats.avg).toBeCloseTo(0.2, 5); // Average of 0.1, 0.2, 0.3 ms
    });

    it('should warn when threshold is exceeded', () => {
      const monitor = HotPathMonitor.getInstance();
      const warnSpy = console.warn as jest.Mock;

      // Record latency above threshold (100us for price-calculation)
      monitor.recordLatency('price-calculation', 200);

      expect(warnSpy).toHaveBeenCalled();
      const warnMessage = warnSpy.mock.calls[0][0];
      expect(warnMessage).toContain('Hot path slow');
      expect(warnMessage).toContain('price-calculation');
    });

    it('should not warn when below threshold', () => {
      const monitor = HotPathMonitor.getInstance();
      const warnSpy = console.warn as jest.Mock;

      // Record latency below threshold
      monitor.recordLatency('price-calculation', 50);

      // No warning for below-threshold operations
      const hotPathWarnings = warnSpy.mock.calls.filter(
        (call: unknown[]) => {
          const firstArg = call[0];
          return typeof firstArg === 'string' && firstArg.includes('Hot path slow');
        }
      );
      expect(hotPathWarnings).toHaveLength(0);
    });
  });

  describe('getStats', () => {
    it('should calculate percentile statistics', () => {
      const monitor = HotPathMonitor.getInstance();

      // Record 100 latencies
      for (let i = 1; i <= 100; i++) {
        monitor.recordLatency('test-op', i * 1000); // i ms
      }

      const stats = monitor.getStats('test-op');

      expect(stats.avg).toBeCloseTo(50.5, 0); // Average of 1-100
      // Percentiles use floor index: floor(100 * 0.5) = 50, array[50] = 51 (0-indexed)
      expect(stats.p50).toBe(51); // 50th percentile
      expect(stats.p95).toBe(96); // 95th percentile
      expect(stats.p99).toBe(100); // 99th percentile
    });

    it('should return zeros for unknown operation', () => {
      const monitor = HotPathMonitor.getInstance();

      const stats = monitor.getStats('unknown-operation');

      expect(stats.avg).toBe(0);
      expect(stats.p50).toBe(0);
      expect(stats.p95).toBe(0);
      expect(stats.p99).toBe(0);
    });
  });

  describe('measureHotPath', () => {
    it('should measure synchronous function execution time', () => {
      const result = measureHotPath('test-sync', () => {
        // Simulate some work
        let sum = 0;
        for (let i = 0; i < 1000; i++) {
          sum += i;
        }
        return sum;
      });

      // Should return the result
      expect(result).toBe(499500);

      // Should have recorded latency
      const stats = HotPathMonitor.getInstance().getStats('test-sync');
      expect(stats.avg).toBeGreaterThan(0);
    });

    it('should propagate errors from measured function', () => {
      expect(() => {
        measureHotPath('test-error', () => {
          throw new Error('Test error');
        });
      }).toThrow('Test error');
    });
  });

  describe('measureHotPathAsync', () => {
    it('should measure async function execution time', async () => {
      const result = await measureHotPathAsync('test-async', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return 'completed';
      });

      expect(result).toBe('completed');

      const stats = HotPathMonitor.getInstance().getStats('test-async');
      expect(stats.avg).toBeGreaterThan(0);
    });

    it('should propagate errors from async function', async () => {
      await expect(
        measureHotPathAsync('test-async-error', async () => {
          throw new Error('Async test error');
        })
      ).rejects.toThrow('Async test error');
    });
  });

  describe('thresholds', () => {
    it('should have default thresholds for common operations', () => {
      const monitor = HotPathMonitor.getInstance();
      const thresholds = monitor.getThresholds();

      expect(thresholds['price-calculation']).toBeDefined();
      expect(thresholds['price-matrix-update']).toBeDefined();
      expect(thresholds['arbitrage-detection']).toBeDefined();
      expect(thresholds['opportunity-publish']).toBeDefined();
    });

    it('should allow adding custom thresholds', () => {
      const monitor = HotPathMonitor.getInstance();

      monitor.setThreshold('custom-operation', 500);

      const thresholds = monitor.getThresholds();
      expect(thresholds['custom-operation']).toBe(500);
    });
  });

  describe('metrics trimming', () => {
    it('should trim old metrics when max is exceeded', () => {
      const monitor = HotPathMonitor.getInstance();

      // Record more than maxMetrics
      for (let i = 0; i < 12000; i++) {
        monitor.recordLatency('trim-test', 100);
      }

      // Internal state should be trimmed (private, so we test indirectly)
      const stats = monitor.getStats('trim-test');
      expect(stats.avg).toBeGreaterThan(0); // Should still work
    });
  });

  describe('getAllStats', () => {
    it('should return stats for all operations', () => {
      const monitor = HotPathMonitor.getInstance();

      monitor.recordLatency('op1', 100);
      monitor.recordLatency('op2', 200);
      monitor.recordLatency('op3', 300);

      const allStats = monitor.getAllStats();

      expect(allStats.has('op1')).toBe(true);
      expect(allStats.has('op2')).toBe(true);
      expect(allStats.has('op3')).toBe(true);
    });
  });
});
