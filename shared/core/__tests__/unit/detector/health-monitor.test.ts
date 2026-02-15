/**
 * Detector Health Monitor Tests
 *
 * Tests for health monitoring with periodic health checks and graceful shutdown.
 * Covers lifecycle, self-termination, callbacks, shutdown guards, and error handling.
 *
 * Migrated from base-detector.test.ts as part of Phase 2 test migration.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  DetectorHealthMonitor,
  createDetectorHealthMonitor,
  type HealthMonitorConfig,
  type HealthMonitorDeps,
} from '../../../src/detector/health-monitor';

describe('DetectorHealthMonitor', () => {
  // Mock dependencies
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const mockPerfLogger = {
    logHealthCheck: jest.fn(),
  };

  const mockRedis = {
    updateServiceHealth: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };

  const mockHealth = {
    service: 'test-service',
    status: 'healthy' as const,
    uptime: 1000,
    memoryUsage: 100,
    cpuUsage: 50,
    lastHeartbeat: Date.now(),
    pairs: 10,
    websocket: { connected: true },
    batcherStats: {},
    chain: 'ethereum',
    dexCount: 2,
    tokenCount: 5,
    factorySubscription: null,
  };

  let isRunning: boolean;
  let isStopping: boolean;

  const createMockDeps = (): HealthMonitorDeps => ({
    logger: mockLogger as any,
    perfLogger: mockPerfLogger,
    redis: mockRedis as any,
    getHealth: jest.fn<() => Promise<any>>().mockResolvedValue(mockHealth),
    isRunning: () => isRunning,
    isStopping: () => isStopping,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    isRunning = true;
    isStopping = false;
    // Restore mock implementations that clearAllMocks doesn't reset
    mockRedis.updateServiceHealth.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =============================================================================
  // Lifecycle Management
  // =============================================================================

  describe('Lifecycle', () => {
    describe('start()', () => {
      it('should start health monitoring with interval', () => {
        const config: HealthMonitorConfig = {
          serviceName: 'test-service',
          chain: 'ethereum',
          healthCheckInterval: 1000,
        };
        const deps = createMockDeps();

        const monitor = createDetectorHealthMonitor(config, deps);
        monitor.start();

        expect(monitor.isActive()).toBe(true);
        expect(mockLogger.debug).toHaveBeenCalledWith(
          'Health monitoring started',
          expect.objectContaining({
            service: 'test-service',
            interval: 1000,
          })
        );
      });

      it('should use default interval (30000ms) if not specified', () => {
        const config: HealthMonitorConfig = {
          serviceName: 'test-service',
          chain: 'ethereum',
        };
        const deps = createMockDeps();

        const monitor = createDetectorHealthMonitor(config, deps);
        monitor.start();

        expect(mockLogger.debug).toHaveBeenCalledWith(
          'Health monitoring started',
          expect.objectContaining({
            interval: 30000,
          })
        );
      });

      it('should not start if already started (idempotent)', () => {
        const config: HealthMonitorConfig = {
          serviceName: 'test-service',
          chain: 'ethereum',
        };
        const deps = createMockDeps();

        const monitor = createDetectorHealthMonitor(config, deps);
        monitor.start();
        mockLogger.debug.mockClear();

        // Try to start again
        monitor.start();

        expect(mockLogger.debug).not.toHaveBeenCalled();
        expect(monitor.isActive()).toBe(true);
      });
    });

    describe('stop()', () => {
      it('should stop health monitoring and clear interval', () => {
        const config: HealthMonitorConfig = {
          serviceName: 'test-service',
          chain: 'ethereum',
        };
        const deps = createMockDeps();

        const monitor = createDetectorHealthMonitor(config, deps);
        monitor.start();
        expect(monitor.isActive()).toBe(true);

        monitor.stop();

        expect(monitor.isActive()).toBe(false);
        expect(mockLogger.debug).toHaveBeenCalledWith(
          'Health monitoring stopped',
          expect.objectContaining({
            service: 'test-service',
          })
        );
      });

      it('should be safe to call stop() when not started', () => {
        const config: HealthMonitorConfig = {
          serviceName: 'test-service',
          chain: 'ethereum',
        };
        const deps = createMockDeps();

        const monitor = createDetectorHealthMonitor(config, deps);

        // Should not throw
        expect(() => monitor.stop()).not.toThrow();
        expect(monitor.isActive()).toBe(false);
      });

      it('should be safe to call stop() multiple times', () => {
        const config: HealthMonitorConfig = {
          serviceName: 'test-service',
          chain: 'ethereum',
        };
        const deps = createMockDeps();

        const monitor = createDetectorHealthMonitor(config, deps);
        monitor.start();
        monitor.stop();
        mockLogger.debug.mockClear();

        // Call stop again
        monitor.stop();

        // Should not log again
        expect(mockLogger.debug).not.toHaveBeenCalled();
      });
    });

    describe('isActive()', () => {
      it('should return false when not started', () => {
        const config: HealthMonitorConfig = {
          serviceName: 'test-service',
          chain: 'ethereum',
        };
        const deps = createMockDeps();

        const monitor = createDetectorHealthMonitor(config, deps);

        expect(monitor.isActive()).toBe(false);
      });

      it('should return true when started', () => {
        const config: HealthMonitorConfig = {
          serviceName: 'test-service',
          chain: 'ethereum',
        };
        const deps = createMockDeps();

        const monitor = createDetectorHealthMonitor(config, deps);
        monitor.start();

        expect(monitor.isActive()).toBe(true);
      });

      it('should return false after stop', () => {
        const config: HealthMonitorConfig = {
          serviceName: 'test-service',
          chain: 'ethereum',
        };
        const deps = createMockDeps();

        const monitor = createDetectorHealthMonitor(config, deps);
        monitor.start();
        monitor.stop();

        expect(monitor.isActive()).toBe(false);
      });
    });
  });

  // =============================================================================
  // Self-Termination on Shutdown
  // =============================================================================

  describe('Self-Termination', () => {
    it('should self-terminate when isStopping() returns true', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };
      const deps = createMockDeps();

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();
      expect(monitor.isActive()).toBe(true);

      // Simulate detector stopping
      isStopping = true;

      // Advance time to trigger interval
      jest.advanceTimersByTime(1000);
      await Promise.resolve(); // Flush promises

      // Should have self-terminated
      expect(monitor.isActive()).toBe(false);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Health monitoring stopped',
        expect.anything()
      );
    });

    it('should self-terminate when isRunning() returns false', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };
      const deps = createMockDeps();

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();
      expect(monitor.isActive()).toBe(true);

      // Simulate detector not running
      isRunning = false;

      // Advance time to trigger interval
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      // Should have self-terminated
      expect(monitor.isActive()).toBe(false);
    });

    it('should self-terminate on first check (before getHealth)', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };
      const deps = createMockDeps();

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      // Mark as stopping before first health check
      isStopping = true;

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      // getHealth should NOT have been called (early termination)
      expect(deps.getHealth).not.toHaveBeenCalled();
      expect(monitor.isActive()).toBe(false);
    });
  });

  // =============================================================================
  // Health Check Callbacks
  // =============================================================================

  describe('Health Check Callbacks', () => {
    it('should call getHealth() on interval', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };
      const deps = createMockDeps();

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(deps.getHealth).toHaveBeenCalledTimes(1);
    });

    it('should call Redis updateServiceHealth with health data', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };
      const deps = createMockDeps();

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      expect(mockRedis.updateServiceHealth).toHaveBeenCalledWith(
        'test-service',
        mockHealth
      );
    });

    it('should call perfLogger.logHealthCheck with health data', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };
      const deps = createMockDeps();

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve(); // Extra flush for async completion

      expect(mockPerfLogger.logHealthCheck).toHaveBeenCalledWith(
        'test-service',
        mockHealth
      );
    });

    it('should handle null Redis gracefully (no Redis update)', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };
      const deps = createMockDeps();
      deps.redis = null; // No Redis available

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      // Should still call getHealth and perfLogger
      expect(deps.getHealth).toHaveBeenCalled();
      expect(mockPerfLogger.logHealthCheck).toHaveBeenCalled();
      // But not try to update Redis
      expect(mockRedis.updateServiceHealth).not.toHaveBeenCalled();
    });

    it('should call health check multiple times on interval', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };
      const deps = createMockDeps();

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      // First interval
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(deps.getHealth).toHaveBeenCalledTimes(1);

      // Second interval
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(deps.getHealth).toHaveBeenCalledTimes(2);

      // Third interval
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      expect(deps.getHealth).toHaveBeenCalledTimes(3);
    });
  });

  // =============================================================================
  // Triple-Check Shutdown Guards
  // =============================================================================

  describe('Shutdown Guards (Triple-Check Pattern)', () => {
    it('should skip Redis update if stopping after getHealth()', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };

      let getHealthCallCount = 0;
      const deps = createMockDeps();
      (deps.getHealth as jest.Mock).mockImplementation(async () => {
        getHealthCallCount++;
        // Mark as stopping AFTER getHealth is called
        isStopping = true;
        return mockHealth;
      });

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve(); // Extra flush for nested async

      // getHealth was called
      expect(getHealthCallCount).toBe(1);

      // But Redis update should be skipped (Check 2 caught it)
      expect(mockRedis.updateServiceHealth).not.toHaveBeenCalled();

      // perfLogger should also be skipped (Check 3)
      expect(mockPerfLogger.logHealthCheck).not.toHaveBeenCalled();
    });

    it('should skip perfLogger if stopping after Redis update', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };

      const deps = createMockDeps();
      mockRedis.updateServiceHealth.mockImplementation(async () => {
        // Mark as stopping AFTER Redis update
        isStopping = true;
      });

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      // getHealth and Redis update were called
      expect(deps.getHealth).toHaveBeenCalled();
      expect(mockRedis.updateServiceHealth).toHaveBeenCalled();

      // But perfLogger should be skipped (Check 3 caught it)
      expect(mockPerfLogger.logHealthCheck).not.toHaveBeenCalled();
    });

    it('should use all three shutdown check points', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };
      const deps = createMockDeps();

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      // Advance full interval and drain all async operations
      await jest.advanceTimersByTimeAsync(1000);

      // Should have completed full cycle with all three checks passing
      expect(deps.getHealth).toHaveBeenCalled();
      expect(mockRedis.updateServiceHealth).toHaveBeenCalled();
      expect(mockPerfLogger.logHealthCheck).toHaveBeenCalled();
    });
  });

  // =============================================================================
  // Error Handling During Shutdown
  // =============================================================================

  describe('Error Handling', () => {
    it('should not log error if stopping (errors during shutdown are expected)', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };

      const deps = createMockDeps();
      (deps.getHealth as any).mockRejectedValue(new Error('Health check failed'));

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      // Mark as stopping
      isStopping = true;

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      // Error should NOT be logged (isStopping check prevents it)
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should log error if not stopping', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };

      const error = new Error('Health check failed');
      const deps = createMockDeps();
      (deps.getHealth as any).mockRejectedValue(error);

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      // Error should be logged (not stopping)
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Health monitoring failed',
        expect.objectContaining({ error })
      );
    });

    it('should handle Redis errors without crashing', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };

      const deps = createMockDeps();
      mockRedis.updateServiceHealth.mockRejectedValue(new Error('Redis error'));

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve(); // Extra flush for async error handling

      // Should log error
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Health monitoring failed',
        expect.objectContaining({ error: expect.any(Error) })
      );

      // Monitor should still be active
      expect(monitor.isActive()).toBe(true);
    });

    it('should continue monitoring after error', async () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
        healthCheckInterval: 1000,
      };

      const deps = createMockDeps();
      // First call fails, second succeeds
      (deps.getHealth as any)
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockResolvedValueOnce(mockHealth);

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      // First interval - error
      await jest.advanceTimersByTimeAsync(1000);
      expect(mockLogger.error).toHaveBeenCalledTimes(1);

      mockLogger.error.mockClear();

      // Second interval - success
      await jest.advanceTimersByTimeAsync(1000);
      expect(deps.getHealth).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(mockPerfLogger.logHealthCheck).toHaveBeenCalledWith(
        'test-service',
        mockHealth
      );
    });
  });

  // =============================================================================
  // Factory Function
  // =============================================================================

  describe('createDetectorHealthMonitor', () => {
    it('should create DetectorHealthMonitor instance', () => {
      const config: HealthMonitorConfig = {
        serviceName: 'test-service',
        chain: 'ethereum',
      };
      const deps = createMockDeps();

      const monitor = createDetectorHealthMonitor(config, deps);

      expect(monitor).toBeInstanceOf(DetectorHealthMonitor);
      expect(monitor.isActive()).toBe(false);
    });

    it('should apply configuration correctly', () => {
      const config: HealthMonitorConfig = {
        serviceName: 'my-service',
        chain: 'bsc',
        healthCheckInterval: 5000,
      };
      const deps = createMockDeps();

      const monitor = createDetectorHealthMonitor(config, deps);
      monitor.start();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Health monitoring started',
        expect.objectContaining({
          service: 'my-service',
          interval: 5000,
        })
      );
    });
  });
});
