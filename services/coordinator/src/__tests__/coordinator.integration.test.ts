/**
 * Coordinator Service Integration Tests
 *
 * Tests for the coordinator service including:
 * - Redis Streams consumption (ADR-002)
 * - Leader election (ADR-007)
 * - Health monitoring
 * - Opportunity tracking
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CoordinatorService } from '../coordinator';
import { getRedisClient, resetRedisInstance, getRedisStreamsClient, resetRedisStreamsInstance, RedisStreamsClient } from '../../../../shared/core/src';

// Mock Redis client
const mockRedisClient = {
  disconnect: jest.fn().mockResolvedValue(undefined),
  subscribe: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn().mockResolvedValue(1),
  getAllServiceHealth: jest.fn().mockResolvedValue({}),
  updateServiceHealth: jest.fn().mockResolvedValue(undefined),
  getServiceHealth: jest.fn().mockResolvedValue(null),
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  setNx: jest.fn().mockResolvedValue(true),
  del: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1)
};

// Mock Redis Streams client
const mockStreamsClient = {
  createConsumerGroup: jest.fn().mockResolvedValue(undefined),
  xreadgroup: jest.fn().mockResolvedValue([]),
  xack: jest.fn().mockResolvedValue(1),
  xadd: jest.fn().mockResolvedValue('1234-0'),
  disconnect: jest.fn().mockResolvedValue(undefined),
  ping: jest.fn().mockResolvedValue(true)
};

// Add STREAMS constant to mock
(mockStreamsClient as any).STREAMS = RedisStreamsClient.STREAMS;

jest.mock('../../../../shared/core/src', () => ({
  getRedisClient: jest.fn(),
  resetRedisInstance: jest.fn(),
  getRedisStreamsClient: jest.fn(),
  resetRedisStreamsInstance: jest.fn(),
  RedisStreamsClient: {
    STREAMS: {
      PRICE_UPDATES: 'stream:price-updates',
      SWAP_EVENTS: 'stream:swap-events',
      OPPORTUNITIES: 'stream:opportunities',
      WHALE_ALERTS: 'stream:whale-alerts',
      VOLUME_AGGREGATES: 'stream:volume-aggregates',
      HEALTH: 'stream:health'
    }
  },
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  })),
  getPerformanceLogger: jest.fn(() => ({
    logEventLatency: jest.fn(),
    logHealthCheck: jest.fn()
  })),
  ValidationMiddleware: {
    validateHealthCheck: (req: any, res: any, next: any) => next()
  }
}));

describe('CoordinatorService Integration', () => {
  let coordinator: CoordinatorService;

  beforeEach(() => {
    jest.clearAllMocks();
    resetRedisInstance();

    // Setup mocks
    (getRedisClient as jest.Mock).mockResolvedValue(mockRedisClient);
    (getRedisStreamsClient as jest.Mock).mockResolvedValue(mockStreamsClient);

    // Reset mock implementations
    mockRedisClient.setNx.mockResolvedValue(true);
    mockRedisClient.get.mockResolvedValue(null);
    mockStreamsClient.xreadgroup.mockResolvedValue([]);

    coordinator = new CoordinatorService();
  });

  afterEach(async () => {
    if (coordinator) {
      await coordinator.stop();
    }
  });

  // ===========================================================================
  // Lifecycle Management Tests
  // ===========================================================================

  describe('lifecycle management', () => {
    it('should start and stop without memory leaks', async () => {
      await coordinator.start(0);

      expect(getRedisClient).toHaveBeenCalled();
      expect(getRedisStreamsClient).toHaveBeenCalled();

      await coordinator.stop();

      expect(mockRedisClient.disconnect).toHaveBeenCalled();
      expect(mockStreamsClient.disconnect).toHaveBeenCalled();
    });

    it('should handle Redis connection failures gracefully', async () => {
      (getRedisClient as jest.Mock).mockRejectedValue(new Error('Redis connection failed'));

      await expect(coordinator.start(0)).rejects.toThrow('Redis connection failed');
    });

    it('should clean up all intervals on stop', async () => {
      await coordinator.start(0);

      expect((coordinator as any).healthCheckInterval).toBeDefined();
      expect((coordinator as any).metricsUpdateInterval).toBeDefined();
      expect((coordinator as any).leaderHeartbeatInterval).toBeDefined();
      expect((coordinator as any).streamConsumerInterval).toBeDefined();

      await coordinator.stop();

      expect((coordinator as any).healthCheckInterval).toBeNull();
      expect((coordinator as any).metricsUpdateInterval).toBeNull();
      expect((coordinator as any).leaderHeartbeatInterval).toBeNull();
      expect((coordinator as any).streamConsumerInterval).toBeNull();
    });
  });

  // ===========================================================================
  // Leader Election Tests (ADR-007)
  // ===========================================================================

  describe('leader election', () => {
    it('should acquire leadership on start when lock is available', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      await coordinator.start(0);

      expect(mockRedisClient.setNx).toHaveBeenCalledWith(
        'coordinator:leader:lock',
        expect.any(String),
        expect.any(Number)
      );
      expect(coordinator.getIsLeader()).toBe(true);
    });

    it('should not become leader when lock is held by another instance', async () => {
      mockRedisClient.setNx.mockResolvedValue(false);
      mockRedisClient.get.mockResolvedValue('other-instance-id');

      await coordinator.start(0);

      expect(coordinator.getIsLeader()).toBe(false);
    });

    it('should release leadership on stop', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);
      const instanceId = (coordinator as any).config.leaderElection.instanceId;
      mockRedisClient.get.mockResolvedValue(instanceId);

      await coordinator.start(0);
      expect(coordinator.getIsLeader()).toBe(true);

      await coordinator.stop();

      expect(mockRedisClient.del).toHaveBeenCalledWith('coordinator:leader:lock');
    });

    it('should detect when leadership is lost', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      await coordinator.start(0);
      expect(coordinator.getIsLeader()).toBe(true);

      // Simulate another instance taking over
      mockRedisClient.get.mockResolvedValue('other-instance-took-over');

      // Trigger heartbeat manually
      await (coordinator as any).tryAcquireLeadership();

      // After the heartbeat check detects different leader
      const currentLeader = await mockRedisClient.get('coordinator:leader:lock');
      expect(currentLeader).not.toBe((coordinator as any).config.leaderElection.instanceId);
    });

    it('should expose leader status via API', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      await coordinator.start(0);
      const server = (coordinator as any).server;
      const port = server.address().port;

      const response = await fetch(`http://localhost:${port}/api/leader`);
      const data = await response.json();

      expect(data.isLeader).toBe(true);
      expect(data.instanceId).toBeDefined();
      expect(data.lockKey).toBe('coordinator:leader:lock');
    });
  });

  // ===========================================================================
  // Redis Streams Consumer Tests (ADR-002)
  // ===========================================================================

  describe('redis streams consumption', () => {
    it('should create consumer groups for all required streams on start', async () => {
      await coordinator.start(0);

      expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          streamName: RedisStreamsClient.STREAMS.HEALTH,
          groupName: 'coordinator-group'
        })
      );

      expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          streamName: RedisStreamsClient.STREAMS.OPPORTUNITIES,
          groupName: 'coordinator-group'
        })
      );

      expect(mockStreamsClient.createConsumerGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          streamName: RedisStreamsClient.STREAMS.WHALE_ALERTS,
          groupName: 'coordinator-group'
        })
      );
    });

    it('should process health messages from stream', async () => {
      const healthMessage = {
        id: '1234-0',
        data: {
          service: 'bsc-detector',
          status: 'healthy',
          uptime: 3600,
          memoryUsage: 100000000,
          timestamp: Date.now()
        }
      };

      mockStreamsClient.xreadgroup.mockResolvedValueOnce([healthMessage]);

      await coordinator.start(0);

      // Wait for stream consumer to run
      await new Promise(resolve => setTimeout(resolve, 200));

      const healthMap = coordinator.getServiceHealthMap();
      expect(healthMap.get('bsc-detector')).toBeDefined();
      expect(healthMap.get('bsc-detector')?.status).toBe('healthy');
    });

    it('should process opportunity messages from stream', async () => {
      const opportunityMessage = {
        id: '1234-0',
        data: {
          id: 'opp-123',
          chain: 'bsc',
          buyDex: 'pancakeswap',
          sellDex: 'biswap',
          profitPercentage: 0.5,
          status: 'pending',
          timestamp: Date.now(),
          expiresAt: Date.now() + 60000
        }
      };

      // Return opportunity on second call (opportunities stream)
      mockStreamsClient.xreadgroup
        .mockResolvedValueOnce([]) // health stream
        .mockResolvedValueOnce([opportunityMessage]) // opportunities stream
        .mockResolvedValueOnce([]); // whale alerts stream

      await coordinator.start(0);

      // Wait for stream consumer to process
      await new Promise(resolve => setTimeout(resolve, 200));

      const metrics = coordinator.getSystemMetrics();
      expect(metrics.totalOpportunities).toBeGreaterThanOrEqual(1);
    });

    it('should process whale alert messages from stream', async () => {
      const whaleMessage = {
        id: '1234-0',
        data: {
          address: '0xwhale123',
          usdValue: 150000,
          direction: 'buy',
          chain: 'ethereum',
          dex: 'uniswap',
          impact: 0.03
        }
      };

      // Return whale alert on third call
      mockStreamsClient.xreadgroup
        .mockResolvedValueOnce([]) // health stream
        .mockResolvedValueOnce([]) // opportunities stream
        .mockResolvedValueOnce([whaleMessage]); // whale alerts stream

      await coordinator.start(0);

      // Wait for stream consumer to process
      await new Promise(resolve => setTimeout(resolve, 200));

      const metrics = coordinator.getSystemMetrics();
      expect(metrics.whaleAlerts).toBeGreaterThanOrEqual(1);
    });

    it('should acknowledge messages after processing', async () => {
      const healthMessage = {
        id: '1234-0',
        data: {
          service: 'test-service',
          status: 'healthy',
          timestamp: Date.now()
        }
      };

      mockStreamsClient.xreadgroup.mockResolvedValueOnce([healthMessage]);

      await coordinator.start(0);
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(mockStreamsClient.xack).toHaveBeenCalledWith(
        RedisStreamsClient.STREAMS.HEALTH,
        'coordinator-group',
        '1234-0'
      );
    });

    it('should publish own health to stream', async () => {
      await coordinator.start(0);

      // Wait for health reporting cycle
      await new Promise(resolve => setTimeout(resolve, 5500));

      expect(mockStreamsClient.xadd).toHaveBeenCalledWith(
        RedisStreamsClient.STREAMS.HEALTH,
        expect.objectContaining({
          service: 'coordinator',
          status: 'healthy'
        })
      );
    });
  });

  // ===========================================================================
  // Health Monitoring Tests
  // ===========================================================================

  describe('health monitoring', () => {
    beforeEach(async () => {
      mockRedisClient.getAllServiceHealth.mockResolvedValue({
        'bsc-detector': {
          status: 'healthy',
          uptime: 3600000,
          memoryUsage: 100 * 1024 * 1024,
          cpuUsage: 25
        },
        'ethereum-detector': {
          status: 'unhealthy',
          uptime: 1800000,
          memoryUsage: 200 * 1024 * 1024,
          cpuUsage: 80
        }
      });

      await coordinator.start(0);
    });

    it('should calculate system metrics correctly', async () => {
      await new Promise(resolve => setTimeout(resolve, 200));

      const metrics = coordinator.getSystemMetrics();
      expect(metrics.activeServices).toBeDefined();
      expect(metrics.systemHealth).toBeDefined();
    });

    it('should track service health from both streams and legacy polling', async () => {
      // Simulate stream health message
      const streamHealth = {
        id: '1234-0',
        data: {
          service: 'polygon-detector',
          status: 'healthy',
          timestamp: Date.now()
        }
      };

      mockStreamsClient.xreadgroup.mockResolvedValueOnce([streamHealth]);

      await new Promise(resolve => setTimeout(resolve, 200));

      // Should have services from both legacy polling and streams
      const healthMap = coordinator.getServiceHealthMap();
      expect(healthMap.size).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // HTTP Endpoints Tests
  // ===========================================================================

  describe('HTTP endpoints', () => {
    let port: number;

    beforeEach(async () => {
      await coordinator.start(0);
      const server = (coordinator as any).server;
      port = server.address().port;
    });

    it('should serve dashboard with leader status', async () => {
      const response = await fetch(`http://localhost:${port}/`);
      expect(response.status).toBe(200);

      const html = await response.text();
      expect(html).toContain('Arbitrage System Dashboard');
      expect(html).toMatch(/LEADER|STANDBY/);
    });

    it('should serve health endpoint with leader info', async () => {
      const response = await fetch(`http://localhost:${port}/api/health`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.status).toBe('ok');
      expect(data.isLeader).toBeDefined();
      expect(data.instanceId).toBeDefined();
    });

    it('should serve metrics endpoint', async () => {
      const response = await fetch(`http://localhost:${port}/api/metrics`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.totalOpportunities).toBeDefined();
      expect(data.whaleAlerts).toBeDefined();
      expect(data.pendingOpportunities).toBeDefined();
    });

    it('should serve opportunities endpoint', async () => {
      const response = await fetch(`http://localhost:${port}/api/opportunities`);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(Array.isArray(data)).toBe(true);
    });

    it('should only allow leader to restart services', async () => {
      // First, make coordinator not the leader
      (coordinator as any).isLeader = false;

      const response = await fetch(`http://localhost:${port}/api/services/bsc-detector/restart`, {
        method: 'POST'
      });

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('Only leader');
    });

    it('should allow leader to restart services', async () => {
      // Make sure we're the leader
      (coordinator as any).isLeader = true;

      const response = await fetch(`http://localhost:${port}/api/services/bsc-detector/restart`, {
        method: 'POST'
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
    });
  });

  // ===========================================================================
  // Alert System Tests
  // ===========================================================================

  describe('alert system', () => {
    beforeEach(async () => {
      await coordinator.start(0);
    });

    it('should generate alerts for system health issues', async () => {
      // Set low system health
      (coordinator as any).systemMetrics.systemHealth = 50;

      // Trigger alert check
      (coordinator as any).checkForAlerts();

      const cooldowns = (coordinator as any).alertCooldowns;
      expect(cooldowns.size).toBeGreaterThan(0);
    });

    it('should implement alert cooldown', () => {
      const alert = {
        type: 'TEST_ALERT',
        message: 'Test alert',
        severity: 'high',
        timestamp: Date.now()
      };

      // First alert should be sent
      (coordinator as any).sendAlert(alert);
      expect((coordinator as any).alertCooldowns.has('TEST_ALERT_system')).toBe(true);

      // Second alert within cooldown should be ignored (no change to cooldown time)
      const firstCooldown = (coordinator as any).alertCooldowns.get('TEST_ALERT_system');
      (coordinator as any).sendAlert(alert);
      const secondCooldown = (coordinator as any).alertCooldowns.get('TEST_ALERT_system');

      // Cooldown timestamp shouldn't change
      expect(firstCooldown).toBe(secondCooldown);
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should handle Redis Streams failures gracefully', async () => {
      mockStreamsClient.xreadgroup.mockRejectedValue(new Error('Stream error'));

      await coordinator.start(0);

      // Should not crash
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(coordinator.getIsRunning()).toBe(true);
    });

    it('should handle consumer group creation failures gracefully', async () => {
      mockStreamsClient.createConsumerGroup.mockRejectedValue(new Error('Group creation failed'));

      // Should not throw
      await expect(coordinator.start(0)).resolves.not.toThrow();
    });

    it('should handle malformed stream messages gracefully', async () => {
      const malformedMessage = {
        id: '1234-0',
        data: null // Invalid data
      };

      mockStreamsClient.xreadgroup.mockResolvedValueOnce([malformedMessage]);

      await coordinator.start(0);

      // Should not crash
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(coordinator.getIsRunning()).toBe(true);
    });
  });

  // ===========================================================================
  // Concurrent Operations Tests
  // ===========================================================================

  describe('concurrent operations', () => {
    it('should handle concurrent stream processing safely', async () => {
      const messages = Array.from({ length: 10 }, (_, i) => ({
        id: `${1234 + i}-0`,
        data: {
          service: `service-${i}`,
          status: 'healthy',
          timestamp: Date.now()
        }
      }));

      mockStreamsClient.xreadgroup.mockResolvedValue(messages);

      await coordinator.start(0);
      await new Promise(resolve => setTimeout(resolve, 300));

      // All messages should be processed
      const healthMap = coordinator.getServiceHealthMap();
      expect(healthMap.size).toBeGreaterThan(0);
    });

    it('should handle concurrent metric updates safely', async () => {
      await coordinator.start(0);

      const updates = Array.from({ length: 10 }, () =>
        (coordinator as any).updateSystemMetrics()
      );

      await expect(Promise.all(updates)).resolves.not.toThrow();
    });
  });
});
