import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CoordinatorService } from '../coordinator';
import { getRedisClient, resetRedisInstance } from '../../../shared/core/src';

// Mock Redis
jest.mock('../../../shared/core/src', () => ({
  getRedisClient: jest.fn(),
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  })),
  getPerformanceLogger: jest.fn(() => ({
    logEventLatency: jest.fn(),
    logHealthCheck: jest.fn()
  }))
}));

describe('CoordinatorService Integration', () => {
  let coordinator: CoordinatorService;
  let mockRedis: any;

  beforeEach(() => {
    // Reset Redis singleton
    resetRedisInstance();

    // Create mock Redis client
    mockRedis = {
      disconnect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(undefined),
      getAllServiceHealth: jest.fn(),
      updateServiceHealth: jest.fn().mockResolvedValue(undefined),
      getServiceHealth: jest.fn()
    };

    (getRedisClient as jest.Mock).mockResolvedValue(mockRedis);

    coordinator = new CoordinatorService();
  });

  afterEach(async () => {
    if (coordinator) {
      await coordinator.stop();
    }
  });

  describe('lifecycle management', () => {
    it('should start and stop without memory leaks', async () => {
      // Mock health data
      mockRedis.getAllServiceHealth.mockResolvedValue({
        'bsc-detector': { status: 'healthy', uptime: 1000, memoryUsage: 50 * 1024 * 1024 }
      });

      await coordinator.start(0); // Use port 0 for testing

      // Verify Redis client was obtained
      expect(getRedisClient).toHaveBeenCalled();

      // Stop should clean up properly
      await coordinator.stop();

      // Verify Redis disconnect was called
      expect(mockRedis.disconnect).toHaveBeenCalled();
    });

    it('should handle Redis connection failures gracefully', async () => {
      (getRedisClient as jest.Mock).mockRejectedValue(new Error('Redis connection failed'));

      await expect(coordinator.start(0)).rejects.toThrow('Redis connection failed');
    });

    it('should clean up intervals on stop', async () => {
      mockRedis.getAllServiceHealth.mockResolvedValue({});
      mockRedis.getServiceHealth.mockResolvedValue(null);

      await coordinator.start(0);

      // Verify intervals are set
      expect((coordinator as any).healthCheckInterval).toBeDefined();
      expect((coordinator as any).metricsUpdateInterval).toBeDefined();

      await coordinator.stop();

      // Verify intervals are cleared
      expect((coordinator as any).healthCheckInterval).toBeNull();
      expect((coordinator as any).metricsUpdateInterval).toBeNull();
    });
  });

  describe('health monitoring', () => {
    beforeEach(async () => {
      mockRedis.getAllServiceHealth.mockResolvedValue({
        'bsc-detector': {
          status: 'healthy',
          uptime: 3600000, // 1 hour
          memoryUsage: 100 * 1024 * 1024,
          cpuUsage: 25
        },
        'ethereum-detector': {
          status: 'unhealthy',
          uptime: 1800000, // 30 minutes
          memoryUsage: 200 * 1024 * 1024,
          cpuUsage: 80
        }
      });

      await coordinator.start(0);
    });

    it('should update service health correctly', async () => {
      // Wait for health update
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = (coordinator as any).serviceHealth;
      expect(health.size).toBe(2);
      expect(health.get('bsc-detector').status).toBe('healthy');
      expect(health.get('ethereum-detector').status).toBe('unhealthy');
    });

    it('should calculate system metrics correctly', async () => {
      await new Promise(resolve => setTimeout(resolve, 100));

      const metrics = (coordinator as any).systemMetrics;
      expect(metrics.activeServices).toBe(1); // Only bsc-detector is healthy
      expect(metrics.systemHealth).toBe(50); // 1/2 services healthy
    });

    it('should trigger alerts for unhealthy services', async () => {
      // Wait for monitoring cycle
      await new Promise(resolve => setTimeout(resolve, 100));

      // Verify alert was triggered (implementation detail)
      expect(mockRedis.publish).toHaveBeenCalledWith(
        expect.stringContaining('alert'),
        expect.any(Object)
      );
    });
  });

  describe('execution result processing', () => {
    beforeEach(async () => {
      mockRedis.getAllServiceHealth.mockResolvedValue({});
      await coordinator.start(0);
    });

    it('should process successful execution results', () => {
      const executionResult = {
        success: true,
        actualProfit: 50.25,
        gasCost: 10.5,
        timestamp: Date.now()
      };

      // Simulate receiving execution result
      (coordinator as any).handleExecutionResult({ data: executionResult });

      const metrics = (coordinator as any).systemMetrics;
      expect(metrics.totalExecutions).toBe(1);
      expect(metrics.successfulExecutions).toBe(1);
      expect(metrics.totalProfit).toBe(50.25);
    });

    it('should handle failed execution results', () => {
      const executionResult = {
        success: false,
        error: 'Insufficient liquidity',
        timestamp: Date.now()
      };

      (coordinator as any).handleExecutionResult({ data: executionResult });

      const metrics = (coordinator as any).systemMetrics;
      expect(metrics.totalExecutions).toBe(1);
      expect(metrics.successfulExecutions).toBe(0);
    });

    it('should handle malformed execution results gracefully', () => {
      const malformedResult = {
        invalidField: 'invalid'
      };

      // Should not throw
      expect(() => {
        (coordinator as any).handleExecutionResult({ data: malformedResult });
      }).not.toThrow();
    });
  });

  describe('HTTP endpoints', () => {
    let server: any;
    let port: number;

    beforeEach(async () => {
      mockRedis.getAllServiceHealth.mockResolvedValue({
        'test-service': { status: 'healthy', uptime: 1000 }
      });

      // Start server on random port
      await coordinator.start(0);
      server = (coordinator as any).server;
      port = server.address().port;
    });

    it('should serve dashboard', async () => {
      const response = await fetch(`http://localhost:${port}/`);
      expect(response.status).toBe(200);

      const html = await response.text();
      expect(html).toContain('Arbitrage System Dashboard');
      expect(html).toContain('System Health');
    });

    it('should serve health endpoint', async () => {
      const response = await fetch(`http://localhost:${port}/api/health`);
      expect(response.status).toBe(200);

      const health = await response.json();
      expect(health.status).toBe('ok');
      expect(health.systemHealth).toBeDefined();
    });

    it('should serve metrics endpoint', async () => {
      const response = await fetch(`http://localhost:${port}/api/metrics`);
      expect(response.status).toBe(200);

      const metrics = await response.json();
      expect(metrics.totalOpportunities).toBeDefined();
      expect(metrics.systemHealth).toBeDefined();
    });

    it('should handle service restart requests', async () => {
      const response = await fetch(`http://localhost:${port}/api/services/bsc-detector/restart`, {
        method: 'POST'
      });

      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result.success).toBe(true);
    });

    it('should handle alert acknowledgments', async () => {
      const response = await fetch(`http://localhost:${port}/api/alerts/test-alert/acknowledge`, {
        method: 'POST'
      });

      expect(response.status).toBe(200);

      const result = await response.json();
      expect(result.success).toBe(true);
    });
  });

  describe('alert system', () => {
    beforeEach(async () => {
      mockRedis.getAllServiceHealth.mockResolvedValue({
        'failing-service': { status: 'unhealthy', uptime: 1000 }
      });
      await coordinator.start(0);
    });

    it('should generate alerts for system issues', async () => {
      // Trigger health check
      await (coordinator as any).updateServiceHealth();

      // Check for alerts
      const alerts = (coordinator as any).alertCooldowns;
      expect(Object.keys(alerts).length).toBeGreaterThan(0);
    });

    it('should implement alert cooldown', () => {
      const alertKey = 'test_alert';

      // First alert should be sent
      (coordinator as any).sendAlert({
        type: 'TEST_ALERT',
        message: 'Test alert',
        severity: 'high',
        timestamp: Date.now()
      });

      // Second alert within cooldown should be ignored
      (coordinator as any).sendAlert({
        type: 'TEST_ALERT',
        message: 'Test alert 2',
        severity: 'high',
        timestamp: Date.now()
      });

      // Should have cooldown entry
      expect((coordinator as any).alertCooldowns[alertKey]).toBeDefined();
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      mockRedis.getAllServiceHealth.mockResolvedValue({});
      await coordinator.start(0);
    });

    it('should handle Redis failures gracefully', async () => {
      mockRedis.getAllServiceHealth.mockRejectedValue(new Error('Redis down'));

      // Should not throw
      await expect((coordinator as any).updateServiceHealth()).resolves.not.toThrow();
    });

    it('should handle server startup failures', async () => {
      const failingCoordinator = new CoordinatorService();

      // Mock express app to fail
      (failingCoordinator as any).app = {
        listen: jest.fn((port, callback) => {
          throw new Error('Port already in use');
        })
      };

      await expect(failingCoordinator.start(1234)).rejects.toThrow('Port already in use');
    });

    it('should handle malformed health data', async () => {
      mockRedis.getAllServiceHealth.mockResolvedValue({
        'malformed-service': null // Invalid health data
      });

      await expect((coordinator as any).updateServiceHealth()).resolves.not.toThrow();
    });
  });

  describe('concurrent operations', () => {
    beforeEach(async () => {
      mockRedis.getAllServiceHealth.mockResolvedValue({});
      await coordinator.start(0);
    });

    it('should handle concurrent health updates safely', async () => {
      const promises = [
        (coordinator as any).updateServiceHealth(),
        (coordinator as any).updateServiceHealth(),
        (coordinator as any).updateServiceHealth()
      ];

      await expect(Promise.all(promises)).resolves.not.toThrow();
    });

    it('should handle concurrent metric updates safely', async () => {
      const promises = [
        (coordinator as any).updateSystemMetrics(),
        (coordinator as any).updateSystemMetrics(),
        (coordinator as any).updateSystemMetrics()
      ];

      await expect(Promise.all(promises)).resolves.not.toThrow();
    });
  });
});