/**
 * Coordinator Service Integration Tests
 *
 * REFACTOR: Uses dependency injection pattern instead of Jest mock hoisting.
 * This approach is more reliable and follows Node.js best practices.
 *
 * Tests for the coordinator service including:
 * - Redis Streams consumption (ADR-002)
 * - Leader election (ADR-007)
 * - Health monitoring
 * - Opportunity tracking
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { CoordinatorService, CoordinatorDependencies } from '../coordinator';
import { RedisStreamsClient, RedisClient, ServiceStateManager } from '@arbitrage/core';

// =============================================================================
// Mock Factory Functions
// =============================================================================

/**
 * Creates a mock Redis client with all required methods.
 */
function createMockRedisClient() {
  return {
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    subscribe: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    publish: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    getAllServiceHealth: jest.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({}),
    updateServiceHealth: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getServiceHealth: jest.fn<() => Promise<unknown>>().mockResolvedValue(null),
    get: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
    set: jest.fn<() => Promise<string>>().mockResolvedValue('OK'),
    setNx: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    del: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    expire: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    // P0-NEW-5 FIX: Atomic lock operations
    renewLockIfOwned: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    releaseLockIfOwned: jest.fn<() => Promise<boolean>>().mockResolvedValue(true)
  };
}

/**
 * Creates a mock Redis Streams client with all required methods.
 */
function createMockStreamsClient() {
  const client = {
    createConsumerGroup: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    xreadgroup: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    xack: jest.fn<() => Promise<number>>().mockResolvedValue(1),
    xadd: jest.fn<() => Promise<string>>().mockResolvedValue('1234-0'),
    disconnect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ping: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    STREAMS: RedisStreamsClient.STREAMS
  };
  return client;
}

/**
 * Creates a mock logger.
 */
function createMockLogger() {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  };
}

/**
 * Creates a mock performance logger.
 */
function createMockPerfLogger() {
  return {
    logEventLatency: jest.fn(),
    logHealthCheck: jest.fn()
  };
}

/**
 * Creates a mock state manager with configurable running state.
 */
function createMockStateManager() {
  const state = { running: false };

  // Use explicit function implementations to avoid Jest type issues
  const executeStartImpl = async (callback: () => Promise<void>) => {
    try {
      await callback();
      state.running = true;
      return { success: true as const, currentState: 'RUNNING' as const };
    } catch (error) {
      state.running = false;
      return { success: false as const, error };
    }
  };

  const executeStopImpl = async (callback: () => Promise<void>) => {
    try {
      await callback();
      state.running = false;
      return { success: true as const, currentState: 'STOPPED' as const };
    } catch (error) {
      return { success: false as const, error };
    }
  };

  return {
    getState: jest.fn().mockImplementation(() => state.running ? 'RUNNING' : 'STOPPED'),
    isRunning: jest.fn().mockImplementation(() => state.running),
    isStopped: jest.fn().mockImplementation(() => !state.running),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executeStart: jest.fn().mockImplementation(executeStartImpl as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executeStop: jest.fn().mockImplementation(executeStopImpl as any),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    // Expose state for test manipulation
    _state: state
  };
}

/**
 * Creates a mock stream health monitor.
 */
function createMockStreamHealthMonitor() {
  return {
    setConsumerGroup: jest.fn(),
    start: jest.fn(),
    stop: jest.fn()
  };
}

/**
 * Creates a mock StreamConsumer class.
 */
function createMockStreamConsumerClass() {
  return jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    pause: jest.fn(),
    resume: jest.fn(),
    isPaused: jest.fn().mockReturnValue(false),
    getStats: jest.fn().mockReturnValue({
      messagesProcessed: 0,
      messagesFailed: 0,
      lastProcessedAt: null,
      isRunning: true,
      isPaused: false
    })
  }));
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('CoordinatorService Integration', () => {
  let coordinator: CoordinatorService;
  let mockRedisClient: ReturnType<typeof createMockRedisClient>;
  let mockStreamsClient: ReturnType<typeof createMockStreamsClient>;
  let mockStateManager: ReturnType<typeof createMockStateManager>;
  let mockDeps: CoordinatorDependencies;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create fresh mocks for each test
    mockRedisClient = createMockRedisClient();
    mockStreamsClient = createMockStreamsClient();
    mockStateManager = createMockStateManager();

    // Create typed mock functions
    const getRedisClientMock = jest.fn<() => Promise<typeof mockRedisClient>>();
    getRedisClientMock.mockResolvedValue(mockRedisClient);

    const getRedisStreamsClientMock = jest.fn<() => Promise<typeof mockStreamsClient>>();
    getRedisStreamsClientMock.mockResolvedValue(mockStreamsClient);

    const createServiceStateMock = jest.fn<() => typeof mockStateManager>();
    createServiceStateMock.mockReturnValue(mockStateManager);

    const getStreamHealthMonitorMock = jest.fn();
    getStreamHealthMonitorMock.mockReturnValue(createMockStreamHealthMonitor());

    // Create dependencies object with proper typing
    mockDeps = {
      logger: createMockLogger(),
      perfLogger: createMockPerfLogger() as any,
      getRedisClient: getRedisClientMock as any,
      getRedisStreamsClient: getRedisStreamsClientMock as any,
      createServiceState: createServiceStateMock as any,
      getStreamHealthMonitor: getStreamHealthMonitorMock as any,
      StreamConsumer: createMockStreamConsumerClass() as any
    };

    // Create coordinator with injected dependencies
    coordinator = new CoordinatorService({}, mockDeps);
  });

  afterEach(async () => {
    if (coordinator) {
      try {
        await coordinator.stop();
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  // ===========================================================================
  // Lifecycle Management Tests
  // ===========================================================================

  describe('lifecycle management', () => {
    it('should start and stop without memory leaks', async () => {
      await coordinator.start(0);

      expect(mockDeps.getRedisClient).toHaveBeenCalled();
      expect(mockDeps.getRedisStreamsClient).toHaveBeenCalled();

      await coordinator.stop();

      expect(mockRedisClient.disconnect).toHaveBeenCalled();
      expect(mockStreamsClient.disconnect).toHaveBeenCalled();
    });

    it('should handle Redis connection failures gracefully', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockDeps.getRedisClient as any).mockRejectedValue(new Error('Redis connection failed'));

      await expect(coordinator.start(0)).rejects.toThrow('Redis connection failed');
    });

    it('should clean up all intervals on stop', async () => {
      await coordinator.start(0);

      expect((coordinator as any).healthCheckInterval).toBeDefined();
      expect((coordinator as any).metricsUpdateInterval).toBeDefined();
      expect((coordinator as any).leaderHeartbeatInterval).toBeDefined();
      expect((coordinator as any).opportunityCleanupInterval).toBeDefined();
      expect((coordinator as any).streamConsumers).toBeDefined();
      expect((coordinator as any).streamConsumers.length).toBeGreaterThan(0);

      await coordinator.stop();

      expect((coordinator as any).healthCheckInterval).toBeNull();
      expect((coordinator as any).metricsUpdateInterval).toBeNull();
      expect((coordinator as any).leaderHeartbeatInterval).toBeNull();
      expect((coordinator as any).opportunityCleanupInterval).toBeNull();
      expect((coordinator as any).streamConsumers.length).toBe(0);
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

      // P0-NEW-5 FIX: Now uses atomic releaseLockIfOwned instead of del
      expect(mockRedisClient.releaseLockIfOwned).toHaveBeenCalledWith(
        'coordinator:leader:lock',
        instanceId
      );
    });

    it('should expose leader status via API', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);

      await coordinator.start(0);
      const server = (coordinator as any).server;
      const port = server.address().port;

      const response = await fetch(`http://localhost:${port}/api/leader`);
      const data = await response.json() as { isLeader: boolean; instanceId: string; lockKey: string };

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

    it('should create stream consumers for each stream', async () => {
      await coordinator.start(0);

      // Verify StreamConsumer was instantiated for each stream
      // 5 streams: health, opportunities, whale-alerts, swap-events, volume-aggregates
      expect(mockDeps.StreamConsumer).toHaveBeenCalledTimes(5);
    });
  });

  // ===========================================================================
  // Health Monitoring Tests
  // ===========================================================================

  describe('health monitoring', () => {
    it('should calculate system metrics correctly', async () => {
      await coordinator.start(0);

      const metrics = coordinator.getSystemMetrics();
      expect(metrics.activeServices).toBeDefined();
      expect(metrics.systemHealth).toBeDefined();
      expect(metrics.totalOpportunities).toBe(0);
      expect(metrics.whaleAlerts).toBe(0);
    });

    it('should initialize service health map empty', async () => {
      await coordinator.start(0);

      const healthMap = coordinator.getServiceHealthMap();
      expect(healthMap).toBeInstanceOf(Map);
      expect(healthMap.size).toBe(0);
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

      const data = await response.json() as { status: string; isLeader: boolean; instanceId: string };
      expect(data.status).toBe('ok');
      expect(data.isLeader).toBeDefined();
      expect(data.instanceId).toBeDefined();
    });

    it('should serve metrics endpoint', async () => {
      const response = await fetch(`http://localhost:${port}/api/metrics`);
      expect(response.status).toBe(200);

      const data = await response.json() as { totalOpportunities: number; whaleAlerts: number; pendingOpportunities: number };
      expect(data.totalOpportunities).toBeDefined();
      expect(data.whaleAlerts).toBeDefined();
      expect(data.pendingOpportunities).toBeDefined();
    });

    it('should serve opportunities endpoint', async () => {
      const response = await fetch(`http://localhost:${port}/api/opportunities`);
      expect(response.status).toBe(200);

      const data = await response.json() as unknown[];
      expect(Array.isArray(data)).toBe(true);
    });

    it('should only allow leader to restart services', async () => {
      // First, make coordinator not the leader
      (coordinator as any).isLeader = false;

      const response = await fetch(`http://localhost:${port}/api/services/bsc-detector/restart`, {
        method: 'POST'
      });

      expect(response.status).toBe(403);
      const data = await response.json() as { error: string };
      expect(data.error).toContain('Only leader');
    });

    it('should allow leader to restart services', async () => {
      // Make sure we're the leader
      (coordinator as any).isLeader = true;

      const response = await fetch(`http://localhost:${port}/api/services/bsc-detector/restart`, {
        method: 'POST'
      });

      expect(response.status).toBe(200);
      const data = await response.json() as { success: boolean };
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

      // Simulate being past the startup grace period (60 seconds)
      // During grace period, alerts are suppressed if no services have reported
      (coordinator as any).startTime = Date.now() - 70000; // 70 seconds ago

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
    it('should handle consumer group creation failures gracefully', async () => {
      mockStreamsClient.createConsumerGroup.mockRejectedValue(new Error('Group creation failed'));

      // Should not throw
      await expect(coordinator.start(0)).resolves.not.toThrow();
    });

    it('should handle malformed stream messages gracefully', async () => {
      // Start the coordinator first
      await coordinator.start(0);

      // The coordinator should handle null/invalid data without crashing
      const handler = (coordinator as any).handleHealthMessage.bind(coordinator);

      // Call with malformed message
      await expect(handler({ id: '1234-0', data: null })).resolves.not.toThrow();
      await expect(handler({ id: '1234-0', data: {} })).resolves.not.toThrow();

      // Verify coordinator is still operational
      expect(coordinator.getIsRunning()).toBe(true);
    });

    it('should handle swap event messages correctly', async () => {
      await coordinator.start(0);

      const handler = (coordinator as any).handleSwapEventMessage.bind(coordinator);

      // Valid swap event message (wrapped in MessageEvent format)
      const validMessage = {
        id: '1234-0',
        data: {
          type: 'swap-event',
          data: {
            pairAddress: '0x1234567890123456789012345678901234567890',
            chain: 'ethereum',
            dex: 'uniswap',
            usdValue: 15000,
            transactionHash: '0xabc123'
          },
          timestamp: Date.now(),
          source: 'ethereum-detector'
        }
      };

      await expect(handler(validMessage)).resolves.not.toThrow();

      // Check metrics were updated
      const metrics = coordinator.getSystemMetrics();
      expect(metrics.totalSwapEvents).toBe(1);
      expect(metrics.totalVolumeUsd).toBe(15000);
      expect(metrics.activePairsTracked).toBe(1);

      // Handle malformed message without crashing
      await expect(handler({ id: '1234-1', data: null })).resolves.not.toThrow();
      await expect(handler({ id: '1234-2', data: {} })).resolves.not.toThrow();
    });

    it('should handle volume aggregate messages correctly', async () => {
      await coordinator.start(0);

      const handler = (coordinator as any).handleVolumeAggregateMessage.bind(coordinator);

      // Valid volume aggregate message (wrapped in MessageEvent format)
      const validMessage = {
        id: '1234-0',
        data: {
          type: 'volume-aggregate',
          data: {
            pairAddress: '0xabcdef1234567890123456789012345678901234',
            chain: 'bsc',
            dex: 'pancakeswap',
            swapCount: 25,
            totalUsdVolume: 75000,
            minPrice: 1.05,
            maxPrice: 1.08,
            avgPrice: 1.065,
            windowStartMs: Date.now() - 5000,
            windowEndMs: Date.now()
          },
          timestamp: Date.now(),
          source: 'bsc-detector'
        }
      };

      await expect(handler(validMessage)).resolves.not.toThrow();

      // Check metrics were updated
      const metrics = coordinator.getSystemMetrics();
      expect(metrics.volumeAggregatesProcessed).toBe(1);
      expect(metrics.activePairsTracked).toBeGreaterThanOrEqual(1);

      // Handle malformed message without crashing
      await expect(handler({ id: '1234-1', data: null })).resolves.not.toThrow();
      await expect(handler({ id: '1234-2', data: { swapCount: 0 } })).resolves.not.toThrow();
    });

    it('should cleanup stale active pairs', async () => {
      await coordinator.start(0);

      // Add a pair to track
      const activePairs = (coordinator as any).activePairs;
      activePairs.set('0xtest', {
        lastSeen: Date.now() - 400000, // 6+ minutes ago (past TTL)
        chain: 'test',
        dex: 'test'
      });

      // Run cleanup
      (coordinator as any).cleanupActivePairs();

      // Pair should be removed
      expect(activePairs.size).toBe(0);
    });
  });

  // ===========================================================================
  // State Getter Tests
  // ===========================================================================

  describe('state getters', () => {
    it('should return correct running state', async () => {
      expect(coordinator.getIsRunning()).toBe(false);

      await coordinator.start(0);
      expect(coordinator.getIsRunning()).toBe(true);

      await coordinator.stop();
      expect(coordinator.getIsRunning()).toBe(false);
    });

    it('should return correct leader state', async () => {
      mockRedisClient.setNx.mockResolvedValue(true);
      expect(coordinator.getIsLeader()).toBe(false);

      await coordinator.start(0);
      expect(coordinator.getIsLeader()).toBe(true);
    });

    it('should return defensive copy of health map', async () => {
      await coordinator.start(0);

      const map1 = coordinator.getServiceHealthMap();
      const map2 = coordinator.getServiceHealthMap();

      // Should be different instances
      expect(map1).not.toBe(map2);
    });

    it('should return defensive copy of metrics', async () => {
      await coordinator.start(0);

      const metrics1 = coordinator.getSystemMetrics();
      const metrics2 = coordinator.getSystemMetrics();

      // Should be different instances
      expect(metrics1).not.toBe(metrics2);
    });
  });

  // ===========================================================================
  // Dependency Injection Tests
  // ===========================================================================

  describe('dependency injection', () => {
    it('should use injected logger', async () => {
      await coordinator.start(0);

      expect(mockDeps.logger!.info).toHaveBeenCalled();
    });

    it('should use injected Redis client factory', async () => {
      await coordinator.start(0);

      expect(mockDeps.getRedisClient).toHaveBeenCalled();
    });

    it('should use injected Streams client factory', async () => {
      await coordinator.start(0);

      expect(mockDeps.getRedisStreamsClient).toHaveBeenCalled();
    });

    it('should use injected state manager factory', () => {
      // State manager is created in constructor
      expect(mockDeps.createServiceState).toHaveBeenCalledWith({
        serviceName: 'coordinator',
        transitionTimeoutMs: 30000
      });
    });

    it('should use injected StreamConsumer class', async () => {
      await coordinator.start(0);

      expect(mockDeps.StreamConsumer).toHaveBeenCalled();
    });

    it('should use injected stream health monitor', async () => {
      await coordinator.start(0);

      expect(mockDeps.getStreamHealthMonitor).toHaveBeenCalled();
    });
  });
});
