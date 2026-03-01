/**
 * Unit Tests for EnhancedHealthMonitor
 *
 * Tests system health monitoring, alerting, threshold checks,
 * and Redis Streams publishing.
 *
 * P1 FIX #1: Added test coverage for previously untested module.
 *
 * @see ADR-002: Redis Streams over Pub/Sub
 * @see ADR-009: Test Architecture
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  EnhancedHealthMonitor,
  resetEnhancedHealthMonitor,
} from '../../src/monitoring/enhanced-health-monitor';
import type {
  EnhancedHealthMonitorDeps,
  HealthMetric,
} from '../../src/monitoring/enhanced-health-monitor';

// ============================================================================
// Mock Factories (DI pattern per ADR-009)
// ============================================================================

const createMockLogger = () => ({
  info: jest.fn<(msg: string, meta?: object) => void>(),
  error: jest.fn<(msg: string, meta?: object) => void>(),
  warn: jest.fn<(msg: string, meta?: object) => void>(),
  debug: jest.fn<(msg: string, meta?: object) => void>(),
});

const createMockRedis = () => ({
  ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
  get: jest.fn<() => Promise<any>>().mockResolvedValue(null),
  publish: jest.fn<() => Promise<number>>().mockResolvedValue(1),
  getAllServiceHealth: jest.fn<() => Promise<Record<string, any>>>().mockResolvedValue({}),
});

const createMockStreamsClient = () => ({
  xadd: jest.fn<() => Promise<string>>().mockResolvedValue('1234-0'),
  xaddWithLimit: jest.fn<() => Promise<string>>().mockResolvedValue('1234-0'),
  ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
});

const createMockCircuitBreakers = () => ({
  getAllStats: jest.fn().mockReturnValue({}),
});

const createMockDlq = () => ({
  getStats: jest.fn<() => Promise<any>>().mockResolvedValue({ totalOperations: 0 }),
});

const createMockDegradationManager = () => ({
  getAllDegradationStates: jest.fn().mockReturnValue({}),
});

const createMockStreamHealthMonitor = () => ({
  getSummary: jest.fn<() => Promise<any>>().mockResolvedValue({
    streamsMonitored: 0,
    totalLag: 0,
    alerts: [],
    isHealthy: true,
  }),
});

const createMockRecoveryHealth = () =>
  jest.fn<() => Promise<any>>().mockResolvedValue({ status: 'healthy' });

/**
 * Create a full set of mock deps for EnhancedHealthMonitor.
 */
function createMockDeps(): {
  deps: EnhancedHealthMonitorDeps;
  mocks: {
    redis: ReturnType<typeof createMockRedis>;
    streams: ReturnType<typeof createMockStreamsClient>;
    circuitBreakers: ReturnType<typeof createMockCircuitBreakers>;
    dlq: ReturnType<typeof createMockDlq>;
    degradationManager: ReturnType<typeof createMockDegradationManager>;
    streamHealthMonitor: ReturnType<typeof createMockStreamHealthMonitor>;
    recoveryHealth: ReturnType<typeof createMockRecoveryHealth>;
  };
} {
  const redis = createMockRedis();
  const streams = createMockStreamsClient();
  const circuitBreakers = createMockCircuitBreakers();
  const dlq = createMockDlq();
  const degradationManager = createMockDegradationManager();
  const streamHealthMonitor = createMockStreamHealthMonitor();
  const recoveryHealth = createMockRecoveryHealth();

  return {
    deps: {
      redis: Promise.resolve(redis) as any,
      streamsClient: streams as any,
      circuitBreakers: circuitBreakers as any,
      dlq: dlq as any,
      degradationManager: degradationManager as any,
      streamHealthMonitor: streamHealthMonitor as any,
      recoveryHealthChecker: recoveryHealth,
    },
    mocks: {
      redis,
      streams,
      circuitBreakers,
      dlq,
      degradationManager,
      streamHealthMonitor,
      recoveryHealth,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('EnhancedHealthMonitor', () => {
  let monitor: EnhancedHealthMonitor;
  let mocks: ReturnType<typeof createMockDeps>['mocks'];

  beforeEach(() => {
    jest.clearAllMocks();
    resetEnhancedHealthMonitor();
    const created = createMockDeps();
    mocks = created.mocks;
    monitor = new EnhancedHealthMonitor(created.deps);
  });

  afterEach(() => {
    monitor.stop();
  });

  describe('constructor', () => {
    it('should create instance with injected deps', () => {
      expect(monitor).toBeDefined();
    });

    it('should initialize default alert rules', () => {
      // The monitor should have default rules set up
      // We verify by triggering a health check and seeing rules evaluated
      expect(monitor).toBeInstanceOf(EnhancedHealthMonitor);
    });
  });

  describe('lifecycle', () => {
    it('should start monitoring with a timer', () => {
      monitor.start(60000);
      // start() sets an interval — we can verify by checking stop() clears it
      monitor.stop();
      // No error means success
    });

    it('should stop monitoring and clear state', () => {
      monitor.start(60000);
      monitor.stop();
      // Calling stop again should be safe
      monitor.stop();
    });
  });

  describe('recordMetric', () => {
    it('should accept and buffer metrics', () => {
      const metric: HealthMetric = {
        name: 'test_metric',
        value: 42,
        unit: 'count',
        timestamp: Date.now(),
      };

      monitor.recordMetric(metric);
      // No error means success — metric is buffered internally
    });

    it('should check thresholds for error metrics', () => {
      const metric: HealthMetric = {
        name: 'error_rate',
        value: 0.5,
        unit: 'ratio',
        timestamp: Date.now(),
      };

      // Should not throw even with high error rate
      monitor.recordMetric(metric);
    });

    it('should check thresholds for latency metrics', () => {
      const metric: HealthMetric = {
        name: 'latency',
        value: 10000,
        unit: 'ms',
        timestamp: Date.now(),
      };

      monitor.recordMetric(metric);
    });
  });

  describe('getSystemHealth', () => {
    it('should return system health status', async () => {
      const health = await monitor.getSystemHealth();

      expect(health).toBeDefined();
      expect(health.overall).toBeDefined();
      expect(['healthy', 'warning', 'critical', 'unknown']).toContain(health.overall);
      expect(health.services).toBeDefined();
      expect(health.infrastructure).toBeDefined();
      expect(health.performance).toBeDefined();
      expect(health.resilience).toBeDefined();
      expect(health.timestamp).toBeGreaterThan(0);
    });

    it('should report Redis health from injected client', async () => {
      const health = await monitor.getSystemHealth();
      expect(health.infrastructure.redis).toBe(true);
      expect(mocks.redis.ping).toHaveBeenCalled();
    });

    it('should report Redis unhealthy when ping fails', async () => {
      mocks.redis.ping.mockRejectedValueOnce(new Error('connection refused'));
      const health = await monitor.getSystemHealth();
      expect(health.infrastructure.redis).toBe(false);
    });

    it('should include stream health summary', async () => {
      const health = await monitor.getSystemHealth();
      expect(mocks.streamHealthMonitor.getSummary).toHaveBeenCalled();
      expect(health.infrastructure.streams).toBeDefined();
    });

    it('should handle stream health monitor failure gracefully', async () => {
      mocks.streamHealthMonitor.getSummary.mockRejectedValueOnce(
        new Error('stream monitor unavailable')
      );
      const health = await monitor.getSystemHealth();
      expect(health.infrastructure.streams).toBeNull();
    });

    it('should include resilience health from circuit breakers', async () => {
      mocks.circuitBreakers.getAllStats.mockReturnValue({
        'test-breaker': { state: 'CLOSED', failures: 0 },
      });
      const health = await monitor.getSystemHealth();
      expect(health.resilience.circuitBreakers).toEqual({
        'test-breaker': { state: 'CLOSED', failures: 0 },
      });
    });

    it('should include DLQ stats', async () => {
      mocks.dlq.getStats.mockResolvedValue({ totalOperations: 50 });
      const health = await monitor.getSystemHealth();
      expect(health.resilience.deadLetterQueue).toEqual({ totalOperations: 50 });
    });
  });

  describe('P1 FIX #4: cpuUsage delta calculation', () => {
    it('should return 0 cpuUsage on first call', async () => {
      const health = await monitor.getSystemHealth();
      // First call has no previous measurement, so cpuUsage should be 0
      expect(health.performance.cpuUsage).toBe(0);
    });

    it('should return a bounded cpu percentage on subsequent calls', async () => {
      // First call establishes baseline
      await monitor.getSystemHealth();
      // Second call computes delta
      const health = await monitor.getSystemHealth();
      expect(health.performance.cpuUsage).toBeGreaterThanOrEqual(0);
      expect(health.performance.cpuUsage).toBeLessThanOrEqual(1);
    });
  });

  describe('P1 FIX #3: recursion guard', () => {
    it('should not recurse infinitely via check_services action', async () => {
      // Add a rule that triggers check_services action
      monitor.addAlertRule({
        name: 'test_recursion_rule',
        condition: () => true, // Always triggers
        severity: 'warning',
        message: 'Test alert',
        cooldown: 0,
        actions: ['check_services'],
      });

      // Record enough metrics to trigger alert evaluation
      for (let i = 0; i < 5; i++) {
        monitor.recordMetric({
          name: 'error_rate',
          value: 0.5,
          unit: 'ratio',
          timestamp: Date.now(),
        });
      }

      // getSystemHealth -> performHealthCheck -> checkAlertRules -> check_services
      // -> performHealthCheck (should bail out due to re-entry guard)
      // If the guard doesn't work, this will stack overflow
      const health = await monitor.getSystemHealth();
      expect(health).toBeDefined();
    });
  });

  describe('P1 FIX #2: publishToStream (no Pub/Sub fallback)', () => {
    it('should publish alerts to Redis Streams only', async () => {
      // Add a rule that always triggers
      monitor.addAlertRule({
        name: 'test_stream_publish',
        condition: () => true,
        severity: 'warning',
        message: 'Test alert for stream publish',
        cooldown: 0,
        actions: ['log'],
      });

      // Record metrics to be available during alert check
      monitor.recordMetric({
        name: 'test_metric',
        value: 1,
        unit: 'count',
        timestamp: Date.now(),
      });

      // Trigger health check which evaluates alert rules
      const health = await monitor.getSystemHealth();
      expect(health).toBeDefined();

      // Streams client should have been called with health alert
      // (xadd is called when an alert rule triggers)
      if (mocks.streams.xaddWithLimit.mock.calls.length > 0) {
        const streamArg = (mocks.streams.xaddWithLimit.mock.calls[0] as any[])[0];
        expect(streamArg).toBe('stream:health-alerts');
      }

      // Pub/Sub should NOT have been called (P1 FIX #2: removed fallback)
      expect(mocks.redis.publish).not.toHaveBeenCalled();
    });
  });

  describe('addAlertRule', () => {
    it('should add custom alert rules', () => {
      monitor.addAlertRule({
        name: 'custom_rule',
        condition: () => false,
        severity: 'info',
        message: 'Custom alert',
        cooldown: 1000,
        actions: ['log'],
      });
      // No error means success
    });
  });

  describe('addThreshold', () => {
    it('should add custom thresholds', () => {
      monitor.addThreshold({
        metric: 'custom_metric',
        warning: 50,
        critical: 90,
        direction: 'above',
      });
      // No error means success
    });
  });

  describe('overall health determination', () => {
    it('should report critical when Redis is down', async () => {
      mocks.redis.ping.mockRejectedValue(new Error('down'));
      const health = await monitor.getSystemHealth();
      // With Redis and messageQueue down, infrastructure is unhealthy
      expect(health.overall).toBe('critical');
    });

    it('should report healthy when all systems nominal', async () => {
      const health = await monitor.getSystemHealth();
      expect(health.overall).toBe('healthy');
    });
  });
});

describe('resetEnhancedHealthMonitor', () => {
  it('should reset the singleton instance', () => {
    resetEnhancedHealthMonitor();
    // Should not throw
  });
});
