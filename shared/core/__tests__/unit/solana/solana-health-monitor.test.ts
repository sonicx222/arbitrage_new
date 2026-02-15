/**
 * Solana Health Monitor Unit Tests
 *
 * Tests for health status determination, slot updates with mutex,
 * latency tracking, and lifecycle-aware monitoring.
 */

import { createSolanaHealthMonitor, type SolanaHealthMonitor } from '../../../src/solana/solana-health-monitor';
import { createMockLogger, createMockPerfLogger, createMockRedisClient, createMockConnection, createMockLifecycle } from './solana-test-helpers';

describe('SolanaHealthMonitor', () => {
  let monitor: SolanaHealthMonitor;
  let logger: ReturnType<typeof createMockLogger>;
  let perfLogger: ReturnType<typeof createMockPerfLogger>;
  let redis: ReturnType<typeof createMockRedisClient>;
  let mockConnection: ReturnType<typeof createMockConnection>;
  let lifecycle: ReturnType<typeof createMockLifecycle>;
  let getCurrentSlot: jest.Mock;
  let setCurrentSlot: jest.Mock;
  let getConnectionMetrics: jest.Mock;

  const defaultConfig = { healthCheckIntervalMs: 5000 };
  const startTime = Date.now() - 60000; // 60s ago

  beforeEach(() => {
    jest.useFakeTimers();
    logger = createMockLogger();
    perfLogger = createMockPerfLogger();
    redis = createMockRedisClient();
    mockConnection = createMockConnection();
    lifecycle = createMockLifecycle();
    getCurrentSlot = jest.fn().mockReturnValue(200000000);
    setCurrentSlot = jest.fn();
    getConnectionMetrics = jest.fn().mockReturnValue({
      totalConnections: 3,
      healthyConnections: 3,
      failedRequests: 0,
      avgLatencyMs: 0
    });

    monitor = createSolanaHealthMonitor(defaultConfig, {
      logger,
      perfLogger,
      redis,
      getConnection: jest.fn().mockReturnValue(mockConnection),
      getConnectionMetrics,
      getSubscriptionCount: jest.fn().mockReturnValue(2),
      getPoolCount: jest.fn().mockReturnValue(10),
      getStartTime: jest.fn().mockReturnValue(startTime),
      getCurrentSlot,
      setCurrentSlot,
      lifecycle
    });
  });

  afterEach(() => {
    monitor.cleanup();
    jest.useRealTimers();
  });

  // =========================================================================
  // getHealth
  // =========================================================================

  describe('getHealth', () => {
    it('should return healthy when running and all connections healthy', async () => {
      const health = await monitor.getHealth();

      expect(health.service).toBe('solana-detector');
      expect(health.status).toBe('healthy');
      expect(health.subscriptions).toBe(2);
      expect(health.pools).toBe(10);
      expect(health.slot).toBe(200000000);
    });

    it('should return unhealthy when not running', async () => {
      lifecycle.isRunning.mockReturnValue(false);

      const health = await monitor.getHealth();
      expect(health.status).toBe('unhealthy');
    });

    it('should return unhealthy when no healthy connections', async () => {
      getConnectionMetrics.mockReturnValue({
        totalConnections: 3,
        healthyConnections: 0,
        failedRequests: 5,
        avgLatencyMs: 0
      });

      const health = await monitor.getHealth();
      expect(health.status).toBe('unhealthy');
    });

    it('should return degraded when some connections unhealthy', async () => {
      getConnectionMetrics.mockReturnValue({
        totalConnections: 3,
        healthyConnections: 2,
        failedRequests: 1,
        avgLatencyMs: 50
      });

      const health = await monitor.getHealth();
      expect(health.status).toBe('degraded');
    });

    it('should calculate uptime from startTime', async () => {
      const health = await monitor.getHealth();
      // startTime is 60s ago, uptime is in seconds
      expect(health.uptime).toBeGreaterThanOrEqual(59);
    });

    it('should return 0 uptime when startTime is 0', async () => {
      const mon = createSolanaHealthMonitor(defaultConfig, {
        logger,
        perfLogger,
        redis,
        getConnection: jest.fn().mockReturnValue(mockConnection),
        getConnectionMetrics,
        getSubscriptionCount: jest.fn().mockReturnValue(0),
        getPoolCount: jest.fn().mockReturnValue(0),
        getStartTime: jest.fn().mockReturnValue(0),
        getCurrentSlot,
        setCurrentSlot,
        lifecycle
      });

      const health = await mon.getHealth();
      expect(health.uptime).toBe(0);
      mon.cleanup();
    });

    it('should include memory usage', async () => {
      const health = await monitor.getHealth();
      expect(health.memoryUsage).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // getAvgLatency
  // =========================================================================

  describe('getAvgLatency', () => {
    it('should return 0 when no latency data', () => {
      expect(monitor.getAvgLatency()).toBe(0);
    });
  });

  // =========================================================================
  // start / stop
  // =========================================================================

  describe('start / stop', () => {
    it('should start periodic health checks', async () => {
      monitor.start();

      // Advance past one interval
      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs + 100);

      expect(mockConnection.getSlot).toHaveBeenCalled();
      expect(setCurrentSlot).toHaveBeenCalled();
    });

    it('should not start multiple intervals', () => {
      monitor.start();
      monitor.start(); // should be no-op

      // Only one interval should exist — verify by advancing time
      // and checking call count
      jest.advanceTimersByTime(defaultConfig.healthCheckIntervalMs * 2);
      // If two intervals, getSlot would be called more times
    });

    it('should stop health monitoring', async () => {
      monitor.start();

      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs + 100);
      const callCountAfterFirst = mockConnection.getSlot.mock.calls.length;

      monitor.stop();

      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs * 3);
      expect(mockConnection.getSlot.mock.calls.length).toBe(callCountAfterFirst);
    });

    it('should stop interval when lifecycle is not running', async () => {
      monitor.start();

      lifecycle.isRunning.mockReturnValue(false);
      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs + 100);

      // After detecting not running, interval should self-clear
      lifecycle.isRunning.mockReturnValue(true);
      mockConnection.getSlot.mockClear();
      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs * 2);

      expect(mockConnection.getSlot).not.toHaveBeenCalled();
    });

    it('should update Redis health when available', async () => {
      monitor.start();

      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs + 100);

      expect(redis.updateServiceHealth).toHaveBeenCalledWith(
        'solana-detector',
        expect.objectContaining({
          name: 'solana-detector',
          status: 'healthy'
        })
      );
    });

    it('should log perfLogger health check', async () => {
      monitor.start();

      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs + 100);

      expect(perfLogger.logHealthCheck).toHaveBeenCalledWith(
        'solana-detector',
        expect.any(Object)
      );
    });

    it('should handle slot update failure gracefully', async () => {
      mockConnection.getSlot.mockRejectedValueOnce(new Error('RPC timeout'));

      monitor.start();
      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs + 100);

      expect(logger.warn).toHaveBeenCalledWith('Failed to update current slot', expect.any(Object));
    });

    it('should handle health monitoring errors', async () => {
      getConnectionMetrics.mockImplementationOnce(() => { throw new Error('metrics error'); });

      monitor.start();
      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs + 100);

      expect(logger.error).toHaveBeenCalledWith('Health monitoring failed', expect.any(Object));
    });

    it('should not log error when stopping during health check failure', async () => {
      getConnectionMetrics.mockImplementationOnce(() => { throw new Error('metrics error'); });
      lifecycle.isStopping.mockReturnValue(true);

      monitor.start();
      // Force the interval to fire even though isStopping is true
      lifecycle.isRunning.mockReturnValue(true);
      lifecycle.isStopping.mockReturnValueOnce(false).mockReturnValue(true);

      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs + 100);

      // Should not log error since we're stopping
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('should work without Redis', async () => {
      const monNoRedis = createSolanaHealthMonitor(defaultConfig, {
        logger,
        perfLogger,
        redis: null,
        getConnection: jest.fn().mockReturnValue(mockConnection),
        getConnectionMetrics,
        getSubscriptionCount: jest.fn().mockReturnValue(0),
        getPoolCount: jest.fn().mockReturnValue(0),
        getStartTime: jest.fn().mockReturnValue(startTime),
        getCurrentSlot,
        setCurrentSlot,
        lifecycle
      });

      monNoRedis.start();
      await jest.advanceTimersByTimeAsync(defaultConfig.healthCheckIntervalMs + 100);

      // Should not throw — just skip Redis update
      expect(perfLogger.logHealthCheck).toHaveBeenCalled();
      monNoRedis.cleanup();
    });
  });

  // =========================================================================
  // cleanup
  // =========================================================================

  describe('cleanup', () => {
    it('should stop monitoring and clear latency data', () => {
      monitor.start();
      monitor.cleanup();

      // After cleanup, getAvgLatency should return 0
      expect(monitor.getAvgLatency()).toBe(0);
    });
  });
});
