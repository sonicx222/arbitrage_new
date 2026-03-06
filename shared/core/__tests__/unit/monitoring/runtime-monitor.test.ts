/**
 * RuntimeMonitor Tests
 *
 * Unit tests for the Node.js runtime health monitor including:
 * - Event loop delay tracking via perf_hooks.monitorEventLoopDelay()
 * - GC pause tracking via PerformanceObserver
 * - Memory breakdown from process.memoryUsage()
 * - Singleton lifecycle (get/reset)
 * - Prometheus text export
 * - Start/stop lifecycle
 *
 * @see monitoring/runtime-monitor.ts
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  RuntimeMonitor,
  getRuntimeMonitor,
  resetRuntimeMonitor,
} from '../../../src/monitoring/runtime-monitor';
import type { RuntimeMetrics } from '../../../src/monitoring/runtime-monitor';

describe('RuntimeMonitor', () => {
  let monitor: RuntimeMonitor;

  beforeEach(() => {
    resetRuntimeMonitor();
    monitor = new RuntimeMonitor();
  });

  afterEach(() => {
    monitor.stop();
    resetRuntimeMonitor();
  });

  // ==========================================================================
  // Constructor & Lifecycle
  // ==========================================================================

  describe('constructor', () => {
    it('should create monitor in stopped state', () => {
      expect(monitor.isRunning()).toBe(false);
    });
  });

  describe('start/stop', () => {
    it('should transition to running on start', () => {
      monitor.start();
      expect(monitor.isRunning()).toBe(true);
    });

    it('should transition to stopped on stop', () => {
      monitor.start();
      monitor.stop();
      expect(monitor.isRunning()).toBe(false);
    });

    it('should be idempotent on duplicate start', () => {
      monitor.start();
      monitor.start(); // should not throw
      expect(monitor.isRunning()).toBe(true);
    });

    it('should be idempotent on duplicate stop', () => {
      monitor.start();
      monitor.stop();
      monitor.stop(); // should not throw
      expect(monitor.isRunning()).toBe(false);
    });

    it('should be safe to stop without starting', () => {
      monitor.stop(); // should not throw
      expect(monitor.isRunning()).toBe(false);
    });
  });

  // ==========================================================================
  // getMetrics
  // ==========================================================================

  describe('getMetrics', () => {
    it('should return metrics even when not started', () => {
      const metrics = monitor.getMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.eventLoop).toBeDefined();
      expect(metrics.memory).toBeDefined();
      expect(metrics.gc).toBeDefined();
    });

    it('should return event loop delay metrics', () => {
      monitor.start();
      const metrics = monitor.getMetrics();

      expect(typeof metrics.eventLoop.min).toBe('number');
      expect(typeof metrics.eventLoop.max).toBe('number');
      expect(typeof metrics.eventLoop.mean).toBe('number');
      expect(typeof metrics.eventLoop.p50).toBe('number');
      expect(typeof metrics.eventLoop.p99).toBe('number');
    });

    it('should return memory metrics in MB', () => {
      const metrics = monitor.getMetrics();

      expect(typeof metrics.memory.heapUsed).toBe('number');
      expect(typeof metrics.memory.heapTotal).toBe('number');
      expect(typeof metrics.memory.rss).toBe('number');
      expect(typeof metrics.memory.external).toBe('number');
      expect(typeof metrics.memory.arrayBuffers).toBe('number');
      // Memory values should be positive
      expect(metrics.memory.rss).toBeGreaterThan(0);
      expect(metrics.memory.heapUsed).toBeGreaterThan(0);
    });

    it('should return GC metrics', () => {
      const metrics = monitor.getMetrics();

      expect(typeof metrics.gc.totalPauseMs).toBe('number');
      expect(typeof metrics.gc.count).toBe('number');
      expect(typeof metrics.gc.majorCount).toBe('number');
      expect(metrics.gc.totalPauseMs).toBeGreaterThanOrEqual(0);
      expect(metrics.gc.count).toBeGreaterThanOrEqual(0);
    });
  });

  // ==========================================================================
  // getPrometheusMetrics
  // ==========================================================================

  describe('getPrometheusMetrics', () => {
    it('should return Prometheus-formatted text', () => {
      const text = monitor.getPrometheusMetrics();

      expect(typeof text).toBe('string');
      // Should contain HELP and TYPE annotations
      expect(text).toContain('# HELP');
      expect(text).toContain('# TYPE');
    });

    it('should include event loop metrics', () => {
      monitor.start();
      const text = monitor.getPrometheusMetrics();

      expect(text).toContain('runtime_eventloop_delay_min_ms');
      expect(text).toContain('runtime_eventloop_delay_max_ms');
      expect(text).toContain('runtime_eventloop_delay_mean_ms');
      expect(text).toContain('runtime_eventloop_delay_p50_ms');
      expect(text).toContain('runtime_eventloop_delay_p99_ms');
    });

    it('should include memory metrics', () => {
      const text = monitor.getPrometheusMetrics();

      expect(text).toContain('runtime_memory_heap_used_mb');
      expect(text).toContain('runtime_memory_heap_total_mb');
      expect(text).toContain('runtime_memory_rss_mb');
      expect(text).toContain('runtime_memory_external_mb');
      expect(text).toContain('runtime_memory_array_buffers_mb');
    });

    it('should include GC metrics', () => {
      const text = monitor.getPrometheusMetrics();

      expect(text).toContain('runtime_gc_pause_total_ms');
      expect(text).toContain('runtime_gc_count_total');
      expect(text).toContain('runtime_gc_major_count_total');
    });
  });

  // ==========================================================================
  // Singleton
  // ==========================================================================

  describe('singleton', () => {
    it('should return same instance on repeated calls', () => {
      const a = getRuntimeMonitor();
      const b = getRuntimeMonitor();
      expect(a).toBe(b);
      a.stop();
    });

    it('should return new instance after reset', () => {
      const a = getRuntimeMonitor();
      a.start();
      resetRuntimeMonitor();
      const b = getRuntimeMonitor();
      expect(a).not.toBe(b);
      b.stop();
    });

    it('should stop the old instance on reset', () => {
      const a = getRuntimeMonitor();
      a.start();
      expect(a.isRunning()).toBe(true);
      resetRuntimeMonitor();
      expect(a.isRunning()).toBe(false);
    });
  });

  // ==========================================================================
  // Edge Cases
  // ==========================================================================

  describe('edge cases', () => {
    it('should handle getMetrics before any event loop ticks', () => {
      // Immediately after creation, event loop histogram has no data
      const metrics = monitor.getMetrics();
      expect(metrics.eventLoop.min).toBeGreaterThanOrEqual(0);
    });
  });
});
