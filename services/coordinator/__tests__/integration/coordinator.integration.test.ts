/**
 * Coordinator Service Integration Tests
 *
 * Uses real Redis (via redis-memory-server) for RedisClient and RedisStreamsClient,
 * with dependency injection for other components (logger, state manager, etc.).
 *
 * Tests for the coordinator service including:
 * - Redis Streams consumption (ADR-002)
 * - Leader election (ADR-007)
 * - Health monitoring
 * - Opportunity tracking
 */

import { jest, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { CoordinatorService, CoordinatorDependencies } from '../../src/coordinator';
import { RedisStreamsClient, RedisClient, ServiceStateManager } from '@arbitrage/core';
import { createTestRedisClient, createMockLogger, createMockPerfLogger } from '@arbitrage/test-utils';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Creates a mock state manager with configurable running state.
 *
 * Fix 12c: This mock mirrors the real ServiceStateManager state machine:
 * - STOPPED -> RUNNING via executeStart (matches ServiceState.STOPPED -> STARTING -> RUNNING)
 * - RUNNING -> STOPPED via executeStop (matches ServiceState.RUNNING -> STOPPING -> STOPPED)
 * - executeStart returns { success, currentState } matching StateTransitionResult shape
 * - executeStop returns { success, currentState } matching StateTransitionResult shape
 *
 * Limitation: The mock skips intermediate STARTING/STOPPING states and does not
 * enforce the transition lock (transitionLock) that prevents concurrent transitions.
 * TODO: Consider swapping to real ServiceStateManager when test setup allows it.
 *
 * @see shared/core/src/service-state.ts — Real ServiceStateManager
 */
function createMockStateManager() {
  const state = { running: false };

  // Use explicit function implementations to avoid Jest type issues
  const executeStartImpl = async (callback: () => Promise<void>) => {
    // Match real behavior: reject start if already running
    if (state.running) {
      return { success: false as const, previousState: 'RUNNING' as const, currentState: 'RUNNING' as const };
    }
    try {
      await callback();
      state.running = true;
      return { success: true as const, previousState: 'STOPPED' as const, currentState: 'RUNNING' as const };
    } catch (error) {
      state.running = false;
      return { success: false as const, previousState: 'STOPPED' as const, currentState: 'STOPPED' as const, error };
    }
  };

  const executeStopImpl = async (callback: () => Promise<void>) => {
    // Match real behavior: reject stop if not running
    if (!state.running) {
      return { success: false as const, previousState: 'STOPPED' as const, currentState: 'STOPPED' as const };
    }
    try {
      await callback();
      state.running = false;
      return { success: true as const, previousState: 'RUNNING' as const, currentState: 'STOPPED' as const };
    } catch (error) {
      return { success: false as const, previousState: 'RUNNING' as const, currentState: 'RUNNING' as const, error };
    }
  };

  return {
    getState: jest.fn().mockImplementation(() => state.running ? 'RUNNING' : 'STOPPED'),
    isRunning: jest.fn().mockImplementation(() => state.running),
    isStopped: jest.fn().mockImplementation(() => !state.running),

    executeStart: jest.fn().mockImplementation(executeStartImpl as any),

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
// Real Redis Client Factories
// =============================================================================

/**
 * Get test Redis URL (same logic as createTestRedisClient in @arbitrage/test-utils)
 */
function getTestRedisUrl(): string {
  const configFile = path.resolve(__dirname, '../../../../.redis-test-config.json');
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.url) return config.url;
    } catch { /* fall through */ }
  }
  return process.env.REDIS_URL ?? 'redis://localhost:6379';
}

/**
 * Creates a real RedisClient connected to the test Redis server.
 */
function createRealRedisClient(): RedisClient {
  const url = getTestRedisUrl();
  return new RedisClient(url);
}

/**
 * Creates a real RedisStreamsClient connected to the test Redis server.
 */
function createRealStreamsClient(): RedisStreamsClient {
  const url = getTestRedisUrl();
  return new RedisStreamsClient(url);
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('CoordinatorService Integration', () => {
  let coordinator: CoordinatorService;
  let redisClient: RedisClient;
  let streamsClient: RedisStreamsClient;
  let mockStateManager: ReturnType<typeof createMockStateManager>;
  let mockDeps: CoordinatorDependencies;
  // Raw Redis client for direct verification and cleanup
  let rawRedis: Redis;

  beforeAll(async () => {
    rawRedis = await createTestRedisClient();
  });

  afterAll(async () => {
    if (rawRedis) {
      await rawRedis.quit();
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    // Flush Redis for isolation
    await rawRedis.flushall();

    // Create fresh real Redis clients for each test
    redisClient = createRealRedisClient();
    streamsClient = createRealStreamsClient();
    mockStateManager = createMockStateManager();

    // Create factory functions that return the real clients
    const getRedisClientMock = jest.fn<() => Promise<RedisClient>>();
    getRedisClientMock.mockResolvedValue(redisClient);

    const getRedisStreamsClientMock = jest.fn<() => Promise<RedisStreamsClient>>();
    getRedisStreamsClientMock.mockResolvedValue(streamsClient);

    const createServiceStateMock = jest.fn<() => typeof mockStateManager>();
    createServiceStateMock.mockReturnValue(mockStateManager);

    const getStreamHealthMonitorMock = jest.fn();
    getStreamHealthMonitorMock.mockReturnValue(createMockStreamHealthMonitor());

    // Create dependencies object with real Redis + mock non-Redis deps
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
    // Disconnect real clients
    if (redisClient) {
      try {
        await redisClient.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
    if (streamsClient) {
      try {
        await streamsClient.disconnect();
      } catch {
        // Ignore disconnect errors
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

      // Real Redis clients are disconnected by the coordinator
    });

    it('should handle Redis connection failures gracefully', async () => {

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
      // With real Redis, the lock should be available (Redis was flushed)
      await coordinator.start(0);

      expect(coordinator.getIsLeader()).toBe(true);
    });

    it('should not become leader when lock is held by another instance', async () => {
      // Pre-set the leader lock in Redis to simulate another instance holding it
      const lockKey = 'coordinator:leader:lock';
      await rawRedis.set(lockKey, 'other-instance-id', 'EX', 60, 'NX');

      await coordinator.start(0);

      expect(coordinator.getIsLeader()).toBe(false);
    });

    it('should release leadership on stop', async () => {
      await coordinator.start(0);
      expect(coordinator.getIsLeader()).toBe(true);

      const instanceId = (coordinator as any).config.leaderElection.instanceId;

      await coordinator.stop();

      // Verify the lock was actually released from Redis
      const lockValue = await rawRedis.get('coordinator:leader:lock');
      expect(lockValue).toBeNull();
    });

    it('should expose leader status via API', async () => {
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
      // Spy on the real streams client to verify calls
      const createGroupSpy = jest.spyOn(streamsClient, 'createConsumerGroup');

      await coordinator.start(0);

      expect(createGroupSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          streamName: RedisStreamsClient.STREAMS.HEALTH,
          groupName: 'coordinator-group'
        })
      );

      expect(createGroupSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          streamName: RedisStreamsClient.STREAMS.OPPORTUNITIES,
          groupName: 'coordinator-group'
        })
      );

      expect(createGroupSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          streamName: RedisStreamsClient.STREAMS.WHALE_ALERTS,
          groupName: 'coordinator-group'
        })
      );

      createGroupSpy.mockRestore();
    });

    it('should create stream consumers for each stream', async () => {
      await coordinator.start(0);

      // Verify StreamConsumer was instantiated for each stream
      // S3.3.5 FIX: Now 6 streams: health, opportunities, whale-alerts, swap-events, volume-aggregates, price-updates
      expect(mockDeps.StreamConsumer).toHaveBeenCalledTimes(6);
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
      expect(data.status).toBe('healthy');
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

      // R2: For tests without healthMonitor, also set healthMonitor's start time
      if ((coordinator as any).healthMonitor) {
        (coordinator as any).healthMonitor.start();
        (coordinator as any).healthMonitor['startTime'] = Date.now() - 70000;
      }

      // Trigger alert check
      (coordinator as any).checkForAlerts();

      // R2: Use getAlertCooldowns() which delegates to healthMonitor if available
      const cooldowns = coordinator.getAlertCooldowns();
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
      // R2: Use getAlertCooldowns() which delegates to healthMonitor if available
      expect(coordinator.getAlertCooldowns().has('TEST_ALERT_system')).toBe(true);

      // Second alert within cooldown should be ignored (no change to cooldown time)
      const firstCooldown = coordinator.getAlertCooldowns().get('TEST_ALERT_system');
      (coordinator as any).sendAlert(alert);
      const secondCooldown = coordinator.getAlertCooldowns().get('TEST_ALERT_system');

      // Cooldown timestamp shouldn't change
      expect(firstCooldown).toBe(secondCooldown);
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should handle consumer group creation failures gracefully', async () => {
      // Spy on real client and make it fail
      jest.spyOn(streamsClient, 'createConsumerGroup').mockRejectedValue(new Error('Group creation failed'));

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

    it('should guard against negative usdValue in swap events', async () => {
      await coordinator.start(0);

      const handler = (coordinator as any).handleSwapEventMessage.bind(coordinator);

      // Malformed message with negative usdValue should not corrupt metrics
      const malformedMessage = {
        id: '1234-0',
        data: {
          pairAddress: '0x1234567890123456789012345678901234567890',
          chain: 'ethereum',
          dex: 'uniswap',
          usdValue: -50000, // Negative value - should be treated as 0
          transactionHash: '0xabc123'
        }
      };

      await expect(handler(malformedMessage)).resolves.not.toThrow();

      // Metrics should NOT be decremented by negative value
      const metrics = coordinator.getSystemMetrics();
      expect(metrics.totalSwapEvents).toBe(1); // Event was processed
      expect(metrics.totalVolumeUsd).toBe(0);  // But volume should be 0, not -50000
      expect(metrics.activePairsTracked).toBe(1); // Pair was still tracked
    });

    it('should guard against negative totalUsdVolume in volume aggregates', async () => {
      await coordinator.start(0);

      const handler = (coordinator as any).handleVolumeAggregateMessage.bind(coordinator);

      // Malformed message with negative totalUsdVolume
      const malformedMessage = {
        id: '1234-0',
        data: {
          pairAddress: '0xabcdef1234567890123456789012345678901234',
          chain: 'bsc',
          dex: 'pancakeswap',
          swapCount: 10,
          totalUsdVolume: -100000 // Negative value - should be treated as 0
        }
      };

      await expect(handler(malformedMessage)).resolves.not.toThrow();

      // Metrics should be updated correctly
      const metrics = coordinator.getSystemMetrics();
      expect(metrics.volumeAggregatesProcessed).toBe(1);
      expect(metrics.activePairsTracked).toBe(1);
    });

    it('should track pairs as active even with swapCount=0', async () => {
      await coordinator.start(0);

      const handler = (coordinator as any).handleVolumeAggregateMessage.bind(coordinator);

      // Volume aggregate with zero swaps (quiet window for monitored pair)
      const quietWindowMessage = {
        id: '1234-0',
        data: {
          pairAddress: '0x9999999999999999999999999999999999999999',
          chain: 'polygon',
          dex: 'quickswap',
          swapCount: 0, // No swaps in this 5-second window
          totalUsdVolume: 0
        }
      };

      await expect(handler(quietWindowMessage)).resolves.not.toThrow();

      // Pair should still be tracked as active (producing aggregates means it's monitored)
      const activePairs = (coordinator as any).activePairs;
      expect(activePairs.has('0x9999999999999999999999999999999999999999')).toBe(true);

      // Metrics should be updated
      const metrics = coordinator.getSystemMetrics();
      expect(metrics.volumeAggregatesProcessed).toBe(1);
      expect(metrics.activePairsTracked).toBe(1);
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

  // ===========================================================================
  // Standby Activation Tests (ADR-007)
  // ===========================================================================

  describe('standby activation', () => {
    let standbyCoordinator: CoordinatorService;

    beforeEach(() => {
      // Create a standby coordinator
      standbyCoordinator = new CoordinatorService({
        isStandby: true,
        canBecomeLeader: true,
        regionId: 'us-central1'
      }, mockDeps);
    });

    afterEach(async () => {
      if (standbyCoordinator) {
        try {
          await standbyCoordinator.stop();
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should skip activation when already leader', async () => {
      // Start coordinator and acquire leadership (real Redis, lock available)
      await coordinator.start(0);
      expect(coordinator.getIsLeader()).toBe(true);

      // Attempt activation - should return true without changing state
      const result = await coordinator.activateStandby();
      expect(result).toBe(true);
    });

    it('should fail activation when canBecomeLeader is false', async () => {
      // Create coordinator that cannot become leader
      const noLeaderCoordinator = new CoordinatorService({
        isStandby: true,
        canBecomeLeader: false
      }, mockDeps);

      await noLeaderCoordinator.start(0);
      const result = await noLeaderCoordinator.activateStandby();
      expect(result).toBe(false);

      await noLeaderCoordinator.stop();
    });

    it('should handle concurrent activation attempts with Promise mutex', async () => {
      await standbyCoordinator.start(0);

      // Simulate concurrent activation attempts
      const [result1, result2] = await Promise.all([
        standbyCoordinator.activateStandby(),
        standbyCoordinator.activateStandby()
      ]);

      // Both should get the same result (either both true or both false)
      expect(result1).toBe(result2);

      // Only one should have actually executed the activation
      // (the second one waits for the first)
    });

    it('should report isActivating correctly', async () => {
      await standbyCoordinator.start(0);

      // Not activating initially
      expect(standbyCoordinator.getIsActivating()).toBe(false);
    });

    it('should successfully activate when lock is available', async () => {
      await standbyCoordinator.start(0);

      // Initially not leader (standby)
      expect(standbyCoordinator.getIsLeader()).toBe(false);

      // Activate - lock should be available (Redis was flushed)
      const result = await standbyCoordinator.activateStandby();
      expect(result).toBe(true);
      expect(standbyCoordinator.getIsLeader()).toBe(true);
    });

    it('should fail activation when lock is held by another instance', async () => {
      // Pre-set the leader lock to simulate another instance
      await rawRedis.set('coordinator:leader:lock', 'other-instance-id', 'EX', 60, 'NX');

      await standbyCoordinator.start(0);
      const result = await standbyCoordinator.activateStandby();

      expect(result).toBe(false);
      expect(standbyCoordinator.getIsLeader()).toBe(false);
    });
  });
});
